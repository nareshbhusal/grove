// Context menu. Items come either from the background ("ui:menu" hook, so any
// module can contribute) or from local arrays with onSelect callbacks.
//
// Background item kinds (besides plain { command, args }):
//   ui: "rename"   { args: {id}, current }          asks for a name, runs tree:rename
//   ui: "prompt"   { title, initial, field, command, args, withWindow }
//   ui: "confirm"  { message, okLabel, command, args }
//   ui: "bookmark" { args: { ids }, initial, count }  asks which bookmark folder, then saves there
//   submenu: "containers"
// Local item kinds: { label, onSelect, danger }, { separator }, { heading },
//   { swatches: [colours], current, onPick }

import { h, run, cmd } from "./client.js";
import { askText, askConfirm } from "./dialog.js";
import { pickBookmarkFolder } from "./bookmark-picker.js";

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
    if (item.ui === "bookmark") {
      return {
        ...item,
        onSelect: async () => {
          const pick = await pickBookmarkFolder({ title: item.count > 1 ? `Save ${item.count} items to…` : "Save to…", initial: item.initial });
          if (!pick) return;
          await run("bookmarks:save", withWindow({ ...item.args, parentId: pick.id }));
          if (pick.makeDefault) run("bookmarks:setDefault", { id: pick.id, stopAsking: true });
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

  // A click outside an open menu only closes it: the press, and the release and click that follow, never
  // reach what was under the pointer (as in every native menu). A right-click goes through, so it can open
  // the menu of whatever it landed on.
  let swallowing = false;
  document.addEventListener("mousedown", (e) => {
    if (root.hidden || root.contains(e.target)) return;
    hide();
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    swallowing = true;
  }, true);
  for (const type of ["mouseup", "click", "auxclick", "dblclick"]) {
    document.addEventListener(type, (e) => {
      if (!swallowing) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === "mouseup") setTimeout(() => { swallowing = false; }, 80); // the click follows the release at once
    }, true);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("blur", hide);

  return { show, hide, openForNode };
}
