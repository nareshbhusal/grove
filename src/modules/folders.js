// folders: named, collapsible groups. A folder is a node with type "folder", so
// it nests, drags and collapses like anything else. Folders may hold folders,
// tabs and notes. Clicking a folder in the sidebar opens it as a context (the
// sidebar shows its contents and tabs outside it are hidden, like switching panel).
//
// Commands:
//   folder:create { name, panelId, parentId, index, nodeIds, windowId }
//       nodeIds are moved into the new folder (grouping tabs).
//       With no parentId it is created inside the folder open in `windowId`.
//   folder:enter  { windowId, id }     open a folder as the current context
//   folder:up     { windowId }         one level up (or the panel's top level)
//   folder:ungroup { id }              contents move up, folder is removed
//   folder:delete  { id, contents }    contents: remove everything inside too

import { uid } from "../lib/util.js";
import * as T from "../lib/tree.js";

const NOTES_BLOCK =
  "This folder holds notes. Move them into another folder first, or delete the folder together with its contents.";

export default {
  name: "folders",
  deps: ["tree", "tabs", "windows"],

  setup({ bus, commands, modules }) {
    const { tree, windows } = modules;

    commands.register("folder:create", async ({ name = "New folder", panelId = null, parentId = null, index = null, nodeIds = [], windowId = null }) => {
      const all = tree.all();
      const first = nodeIds.map((i) => all[i]).find(Boolean);
      const view = windowId != null ? windows.getView(windowId) : null;

      let pid = parentId;
      let at = index;
      if (first && pid === null && at === null) {
        // Group in place: the folder takes the first selected node's position.
        pid = first.parentId;
        at = T.indexAmongSiblings(all, first.id);
      } else if (!first && pid === null && view) {
        pid = view.folderId; // created while a folder is open: inside it
      }

      const spot = T.validSpot(all, pid, at, { type: "folder" });
      if (!spot) return null;
      const targetPanel = spot.parent?.panelId ?? first?.panelId ?? panelId ?? view?.panelId ?? null;
      if (!targetPanel) return null;

      const folder = { id: uid("f"), type: "folder", name, panelId: targetPanel, parentId: null, order: 0, collapsed: false };
      if (windows.isPrivatePanel(targetPanel)) folder.private = true; // lives in the private space: memory only
      tree.add(folder, { parentId: spot.parent ? spot.parent.id : null, index: spot.index });
      for (const id of nodeIds) {
        if (id !== folder.id) await tree.move({ id, parentId: folder.id });
      }
      await bus.emit("folder:created", { id: folder.id });
      return folder.id;
    }, { title: "New folder" });

    commands.register("folder:enter", async ({ windowId, id }) => {
      const n = tree.get(id);
      if (!n || n.type !== "folder") return false;
      return windows.setView(windowId, { panelId: n.panelId, folderId: id });
    }, { title: "Open folder" });

    commands.register("folder:up", async ({ windowId }) => {
      const view = windows.getView(windowId);
      const f = view.folderId ? tree.get(view.folderId) : null;
      if (!f) return false;
      const parent = f.parentId ? tree.get(f.parentId) : null;
      return windows.setView(windowId, { panelId: f.panelId, folderId: parent?.type === "folder" ? parent.id : null });
    }, { title: "Up one level" });

    function ungroup(id) {
      const n = tree.get(id);
      if (!n || n.type !== "folder") return false;
      const removed = tree.remove(id, { mode: "promote" });
      if (!removed.length) throw new Error(NOTES_BLOCK);
      return true;
    }

    commands.register("folder:ungroup", ({ id }) => ungroup(id), { title: "Ungroup folder" });

    commands.register("folder:delete", async ({ id, contents = false, closeTabs = false }) => {
      const n = tree.get(id);
      if (!n || n.type !== "folder") return false;
      if (contents || closeTabs) return commands.run("tab:close", { id, mode: "subtree" });
      return ungroup(id);
    }, { title: "Delete folder" });

    return {};
  },
};
