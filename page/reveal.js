// Fades each block below the hero in as it enters the view, once. The inline script
// in <head> sets html.reveal before the first paint; without it (reduced motion, or
// no JavaScript) every block shows from the start.
const root = document.documentElement;

// How far a block must rise into the view before it shows: past the bottom 8%.
const ENTER_MARGIN = "0px 0px -8% 0px";

if (root.classList.contains("reveal")) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries.filter((e) => e.isIntersecting)) {
      entry.target.classList.add("shown");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: ENTER_MARGIN });
  document.querySelectorAll("main > section:not(.hero) > *").forEach((block) => observer.observe(block));
  // Tells the stylesheet the observer runs, which stops its show-everything fallback.
  root.classList.add("reveal-ready");
}
