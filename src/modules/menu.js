// menu: the default context-menu items for tree rows. This is also the
// reference example of extending the UI from a module: tap the "ui:menu" hook.
//
// Item shapes understood by the sidebar (see sidebar/ui/context-menu.js):
//   { id, label, command, args?, danger?, withWindow? }
//   { id, label, ui: "rename" | "prompt" | "confirm", ... }
//   { id, separator: true }

import * as T from "../lib/tree.js";

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export default {
  name: "menu",
  deps: ["bridge", "tabs", "folders", "notes", "containers", "panels"],

  setup({ hooks, store, modules }) {
    const { tree, tabs } = modules;

    // Menu for several selected rows. Unload and load reach everything beneath
    // the selected rows (a folder means its tabs); close touches only the selected tabs.
    function bulkItems(items, selection) {
      const all = tree.all();
      const sel = selection.map((i) => all[i]).filter(Boolean);
      const out = [...items];
      const live = tabs.liveTabsUnder(selection, true).map((i) => all[i]);
      const awake = live.filter((n) => !n.discarded).length;
      const asleep = live.filter((n) => n.discarded).length;
      const tabNodes = sel.filter((n) => n.type === "tab");
      const set = new Set(selection);
      // Rows whose ancestor is also selected come along with that ancestor.
      const top = selection.filter((i) => { for (let p = all[i]?.parentId; p; p = all[p]?.parentId) if (set.has(p)) return false; return true; });
      const hasNote = sel.some((n) => n.type === "note");

      out.push({ id: "sel-head", heading: `${plural(sel.length, "item")} selected` });
      if (awake) out.push({ id: "sel-unload", label: `Unload ${plural(awake, "tab")}`, command: "tabs:unload", args: { ids: selection, deep: true } });
      if (asleep) out.push({ id: "sel-load", label: `Load ${plural(asleep, "tab")}`, command: "tabs:load", args: { ids: selection, deep: true } });
      if (sel.some((n) => n.type === "tab" && n.parentId && all[n.parentId]?.type === "tab")) out.push({ id: "sel-outdent", label: "Move out one level", command: "tab:outdent", args: { ids: selection } });
      out.push({ id: "sel-folder", label: "Move into new folder…", ui: "prompt", title: "Folder name", initial: "New folder", command: "folder:create", args: { nodeIds: top }, withWindow: true });
      if (!hasNote) {
        const others = store.get("panels").filter((p) => !!p.private === !!sel[0]?.private && sel.some((n) => n.panelId !== p.id));
        if (others.length) out.push({ id: "sel-sep1", separator: true });
        for (const p of others) {
          out.push({ id: `sel-to-${p.id}`, label: `Move to “${p.name}”`, command: "tree:moveMany", args: { ids: top, parentId: null, panelId: p.id } });
        }
      }
      if (tabNodes.length) {
        out.push({ id: "sel-sep2", separator: true });
        out.push({ id: "sel-close", label: `Close ${plural(tabNodes.length, "tab")}`, command: "tab:closeMany", args: { ids: tabNodes.map((n) => n.id) }, danger: true });
      }
      return out;
    }

    hooks.tap(
      "ui:menu",
      (items, { node, selection }) => {
        if (selection) return bulkItems(items, selection);
        if (!node) return items;
        const id = node.id;
        const all = tree.all();
        const out = [...items];
        const below = T.descendantsOf(all, id).map((d) => all[d]);
        const noteCount = below.filter((n) => n.type === "note").length;
        const tabCount = below.filter((n) => n.type === "tab" && n.tabId != null).length;
        const parentIsTab = node.parentId !== null && all[node.parentId]?.type === "tab";
        const parentIsFolder = node.parentId !== null && all[node.parentId]?.type === "folder";

        if (node.type === "tab") {
          out.push({ id: "new-child", label: "New child tab", command: "tab:new", args: { parentId: id } });
          if (parentIsTab) out.push({ id: "outdent", label: "Move out one level", command: "tab:outdent", args: { id } });
          out.push({ id: "group", label: "Move into new folder…", ui: "prompt", title: "Folder name", initial: "New folder", command: "folder:create", args: { nodeIds: [id] }, withWindow: true });
          if (tabs.tabIdOf(id) != null) {
            out.push({ id: "mute", label: node.muted ? "Unmute tab" : "Mute tab", command: "tab:mute", args: { id } });
            out.push(node.discarded
              ? { id: "load", label: "Load tab", command: "tab:load", args: { id } }
              : { id: "unload", label: "Unload tab", command: "tab:unload", args: { id } });
            // A tab with children: act on the whole branch.
            if (below.length) {
              const branch = tabs.liveTabsUnder([id], true).map((i) => all[i]);
              const awake = branch.filter((n) => !n.discarded).length;
              const asleep = branch.filter((n) => n.discarded).length;
              if (awake > 1 || (awake === 1 && node.discarded)) out.push({ id: "unload-branch", label: `Unload tab and children (${awake})`, command: "tabs:unload", args: { ids: [id], deep: true } });
              if (asleep > 1 || (asleep === 1 && !node.discarded)) out.push({ id: "load-branch", label: `Load tab and children (${asleep})`, command: "tabs:load", args: { ids: [id], deep: true } });
            }
            out.push({ id: "reopen", label: "Reopen in container…", submenu: "containers", args: { id } });
          }
          out.push({ id: "rename", label: "Rename…", ui: "rename", args: { id }, current: node.customTitle || node.title || "" });
        } else if (node.type === "folder") {
          out.push({ id: "open", label: "Open folder", command: "folder:enter", args: { id }, withWindow: true });
          out.push({ id: "new-tab-in", label: "New tab here", command: "tab:new", args: { parentId: id } });
          out.push({ id: "new-note", label: "New note…", ui: "prompt", title: "Note title", initial: "Untitled note", command: "note:create", args: { folderId: id } });
          out.push({ id: "new-folder", label: "New subfolder…", ui: "prompt", title: "Folder name", initial: "New folder", command: "folder:create", args: { parentId: id } });
          const inside = tabs.liveTabsUnder([id], true).map((i) => all[i]);
          const awake = inside.filter((n) => !n.discarded).length;
          const asleep = inside.filter((n) => n.discarded).length;
          if (awake) out.push({ id: "unload-inside", label: `Unload all tabs inside (${awake})`, command: "tabs:unload", args: { ids: [id], deep: true } });
          if (asleep) out.push({ id: "load-inside", label: `Load all tabs inside (${asleep})`, command: "tabs:load", args: { ids: [id], deep: true } });
          if (!node.private) out.push({ id: "folder-containers", label: "Containers for this folder…", ui: "folderContainers", args: { id } });
          out.push({ id: "rename", label: "Rename…", ui: "rename", args: { id }, current: node.name || "" });
        } else {
          out.push({ id: "rename", label: "Rename…", ui: "rename", args: { id }, current: node.name || "" });
        }

        if (all[id] && Object.values(all).some((n) => n.parentId === id) && node.type !== "note") {
          out.push({ id: "sep1", separator: true });
          out.push({ id: "toggle", label: node.collapsed ? "Expand" : "Collapse", command: "tree:toggle", args: { id } });
        }

        // Send to another panel (a note cannot leave its folder).
        if (node.type !== "note") {
          const others = store.get("panels").filter((p) => p.id !== node.panelId && !!p.private === !!node.private);
          if (others.length) out.push({ id: "sep2", separator: true });
          for (const p of others) {
            out.push({ id: `to-${p.id}`, label: `Move to “${p.name}”`, command: "tree:move", args: { id, parentId: null, panelId: p.id } });
          }
        }

        out.push({ id: "sep3", separator: true });
        if (node.type === "tab") {
          out.push({ id: "close", label: "Close tab", command: "tab:close", args: { id, mode: "self" }, danger: true });
          if (below.length) out.push({ id: "close-tree", label: "Close tab and children", command: "tab:close", args: { id, mode: "subtree" }, danger: true });
        } else if (node.type === "folder") {
          // Ungrouping would strand notes at the top level, so it is only offered when it is possible.
          if (!noteCount || parentIsFolder) {
            out.push({ id: "ungroup", label: "Ungroup (keep contents)", command: "folder:ungroup", args: { id }, danger: true });
          }
          const what = [tabCount && `close ${plural(tabCount, "tab")}`, noteCount && `delete ${plural(noteCount, "note")}`].filter(Boolean).join(" and ");
          out.push({
            id: "delete-all",
            label: "Delete folder and contents…",
            ui: "confirm",
            message: `Delete “${node.name || "Folder"}” and everything inside it${what ? ` (${what})` : ""}?`,
            okLabel: "Delete",
            command: "folder:delete",
            args: { id, contents: true },
            danger: true,
          });
        } else {
          out.push({ id: "delete-note", label: "Delete note…", ui: "confirm", message: `Delete “${node.name || "Untitled note"}”? This cannot be undone.`, okLabel: "Delete", command: "note:delete", args: { id }, danger: true });
        }
        return out;
      },
      { priority: 50 }
    );

    return {};
  },
};
