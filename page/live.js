// The live section: anonymous counts from the projects whose owners turned them on, read from
// the counter (counter/ in the repo). The whole section stays hidden until the counter answers
// with at least one project. The numbers count up and each project's bar grows as its block enters the view;
// reduced motion shows the final state.
import { onEnter } from "./reveal.js";

const COUNTER = "https://findwright-counter.starfoxcom.workers.dev/total";
const TIMEOUT_MS = 3000;
const DURATION_MS = 1200;
const STEP_MS = 30;
const KIND_NAMES = {
  "game": "Game project",
  "business-app": "Business app",
  "developer-tool": "Developer tool",
  "mobile-app": "Mobile app",
  "website": "Website",
  "other": "Other project",
};

const section = document.getElementById("live");
const counts = document.getElementById("live-counts");
const note = document.getElementById("live-note");
const stats = counts.querySelector(".stats");
const chart = document.getElementById("live-projects");

// A preview may read sample totals with ?counter=<url>: any address on a local server,
// otherwise only a file from the page's own site, so a link cannot point the page elsewhere.
function counterUrl() {
  const override = new URLSearchParams(location.search).get("counter");
  if (!override) return COUNTER;
  const url = new URL(override, location.href);
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  return isLocal || url.origin === location.origin ? url.href : COUNTER;
}

const isCount = (value) => Number.isInteger(value) && value >= 0;
const isRow = (row) => row?.kind in KIND_NAMES && isCount(row.searches) && row.searches > 0
  && isCount(row.hits) && row.hits <= row.searches;

// The counter's answer, or null when it holds no project or is not the shape drawn here.
async function load() {
  const response = await fetch(counterUrl(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const total = await response.json();
  const fields = ["projects", "sessions", "searches", "hits", "bytes"];
  if (!total || !fields.every((field) => isCount(total[field])) || total.searches === 0) return null;
  const rows = Array.isArray(total.top) ? total.top.filter(isRow) : [];
  const countries = Array.isArray(total.countries) ? total.countries.length : 0;
  return rows.length ? { ...total, rows, countries } : null;
}

// "Game project", or "Game project 1", "Game project 2" when the kind repeats.
function labelled(rows) {
  const totals = {};
  for (const row of rows) totals[row.kind] = (totals[row.kind] ?? 0) + 1;
  const seen = {};
  return rows.map((row) => {
    seen[row.kind] = (seen[row.kind] ?? 0) + 1;
    const name = KIND_NAMES[row.kind];
    return { ...row, label: totals[row.kind] > 1 ? `${name} ${seen[row.kind]}` : name };
  });
}

const el = (tag, cls, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const percentOf = (part, whole) => Math.round((100 * part) / whole);
const width = (part, whole) => `${((100 * part) / whole).toFixed(3)}%`;

// Under the bar, each part's exact count, the number in its part's colour.
function breakdown(row) {
  const line = el("span", "project-breakdown");
  line.append(...[
    ["tone-hit", row.hits, "named the file"],
    ["tone-miss", row.searches - row.hits, "did not"],
  ].map(([tone, count, words]) => {
    const part = el("span", "project-part");
    part.append(el("b", tone, String(count)), ` ${words}`);
    return part;
  }));
  return line;
}

// One project's row: its bar as wide as its searches against the largest, the hits part first.
function projectRow(row, index, largest) {
  const item = el("li", "project");
  item.style.setProperty("--row", index);
  const bar = el("i", "project-bar");
  bar.style.width = width(row.searches, largest);
  const hits = el("i", "seg-hit");
  hits.style.width = width(row.hits, row.searches);
  bar.append(hits, el("i", "seg-miss"));
  const track = el("span", "project-track");
  track.append(bar);
  const count = `${row.searches} searches · ${percentOf(row.hits, row.searches)}% found the file`;
  item.append(el("span", "project-name", row.label), track, el("span", "project-count", count), breakdown(row));
  return item;
}

// Counts one number from zero up to its target, written by `format`.
function countUp(node, target, format) {
  let step = 0;
  const steps = DURATION_MS / STEP_MS;
  const tick = () => {
    step += 1;
    node.textContent = format(target * (1 - (1 - step / steps) ** 3));
    if (step < steps) setTimeout(tick, STEP_MS);
  };
  tick();
}

function show(total) {
  const numbers = {
    rate: [percentOf(total.hits, total.searches), (v) => `${Math.round(v)}%`],
    searches: [total.searches, (v) => String(Math.round(v))],
    sessions: [total.sessions, (v) => String(Math.round(v))],
    answer: [total.bytes / total.searches / 1024, (v) => `${v.toFixed(1)} KB`],
  };
  for (const [name, [value, format]] of Object.entries(numbers)) {
    stats.querySelector(`[data-total="${name}"]`).textContent = format(value);
  }
  const places = total.countries > 1 ? ` in ${total.countries} countries` : "";
  const one = total.projects === 1;
  note.textContent = `From ${total.projects} ${one ? "project" : "projects"}${places} `
    + `whose ${one ? "owner" : "owners"} turned on the anonymous counts. `
    + "An anonymous counter cannot prove a count is real, so read these as a signal.";
  const rows = labelled(total.rows);
  const largest = Math.max(...rows.map((row) => row.searches));
  chart.replaceChildren(...rows.map((row, index) => projectRow(row, index, largest)));
  section.hidden = false;
  // reveal.js could not see these blocks while the section was hidden, so they join its fade here.
  for (const block of section.children) onEnter(block, () => block.classList.add("shown"));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    chart.classList.add("counted");
    return;
  }
  onEnter(stats, () => {
    for (const [name, [value, format]] of Object.entries(numbers)) {
      countUp(stats.querySelector(`[data-total="${name}"]`), value, format);
    }
  });
  onEnter(chart, () => chart.classList.add("counted"));
}

load().then((total) => total && show(total)).catch(() => {});
