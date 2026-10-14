// Breadcrumb: shown while a folder is open. Panel › Folder › Subfolder.
// Click a crumb to go there. Drop a row on a crumb to move it into that place,
// which is how you drag something out of the folder you are in.

import { h, run } from "./client.js";
import { icon } from "./icons.js";
import { dropAllowed, countInside } from "../../lib/tree.js";
import { viewOf } from "./tree-view.js";

export function createBreadcrumb({ root, getState, getWindowId, getDraggingIds }) {
  function render() {
    const state = getState();
    if (!state) return;
    const windowId = getWindowId();
    const view = viewOf(state, windowId);
    root.hidden = !view.folderId;
    if (!view.folderId) {
      root.replaceChildren();
      return;
    }

    const panel = state.panels.find((p) => p.id === view.panelId);
    const chain = [];
    for (let id = view.folderId; id && state.nodes[id]; id = state.nodes[id].parentId) chain.unshift(state.nodes[id]);

    const crumbs = [{ label: panel?.name ?? "Panel", folderId: null }, ...chain.map((f) => ({ label: f.name || "Folder", folderId: f.id }))];
    const last = crumbs.length - 1;

    const up = h("button", {
      class: "crumb-up",
      title: "Up one level",
      "aria-label": "Up one level",
      onclick: () => run("folder:up", { windowId }),
    }, icon("back", { size: 16 }));

    const items = crumbs.map((c, i) => {
      const current = i === last;
      const el = h(
        "button",
        {
          class: `crumb${current ? " current" : ""}`,
          title: c.label,
          "aria-current": current ? "location" : null,
          onclick: () => !current && run("view:set", { windowId, panelId: view.panelId, folderId: c.folderId }),
        },
        c.label,
        current && c.folderId && countInside(state.nodes, c.folderId).total
          ? h("span", { class: "crumb-count", title: "Tabs and notes in this folder" }, String(countInside(state.nodes, c.folderId).total))
          : null
      );
      // A row can be dropped on any crumb: it moves to the end of that place.
      el.addEventListener("dragover", (e) => {
        const ids = getDraggingIds();
        if (!ids.length || !ids.every((id) => dropAllowed(state.nodes, id, { parentId: c.folderId }))) return;
        e.preventDefault();
        el.classList.add("drop-target");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drop-target");
        const ids = getDraggingIds();
        if (ids.length) run("tree:moveMany", { ids, parentId: c.folderId, index: null, panelId: view.panelId });
      });
      return [el, i < last ? h("span", { class: "crumb-sep", "aria-hidden": "true" }, "›") : null];
    });

    root.replaceChildren(up, h("nav", { class: "crumbs", "aria-label": "Folder path" }, items.flat()));
  }

  return { render };
}
