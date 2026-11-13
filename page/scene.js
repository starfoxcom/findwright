// Plays the hero's session as a loop: the question is typed and sent, the search runs and its
// files arrive one by one, Claude reads the part it needs, and a card pops in for each act.
// Every part is already in the page, so the window never changes size; the script only hides
// them and shows them in turn. With reduced motion, or without this script, the finished
// session shows as it is. The loop pauses while the scene is off screen or the tab is hidden.

const stage = document.querySelector(".hero .stage");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STEP_MS = 40;
const TYPE_MS = 28;
const CAPTIONS = [
  "Ask in plain words",
  "One search finds the files",
  "Reads only what it needs",
  "Sees your latest edits",
];

let paused = false;

// Resolves after ms of time the scene was on screen.
function hold(ms) {
  return new Promise((resolve) => {
    let left = ms;
    let last = performance.now();
    const beat = () => {
      const now = performance.now();
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) resolve();
      else setTimeout(beat, Math.min(STEP_MS, left));
    };
    beat();
  });
}

const part = (name) => stage.querySelector(`[data-step="${name}"]`);
const show = (node) => node.classList.add("on");

async function caption(number, text) {
  const node = stage.querySelector(".caption");
  const lead = Object.assign(document.createElement("b"), { textContent: `${number}.` });
  node.replaceChildren(lead, text);
  node.classList.remove("in");
  void node.offsetWidth;
  node.classList.add("in");
  await hold(500);
}

async function typeQuestion() {
  const input = stage.querySelector(".input");
  const text = part("ask").textContent;
  const typed = Object.assign(document.createElement("span"), { className: "typed" });
  input.replaceChildren(typed, Object.assign(document.createElement("span"), { className: "caret" }));
  for (let index = 1; index <= text.length; index += 1) {
    typed.textContent = text.slice(0, index);
    input.scrollLeft = input.scrollWidth;
    await hold(TYPE_MS);
  }
  await hold(400);
  input.textContent = "Type / for commands";
  show(part("ask"));
}

// A tool call: its line shows with a blinking dot while it runs, then the dot settles.
async function runTool(name, ms) {
  const line = part(name);
  line.classList.add("running");
  show(line);
  await hold(ms);
  line.classList.remove("running");
}

async function story() {
  stage.querySelectorAll("[data-step], .card").forEach((node) => node.classList.remove("on"));
  await caption(1, CAPTIONS[0]);
  await typeQuestion();
  await hold(600);
  await caption(2, CAPTIONS[1]);
  await runTool("search", 1100);
  for (const file of stage.querySelectorAll('[data-step="file"]')) {
    show(file);
    await hold(160);
  }
  show(stage.querySelector('.card[data-card="search"]'));
  await hold(1600);
  await caption(3, CAPTIONS[2]);
  await runTool("read", 800);
  await hold(500);
  show(part("reply"));
  show(stage.querySelector('.card[data-card="read"]'));
  await hold(2200);
  await caption(4, CAPTIONS[3]);
  show(stage.querySelector('.card[data-card="current"]'));
  await hold(4200);
}

async function loop() {
  for (;;) await story();
}

if (stage && !reduce) {
  let seen = true;
  const sync = () => {
    paused = !seen || document.hidden;
  };
  stage.classList.add("playing");
  // The window, not the stage: on a phone the stage has no box of its own (display: contents).
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting;
    sync();
  }).observe(stage.querySelector(".term"));
  document.addEventListener("visibilitychange", sync);
  loop();
}
