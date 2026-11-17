// The estimated saving of a session's FindWright searches, in dollars. A search that names the file
// the session opens next saves the extra model turns a miss costs before the file is found. That
// cost is measured from this project's own sessions: the turns between a missed search and the
// file open, minus the turns after a hit, averaged per model and effort of the turn that searched,
// and priced at each turn's own model. Only those turns count, not what their output adds to later
// turns, so the estimate errs low.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costOf, priceOf, tokensOf } from "./prices.mjs";

const TOKEN_CLASSES = ["input", "write5m", "write1h", "read", "output"];
const zeroTokens = () => Object.fromEntries(TOKEN_CLASSES.map((c) => [c, 0]));
const addTokens = (into, from) => TOKEN_CLASSES.forEach((c) => { into[c] += from[c]; });
const isEmpty = (tokens) => TOKEN_CLASSES.every((c) => tokens[c] === 0);

/** The transcripts of the helper sessions a session started, next to its own transcript. */
export function helperTranscripts(transcript) {
  const folder = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.endsWith(".jsonl")).map((f) => join(folder, f));
}

// A response's tokens. Some rows carry their usage only in `iterations`, one entry per model call.
function responseTokens(usage) {
  const tokens = tokensOf(usage);
  if (!isEmpty(tokens) || !Array.isArray(usage?.iterations)) return tokens;
  const sum = zeroTokens();
  for (const step of usage.iterations) addTokens(sum, tokensOf(step));
  return sum;
}

/**
 * The model responses of a transcript in order, one per response id, each with the model and
 * effort that ran it, whether it ran in fast mode, its tokens and its cost (null when unpriced).
 */
export function responses(transcript, { helper = false } = {}) {
  const byId = new Map();
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const id = row.type === "assistant" ? row.message?.id : null;
    if (!id || (row.isSidechain && !helper)) continue;
    // A response is written once per content block; the last copy carries its final usage.
    const tokens = responseTokens(row.message.usage);
    const fast = row.message.usage?.speed === "fast";
    byId.set(id, {
      id, model: String(row.message.model ?? "unknown"), effort: String(row.perTurnEffort ?? row.effort ?? "unknown"),
      fast, tokens, cost: isEmpty(tokens) ? 0 : costOf(row.message.model, tokens, { fast }),
    });
  }
  return [...byId.values()];
}

const emptySide = () => ({ count: 0, turns: 0, cost: 0, tokens: zeroTokens() });
const emptyGroup = (model, effort) => ({ model, effort, hits: emptySide(), misses: emptySide() });

// Model and effort are both free text from a transcript, so the key encodes them as a JSON pair
// rather than joining them with a separator either could contain.
const groupKey = (model, effort) => JSON.stringify([model, effort]);

function addSide(into, side) {
  into.count += side.count;
  into.turns += side.turns;
  into.cost += side.cost;
  addTokens(into.tokens, side.tokens);
}

/**
 * The searches of one transcript sorted into groups by the model and effort of the response that
 * searched: `{ <key>: { model, effort, hits, misses } }`, each side holding how many searches it
 * saw and the turns, tokens and cost between each search and the file open. A turn on a model
 * with no known price adds its tokens but no cost.
 */
export function searchGroups(transcript, searches, { helper = false } = {}) {
  if (!searches.length) return {};
  const list = responses(transcript, { helper });
  const index = new Map(list.map((r, i) => [r.id, i]));
  const groups = {};
  for (const search of searches) {
    const from = index.get(search.from);
    const to = index.get(search.to);
    if (from === undefined || to === undefined) continue;
    const { model, effort } = list[from];
    const group = (groups[groupKey(model, effort)] ??= emptyGroup(model, effort));
    const side = search.hit ? group.hits : group.misses;
    side.count += 1;
    for (const turn of list.slice(from + 1, to)) {
      addSide(side, { count: 0, turns: 1, cost: turn.cost ?? 0, tokens: turn.tokens });
    }
  }
  return groups;
}

/** Several sets of groups added together, one group per model and effort. */
export function mergeGroups(...sets) {
  const merged = {};
  for (const groups of sets) {
    for (const group of Object.values(groups)) {
      const into = (merged[groupKey(group.model, group.effort)] ??= emptyGroup(group.model, group.effort));
      addSide(into.hits, group.hits);
      addSide(into.misses, group.misses);
    }
  }
  return merged;
}

// The hits and misses of several groups summed, whatever their model and effort.
function summed(groups) {
  const total = { hits: emptySide(), misses: emptySide() };
  for (const group of groups) {
    addSide(total.hits, group.hits);
    addSide(total.misses, group.misses);
  }
  return total;
}

const perSearch = (side, field) => (side.count ? side[field] / side.count : 0);

// A miss's extra cost measured in its own group, in dollars.
function measured(group) {
  return Math.max(0, perSearch(group.misses, "cost") - perSearch(group.hits, "cost"));
}

// A miss's extra cost for a group with no miss of its own: the extra turns other groups measured,
// with their average tokens per turn, priced at this group's model.
function borrowed(model, effort, pooled) {
  const all = Object.values(pooled);
  const source = [all.filter((g) => g.effort === effort), all].map(summed).find((g) => g.misses.count);
  if (!source) return 0;
  const extraTurns = Math.max(0, perSearch(source.misses, "turns") - perSearch(source.hits, "turns"));
  const turns = source.misses.turns;
  const perTurn = Object.fromEntries(TOKEN_CLASSES.map((c) => [c, turns ? source.misses.tokens[c] / turns : 0]));
  const turnCost = costOf(model, perTurn);
  return turnCost === null ? null : extraTurns * turnCost;
}

const round = (dollars) => Math.round(dollars * 100) / 100;

/**
 * The estimated saving of a session's main and helper searches: `{ main, helpers, groups,
 * unpriced }` in dollars, or `{ main: null, helpers: null, why }` when no miss exists yet to
 * measure what a miss costs. `pooled` holds the groups the estimate measures from: this session's
 * and those of the other sessions the caller read. `groups` lists each model and effort with its
 * hits and the cost of a miss.
 */
export function estimateSaving({ main, helpers }, pooled) {
  if (!Object.values(pooled).some((g) => g.misses.count)) {
    return { main: null, helpers: null, why: "no missed search is recorded yet, so what a miss costs is unmeasured" };
  }
  const unpriced = new Set();
  const detail = [];
  const total = (groups, role) => {
    let dollars = 0;
    for (const group of Object.values(groups)) {
      if (!group.hits.count) continue;
      const { model, effort } = group;
      const own = pooled[groupKey(model, effort)];
      const cost = own?.misses.count ? measured(own) : borrowed(model, effort, pooled);
      if (cost === null || !priceOf(model)) { unpriced.add(model); continue; }
      dollars += group.hits.count * cost;
      const isMeasured = Boolean(own?.misses.count);
      detail.push({ role, model, effort, hits: group.hits.count, perMiss: round(cost), measured: isMeasured });
    }
    return round(dollars);
  };
  return { main: total(main, "main"), helpers: total(helpers, "helpers"), groups: detail, unpriced: [...unpriced] };
}
