// notes: plain-text files that live inside folders.
//
// A note is a tree node ({ type: "note", name }) so it drags, nests and exports
// like everything else; the rule that notes only exist inside folders is
// enforced by lib/tree.js. The text itself is NOT in the node map: it lives under
// its own storage key ("grove:note:<id>"), because every tree change is pushed
// to the sidebar and saved as a whole, and long texts would make that heavy.
//
// Commands:
//   note:create { folderId, name?, text? } -> id
//   note:get    { id } -> { id, name, text }
//   note:save   { id, text?, name? }
//   note:delete { id }
//
// Bodies of notes that disappear from the tree (deleted, folder deleted,
// import "replace") are removed on the tree:removed event, and any stragglers
// are swept at startup.

import { uid } from "../lib/util.js";

const PREFIX = "grove:note:";

export default {
  name: "notes",
  deps: ["tree"],

  async setup({ api, bus, commands, log, modules }) {
    const { tree } = modules;
    const storage = api.storage.local;
    const key = (id) => PREFIX + id;
    // Notes in the private space keep their text here, in memory, and nowhere else.
    const memory = new Map();
    const isPrivate = (id) => memory.has(id) || !!tree.get(id)?.private;

    async function getBody(id) {
      if (isPrivate(id)) return memory.get(id) ?? "";
      const res = await storage.get(key(id));
      return res?.[key(id)] ?? "";
    }

    async function setBody(id, text, { private: priv = isPrivate(id) } = {}) {
      if (priv) {
        memory.set(id, String(text ?? ""));
        return;
      }
      await storage.set({ [key(id)]: String(text ?? "") });
      bus.emit("notes:changed", { id }); // note texts are not in the store, so backups listen for this
    }

    // Bodies for a set of note ids, as { id: text } (used by export).
    async function bodies(ids) {
      if (!ids.length) return {};
      const stored = ids.filter((id) => !isPrivate(id));
      const res = stored.length ? await storage.get(stored.map(key)) : {};
      return Object.fromEntries(ids.map((id) => [id, isPrivate(id) ? memory.get(id) ?? "" : res?.[key(id)] ?? ""]));
    }

    async function dropBodies(ids) {
      for (const id of ids) memory.delete(id);
      if (ids.length) await storage.remove(ids.map(key));
    }

    // Sweep bodies whose note no longer exists.
    try {
      const all = (await storage.get(null)) ?? {};
      const stray = Object.keys(all)
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => k.slice(PREFIX.length))
        .filter((id) => tree.get(id)?.type !== "note");
      await dropBodies(stray);
      if (stray.length) log.info(`removed ${stray.length} orphaned note body(ies)`);
    } catch (err) {
      log.warn("note sweep failed", err);
    }

    bus.on("tree:removed", ({ ids }) => dropBodies(ids));

    commands.register("note:create", async ({ folderId, name = "Untitled note", text = "" }) => {
      const folder = tree.get(folderId);
      if (!folder || folder.type !== "folder") throw new Error("Notes can only be created inside a folder");
      const node = { id: uid("n"), type: "note", name: String(name).trim() || "Untitled note", panelId: folder.panelId, parentId: null, order: 0 };
      if (folder.private) node.private = true;
      await setBody(node.id, text, { private: !!node.private });
      const added = tree.add(node, { parentId: folder.id, index: null });
      if (!added) {
        await dropBodies([node.id]);
        throw new Error("Could not create the note here");
      }
      if (folder.collapsed) tree.mutate((all) => (all[folder.id].collapsed = false), "reveal");
      return node.id;
    }, { title: "New note" });

    commands.register("note:get", async ({ id }) => {
      const n = tree.get(id);
      if (!n || n.type !== "note") throw new Error("Note not found");
      return { id, name: n.name, text: await getBody(id) };
    });

    commands.register("note:save", async ({ id, text, name }) => {
      const n = tree.get(id);
      if (!n || n.type !== "note") throw new Error("Note not found");
      if (text !== undefined) await setBody(id, text);
      if (name !== undefined) await commands.run("tree:rename", { id, name });
      return true;
    });

    commands.register("note:delete", ({ id }) => {
      const n = tree.get(id);
      if (!n || n.type !== "note") return false;
      tree.removeMany([id]);
      return true;
    }, { title: "Delete note" });

    return { exports: { getBody, setBody, bodies } };
  },
};
