// tabs: keeps the node tree in sync with real browser tabs.
//
// Each tab node is stamped onto its tab with sessions.setTabValue, so after a
// restart or session restore the tree structure is matched back up exactly.
// Tabs that disappear without their window closing remove their node; tabs
// that vanish with a closing window become "ghost" nodes that can be rebound
// (session restore) or reopened from the sidebar.
//
// WHERE A NEW TAB GOES
//   Tree position means "where did this come from", so:
//   - opened from a link in a tab  -> child of that tab (appended, so children
//                                     read in the order you opened them)
//   - opened by you (Ctrl+T, +)    -> sibling of the current tab, placed after
//                                     the current tab's whole subtree
//   Whether a tab came from a link is decided from two independent signals:
//   tab.openerTabId, and webNavigation.onCreatedNavigationTarget (which can
//   arrive after the tab appears, in which case the tab is moved under its
//   opener right away). If neither fires the tab is treated as opened by you,
//   which lands it right next to where you were: a harmless miss, and every
//   decision is written to the diagnostics log.
//
// Hooks:
//   tab:placement  ({ parentId, index, panelId }, { tab, opener }) -> placement
// Events:
//   tab:created { tab, nodeId, claimed }   tab:updated { tabId, nodeId, changeInfo }
//   tab:removed { nodeId }                 tab:activated { tabId, nodeId, windowId }

import { uid } from "../lib/util.js";
import * as T from "../lib/tree.js";
import { pickSuccessor } from "../lib/succession.js";

const NODE_KEY = "grove:node";
const LATE_EVIDENCE_MS = 3000;

export function openableUrl(url) {
  if (!url) return undefined;
  if (/^about:/i.test(url)) return undefined; // extensions cannot open privileged about: pages
  return url;
}

