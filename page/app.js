// Runs the install switch (desktop app or CLI) and the copy button on each command.

// Both icons share one stroke style; each is drawn by its path data.
const ICON_ATTRS = 'viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg class="ico-copy" ${ICON_ATTRS}><rect x="8" y="8" width="14" height="14" rx="2"/>`
  + '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = `<svg class="ico-check" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;

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
