// Fills the page's numbers from metrics.json, which bench/page_metrics.py writes.
// Without it the placeholders stay, so the page still reads.

const ROW_GROUPS = [
  ["all", "Every search"],
  ["questions", "Plain-English questions"],
  ["names", "Names and identifiers"],
];

function valueAt(metrics, path) {
  return path.split(".").reduce((node, key) => (node == null ? node : node[key]), metrics);
}

function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
}

function fillFields(metrics) {
  for (const element of document.querySelectorAll("[data-field]")) {
    const value = valueAt(metrics, element.dataset.field);
    if (value != null) element.textContent = formatNumber(value);
  }
}

function tableRow(label, summary) {
  const row = document.createElement("tr");
  const cells = [
    label,
    formatNumber(summary.searches),
    `${summary.findwright.hitRate}%`,
    `${summary.baseline.hitRate}%`,
  ];
  cells.forEach((text, index) => {
    const cell = document.createElement(index === 0 ? "th" : "td");
    if (index === 0) cell.scope = "row";
    cell.textContent = text;
    row.append(cell);
  });
  return row;
}

function fillTable(metrics) {
  const body = document.querySelector("[data-rows]");
  for (const [key, label] of ROW_GROUPS) body.append(tableRow(label, metrics[key]));
  for (const project of metrics.projects) body.append(tableRow(project.kind, project));
}

async function main() {
  try {
    const response = await fetch("metrics.json");
    if (!response.ok) return;
    const metrics = await response.json();
    fillFields(metrics);
    fillTable(metrics);
  } catch {
    // The page reads without numbers; nothing else depends on them.
  }
}

main();