export default {
  name: "tabs",
  deps: ["tree", "windows", "settings", "favicons", "diagnostics"],

  async setup({ api, bus, hooks, commands, store, log, modules }) {
    const { tree, windows, settings, favicons, diagnostics } = modules;

    settings.register("tabs", {
      openerChild: { type: "boolean", label: "Open links from a tab as its children", default: true },
      newTabPlacement: {
        type: "select",
        label: "A tab you open yourself (Ctrl+T, + button) goes",
        default: "sibling",
        options: [
          ["sibling", "Next to the current tab (sibling)"],
          ["child", "Under the current tab (child)"],
          ["end", "At the end of the list"],
        ],
      },
      outdentShortcut: {
        type: "boolean",
        label: "Keyboard shortcut: move the current tab out one level (Alt+Shift+Left; change it under Manage Extension Shortcuts)",
        default: true,
      },
      restoreLoaded: {
        type: "boolean",
        label: "After a restart, load the tabs that were loaded before (Firefox restores them unloaded)",
        default: true,
      },
      closeToRecent: {
        type: "boolean",
        label: "When the tab you are looking at closes, go to the one you used before it (and so on back), skipping tabs that are not loaded. Unloading the tab you are looking at does the same",
        default: true,
      },
      ghostMinutes: {
        type: "number",
        label: "Keep tabs from a previous session in the tree for (minutes)",
        default: 10,
        min: 1,
        max: 1440,
      },
    });

    const nodeByTab = new Map();
    const tabByNode = new Map();
    const claims = [];
    const ignoreRemoval = new Set();
    const pending = new Map(); // tabId -> promise while a node is being created
    const waiters = new Map(); // tabId -> Set(wake) for whenNode()
    const activeByWindow = new Map(); // windowId -> tabId
    const lastActive = new Map(); // `${windowId}:${panelId}` -> tabId
    const navSource = new Map(); // tabId -> sourceTabId (webNavigation evidence)
    const placed = new Map(); // nodeId -> { parentId, signal, at } for late corrections

    // ---- helpers ---------------------------------------------------------

    // Firefox 149+ reports which tabs share a split view (read-only: extensions
    // cannot create one yet). The "none" value is exposed as a constant.
    const NO_SPLIT = api.tabs.SPLIT_VIEW_ID_NONE ?? -1;

    const snapshot = (tab) => ({
      type: "tab",
      url: tab.url ?? "",
      title: tab.title ?? "",
      favIconUrl: favicons.resolve(tab),
      cookieStoreId: tab.cookieStoreId ?? "firefox-default",
      pinned: !!tab.pinned,
      discarded: !!tab.discarded,
      audible: !!tab.audible,
      muted: !!tab.mutedInfo?.muted,
      loading: tab.status === "loading",
      split: tab.splitViewId != null && tab.splitViewId !== NO_SPLIT,
    });

    // "wasLoaded" remembers whether the tab was loaded the last time we knew for
    // sure. Firefox restores every tab unloaded after a restart, so for a short
    // while after startup an unloaded tab says nothing about what you left.
    const STARTUP_MS = 60_000;
    const startedAt = Date.now();
    const inStartup = () => Date.now() - startedAt < STARTUP_MS;
    function applyTab(n, tab) {
      Object.assign(n, snapshot(tab));
      if (!tab.discarded) n.wasLoaded = true;
      else if (!inStartup()) n.wasLoaded = false;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const RESTORE_GAP_MS = 250;
    const restoreQueue = [];
    let draining = false;

    // Load an unloaded tab without switching to it.
    async function loadTab(tabId) {
      let tab;
      try {
        tab = await api.tabs.get(tabId);
        if (!tab.discarded) return true;
        await api.tabs.reload(tabId);
        if (!(await api.tabs.get(tabId)).discarded) return true;
        await sleep(300);
        tab = await api.tabs.get(tabId);
        if (!tab.discarded) return true;
        // reload() did not wake it: navigate to its own address instead.
        if (/^(https?|file):/i.test(tab.url ?? "")) await api.tabs.update(tabId, { url: tab.url });
        return true;
      } catch (err) {
        log.debug("could not load tab", tabId, err);
        return false;
      }
    }

    // Loading a page with no connection only produces an error page and throws the
    // restored page away, so while the browser reports being offline the queue
    // waits, and carries on when the "online" event fires. (A connection that is
    // up but has no internet still reports online; those pages show Firefox's
    // usual error and reload fine from the menu once the network is back.)
    const online = () => globalThis.navigator?.onLine !== false;

    // One at a time with a small gap, so a hundred tabs do not all start at once.
    async function drainRestores() {
      if (draining) return;
      draining = true;
      try {
        while (restoreQueue.length && online()) {
          await loadTab(restoreQueue.shift());
          await sleep(RESTORE_GAP_MS);
        }
        if (restoreQueue.length) diagnostics.log("restore", { waiting: restoreQueue.length, reason: "offline: waiting for a connection" });
      } finally {
        draining = false;
      }
    }
    const onOnline = () => drainRestores();
    globalThis.addEventListener?.("online", onOnline);

    function queueRestore(tabId) {
      if (!settings.get("tabs", "restoreLoaded") || restoreQueue.includes(tabId)) return;
      restoreQueue.push(tabId);
      drainRestores();
    }

    async function stamp(tabId, nodeId) {
      if (tree.get(nodeId)?.private) return; // nothing about a private tab is written anywhere
      try {
        await api.sessions.setTabValue(tabId, NODE_KEY, nodeId);
      } catch (err) {
        log.debug("could not stamp tab", tabId, err);
      }
    }

    async function stampedNode(tabId, tab = null) {
      if (tab?.incognito) return null;
      try {
        return await api.sessions.getTabValue(tabId, NODE_KEY);
      } catch {
        return null;
      }
    }

    function bind(tab, nodeId) {
      const wasLoaded = tree.get(nodeId)?.wasLoaded === true;
      nodeByTab.set(tab.id, nodeId);
      tabByNode.set(nodeId, tab.id);
      tree.mutate((all) => {
        const n = all[nodeId];
        if (!n) return;
        applyTab(n, tab);
        n.tabId = tab.id;
        delete n.orphanedAt;
      }, "bind");
      stamp(tab.id, nodeId);
      // Restored by Firefox as unloaded, but it was loaded when you left.
      if (tab.discarded && wasLoaded && inStartup()) queueRestore(tab.id);
    }

    function unbind(tabId) {
      const nodeId = nodeByTab.get(tabId);
      nodeByTab.delete(tabId);
      navSource.delete(tabId);
      if (nodeId && tabByNode.get(nodeId) === tabId) tabByNode.delete(nodeId);
      return nodeId;
    }

    function nodeLabel(id) {
      const n = id ? tree.get(id) : null;
      return n ? n.customTitle || n.name || n.title || n.url || id : "top level";
    }

    // The tab this one was opened from, if there is evidence and it is usable:
    // known to Grove and in the same window (a popup window must not become a
    // child in another window's tree, where it would be hidden).
    async function usableOpener(tab, sourceTabId) {
      if (sourceTabId == null || sourceTabId < 0) return null;
      const node = tree.get(nodeByTab.get(sourceTabId));
      if (!node || node.type !== "tab") return null;
      try {
        const src = await api.tabs.get(sourceTabId);
        if (src.windowId !== tab.windowId) return null;
      } catch {
        return null;
      }
      return node;
    }

    // Placement for a tab the user opened (no link evidence).
    // relation: "sibling" | "child" | "end" (default from settings).
    function manualPlacement(windowId, relation, panelHint = null) {
      const rel = relation ?? settings.get("tabs", "newTabPlacement");
      const view = windows.getView(windowId);
      const sameView = !panelHint || panelHint === view.panelId;
      const panelId = panelHint ?? view.panelId;
      const nodes = tree.all();
      const activeId = nodeByTab.get(activeByWindow.get(windowId));
      const active = activeId ? nodes[activeId] : null;
      if (rel !== "end" && sameView && active && !active.pinned && T.inView(nodes, active, view)) {
        if (rel === "child") return { parentId: active.id, index: null, panelId: active.panelId };
        const spot = T.placeAfter(nodes, active.id, { type: "tab" });
        if (spot) return spot;
      }
      // Nothing to anchor to: the end of the open folder, or of the panel.
      return { parentId: sameView ? view.folderId : null, index: null, panelId };
    }

    async function createNode(tab, claim) {
      // The tab itself says its window is private, even if Firefox has not announced the window yet:
      // it must be placed in the private space, not a normal panel the private sidebar never shows.
      if (tab.incognito) windows.ensurePrivate(tab.windowId);
      let placement;
      let signal;
      let opener = null;

      if (claim?.placement) {
        placement = claim.placement;
        signal = "grove";
      } else {
        const sourceTabId = tab.openerTabId ?? navSource.get(tab.id);
        opener = await usableOpener(tab, sourceTabId);
        if (opener && !tab.pinned && settings.get("tabs", "openerChild")) {
          placement = { parentId: opener.id, index: null, panelId: opener.panelId };
          signal = tab.openerTabId != null ? "opener" : "navigation";
        } else {
          placement = manualPlacement(tab.windowId, null);
          signal = "none";
        }
      }
      placement = await hooks.run("tab:placement", placement, { tab, opener });

      const node = { id: uid("t"), order: 0, collapsed: false, panelId: placement.panelId, ...snapshot(tab), wasLoaded: !tab.discarded, tabId: tab.id };
      if (tab.incognito) node.private = true; // lives in memory only: see lib/tree.js withoutPrivate
      let added = tree.add(node, { parentId: placement.parentId, index: placement.index });
      if (!added) added = tree.add(node, { parentId: null, index: null }); // a hook asked for an illegal spot
      nodeByTab.set(tab.id, node.id);
      tabByNode.set(node.id, tab.id);
      stamp(tab.id, node.id);

      placed.set(node.id, { parentId: tree.get(node.id)?.parentId ?? null, signal, at: Date.now() });
      diagnostics.log("placement", {
        url: tab.incognito ? "(private tab)" : tab.url, // the log must not keep what you browse privately
        signal,
        result: tree.get(node.id)?.parentId ? `inside “${nodeLabel(tree.get(node.id).parentId)}”` : "top level",
      });
      return node.id;
    }

    // Attach a browser tab to the tree: rebind a stamped node, or create one.
    async function ingest(tab, { claim } = {}) {
      if (nodeByTab.has(tab.id)) return nodeByTab.get(tab.id);

      if (claim?.nodeId && tree.get(claim.nodeId)) {
        bind(tab, claim.nodeId);
        return claim.nodeId;
      }

      const saved = await stampedNode(tab.id, tab);
      const node = saved ? tree.get(saved) : null;
      if (node && node.type === "tab" && !tabByNode.has(saved)) {
        bind(tab, saved);
        return saved;
      }

      return createNode(tab, claim);
    }

    function orphan(nodeId) {
      tree.mutate((all) => {
        const n = all[nodeId];
        if (!n) return;
        n.tabId = null;
        n.orphanedAt = Date.now();
      }, "orphan");
    }

    function prune() {
      const ttl = settings.get("tabs", "ghostMinutes") * 60_000;
      const now = Date.now();
      const doomed = Object.values(tree.all()).filter(
        (n) => n.type === "tab" && n.tabId == null && !n.saved && n.orphanedAt && now - n.orphanedAt > ttl
      );
      for (const n of doomed) tree.remove(n.id, { mode: "promote" });
      return doomed.length;
    }

    // Make sure the active tab can be seen: open every collapsed branch above it.
    function reveal(nodeId) {
      const all = tree.all();
      const hidden = [];
      for (let p = all[nodeId]?.parentId; p; p = all[p]?.parentId) if (all[p]?.collapsed) hidden.push(p);
      if (hidden.length) tree.mutate((a) => hidden.forEach((id) => (a[id].collapsed = false)), "reveal");
    }

    // Create a tab that will be claimed by the onCreated handler.
    async function createTab(props, claim = {}) {
      const entry = { windowId: props.windowId, cookieStoreId: props.cookieStoreId, ...claim };
      claims.push(entry);
      try {
        return await api.tabs.create(props);
      } finally {
        const i = claims.indexOf(entry);
        if (i >= 0) claims.splice(i, 1);
      }
    }

    // Create a tab Grove is opening in `panelId`, straight into the container that
    // its folder, its panel (or a rule for this address) asks for, so it never opens in the wrong
    // one first. An explicit cookieStoreId wins. If the container cannot be used
    // (deleted, say) the tab opens normally instead of not at all.
    async function createTabIn(props, claim, panelId) {
      const containers = modules.containers; // loads after this module: looked up when needed
      const want = props.cookieStoreId ? null : containers?.containerForNew(props.url ?? "", panelId, claim?.placement?.parentId ?? null);
      if (want) {
        try {
          return await createTab({ ...props, cookieStoreId: want }, claim);
        } catch (err) {
          containers.noteFailed(want, err);
        }
      }
      return createTab(props, claim);
    }

    // Resolves with the node id of a tab, waiting briefly for a tab that is
    // still being created (a request can start before onCreated is handled).
    function whenNode(tabId, ms = 200) {
      if (nodeByTab.has(tabId)) return Promise.resolve(nodeByTab.get(tabId));
      const p = pending.get(tabId);
      if (p) return p.then(() => nodeByTab.get(tabId) ?? null);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.get(tabId)?.delete(done);
          resolve(nodeByTab.get(tabId) ?? null);
        };
        const timer = setTimeout(done, ms);
        if (!waiters.has(tabId)) waiters.set(tabId, new Set());
        waiters.get(tabId).add(done);
      });
    }
    const wake = (tabId) => {
      for (const f of [...(waiters.get(tabId) ?? [])]) f();
      waiters.delete(tabId);
    };

    // ---- browser events --------------------------------------------------

    const onCreated = (tab) => {
      const ci = claims.findIndex(
        (c) =>
          (c.windowId == null || c.windowId === tab.windowId) &&
          (c.cookieStoreId == null || c.cookieStoreId === tab.cookieStoreId)
      );
      const claim = ci >= 0 ? claims.splice(ci, 1)[0] : undefined;
      const work = ingest(tab, { claim }).then(async (nodeId) => {
        pending.delete(tab.id);
        wake(tab.id);
        await bus.emit("tab:created", { tab, nodeId, claimed: !!claim });
      });
      pending.set(tab.id, work);
    };

    // Second, independent evidence that a tab was opened from a link.
    const onNavTarget = async ({ sourceTabId, tabId }) => {
      if (sourceTabId == null || sourceTabId < 0 || tabId == null) return;
      navSource.set(tabId, sourceTabId);
      await pending.get(tabId);
      const nodeId = nodeByTab.get(tabId);
      const rec = nodeId ? placed.get(nodeId) : null;
      // Only a tab we placed as "opened by you" a moment ago, and that has not been moved since.
      if (!rec || rec.signal !== "none" || Date.now() - rec.at > LATE_EVIDENCE_MS) return;
      const node = tree.get(nodeId);
      if (!node || node.pinned || node.parentId !== rec.parentId || !settings.get("tabs", "openerChild")) return;
      const tab = await api.tabs.get(tabId).catch(() => null);
      const opener = tab ? await usableOpener(tab, sourceTabId) : null;
      if (!opener || T.isAncestor(tree.all(), nodeId, opener.id)) return;
      if (await tree.move({ id: nodeId, parentId: opener.id, index: null })) {
        rec.signal = "navigation (late)";
        rec.parentId = opener.id;
        diagnostics.log("placement", { url: tab.incognito ? "(private tab)" : tab.url, signal: rec.signal, result: `moved inside “${nodeLabel(opener.id)}”` });
      }
    };

    const onUpdated = async (tabId, changeInfo, tab) => {
      await pending.get(tabId);
      if ("discarded" in changeInfo || "hidden" in changeInfo) scheduleSuccessor(tab?.windowId);
      const nodeId = nodeByTab.get(tabId);
      if (!nodeId) return;
      const keys = ["url", "title", "favIconUrl", "pinned", "status", "discarded", "audible", "mutedInfo", "splitViewId"];
      if (!keys.some((k) => k in changeInfo)) return;
      tree.mutate((all) => {
        if (all[nodeId]) applyTab(all[nodeId], tab);
      }, "update");
      await bus.emit("tab:updated", { tabId, nodeId, changeInfo, tab });
    };

    const onRemoved = async (tabId, { isWindowClosing, windowId } = {}) => {
      await pending.get(tabId);
      seen.delete(tabId);
      given.delete(tabId);
      if (!isWindowClosing) scheduleSuccessor(windowId);
      lastActive.forEach((v, k) => v === tabId && lastActive.delete(k));
      if (ignoreRemoval.delete(tabId)) {
        unbind(tabId);
        return;
      }
      const nodeId = unbind(tabId);
      if (!nodeId || !tree.get(nodeId)) return;
      if (isWindowClosing && !tree.get(nodeId).private) {
        orphan(nodeId);
      } else {
        tree.remove(nodeId, { mode: "promote" });
      }
      placed.delete(nodeId);
      await bus.emit("tab:removed", { nodeId, tabId });
    };

    const onActivated = async ({ tabId, windowId }) => {
      await pending.get(tabId);
      activeByWindow.set(windowId, tabId);
      seen.set(tabId, ++visits);
      scheduleSuccessor(windowId);
      const nodeId = nodeByTab.get(tabId);
      const node = nodeId ? tree.get(nodeId) : null;
      if (node) {
        lastActive.set(`${windowId}:${node.panelId}`, tabId);
        reveal(nodeId);
        // The tab you are looking at must be in the view you are looking at.
        const view = windows.getView(windowId);
        if (!node.pinned && !T.inView(tree.all(), node, view)) {
          await windows.setView(windowId, { panelId: node.panelId, folderId: null });
        }
      }
      await bus.emit("tab:activated", { tabId, nodeId, windowId });
    };

    const onAttached = async (tabId) => {
      await bus.emit("tab:attached", { tabId, nodeId: nodeByTab.get(tabId) });
    };

    api.tabs.onCreated.addListener(onCreated);

    // A new window: take in any tab it already has that onCreated did not tell us about
    // (the first tab of a window is not always announced), and note which one is showing.
    const onWindowOpened = async ({ windowId }) => {
      const here = await api.tabs.query({ windowId }).catch(() => []);
      for (const tab of here) {
        if (nodeByTab.has(tab.id) || pending.has(tab.id)) continue;
        const work = ingest(tab).then(async (nodeId) => {
          pending.delete(tab.id);
          wake(tab.id);
          await bus.emit("tab:created", { tab, nodeId, claimed: false });
        });
        pending.set(tab.id, work);
        await work;
      }
      const shown = here.find((tab) => tab.active);
      if (shown && !activeByWindow.has(windowId)) await onActivated({ tabId: shown.id, windowId });
    };
    bus.on("window:opened", onWindowOpened);
    api.tabs.onUpdated.addListener(onUpdated);
    api.tabs.onRemoved.addListener(onRemoved);
    api.tabs.onActivated.addListener(onActivated);
    api.tabs.onAttached.addListener(onAttached);
    api.webNavigation?.onCreatedNavigationTarget.addListener(onNavTarget);

    // ---- where to go when the tab you are looking at closes or is unloaded ----
    //
    // Firefox decides that itself unless a tab has a successor (tabs.update successorTabId): then closing
    // the tab shows its successor. So the tab you are looking at always gets the one you used before it
    // as its successor, chosen among tabs that are loaded (src/lib/succession.js). That way it holds
    // however the tab is closed (Ctrl+W, the sidebar, a script) and nothing has to intercept the close.
    const NO_TAB = api.tabs.TAB_ID_NONE ?? -1;
    const seen = new Map(); // tabId -> how recently it was shown (larger = later); in memory
    const given = new Map(); // tabId -> the successor Grove set on it
    const successorTimers = new Map(); // windowId -> timer
    let visits = 0;
    const noSuccessor = (id) => id == null || id < 0;

    const windowTabs = (windowId) => api.tabs.query({ windowId }).catch(() => []);

    async function refreshSuccessor(windowId) {
      const list = await windowTabs(windowId);
      const here = list.find((t) => t.active);
      if (!here) return;
      const had = noSuccessor(here.successorTabId) ? NO_TAB : here.successorTabId;
      let want = NO_TAB;
      if (settings.get("tabs", "closeToRecent")) want = pickSuccessor(list, here.id, { seen })?.id ?? NO_TAB;
      else if (given.get(here.id) !== had) return; // off: only undo what we set ourselves
      if (want === had) return;
      try {
        await api.tabs.update(here.id, { successorTabId: want });
        if (want === NO_TAB) given.delete(here.id);
        else given.set(here.id, want);
      } catch { /* the tab or its successor went away meanwhile; the next event looks again */ }
    }

    // Many things change the answer at once (a switch, a tab unloaded, a panel shown): look once, shortly after.
    function scheduleSuccessor(windowId) {
      if (windowId == null) return;
      clearTimeout(successorTimers.get(windowId));
      successorTimers.set(windowId, setTimeout(() => {
        successorTimers.delete(windowId);
        refreshSuccessor(windowId).catch(() => {});
      }, 30));
    }

    // ---- commands --------------------------------------------------------

    commands.register("tab:activate", async ({ id, windowId }) => {
      const node = tree.get(id);
      if (!node || node.type !== "tab") return false;
      const tabId = tabByNode.get(id);
      if (tabId == null) return commands.run("tab:open", { id, windowId });
      const tab = await api.tabs.get(tabId);
      // Firefox does not move tabs between a private and a normal window: leave it where it is.
      if (windowId != null && tab.windowId !== windowId && (await api.windows.get(windowId).catch(() => null))?.incognito === !!tab.incognito) {
        await api.tabs.move(tabId, { windowId, index: -1 });
      }
      await api.tabs.update(tabId, { active: true });
      return true;
    });

    // Take tabs out of their parent: each lands right after it, among the parent's siblings,
    // and brings its own children along. Only a tab's children can be taken out this way
    // (a tab inside a folder stays in its folder). Returns how many moved.
    commands.register("tab:outdent", async ({ ids = [], id = null }) => {
      const list = (ids.length ? ids : [id]).filter(Boolean);
      const set = new Set(list);
      let moved = 0;
      for (const nodeId of list) {
        const n = tree.get(nodeId);
        const parent = n?.parentId ? tree.get(n.parentId) : null;
        if (!n || n.type !== "tab" || !parent || parent.type !== "tab") continue;
        // A whole branch selected: only its top moves, the rest comes along.
        let inside = false;
        for (let p = n.parentId; p; p = tree.get(p)?.parentId) if (set.has(p)) inside = true;
        if (inside) continue;
        const at = T.indexAmongSiblings(tree.all(), parent.id) + 1;
        if (await tree.move({ id: nodeId, parentId: parent.parentId, index: at, panelId: parent.panelId })) moved++;
      }
      return moved;
    }, { title: "Move out one level" });

    // One place up or down among the siblings (never into another parent). Pinned tabs, which
    // the sidebar does not list, are stepped over. Returns false at the end of the list.
    commands.register("tab:shift", async ({ id, dir }) => {
      const n = tree.get(id);
      if (!n) return false;
      const sibs = T.childrenOf(tree.all(), n.parentId, n.panelId);
      const i = sibs.findIndex((s) => s.id === id);
      const step = dir === "up" ? -1 : 1;
      let j = i + step;
      while (sibs[j]?.pinned) j += step;
      if (j < 0 || j >= sibs.length) return false;
      return tree.move({ id, parentId: n.parentId, index: step < 0 ? j : j + 1, panelId: n.panelId });
    }, { title: "Move up or down" });

    // The shortcut: the tab you are looking at, wherever the keyboard focus is.
    commands.register("tab:outdentActive", async ({ windowId }) => {
      if (!settings.get("tabs", "outdentShortcut")) return 0;
      const id = windowId != null ? nodeByTab.get(activeByWindow.get(windowId)) : null;
      return id ? commands.run("tab:outdent", { id }) : 0;
    });

    // Reopen a ghost node (e.g. from an import or a previous session).
    commands.register("tab:open", async ({ id, windowId, active = true }) => {
      const node = tree.get(id);
      if (!node || node.type !== "tab" || tabByNode.has(id)) return false;
      const wid = windowId ?? (await api.windows.getLastFocused()).id;
      const props = { windowId: wid, active, pinned: !!node.pinned };
      const url = openableUrl(node.url);
      if (url) props.url = url;
      if (node.cookieStoreId && node.cookieStoreId !== "firefox-default") props.cookieStoreId = node.cookieStoreId;
      try {
        await createTab(props, { nodeId: id });
      } catch (err) {
        // Container no longer exists, etc. Fall back to the default container.
        delete props.cookieStoreId;
        await createTab(props, { nodeId: id });
      }
      return true;
    });

    // parentId: open inside that tab (as a child) or folder (at its end).
    // Otherwise a tab "opened by you": relation sibling | child | end.
    commands.register("tab:new", async ({ windowId, parentId = null, panelId = null, url, cookieStoreId, active = true, relation = null }) => {
      const wid = windowId ?? (await api.windows.getLastFocused()).id;
      const parent = parentId ? tree.get(parentId) : null;
      const placement = parent
        ? { parentId: parent.id, index: null, panelId: parent.panelId }
        : manualPlacement(wid, relation, panelId);
      const props = { windowId: wid, active };
      const open = openableUrl(url);
      if (open) props.url = open;
      if (cookieStoreId && cookieStoreId !== "firefox-default") props.cookieStoreId = cookieStoreId;
      await createTabIn(props, { placement }, placement.panelId);
      return true;
    });

    // Links dropped on the sidebar (from a page, bookmarks, downloads). Opens one
    // tab per link at the given place, in order. Only the first becomes the active
    // tab, and only when the place is what you are looking at: dropping into
    // another panel must not pull you away from where you are.
    commands.register("tab:openUrls", async ({ urls = [], windowId = null, parentId = null, index = null, panelId = null }) => {
      const wid = windowId ?? (await api.windows.getLastFocused()).id;
      const clean = urls.map((u) => (typeof u === "string" ? { url: u } : u)).filter((u) => /^(https?|ftp|file):\/\//i.test(u?.url ?? ""));
      const parent = parentId ? tree.get(parentId) : null;
      const view = windows.getView(wid);
      const targetPanel = parent?.panelId ?? panelId ?? view.panelId;
      const all = tree.all();
      const inOpenFolder = view.folderId == null || parentId === view.folderId || (parentId && T.isAncestor(all, view.folderId, parentId));
      const visible = targetPanel === view.panelId && inOpenFolder;
      let at = index;
      let opened = 0;
      let error = null;
      for (const { url } of clean) {
        try {
          await createTabIn({ windowId: wid, url, active: visible && opened === 0 }, { placement: { parentId, index: at, panelId: targetPanel } }, targetPanel);
          opened++;
          if (at !== null) at++;
        } catch (err) {
          error = `Firefox would not open ${url}: ${err.message}`;
        }
      }
      return { opened, skipped: urls.length - clean.length, error };
    }, { title: "Open links" });

    // Text dropped on the sidebar: search for it with the default search engine,
    // in a new tab at the drop place. Like a Firefox tab strip drop, but the tab
    // opens in the background: it never takes you away from what you are reading.
    const MAX_SEARCH = 1000;
    commands.register("tab:search", async ({ text, windowId = null, parentId = null, index = null, panelId = null }) => {
      const query = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!query) return { opened: 0, error: null };
      if (query.length > MAX_SEARCH) return { opened: 0, error: `That text is too long to search for (${query.length} characters; the limit is ${MAX_SEARCH}).` };
      if (!api.search?.search) return { opened: 0, error: "This Firefox does not let extensions run a search." };
      const wid = windowId ?? (await api.windows.getLastFocused()).id;
      const parent = parentId ? tree.get(parentId) : null;
      const targetPanel = parent?.panelId ?? panelId ?? windows.getView(wid).panelId;
      // An empty tab first (placed and put in the panel's container), then the search is
      // loaded into it: that is the only way to choose where it goes AND use the default engine.
      const tab = await createTabIn({ windowId: wid, active: false }, { placement: { parentId, index, panelId: targetPanel } }, targetPanel);
      try {
        await api.search.search({ query, tabId: tab.id });
      } catch (err) {
        await api.tabs.remove(tab.id).catch(() => {});
        return { opened: 0, error: `Firefox could not run the search: ${err.message}` };
      }
      return { opened: 1, error: null };
    }, { title: "Search for dropped text" });

    // mode "self": close this tab only (children are promoted)
    // mode "subtree": close the tab and everything beneath it
    commands.register("tab:close", async ({ id, mode = "self" }) => {
      const node = tree.get(id);
      if (!node) return false;
      if (mode === "subtree") {
        const ids = [id, ...descendantIds(id)];
        const tabIds = ids.map((i) => tabByNode.get(i)).filter((t) => t != null);
        if (tabIds.length) await api.tabs.remove(tabIds);
        // Folders, notes and ghosts have no browser tab: delete what is left.
        tree.removeMany(ids.filter((i) => tree.get(i)));
        return true;
      }
      const tabId = tabByNode.get(id);
      if (tabId != null) {
        await api.tabs.remove(tabId);
        return true;
      }
      return tree.remove(id, { mode: "promote" }).length > 0; // a ghost or an (empty-of-notes) folder
    });

    commands.register("tab:mute", async ({ id, value }) => {
      const tabId = tabByNode.get(id);
      if (tabId == null) return false;
      const tab = await api.tabs.get(tabId);
      await api.tabs.update(tabId, { muted: value ?? !tab.mutedInfo?.muted });
      return true;
    });

    // Free the memory of a tab. If you are looking at it, you go to the tab you used before it first (as when
    // it closes: a loaded one if there is one), because a tab being shown cannot be unloaded.
    commands.register("tab:unload", async ({ id }) => {
      if (tabByNode.get(id) == null) return false;
      const r = await unloadTabs([id]);
      if (r.skipped) throw new Error("There is no other tab to switch to, so this one stays loaded.");
      return true;
    });

    commands.register("tab:load", async ({ id }) => {
      const tabId = tabByNode.get(id);
      return tabId == null ? false : loadTab(tabId);
    });

    // Tab nodes that have a live browser tab: the given nodes, and everything
    // beneath them when `deep` (folders always count their contents).
    function liveTabsUnder(ids, deep = false) {
      const all = tree.all();
      const out = new Set();
      for (const id of ids) {
        const n = all[id];
        if (!n) continue;
        if (n.type === "tab") out.add(id);
        if (deep || n.type === "folder") for (const d of T.descendantsOf(all, id)) if (all[d]?.type === "tab") out.add(d);
      }
      return [...out].filter((id) => tabByNode.has(id));
    }

    // Unload tabs. A tab being looked at (in any window) is left for the tab you used before it, chosen among
    // tabs that are not being unloaded too; if there is no other tab it is skipped and reported.
    async function unloadTabs(nodeIds) {
      const all = tree.all();
      const found = [];
      for (const id of nodeIds) {
        if (!all[id] || all[id].discarded || !tabByNode.has(id)) continue;
        const tab = await api.tabs.get(tabByNode.get(id)).catch(() => null);
        if (tab && !tab.discarded) found.push({ id, tab });
      }
      const exclude = found.map((f) => f.tab.id);
      const doomed = [];
      let skipped = 0;
      for (const { id, tab } of found) {
        if (tab.active) {
          const next = pickSuccessor(await windowTabs(tab.windowId), tab.id, { seen, exclude });
          if (!next) {
            skipped++;
            continue;
          }
          await api.tabs.update(next.id, { active: true });
          diagnostics.log("unload", { url: tab.incognito ? "(private tab)" : tab.url, result: `switched first, to ${next.incognito ? "(private tab)" : next.url}${next.discarded ? " (it was not loaded)" : ""}` });
        }
        doomed.push(id);
      }
      if (doomed.length) await api.tabs.discard(doomed.map((id) => tabByNode.get(id)));
      // You chose this: remember it even inside the startup window.
      tree.mutate((a) => doomed.forEach((id) => a[id] && (a[id].wasLoaded = false)), "unload");
      return { unloaded: doomed.length, skipped };
    }

    commands.register("tabs:unload", async ({ ids = [], deep = false }) => unloadTabs(liveTabsUnder(ids, deep)), { title: "Unload tabs" });

    // Load many unloaded tabs, a few at a time, without switching to them.
    commands.register("tabs:load", async ({ ids = [], deep = false }) => {
      const all = tree.all();
      const targets = liveTabsUnder(ids, deep).filter((id) => all[id].discarded);
      for (const id of targets) {
        await loadTab(tabByNode.get(id));
        await sleep(RESTORE_GAP_MS);
      }
      return { loaded: targets.length };
    }, { title: "Load tabs" });

    // Close the selected tabs themselves (children are promoted, as with one tab).
    commands.register("tab:closeMany", async ({ ids = [] }) => {
      const all = tree.all();
      const tabNodes = ids.filter((id) => all[id]?.type === "tab");
      const live = tabNodes.filter((id) => tabByNode.has(id)).map((id) => tabByNode.get(id));
      if (live.length) await api.tabs.remove(live);
      for (const id of tabNodes) if (!tabByNode.has(id) && tree.get(id)) tree.remove(id, { mode: "promote" }); // ghosts
      return tabNodes.length;
    }, { title: "Close tabs" });

    function descendantIds(id) {
      return T.descendantsOf(tree.all(), id);
    }

    // ---- startup ---------------------------------------------------------

    for (const tab of await api.tabs.query({})) {
      pending.set(tab.id, ingest(tab).then(() => pending.delete(tab.id)));
    }
    await Promise.all([...pending.values()]);

    for (const w of await api.windows.getAll({ populate: true })) {
      const act = w.tabs?.find((t) => t.active);
      if (act) {
        activeByWindow.set(w.id, act.id);
        const nid = nodeByTab.get(act.id);
        const node = nid ? tree.get(nid) : null;
        if (node) lastActive.set(`${w.id}:${node.panelId}`, act.id);
      }
    }

    // Anything that has a tabId in storage but no live tab is a ghost now.
    tree.mutate((all) => {
      for (const n of Object.values(all)) {
        if (n.type === "tab" && n.tabId != null && !tabByNode.has(n.id)) {
          n.tabId = null;
          n.orphanedAt ??= Date.now();
        } else if (n.type === "tab" && n.tabId == null && !n.saved) {
          n.orphanedAt ??= Date.now();
        }
      }
    }, "reconcile");
    prune();
    const pruneTimer = setInterval(prune, 5 * 60_000);
    pruneTimer.unref?.(); // lets Node (tests) exit; a no-op in the browser

    return {
      exports: {
        nodeIdOf: (tabId) => nodeByTab.get(tabId),
        tabIdOf: (nodeId) => tabByNode.get(nodeId),
        createTab,
        liveTabsUnder,
        ignoreRemoval: (tabId) => ignoreRemoval.add(tabId),
        activeTab: (windowId) => activeByWindow.get(windowId),
        activeNode: (windowId) => nodeByTab.get(activeByWindow.get(windowId)),
        lastActiveTab: (windowId, panelId) => lastActive.get(`${windowId}:${panelId}`),
        ready: (tabId) => pending.get(tabId) ?? Promise.resolve(),
        whenNode,
        prune,
      },
      teardown() {
        clearInterval(pruneTimer);
        successorTimers.forEach((timer) => clearTimeout(timer));
        globalThis.removeEventListener?.("online", onOnline);
        api.tabs.onCreated.removeListener(onCreated);
        bus.off("window:opened", onWindowOpened);
        api.tabs.onUpdated.removeListener(onUpdated);
        api.tabs.onRemoved.removeListener(onRemoved);
        api.tabs.onActivated.removeListener(onActivated);
        api.tabs.onAttached.removeListener(onAttached);
        api.webNavigation?.onCreatedNavigationTarget.removeListener(onNavTarget);
      },
    };
  },
};
