// Fades each block below the hero in as it enters the view, once. The inline script
// in <head> sets html.reveal before the first paint; without it (reduced motion, or
// no JavaScript) every block shows from the start.
const root = document.documentElement;

// How far a block must rise into the view before it shows: past the bottom 8%.
const ENTER_MARGIN = "0px 0px -8% 0px";

/** Runs `start` once, when `node` rises past the bottom 8% of the view: the moment it fades in. */
export function onEnter(node, start) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    start();
  }, { rootMargin: ENTER_MARGIN });
  observer.observe(node);
}

if (root.classList.contains("reveal")) {
  document.querySelectorAll("main > section:not(.hero) > *")
    .forEach((block) => onEnter(block, () => block.classList.add("shown")));
  // Tells the stylesheet the observer runs, which stops its show-everything fallback.
  root.classList.add("reveal-ready");
}
