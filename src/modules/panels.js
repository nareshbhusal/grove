// panels: separate contexts ("Interests", "Work", ...) that behave like fast,
// lightweight windows. A window's *view* (panel, and optionally an open folder
// inside it; see windows.js) decides which tabs are visible: everything outside
// the view is hidden with tabs.hide, everything inside is shown.
//
// The panel list lives in store key "panels" (defaults registered by `windows`).
// Events: panel:changed { reason }  panel:deleted { id }

import { uid } from "../lib/util.js";
import * as T from "../lib/tree.js";

export default {
  name: "panels",
  deps: ["tree", "tabs", "windows"],

  setup({ api, bus, commands, store, log, modules }) {
    const { tree, tabs, windows } = modules;

    const list = () => store.get("panels");
    const find = (id) => list().find((p) => p.id === id);
    const listFor = (priv) => list().filter((p) => !!p.private === !!priv);

    function save(next, reason) {
      store.set("panels", next);
      bus.emit("panel:changed", { reason });
    }

    // ---- visibility ------------------------------------------------------

    const locks = new Map(); // windowId -> promise chain
    function applyVisibility(windowId) {
      const prev = locks.get(windowId) ?? Promise.resolve();
      const next = prev.then(() => doApply(windowId)).catch((err) => log.error("visibility failed", err));
      locks.set(windowId, next);
      return next;
    }

    async function doApply(windowId) {
      const view = windows.getView(windowId);
      const nodes = tree.all();
      let all;
      try {
        all = await api.tabs.query({ windowId });
      } catch {
        return; // window is gone
      }
      const show = [];
      const hide = [];
      for (const tab of all) {
        if (tab.pinned) continue;
        const nodeId = tabs.nodeIdOf(tab.id);
        const node = nodeId ? nodes[nodeId] : null;
        if (!node) continue;
        (T.inView(nodes, node, view) ? show : hide).push(tab);
      }

      if (show.length) await api.tabs.show(show.map((t) => t.id));

      const active = all.find((t) => t.active);
      const activeVisible = active && (active.pinned || show.some((t) => t.id === active.id));
      if (!activeVisible) {
        const remembered = tabs.lastActiveTab(windowId, view.panelId);
        const target = show.find((t) => t.id === remembered) ?? show[show.length - 1];
        if (target) {
          await api.tabs.update(target.id, { active: true });
        } else if (hide.length || all.length) {
          // Nothing to show here (an empty panel or folder): open a fresh tab in
          // it so there is something to look at. Firefox needs a visible tab.
          await commands.run("tab:new", { windowId, panelId: view.panelId, parentId: view.folderId, relation: "end" });
        }
      }

      // The active tab now belongs to the view, so everything in `hide` can go.
      if (hide.length) await api.tabs.hide(hide.map((t) => t.id)).catch((err) => log.warn("hide failed", err));
    }

    async function applyAll() {
      for (const id of windows.windowIds()) await applyVisibility(id);
    }

    bus.on("window:viewChanged", ({ windowId }) => applyVisibility(windowId));
    bus.on("node:panelChanged", () => applyAll());
    bus.on("panel:deleted", () => applyAll());
    bus.on("tab:attached", async ({ tabId }) => {
      const t = await api.tabs.get(tabId).catch(() => null);
      if (t) applyVisibility(t.windowId);
    });
    bus.on("tab:created", async ({ tab, nodeId }) => {
      const node = tree.get(nodeId);
      if (!node || tab.pinned) return;
      const view = windows.getView(tab.windowId);
      if (!T.inView(tree.all(), node, view) && !tab.active) {
        await api.tabs.hide(tab.id).catch(() => {});
      }
    });

    // ---- commands --------------------------------------------------------

    // A panel made from a private window is private: in memory, and only that kind of window sees it.
    commands.register("panel:create", ({ name = "New panel", color = "#8a8a8a", icon = null, windowId = null } = {}) => {
      const panel = { id: uid("p"), name, color, icon, defaultContainer: null };
      if (windowId != null && windows.isPrivate(windowId)) panel.private = true;
      save([...list(), panel], "create");
      return panel.id;
    });

    commands.register("panel:update", ({ id, ...fields }) => {
      const allowed = ["name", "color", "icon", "defaultContainer"];
      const next = list().map((p) => {
        if (p.id !== id) return p;
        const patch = {};
        for (const k of allowed) if (k in fields) patch[k] = fields[k];
        return { ...p, ...patch };
      });
      save(next, "update");
      return true;
    });

    commands.register("panel:reorder", ({ ids }) => {
      const byId = new Map(list().map((p) => [p.id, p]));
      const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
      for (const p of list()) if (!ordered.includes(p)) ordered.push(p);
      save(ordered, "reorder");
      return true;
    });

    commands.register("panel:delete", async ({ id, moveTo = null }) => {
      const doomed = find(id);
      if (!doomed) return false;
      // Only panels of the same kind can take its tabs, and the last one of a kind stays.
      const sameKind = listFor(doomed.private).filter((p) => p.id !== id);
      if (sameKind.length === 0) return false;
      const remaining = list().filter((p) => p.id !== id);
      const target = sameKind.find((p) => p.id === moveTo) ?? sameKind[0];
      tree.mutate((nodes) => {
        for (const root of T.childrenOf(nodes, null, id)) {
          T.moveNode(nodes, root.id, { parentId: null, panelId: target.id });
        }
      }, "panel-delete");
      save(remaining, "delete");
      // A rule limited to this panel loses it; a rule that was only for this panel goes too.
      store.update("rules", (rules) => {
        if (!Array.isArray(rules)) return rules;
        return rules.filter((r) => {
          const list = Array.isArray(r.panelIds) ? r.panelIds : r.panelId ? [r.panelId] : [];
          if (!list.includes(id)) return true;
          r.panelIds = list.filter((p) => p !== id);
          delete r.panelId;
          return r.panelIds.length > 0;
        });
      });
      await bus.emit("panel:deleted", { id });
      return true;
    });

    commands.register("panel:switch", ({ windowId, panelId }) => windows.setActive(windowId, panelId));

    // Open a folder (or go back to the top of the panel with folderId: null).
    commands.register("view:set", ({ windowId, panelId, folderId = null }) =>
      windows.setView(windowId, { panelId: panelId ?? windows.getActive(windowId), folderId }));

    const step = (dir) => async ({ windowId }) => {
      const ids = listFor(windows.isPrivate(windowId)).map((p) => p.id);
      const at = ids.indexOf(windows.getActive(windowId));
      const next = ids[(at + dir + ids.length) % ids.length];
      return windows.setActive(windowId, next);
    };
    commands.register("panel:next", step(1), { title: "Next panel" });
    commands.register("panel:prev", step(-1), { title: "Previous panel" });

    // The private space ends with the last private window: its panels, folders and notes go.
    // (Its tabs left one by one as they closed.)
    bus.on("window:closed", ({ private: wasPrivate, privateLeft }) => {
      if (!wasPrivate || privateLeft > 0) return;
      const ids = Object.values(tree.all()).filter((n) => n.private).map((n) => n.id);
      if (ids.length) tree.removeMany(ids);
      if (list().some((p) => p.private)) save(list().filter((p) => !p.private), "private-ended");
    });

    // Make the browser agree with the model on startup.
    applyAll();

    return { exports: { list, listFor, find, applyVisibility, applyAll } };
  },
};
