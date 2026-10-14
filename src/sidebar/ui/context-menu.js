// Context menu. Items come either from the background ("ui:menu" hook, so any
// module can contribute) or from local arrays with onSelect callbacks.
//
// Background item kinds (besides plain { command, args }):
//   ui: "rename"   { args: {id}, current }          asks for a name, runs tree:rename
//   ui: "prompt"   { title, initial, field, command, args, withWindow }
//   ui: "confirm"  { message, okLabel, command, args }
//   submenu: "containers"
// Local item kinds: { label, onSelect, danger }, { separator }, { heading },
//   { swatches: [colours], current, onPick }

import { h, run, cmd } from "./client.js";
import { askText, askConfirm } from "./dialog.js";

export function createContextMenu({ root, getContainers, getWindowId }) {
  function hide() {
    root.hidden = true;
    root.replaceChildren();
  }

  function show(e, items) {
    root.replaceChildren(
      ...items.map((it) => {
        if (it.separator) return h("hr");
        if (it.heading) return h("div", { class: "heading" }, it.heading);
        if (it.swatches) {
          return h(
            "div",
            { class: "swatches", role: "group", "aria-label": "Colour" },
            ...it.swatches.map((c) =>
              h("button", {
                class: `swatch${c === it.current ? " current" : ""}`,
                style: { background: c },
                title: c,
                "aria-label": c,
                onclick: () => {
                  hide();
                  it.onPick(c);
                },
              })
            )
          );
        }
        return h("button", { class: it.danger ? "danger" : "", onclick: () => { hide(); it.onSelect(); } }, it.label);
      })
    );
    root.hidden = false;
    const { innerWidth: w, innerHeight: ht } = window;
    const r = root.getBoundingClientRect();
    root.style.left = `${Math.max(4, Math.min(e.clientX, w - r.width - 4))}px`;
    root.style.top = `${Math.max(4, Math.min(e.clientY, ht - r.height - 4))}px`;
  }

  // Turn a background menu item into a local one.
  function localize(item, e) {
    if (item.separator || item.heading) return item;
    const withWindow = (args) => (item.withWindow ? { ...args, windowId: getWindowId() } : args);

    if (item.ui === "rename") {
      return {
        ...item,
        onSelect: async () => {
          const name = await askText("Rename", item.current ?? "");
          if (name) run("tree:rename", { id: item.args.id, name });
        },
      };
    }
    if (item.ui === "prompt") {
      return {
        ...item,
        onSelect: async () => {
          const value = await askText(item.title, item.initial ?? "");
          if (value) run(item.command, withWindow({ ...item.args, [item.field ?? "name"]: value }));
        },
      };
    }
    if (item.ui === "confirm") {
      return {
        ...item,
        onSelect: async () => {
          if (await askConfirm(item.message, item.okLabel ?? "OK")) run(item.command, withWindow(item.args));
        },
      };
    }
    if (item.submenu === "containers") {
      return {
        ...item,
        onSelect: () => {
          const list = getContainers().map((c) => ({
            label: c.name,
            onSelect: () => run("containers:reopen", { id: item.args.id, cookieStoreId: c.cookieStoreId }),
          }));
          show(e, [{ heading: "Reopen in container" }, ...list]);
        },
      };
    }
    return { ...item, onSelect: () => run(item.command, withWindow(item.args)) };
  }

  // `ids`: several selected rows (the menu then acts on all of them); `after`
  // runs once an item has been chosen (used to clear the selection).
  async function openForNode(e, id, ids = null, after = null) {
    let items = [];
    try {
      items = await cmd("ui:menu", { id, ids });
    } catch {
      return;
    }
    show(e, items.map((i) => {
      const local = localize(i, e);
      return after && local.onSelect ? { ...local, onSelect: () => { local.onSelect(); after(); } } : local;
    }));
  }

  document.addEventListener("mousedown", (e) => { if (!root.contains(e.target)) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("blur", hide);

  return { show, hide, openForNode };
}
