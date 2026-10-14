// Panel bar: one tab per panel. Click to switch, drop tab rows on it to move
// them (and their subtrees) into the panel, right-click for rename/colour/delete.

import { h, run, toast } from "./client.js";
import { askText, askConfirm } from "./dialog.js";
import { icon } from "./icons.js";
import { dropAllowed } from "../../lib/tree.js";
import { isExternal, readLinks } from "./external-drop.js";

const PALETTE = ["#4f8cff", "#00c79a", "#51cd00", "#ffcb00", "#ff9f00", "#ff613d", "#ff4bda", "#af51f5", "#8a8a8a"];

const PEEK_DELAY = 450; // ms of hovering before a panel's tree opens under the drag

export function createPanelBar({ root, getState, getWindowId, getDraggingIds, showMenu, onHoverPanel = () => {} }) {
  let hoverId = null;
  let hoverTimer = null;
  let peeking = null;

  // Called while something is dragged over a panel tab. Resting on another panel
  // opens its tree; moving back to the current panel closes it again.
  function hover(panelId, activeId) {
    if (hoverId === panelId) return;
    clearTimeout(hoverTimer);
    hoverId = panelId;
    if (panelId === activeId) return onHoverPanel(null);
    hoverTimer = setTimeout(() => onHoverPanel(panelId), PEEK_DELAY);
  }

  function setPeeking(id) {
    peeking = id;
    if (!id) {
      clearTimeout(hoverTimer);
      hoverId = null;
    }
    root.querySelectorAll(".panel-tab[data-id]").forEach((el) => el.classList.toggle("peeking", el.dataset.id === id));
  }

  function count(state, panelId) {
    let n = 0;
    for (const x of Object.values(state.nodes)) if (x.panelId === panelId && x.type === "tab" && x.tabId != null) n++;
    return n;
  }

  function panelMenu(p, state) {
    const index = state.panels.findIndex((x) => x.id === p.id);
    const move = (dir) => {
      const ids = state.panels.map((x) => x.id);
      [ids[index], ids[index + dir]] = [ids[index + dir], ids[index]];
      run("panel:reorder", { ids });
    };
    const items = [
      { label: "Rename…", onSelect: async () => {
        const name = await askText("Panel name", p.name);
        if (name) run("panel:update", { id: p.id, name });
      } },
      { swatches: PALETTE, current: p.color, onPick: (color) => run("panel:update", { id: p.id, color }) },
    ];
    if (index > 0) items.push({ label: "Move left", onSelect: () => move(-1) });
    if (index < state.panels.length - 1) items.push({ label: "Move right", onSelect: () => move(1) });
    if (state.panels.length > 1) {
      items.push({ separator: true });
      items.push({ label: "Delete panel…", danger: true, onSelect: async () => {
        if (await askConfirm(`Delete “${p.name}”? Its tabs move to another panel.`, "Delete")) run("panel:delete", { id: p.id });
      } });
    }
    return items;
  }

  // Is something playing in this panel? (Its tabs may be hidden, so say so here.)
  function playing(state, panelId) {
    return Object.values(state.nodes).some((x) => x.panelId === panelId && x.type === "tab" && x.tabId != null && x.audible && !x.muted);
  }

  function render() {
    const state = getState();
    if (!state) return;
    const windowId = getWindowId();
    const active = state.activePanels[windowId] ?? state.panels[0]?.id;

    const tabs = state.panels.map((p) => {
      const el = h(
        "button",
        {
          class: `panel-tab${p.id === peeking ? " peeking" : ""}`,
          dataset: { id: p.id },
          role: "tab",
          "aria-selected": String(p.id === active),
          style: { "--panel-color": p.color },
          title: p.name,
          onclick: () => run("panel:switch", { windowId, panelId: p.id }),
          oncontextmenu: (e) => {
            e.preventDefault();
            showMenu(e, panelMenu(p, state));
          },
        },
        h("span", { class: "dot" }),
        h("span", {}, p.name),
        h("span", { class: "count" }, String(count(state, p.id))),
        playing(state, p.id) ? h("span", { class: "playing", title: "Playing sound" }, icon("speaker", { size: 12 })) : null
      );
      el.addEventListener("dragover", (e) => {
        const ids = getDraggingIds();
        if (!ids.length) {
          if (!isExternal(e.dataTransfer)) return;
        } else if (!ids.every((id) => dropAllowed(state.nodes, id, { parentId: null }))) return; // e.g. notes cannot sit at the top level
        e.preventDefault();
        el.classList.add("drop-target");
        hover(p.id, active);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drop-target");
        const ids = getDraggingIds();
        if (ids.length) return run("tree:moveMany", { ids, parentId: null, index: null, panelId: p.id });
        // A link, bookmark or download dropped on a panel opens there, without switching to it.
        // Text with no link in it is searched for, also in the background.
        const { links, text } = readLinks(e.dataTransfer);
        const spot = { windowId, parentId: null, index: null, panelId: p.id };
        const started = links.length ? run("tab:openUrls", { urls: links, ...spot }) : text ? run("tab:search", { text, ...spot }) : null;
        started?.then((res) => res?.error && toast(res.error));
      });
      return el;
    });

    const add = h("button", {
      class: "panel-tab panel-add",
      title: "New panel",
      onclick: async () => {
        const name = await askText("New panel name");
        if (!name) return;
        const id = await run("panel:create", { name, windowId, color: PALETTE[state.panels.length % PALETTE.length] });
        if (id) run("panel:switch", { windowId, panelId: id });
      },
    }, "+");

    root.replaceChildren(...tabs, add);
  }

  return { render, setPeeking };
}
