// bookmarks: a viewer and manager for Firefox's own bookmarks. There is no second copy: what
// you see is the real bookmark tree, so nothing can drift out of step, other bookmark tools and
// Firefox sync keep working, and an edit here is an edit there.
//
// What Grove adds on top:
//   - saving tabs: a tab becomes a bookmark, a tab with children or a folder becomes a bookmark
//     FOLDER with the same shape (a bookmark tree is a tree, so the hierarchy survives). You choose
//     the folder each time (a picker in the sidebar), or set one as the default and stop being asked.
//   - opening them: a bookmark opens a tab (or switches to the tab that already shows it); a folder opens as
//     a Grove folder of "saved" tabs that are NOT loaded until you click them, so a hundred bookmarks
//     cost nothing but rows.
//   - delete with undo, and the bookmarks go into exports and backups (and come back by import).
//
// Commands (the sidebar's bookmark view uses these):
//   bookmarks:tree     {}                                  -> { roots: [simple] }
//   bookmarks:save     { ids, parentId?, windowId? }       -> { saved, folders, duplicates, skipped, parentId }
//                      (no parentId: the default folder, else Other Bookmarks)
//   bookmarks:prefs    {}                                  -> { ask, defaultId, defaultTitle, lastId }
//   bookmarks:setDefault { id, stopAsking? }               id null clears it
//   bookmarks:open     { id, windowId, mode? }             mode "tab" (default) | "child" | "background"
//   bookmarks:openFolder { id, windowId, loaded? }         -> the Grove folder it made
//   bookmarks:create   { parentId, title, url?, index? }   -> id
//   bookmarks:update   { id, title?, url? }
//   bookmarks:move     { id, parentId, index? }            index is where it ends up among the new siblings
//   bookmarks:remove   { id }                              -> true; bookmarks:undo brings the last one back
//   bookmarks:undo     {}                                  -> true | false
// Events: bookmarks:changed
// Used by io.js: snapshot(), restore(snapshot)

import { uid, debounce } from "../lib/util.js";
import * as T from "../lib/tree.js";
import * as B from "../lib/bookmarks.js";

