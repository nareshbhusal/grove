// The hover preview: a small card with a picture of the page and its title / address.
// It sits over the list (it cannot leave the sidebar) and lets the pointer through.
//
// The settings come from the background ("hover": tooltip, preview, previewWidth, previewDelay).
// The first row shown waits `previewDelay`; moving to another row while one is showing switches at once.

import { h, cmd } from "./client.js";
import { hoverLines, previewable, previewMode } from "../../lib/hover.js";

export function createHover({ root, card, getState, getWindowId }) {
  let timer = null;
  let currentId = null; // the row the pointer is on (and a card is wanted for)
  let shownId = null; // the row the card is showing
  let suppressed = null; // a row you clicked: no card for it until the pointer leaves
  let token = 0; // a newer request makes older ones stop

  const cfg = () => getState()?.settings?.hover ?? {};

  function hide() {
    clearTimeout(timer);
    timer = null;
    currentId = null;
    shownId = null;
    token++;
    card.hidden = true;
    card.replaceChildren();
  }

  function targetOf(e) {
    if (previewMode(cfg()) === "off") return null;
    const row = e.target.closest?.(".row");
    if (!row || !root.contains(row)) return null;
    if (previewMode(cfg()) === "favicon" && !e.target.closest(".favicon")) return null;
    const node = getState()?.nodes[row.dataset.id];
    return node && previewable(node) ? { row, node } : null;
  }

  async function show(row, node) {
    const mine = ++token;
    const data = await cmd("thumb:get", { id: node.id, windowId: getWindowId() }).catch(() => null);
    if (mine !== token || currentId !== node.id) return;

    const width = Math.max(120, Math.min(Number(cfg().previewWidth) || 260, window.innerWidth - 16));
    const label = node.customTitle || node.title || node.url || "";
    const lines = hoverLines(node, cfg().tooltip, label);
    card.style.width = `${width}px`;
    card.replaceChildren(
      data
        ? h("img", { class: "pv-shot", src: data.dataUrl, alt: "", style: { aspectRatio: `${1 / (data.ratio || 0.62)}` } })
        : h("div", { class: "pv-shot empty", style: { aspectRatio: "16 / 10" } }, "No preview yet. It is taken while you view the tab."),
      lines.length ? h("div", { class: "pv-text" }, ...lines.map((l) => h("div", { class: `pv-${l.kind}` }, l.text))) : null
    );
    card.hidden = false;
    // Below the row, or above it when there is no room; centred in the sidebar.
    const r = row.getBoundingClientRect();
    const height = card.offsetHeight;
    let top = r.bottom + 6;
    if (top + height > window.innerHeight - 4) top = Math.max(4, r.top - height - 6);
    card.style.top = `${top}px`;
    card.style.left = `${Math.max(8, (window.innerWidth - width) / 2)}px`;
    shownId = node.id;
  }

  root.addEventListener("mouseover", (e) => {
    const t = targetOf(e);
    if (!t) {
      suppressed = null;
      if (currentId) hide();
      return;
    }
    if (t.node.id === suppressed) return;
    suppressed = null;
    if (t.node.id === currentId) return;
    clearTimeout(timer);
    currentId = t.node.id;
    const delay = shownId ? 0 : Math.max(0, Number(cfg().previewDelay) || 0);
    timer = setTimeout(() => show(t.row, t.node), delay);
  });
  root.addEventListener("mouseleave", () => {
    suppressed = null;
    hide();
  });

  // Anything you do ends it: click, right-click, drag, scroll, a key, leaving the window.
  const quit = (e) => {
    suppressed = currentId;
    hide();
  };
  root.addEventListener("mousedown", quit, true);
  root.addEventListener("contextmenu", quit, true);
  root.addEventListener("scroll", () => hide(), true);
  document.addEventListener("dragstart", quit, true);
  document.addEventListener("keydown", () => hide(), true);
  window.addEventListener("blur", () => hide());

  return {
    // After the list is redrawn: forget a card whose row is gone.
    refresh() {
      if (currentId && !root.querySelector(`.row[data-id="${CSS.escape(currentId)}"]`)) hide();
    },
    hide,
  };
}
