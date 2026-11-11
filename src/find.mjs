// Ranked file search for a name, a few identifiers or a plain-language question.
// Each query word scores the files it hits, weighted by how rare it is across the
// project (IDF), so a word every file contains counts for little:
//   6  a symbol named exactly the word (`Foo::bar` and `bar` both answer to `bar`)
//   5  the file name contains the word
//   3  a symbol name contains the word
//   2  the path contains the word
//   1  the text contains the word
// CamelCase words also match their snake_case form, and two neighbouring words
// match the identifier that joins them (`water flow` finds `water_flow` and `waterFlow`).
// A header and its source file share part of each other's score.

import { meaningScores } from "./meaning.mjs";

const STOP = new Set(("the and for with from that this into when what which where how does are was not has have its "
  + "use uses used using all any each per via them they then than also only just like out off our new old "
  + "file files code function functions method class find show list read write make get set run runs").split(" "));

const snake = (w) => w.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const PAIRS = [[/\.(h|hpp|hh)$/, [".cpp", ".cc", ".c"]], [/\.(cpp|cc|c)$/, [".h", ".hpp", ".hh"]]];

/** The query's words, lower-cased, without stop words, plus joined neighbours. */
export function queryTerms(text) {
  const words = (text.match(/[A-Za-z_]\w*/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()));
  const terms = new Map();
  for (const w of words) for (const v of new Set([w.toLowerCase(), snake(w)])) terms.set(v, 1);
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i].toLowerCase(), words[i + 1].toLowerCase()];
    if (!/^[a-z]+$/.test(a + b)) continue;
    terms.set(`${a}_${b}`, 1.5);
    terms.set(a + b, 1.5);
  }
  return terms;
}

function scorer(db, keep) {
  const kinds = new Map(db.prepare("SELECT path, kind FROM files").all().map((r) => [r.path, r.kind]));
  const paths = [...kinds.keys()].filter(keep);
  const symbolRows = db.prepare("SELECT path, name FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT 2000");
  const body = db.prepare("SELECT path FROM body WHERE body MATCH ?");
  const base = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  return (term) => {
    const best = new Map();
    const bump = (p, n) => keep(p) && best.set(p, Math.max(best.get(p) ?? 0, n));
    for (const r of symbolRows.all(`%${term.replace(/[\\%_]/g, "\\$&")}%`)) {
      const n = r.name.toLowerCase();
      bump(r.path, n === term || n.slice(n.lastIndexOf(":") + 1) === term ? 6 : 3);
    }
    for (const p of paths) {
      if (base(p).includes(term)) bump(p, 5);
      else if (p.toLowerCase().includes(term)) bump(p, 2);
    }
    const inBody = new Set(term.length >= 3 ? body.all(`text : "${term.replaceAll('"', '""')}"`).map((r) => r.path) : []);
    return { best, inBody, files: kinds.size };
  };
}

function sharePairs(score) {
  const out = new Map(score);
  for (const [path, s] of score) {
    for (const [re, exts] of PAIRS) {
      if (!re.test(path)) continue;
      for (const ext of exts) {
        const partner = path.replace(re, ext);
        if (score.has(partner)) out.set(partner, out.get(partner) + s * 0.3);
      }
    }
  }
  return out;
}

// Word scores scaled to [0, 1] by the best one, plus the weighted meaning score.
function blendMeaning(score, meaning, weight) {
  const top = Math.max(1e-9, ...score.values());
  for (const [path, s] of score) score.set(path, s / top);
  for (const [path, m] of meaning) score.set(path, (score.get(path) ?? 0) + weight * m);
}

/**
 * Files ranked for `query`, best first. With `model`, each file also scores by
 * how close its best window's meaning is to the query.
 * @param {object} db the open index
 * @param {{ query: string, keep?: (path: string) => boolean, limit?: number }} options
 */
export function find(db, { query, keep = () => true, limit = 20, model = null, meaningWeight = 1 }) {
  const score = new Map();
  const termScore = scorer(db, keep);
  for (const [term, boost] of queryTerms(query)) {
    const { best, inBody, files } = termScore(term);
    const df = Math.max(inBody.size, best.size);
    if (df === 0) continue;
    const weight = boost * Math.log(1 + files / (1 + df));
    for (const p of new Set([...best.keys(), ...inBody])) {
      if (keep(p)) score.set(p, (score.get(p) ?? 0) + weight * ((best.get(p) ?? 0) + (inBody.has(p) ? 1 : 0)));
    }
  }
  const shared = sharePairs(score);
  if (model) blendMeaning(shared, meaningScores(db, model, query, keep), meaningWeight);
  return [...shared.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([path, s]) => ({ path, score: +s.toFixed(3) }));
}
