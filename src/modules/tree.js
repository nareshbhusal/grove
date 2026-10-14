// tree: owns the node map (tabs, folders and notes arranged in a tree) and the
// commands that only touch that data. It knows nothing about browser tabs;
// the `tabs` module keeps the two in sync.
//
// Containment rules live in lib/tree.js (canContain): folders hold folders,
// tabs and notes; tabs hold only tabs; notes are leaves inside folders.
//
// Hooks:
//   tree:move  (move, ctx) -> move | null     modify or veto a move
// Events:
//   tree:changed { reason }
//   tree:removed { ids }
//   node:panelChanged { id, from, to }

import * as T from "../lib/tree.js";

export default {
  name: "tree",

  setup({ bus, hooks, commands, store, log }) {
    store.defaults("tree", { nodes: {} });
    // Private tabs are kept in memory only.
    store.persistFilter("tree", (tree) => ({ ...tree, nodes: T.withoutPrivate(tree.nodes) }));
    const isPrivatePanel = (id) => !!store.get("panels")?.find((p) => p.id === id)?.private;

    const nodes = () => store.get("tree").nodes;

    // Data from older versions (or a crash) may break today's rules: repair it.
    const repaired = T.normalize(nodes());
    if (repaired) {
      log.info(`repaired ${repaired} node(s)`);
      store.set("tree", store.get("tree"), { silent: true });
    }

    function mutate(fn, reason = "mutate") {
      const result = fn(nodes());
      store.set("tree", store.get("tree"), { silent: true });
      bus.emit("tree:changed", { reason });
      return result;
    }

    async function move({ id, parentId = null, index = null, panelId = null }) {
      const n = nodes()[id];
      if (!n) return false;
      const from = n.panelId;
      const wanted = await hooks.run("tree:move", { id, parentId, index, panelId }, { nodes: nodes() });
      if (!wanted) return false;
      // Private and normal things never mix: not in a panel, not in a folder.
      const dest = wanted.parentId ? nodes()[wanted.parentId]?.panelId : wanted.panelId ?? n.panelId;
      if (dest && !!n.private !== isPrivatePanel(dest)) return false;
      const ok = mutate((all) => T.moveNode(all, id, wanted), "move");
      if (ok && nodes()[id].panelId !== from) {
        await bus.emit("node:panelChanged", { id, from, to: nodes()[id].panelId });
      }
      return ok;
    }

    function remove(id, opts) {
      const removed = mutate((all) => T.removeNode(all, id, opts), "remove");
      if (removed.length) bus.emit("tree:removed", { ids: removed });
      return removed;
    }

    // Delete exactly these nodes (callers pass a whole subtree). Siblings are renumbered.
    function removeMany(ids) {
      const gone = [];
      mutate((all) => {
        const lists = new Map();
        for (const id of ids) {
          const n = all[id];
          if (!n) continue;
          lists.set(`${n.parentId}|${n.panelId}`, [n.parentId, n.panelId]);
          delete all[id];
          gone.push(id);
        }
        for (const [parentId, panelId] of lists.values()) {
          if (parentId !== null && !all[parentId]) continue;
          T.childrenOf(all, parentId, panelId).forEach((n, i) => (n.order = i));
        }
      }, "remove");
      if (gone.length) bus.emit("tree:removed", { ids: gone });
      return gone;
    }

    commands.register("tree:move", move, { title: "Move node" });

    // Move several nodes to one place, keeping the order you give. The first goes
    // to the spot; each next one lands right after the one before it. A node whose
    // ancestor is also in the list travels with that ancestor, and nodes that may
    // not go there (a note at the top level, a folder into itself) are skipped.
    commands.register("tree:moveMany", async ({ ids = [], parentId = null, index = null, panelId = null }) => {
      const set = new Set(ids);
      const top = ids.filter((id, i) => {
        const n = nodes()[id];
        if (!n || ids.indexOf(id) !== i) return false;
        for (let p = n.parentId; p; p = nodes()[p]?.parentId) if (set.has(p)) return false;
        return true;
      });
      let prev = null;
      let moved = 0;
      for (const id of top) {
        const before = prev ? nodes()[prev] : null;
        const spot = before
          ? { id, parentId: before.parentId, index: T.indexAmongSiblings(nodes(), before.id) + 1, panelId: before.panelId }
          : { id, parentId, index, panelId };
        if (await move(spot)) {
          prev = id;
          moved++;
        }
      }
      return moved;
    }, { title: "Move nodes" });

    commands.register("tree:toggle", ({ id, value }) =>
      mutate((all) => T.setCollapsed(all, id, value), "collapse"));

    commands.register("tree:collapseAll", ({ panelId }) =>
      mutate((all) => T.setAllCollapsed(all, panelId, true), "collapse"), { title: "Collapse all" });

    commands.register("tree:expandAll", ({ panelId }) =>
      mutate((all) => T.setAllCollapsed(all, panelId, false), "collapse"), { title: "Expand all" });

    commands.register("tree:rename", ({ id, name }) =>
      mutate((all) => {
        const n = all[id];
        if (!n) return false;
        const clean = String(name ?? "").trim();
        if (n.type === "folder") n.name = clean || "Folder";
        else if (n.type === "note") n.name = clean || "Untitled note";
        else n.customTitle = clean || null;
        return true;
      }, "rename"));

    log.debug("ready");

    return {
      exports: {
        all: nodes,
        get: (id) => nodes()[id],
        mutate,
        move,
        add: (node, pos) => mutate((all) => T.addNode(all, node, pos), "add"),
        remove,
        removeMany,
        rows: (panelId, rootId = null) => T.flatten(nodes(), panelId, rootId),
      },
    };
  },
};