export default {
  name: "bookmarks",
  deps: ["tree", "windows", "tabs", "folders", "settings", "bridge"],

  async setup({ api, bus, commands, hooks, log, modules }) {
    const { tree, windows, tabs, settings, bridge } = modules;
    const native = () => {
      if (!api.bookmarks) throw new Error("Firefox did not give Grove access to bookmarks (the extension needs the bookmarks permission)");
      return api.bookmarks;
    };

    settings.register("bookmarks", {
      ask: { type: "boolean", label: "Ask which folder to save into each time (untick to use the default folder, which you set in that dialog)", default: true },
      reuse: { type: "boolean", label: "Opening a bookmark switches to the tab that already shows it, instead of opening another", default: true },
      backup: {
        type: "select",
        label: "Bookmarks in exports and backups",
        default: "all",
        options: [["all", "All bookmarks"], ["none", "None"]],
      },
    });
    const get = (k) => settings.get("bookmarks", k);

    // Where you last saved to, and the default folder: kept apart from settings (they are folder ids of this profile).
    const PREFS = "grove:bookmarks";
    let prefs = { defaultId: null, lastId: null };
    try { prefs = { ...prefs, ...((await api.storage.local.get(PREFS))?.[PREFS] ?? {}) }; } catch { /* first run */ }
    const savePrefs = () => api.storage.local.set({ [PREFS]: prefs }).catch((e) => log.warn("bookmark choices not saved", e));
    // A folder id that is still a real, writable folder (not the root, not a bookmark), else null.
    async function folderOk(id) {
      if (!id || id === B.ROOT) return null;
      const [n] = await api.bookmarks.get(id).catch(() => []);
      return n && n.type === "folder" ? n : null;
    }

    // ---- reading ---------------------------------------------------------

    async function roots() {
      const [top] = await native().getTree();
      return (top?.children ?? []).map(B.simplify);
    }

    commands.register("bookmarks:tree", async () => ({ roots: await roots() }), { title: "Bookmarks" });

    commands.register("bookmarks:prefs", async () => {
      const def = await folderOk(prefs.defaultId);
      const last = await folderOk(prefs.lastId);
      return { ask: !!get("ask") || !def, defaultId: def?.id ?? null, defaultTitle: def?.title ?? null, lastId: last?.id ?? null };
    });

    commands.register("bookmarks:setDefault", async ({ id = null, stopAsking = false }) => {
      prefs.defaultId = id && (await folderOk(id)) ? id : null;
      await savePrefs();
      if (stopAsking && prefs.defaultId) await commands.run("settings:set", { module: "bookmarks", key: "ask", value: false });
      return true;
    });

    // ---- writing ---------------------------------------------------------

    // Make `items` under `parentId`. With `merge`, a folder that is already there (same title) is
    // filled rather than doubled, and a page already in it is not added again: doing the same thing twice
    // changes nothing. Without it everything is made exactly as given (undo).
    async function make(parentId, items, { merge = true, index = null } = {}) {
      const count = { saved: 0, folders: 0, duplicates: 0 };
      const existing = merge ? await native().getChildren(parentId).catch(() => []) : [];
      let at = index;
      for (const item of items) {
        const opts = { parentId, title: item.title ?? "" };
        if (at != null) opts.index = at;
        if (item.type === "folder") {
          const same = merge ? existing.find((e) => e.type === "folder" && e.title === item.title) : null;
          let id = same?.id;
          if (!id) {
            id = (await native().create(opts)).id;
            count.folders++;
            if (at != null) at++;
          }
          const inner = await make(id, item.children ?? [], { merge });
          count.saved += inner.saved; count.folders += inner.folders; count.duplicates += inner.duplicates;
        } else if (item.url) {
          if (merge && existing.some((e) => e.url && B.samePage(e.url, item.url))) { count.duplicates++; continue; }
          try {
            await native().create({ ...opts, url: item.url });
            count.saved++;
            if (at != null) at++;
          } catch (err) {
            log.warn("could not bookmark", item.url, err);
          }
        }
      }
      return count;
    }

    commands.register("bookmarks:save", async ({ ids = [], parentId = null, windowId = null }) => {
      const { plan, skipped } = B.planFromTree(tree.all(), ids);
      // Where you chose, else the default folder, else Other Bookmarks. Nothing is ever made for you.
      const into = (await folderOk(parentId))?.id ?? (await folderOk(prefs.defaultId))?.id ?? B.OTHER;
      if (!plan.length || !into) {
        const out = { saved: 0, folders: 0, duplicates: 0, skipped: skipped.notes + skipped.pages, parentId: into };
        notify(windowId, skipped.notes && !skipped.pages ? "Notes are not saved to bookmarks (they stay in their folder)" : "Nothing here to bookmark");
        return out;
      }
      // Several things at once keep together, in a folder named for the moment, easy to rename or move.
      const wrapped = plan.length > 1 ? [{ type: "folder", title: `Saved ${stamp()}`, children: plan }] : plan;
      const c = await make(into, wrapped);
      if (parentId && prefs.lastId !== into) { prefs.lastId = into; savePrefs(); }
      const out = { ...c, skipped: skipped.notes + skipped.pages, parentId: into };
      notify(windowId, summary(out, await nameOf(into)));
      return out;
    }, { title: "Bookmark" });

    const stamp = (d = new Date()) => {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const nameOf = async (id) => (await native().get(id).catch(() => [null]))?.[0]?.title || "bookmarks";
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    function summary({ saved, folders, duplicates, skipped }, where) {
      const parts = [];
      if (saved) parts.push(`${plural(saved, "bookmark")} saved to “${where}”`);
      else if (duplicates) parts.push(`Already bookmarked in “${where}”`);
      if (saved && duplicates) parts.push(`${duplicates} already there`);
      if (skipped) parts.push(`${plural(skipped, "item")} left out (new tabs, notes)`);
      return parts.join(" · ") || "Nothing to bookmark";
    }
    const notify = (windowId, text) => { if (windowId != null) bridge.notify(windowId, text); };

    commands.register("bookmarks:create", async ({ parentId, title, url = null, index = null }) => {
      const props = { parentId, title: String(title ?? "") };
      if (url) props.url = url;
      if (index != null) props.index = index;
      return (await native().create(props)).id;
    }, { title: "New bookmark" });

    commands.register("bookmarks:update", async ({ id, title, url }) => {
      const changes = {};
      if (title !== undefined) changes.title = String(title);
      if (url !== undefined) changes.url = String(url);
      await native().update(id, changes);
      return true;
    }, { title: "Edit bookmark" });

    commands.register("bookmarks:move", async ({ id, parentId, index }) => {
      const dest = {};
      if (parentId != null) dest.parentId = parentId;
      if (index != null) dest.index = index;
      await native().move(id, dest);
      return true;
    }, { title: "Move bookmark" });

    // Deleting a folder takes everything in it: keep what went so it can come back.
    let removed = null;
    commands.register("bookmarks:remove", async ({ id }) => {
      const [node] = await native().getSubTree(id);
      if (!node || !node.parentId || node.parentId === B.ROOT) return false; // a built-in folder cannot go
      removed = { parentId: node.parentId, index: node.index, item: B.toSnapshotItems([B.simplify(node)])[0], title: node.title };
      if (node.type === "folder") await native().removeTree(id);
      else await native().remove(id);
      return true;
    }, { title: "Delete bookmark" });

    commands.register("bookmarks:undo", async () => {
      if (!removed?.item) return false;
      const { parentId, index, item } = removed;
      removed = null;
      try {
        await make(parentId, [item], { merge: false, index });
      } catch {
        await make(B.OTHER, [item], { merge: false }); // its folder is gone too
      }
      return true;
    }, { title: "Undo delete" });

    // ---- opening ---------------------------------------------------------

    const view = (windowId) => windows.getView(windowId);

    commands.register("bookmarks:open", async ({ id, windowId, mode = "tab" }) => {
      const [bm] = await native().get(id);
      if (!bm?.url) return false;
      if (mode === "tab" && get("reuse")) {
        const mine = T.visibleTo(tree.all(), windows.isPrivate(windowId));
        const live = Object.values(mine).find((n) => n.type === "tab" && tabs.tabIdOf(n.id) != null && B.samePage(n.url, bm.url));
        if (live) return commands.run("tab:activate", { id: live.id, windowId });
      }
      const props = { windowId, url: bm.url, panelId: view(windowId).panelId, active: mode !== "background" };
      if (mode === "child") props.relation = "child";
      return commands.run("tab:new", props);
    }, { title: "Open bookmark" });

    // A bookmark folder as a Grove folder of saved tabs (not loaded: clicking one opens it), kept in the
    // folder shape of the bookmarks.
    commands.register("bookmarks:openFolder", async ({ id, windowId, loaded = false }) => {
      const [node] = await native().getSubTree(id);
      if (!node || node.type !== "folder") return null;
      const toForest = (n) => (n.children ?? []).filter((c) => c.type !== "separator").flatMap((c) =>
        c.type === "folder"
          ? [{ type: "folder", name: c.title || "Folder", collapsed: false, children: toForest(c) }]
          : c.url ? [{ type: "tab", url: c.url, title: c.title || c.url, saved: true, children: [] }] : []);
      const v = view(windowId);
      const panelId = v.panelId;
      const forest = [{ type: "folder", name: node.title || "Bookmarks", collapsed: false, children: toForest(node) }];
      const priv = windows.isPrivatePanel(panelId);
      let rootId = null;
      tree.mutate((all) => {
        const start = T.childrenOf(all, null, panelId).length;
        const fresh = T.fromNested(forest, panelId, () => uid("t"));
        for (const n of Object.values(fresh)) {
          if (n.parentId === null) { n.order += start; rootId = n.id; }
          if (priv) n.private = true; // opened in a private window: it stays in memory
          all[n.id] = n;
        }
        T.normalize(all);
      }, "bookmarks-open");
      // Into the folder you have open, if you have one.
      if (rootId && v.folderId) await tree.move({ id: rootId, parentId: v.folderId, index: null });
      if (loaded && rootId) {
        const urls = T.descendantsOf(tree.all(), rootId).map((d) => tree.get(d)).filter((n) => n?.type === "tab");
        for (const n of urls) await commands.run("tab:open", { id: n.id, windowId, active: false });
      }
      return rootId;
    }, { title: "Open bookmark folder" });

    // ---- backups ---------------------------------------------------------

    // What goes into an export: { scope, roots: [{ root, title, children }] }, or null.
    async function snapshot() {
      const scope = get("backup");
      if (scope === "none" || !api.bookmarks) return null;
      try {
        const list = await roots();
        return { scope: "all", roots: list.map((r) => ({ root: r.id, title: r.title, children: B.toSnapshotItems(r.children) })) };
      } catch (err) {
        log.warn("bookmarks left out of the export", err);
        return null;
      }
    }

    // Put an export's bookmarks back. Nothing is removed or replaced: folders that are there are
    // filled in, pages already in them are skipped, so importing twice changes nothing.
    async function restore(data) {
      const out = { saved: 0, folders: 0, duplicates: 0 };
      if (!data || !Array.isArray(data.roots) || !api.bookmarks) return out;
      for (const r of data.roots) {
        const items = B.cleanSnapshotItems(r?.children);
        if (!items.length) continue;
        const home = await native().get(String(r.root ?? "")).then((x) => x?.[0]?.id, () => null);
        const c = await make(home ?? B.OTHER, items);
        out.saved += c.saved; out.folders += c.folders; out.duplicates += c.duplicates;
      }
      return out;
    }

    // ---- change notices --------------------------------------------------

    const changed = debounce(() => bus.emit("bookmarks:changed", {}), 100);
    const listen = [];
    for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved"]) {
      const target = api.bookmarks?.[ev];
      if (target) { target.addListener(changed); listen.push(target); }
    }

    // ---- menus -----------------------------------------------------------

    const few = (n) => (n === 1 ? "" : `s`);
    // The save entries for a menu: one that asks where (a picker), or, once a default is set and asking is off,
    // one that saves straight there and one that asks.
    async function saveItems(id, what, ids) {
      const def = await folderOk(prefs.defaultId);
      const last = await folderOk(prefs.lastId);
      const initial = def?.id ?? last?.id ?? B.OTHER;
      const asks = { id: `${id}-pick`, ui: "bookmark", args: { ids }, initial, count: ids.length, withWindow: true };
      if (get("ask") || !def) return [{ ...asks, label: `${what}…` }];
      return [
        { id, label: `${what} to “${def.title || "Untitled"}”`, command: "bookmarks:save", args: { ids, parentId: def.id }, withWindow: true },
        { ...asks, label: `${what} to…` },
      ];
    }
    const placed = (items, entries, beforeId) => {
      const at = items.findIndex((i) => i.id === beforeId);
      return at < 0 ? [...items, ...entries] : [...items.slice(0, at), ...entries, ...items.slice(at)];
    };

    hooks.tap("ui:menu", async (items, { node, selection }) => {
      if (!api.bookmarks) return items;
      const all = tree.all();
      if (selection) {
        const picked = selection.filter((i) => all[i] && all[i].type !== "note");
        if (!picked.length) return items;
        return placed(items, await saveItems("bm-save-sel", `Bookmark ${picked.length} item${few(picked.length)}`, selection), "sel-sep2");
      }
      if (!node || node.type === "note") return items;
      const below = T.descendantsOf(all, node.id).length;
      const what = node.type === "folder" ? "Save folder to bookmarks" : below ? "Bookmark tab and children" : "Bookmark tab";
      // Next to the other things you do with a tab, before the separator that leads to closing it.
      return placed(items, await saveItems("bm-save", what, [node.id]), "sep3");
    }, { priority: 60 });

    return {
      exports: { snapshot, restore, make, roots },
      teardown() {
        changed.cancel();
        for (const t of listen) t.removeListener?.(changed);
      },
    };
  },
};
