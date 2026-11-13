// Fills the page's numbers from metrics.json, which bench/page_metrics.py writes, and runs the
// install switch and the copy buttons. Without metrics.json the numbers written into the page stay.

import { onEnter } from "./reveal.js";

const COUNT_MS = 1200;

const GROUPS = [
  ["all", "Every search"],
  ["questions", "Plain-English questions"],
  ["names", "Names and identifiers"],
];

// Both icons share one stroke style; each is drawn by its path data.
const ICON_ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg class="ico-copy" ${ICON_ATTRS}><rect x="8" y="8" width="14" height="14" rx="2"/>`
  + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = `<svg class="ico-check" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;

function valueAt(metrics, path) {
  return path.split(".").reduce((node, key) => (node == null ? node : node[key]), metrics);
}

function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillFields(metrics) {
  for (const node of document.querySelectorAll("[data-field]")) {
    const value = valueAt(metrics, node.dataset.field);
    if (value != null) node.textContent = formatNumber(value);
  }
}

// Every group the page compares, in reading order: kinds of search first, then each project.
function groupsOf(metrics) {
  const kinds = GROUPS.filter(([key]) => metrics[key]).map(([key, label]) => ({ label, ...metrics[key] }));
  return [...kinds, ...(metrics.projects ?? []).map((project) => ({ label: project.kind, ...project }))];
}

function barLine(className, rate) {
  const line = element("div", "bar-line");
  const track = element("div", "bar-track");
  const fill = element("i", className);
  fill.style.width = `${rate}%`;
  track.append(fill);
  line.append(track, element("span", "bar-value", `${rate}%`));
  return line;
}

function barRow(group, index) {
  const row = element("li", "bar-row");
  row.style.setProperty("--row", String(index));
  const rates = `FindWright ${group.findwright.hitRate}%, previous tool ${group.baseline.hitRate}%`;
  row.setAttribute("aria-label", `${group.label}, ${group.searches} searches: ${rates}`);
  const name = element("div", "bar-name", group.label);
  name.append(element("small", "", `${formatNumber(group.searches)} searches`));
  const pair = element("div", "bar-pair");
  pair.setAttribute("aria-hidden", "true");
  pair.append(barLine("bar-ours", group.findwright.hitRate), barLine("bar-was", group.baseline.hitRate));
  row.append(name, pair);
  return row;
}

function tableRow(group) {
  const row = document.createElement("tr");
  const rates = [`${group.findwright.hitRate}%`, `${group.baseline.hitRate}%`];
  const cells = [group.label, formatNumber(group.searches), ...rates];
  cells.forEach((text, index) => {
    const cell = document.createElement(index === 0 ? "th" : "td");
    if (index === 0) cell.scope = "row";
    cell.textContent = text;
    row.append(cell);
  });
  return row;
}

function fillCharts(metrics) {
  const groups = groupsOf(metrics);
  document.querySelector("[data-bars]").replaceChildren(...groups.map(barRow));
  document.querySelector("[data-rows]").replaceChildren(...groups.map(tableRow));
}

async function loadMetrics() {
  try {
    const response = await fetch("metrics.json");
    if (!response.ok) return;
    const metrics = await response.json();
    fillFields(metrics);
    fillCharts(metrics);
  } catch {
    // The numbers written into the page stay; nothing else depends on them.
  }
}

// Counts a number up from zero to the value it shows, quick at first and slowing at the end.
function countUp(node) {
  const target = Number(node.textContent.replaceAll(",", ""));
  if (!Number.isFinite(target)) return;
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / COUNT_MS);
    node.textContent = formatNumber(Math.round(target * (1 - (1 - progress) ** 3)));
    if (progress < 1) requestAnimationFrame(tick);
  };
  node.textContent = "0";
  requestAnimationFrame(tick);
}

// The totals count up and the bars grow as each comes into view; reduced motion shows them done.
function animateNumbers() {
  const stats = document.querySelector(".stats");
  const bars = document.querySelector("[data-bars]");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    bars.classList.add("counted");
    return;
  }
  onEnter(stats, () => stats.querySelectorAll(".stat-num [data-field]").forEach(countUp));
  onEnter(bars, () => bars.classList.add("counted"));
}

function selectTab(tabs, chosen) {
  for (const tab of tabs) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
  }
  chosen.closest("[role=tablist]").dataset.active = chosen.id.replace("install-tab-", "");
}

function setUpSwitch() {
  const tabs = [...document.querySelectorAll(".install-switch [role=tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tabs, tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(tabs, next);
      next.focus();
    });
  }
}

function setUpCopy() {
  const status = document.querySelector(".copy-status");
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.innerHTML = COPY_ICON + CHECK_ICON;
    button.addEventListener("click", async () => {
      const text = button.parentElement.querySelector("code").textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("copied");
        status.textContent = "Command copied";
        setTimeout(() => button.classList.remove("copied"), 1600);
      } catch {
        status.textContent = "Copy did not work here; select the command and copy it by hand";
      }
    });
  }
}

setUpSwitch();
setUpCopy();
loadMetrics().then(animateNumbers);
