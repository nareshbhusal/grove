// A small in-memory stand-in for the parts of the Firefox WebExtension API that
// Grove uses. It models: windows, tabs (incl. hide/show, openers, containers),
// sessions values, storage.local, contextualIdentities, blocking webRequest.

import { readFileSync } from "node:fs";

// Read from the real manifest, so a missing permission fails the tests too.
export const MANIFEST_PERMISSIONS = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).permissions;

function ev() {
  const ls = new Set();
  return {
    addListener: (f) => ls.add(f),
    removeListener: (f) => ls.delete(f),
    hasListener: (f) => ls.has(f),
    async dispatch(...args) {
      const results = [];
      for (const f of [...ls]) results.push(await f(...args));
      return results;
    },
    fire(...args) {
      for (const f of [...ls]) f(...args);
    },
  };
}

export function createFakeBrowser({ storageData = {} } = {}) {
  let nextTab = 1;
  let nextWin = 1;
  let nextCtr = 1;
  const tabs = new Map();
  const wins = new Map();
  const tabValues = new Map();
  const winValues = new Map();
  const storage = storageData;
  const containers = new Map();
  const reloads = [];
  const downloadsList = new Map();
  let nextDl = 1;

  const E = {
    tabCreated: ev(), tabUpdated: ev(), tabRemoved: ev(), tabActivated: ev(), tabAttached: ev(),
    winCreated: ev(), winRemoved: ev(),
    beforeRequest: ev(), dlChanged: ev(), connect: ev(), message: ev(), command: ev(), navTarget: ev(),
  };

  const inWin = (windowId) => [...tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  const reindex = (windowId) => inWin(windowId).forEach((t, i) => (t.index = i));
  const clone = (t) => ({ ...t });

  const browser = {
    storage: {
      local: {
        async get(keys) {
          const list = keys == null ? Object.keys(storage) : [].concat(keys);
          return Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, structuredClone(storage[k])]));
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) storage[k] = structuredClone(v); },
        async remove(keys) { for (const k of [].concat(keys)) delete storage[k]; },
      },
    },

    windows: {
      onCreated: E.winCreated,
      onRemoved: E.winRemoved,
      async getAll({ populate } = {}) {
        return [...wins.values()].map((w) => ({ ...w, ...(populate ? { tabs: inWin(w.id).map(clone) } : {}) }));
      },
      async getLastFocused() { return { ...[...wins.values()].at(-1) }; },
      async getCurrent() { return { ...[...wins.values()].at(0) }; },
      async get(id) {
        const w = wins.get(id);
        if (!w) throw new Error(`Invalid window ID: ${id}`);
        return { ...w };
      },
    },

    tabs: {
      onCreated: E.tabCreated, onUpdated: E.tabUpdated, onRemoved: E.tabRemoved,
      onActivated: E.tabActivated, onAttached: E.tabAttached,

      async query({ windowId, active } = {}) {
        return [...tabs.values()]
          .filter((t) => (windowId == null || t.windowId === windowId) && (active == null || t.active === active))
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
          .map(clone);
      },
      async goBack(id) { if (!tabs.has(id)) throw new Error(`Invalid tab ID: ${id}`); sim.history.push(["back", id]); },
      async goForward(id) { if (!tabs.has(id)) throw new Error(`Invalid tab ID: ${id}`); sim.history.push(["forward", id]); },
      async sendMessage(id, msg) { sim.pageMessages.push([id, msg]); },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        return clone(t);
      },
      async create(props) {
        const windowId = props.windowId ?? [...wins.keys()].at(-1);
        // Firefox refuses any cookieStoreId unless the manifest asks for "cookies".
        if (props.cookieStoreId && !MANIFEST_PERMISSIONS.includes("cookies")) {
          throw new Error(`No permission for cookieStoreId: ${props.cookieStoreId}`);
        }
        if (props.cookieStoreId && props.cookieStoreId !== "firefox-default" && !containers.has(props.cookieStoreId)) {
          throw new Error(`No cookie store exists with ID ${props.cookieStoreId}`);
        }
        const tab = {
          id: nextTab++, windowId, index: props.index ?? inWin(windowId).length,
          url: props.url ?? "about:newtab", title: props.url ?? "New Tab", active: false,
          pinned: !!props.pinned, hidden: false, discarded: false, audible: false, status: "complete",
          mutedInfo: { muted: false },
          cookieStoreId: props.cookieStoreId ?? "firefox-default", openerTabId: props.openerTabId, incognito: !!wins.get(windowId)?.incognito,
        };
        tabs.set(tab.id, tab);
        inWin(windowId).filter((t) => t !== tab && t.index >= tab.index).forEach((t) => t.index++);
        reindex(windowId);
        E.tabCreated.fire(clone(tab));
        if (props.active !== false) await browser.tabs.update(tab.id, { active: true });
        return clone(tab);
      },
      async update(id, props) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        if (props.url) {
          t.url = props.url;
          if (t.discarded) {
            t.discarded = false;
            await E.tabUpdated.dispatch(id, { discarded: false, url: props.url }, clone(t));
          }
        }
        if (props.active) {
          if (t.hidden) throw new Error("Cannot activate a hidden tab");
          const prev = inWin(t.windowId).find((x) => x.active);
          if (prev) prev.active = false;
          t.active = true;
          await E.tabActivated.dispatch({ tabId: id, windowId: t.windowId, previousTabId: prev?.id });
        }
        if (props.muted !== undefined) {
          t.mutedInfo = { muted: !!props.muted, reason: "extension" };
          await E.tabUpdated.dispatch(id, { mutedInfo: t.mutedInfo }, clone(t));
        }
        return clone(t);
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (!t) continue;
          const siblings = inWin(t.windowId).filter((x) => x.id !== id && !x.hidden);
          tabs.delete(id);
          reindex(t.windowId);
          if (t.active && siblings.length) {
            const next = siblings.find((x) => x.index >= t.index) ?? siblings.at(-1);
            await E.tabRemoved.dispatch(id, { windowId: t.windowId, isWindowClosing: false });
            await browser.tabs.update(next.id, { active: true });
          } else {
            await E.tabRemoved.dispatch(id, { windowId: t.windowId, isWindowClosing: false });
          }
        }
      },
      async move(id, { windowId, index }) {
        const t = tabs.get(id);
        const from = t.windowId;
        if (windowId != null) t.windowId = windowId;
        t.index = index === -1 ? inWin(t.windowId).length : index;
        reindex(from);
        reindex(t.windowId);
        if (from !== t.windowId) await E.tabAttached.dispatch(id, { newWindowId: t.windowId });
        return [clone(t)];
      },
      async discard(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (!t || t.active) continue; // Firefox never discards the active tab
          t.discarded = true;
          await E.tabUpdated.dispatch(id, { discarded: true }, clone(t));
        }
      },
      async reload(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Invalid tab ID: ${id}`);
        reloads.push(id);
        if (t.discarded && !sim.reloadDoesNotWake) {
          t.discarded = false;
          await E.tabUpdated.dispatch(id, { discarded: false }, clone(t));
        }
      },
      async hide(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.get(id);
          if (t?.active) throw new Error("Cannot hide the active tab");
          if (t) t.hidden = true;
        }
      },
      async show(ids) {
        for (const id of [].concat(ids)) { const t = tabs.get(id); if (t) t.hidden = false; }
      },
    },

    sessions: {
      async setTabValue(id, k, v) { tabValues.set(`${id}:${k}`, v); },
      async getTabValue(id, k) { return tabValues.get(`${id}:${k}`); },
      async setWindowValue(id, k, v) { winValues.set(`${id}:${k}`, v); },
      async getWindowValue(id, k) { return winValues.get(`${id}:${k}`); },
    },

    contextualIdentities: {
      async query() { return [...containers.values()].map((c) => ({ ...c })); },
      async create({ name, color, icon }) {
        const c = { cookieStoreId: `firefox-container-${nextCtr++}`, name, color, icon };
        containers.set(c.cookieStoreId, c);
        return { ...c };
      },
      async remove(id) { containers.delete(id); },
    },

    webRequest: { onBeforeRequest: E.beforeRequest },
    webNavigation: { onCreatedNavigationTarget: E.navTarget },

    runtime: {
      onConnect: E.connect,
      onMessage: E.message,
      onSuspend: ev(),
      async sendMessage(msg) {
        const rs = await E.message.dispatch(msg);
        return rs.find((r) => r !== undefined);
      },
    },

    // Records what would be saved. `content` is read back from the blob URL.
    downloads: {
      onChanged: E.dlChanged,
      async download({ url, filename, saveAs, conflictAction }) {
        if (sim.downloadFails) throw new Error("Download failed: " + sim.downloadFails);
        const id = nextDl++;
        const { resolveObjectURL } = await import("node:buffer");
        const blob = resolveObjectURL(url);
        const text = blob ? await blob.text() : null;
        const existing = [...downloadsList.values()].find((d) => d.filename === filename && !d.removed);
        if (existing && conflictAction === "overwrite") existing.removed = true;
        downloadsList.set(id, { id, filename, saveAs: !!saveAs, conflictAction, text, removed: false, erased: false, state: sim.instantDownloads ? "complete" : "in_progress" });
        return id;
      },
      // Only entries still in the history can be searched or have their file removed.
      async search({ id, state } = {}) {
        return [...downloadsList.values()].filter((d) => !d.erased && (id == null || d.id === id) && (!state || d.state === state)).map((d) => ({ ...d }));
      },
      async removeFile(id) {
        const d = downloadsList.get(id);
        if (!d || d.erased) throw new Error("Download is not in the history");
        if (d.removed) throw new Error("Download file already deleted");
        d.removed = true;
      },
      async erase({ id, filenameRegex, state } = {}) {
        const re = filenameRegex ? new RegExp(filenameRegex) : null;
        const hit = [...downloadsList.values()].filter((d) => !d.erased && (id == null || d.id === id) && (!re || re.test("/home/user/Downloads/" + d.filename) /* Firefox reports absolute paths */) && (!state || d.state === state));
        for (const d of hit) d.erased = true;
        return hit.map((d) => d.id);
      },
    },

    // The default engine is "Fake Search". With a tabId the query loads in that tab.
    search: {
      async search({ query, tabId, disposition }) {
        if (!MANIFEST_PERMISSIONS.includes("search")) throw new Error("browser.search is undefined (needs the search permission)");
        const url = `https://search.test/?q=${encodeURIComponent(query)}`;
        sim.searches.push({ query, tabId, disposition });
        if (tabId != null) {
          if (!tabs.has(tabId)) throw new Error(`Invalid tab ID: ${tabId}`);
          await sim.navigate(tabId, url);
        } else {
          await browser.tabs.create({ url });
        }
      },
    },

    commands: { onCommand: E.command },
  };

  // ---- test helpers (not part of the real API) ---------------------------

  const sim = {
    tabs, wins, containers, storage, E, tabValues, winValues, reloads,
    downloads: downloadsList,
    downloadFails: null,
    searches: [],
    history: [], // goBack / goForward calls
    pageMessages: [], // tabs.sendMessage calls
    // A message from a content script in a tab, the way the background receives it.
    async fromPage(tabId, msg) {
      const rs = await E.message.dispatch(msg, { tab: clone(tabs.get(tabId)) });
      return rs.find((r) => r !== undefined);
    },
    liveDownloads() { return [...downloadsList.values()].filter((d) => !d.removed); },
    reloadDoesNotWake: false,
    instantDownloads: false, // true: a download is already complete when download() returns

    // A download ends: the real browser reports it through downloads.onChanged.
    async finishDownload(id, state = "complete", error) {
      const d = downloadsList.get(id);
      d.state = state;
      await E.dlChanged.dispatch({ id, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
    },

    async discardTab(tabId) {
      const t = tabs.get(tabId);
      t.discarded = true;
      await E.tabUpdated.dispatch(tabId, { discarded: true }, clone(t));
    },

    addWindow({ incognito = false } = {}) {
      const w = { id: nextWin++, focused: true, incognito };
      wins.set(w.id, w);
      E.winCreated.fire({ ...w });
      return w;
    },

    // Simulate tabs that exist before the extension starts.
    seedTab({ windowId, url, title, active = false, cookieStoreId = "firefox-default", pinned = false, discarded = false }) {
      const tab = {
        id: nextTab++, windowId, index: inWin(windowId).length, url, title: title ?? url, active, pinned,
        hidden: false, discarded, audible: false, status: "complete", cookieStoreId, incognito: !!wins.get(windowId)?.incognito,
        mutedInfo: { muted: false },
      };
      tabs.set(tab.id, tab);
      return tab.id;
    },

    async setAudible(tabId, audible) {
      const t = tabs.get(tabId);
      t.audible = audible;
      await E.tabUpdated.dispatch(tabId, { audible }, clone(t));
    },

    // User navigates a tab. Blocking webRequest listeners may cancel it.
    async navigate(tabId, url) {
      const tab = tabs.get(tabId);
      const results = await E.beforeRequest.dispatch({ tabId, url, type: "main_frame" });
      if (results.some((r) => r?.cancel)) return false;
      tab.url = url;
      tab.title = url;
      await E.tabUpdated.dispatch(tabId, { url, title: url }, clone(tab));
      return true;
    },

    // A page opens a link in a new tab (middle click).
    // signal: "opener"      tab.openerTabId is set (the usual case)
    //         "navigation"  no openerTabId, but webNavigation reports the source first
    //         "late"        no openerTabId; webNavigation reports it after the tab appeared
    //         "none"        Firefox gives no evidence at all
    async openFrom(openerTabId, url, { active = false, signal = "opener" } = {}) {
      const opener = tabs.get(openerTabId);
      const props = { windowId: opener.windowId, url, active };
      if (signal === "opener") props.openerTabId = openerTabId;
      const nextId = [...tabs.keys()].reduce((a, b) => Math.max(a, b), 0) + 1;
      if (signal === "navigation") await E.navTarget.dispatch({ sourceTabId: openerTabId, tabId: nextId, url });
      const tab = await browser.tabs.create(props);
      if (signal === "late") {
        await new Promise((r) => setTimeout(r, 25)); // after Grove has already placed the tab
        await E.navTarget.dispatch({ sourceTabId: openerTabId, tabId: tab.id, url });
      }
      return tab;
    },

    // Ctrl+T: a tab with no opener and no evidence of any link.
    async userNewTab({ windowId } = {}) {
      return browser.tabs.create({ windowId: windowId ?? [...wins.keys()].at(-1), active: true });
    },

    async closeWindow(windowId) {
      for (const t of inWin(windowId)) {
        tabs.delete(t.id);
        await E.tabRemoved.dispatch(t.id, { windowId, isWindowClosing: true });
      }
      wins.delete(windowId);
      await E.winRemoved.dispatch(windowId);
    },

    visible(windowId) { return inWin(windowId).filter((t) => !t.hidden).map(clone); },
    hidden(windowId) { return inWin(windowId).filter((t) => t.hidden).map(clone); },
    byUrl(url) { return [...tabs.values()].filter((t) => t.url === url).map(clone); },

    // Open a port like the sidebar does and collect pushed states.
    connectUi({ windowId = null } = {}) {
      const received = [];
      const msgListeners = new Set();
      const discListeners = new Set();
      const uiPort = {
        name: "grove-ui",
        postMessage: (m) => received.push(m),
        onMessage: { addListener: (f) => msgListeners.add(f) },
        onDisconnect: { addListener: (f) => discListeners.add(f) },
      };
      E.connect.fire(uiPort);
      if (windowId != null) msgListeners.forEach((f) => f({ type: "hello", windowId }));
      return { received, last: () => received.filter((m) => m.type === "state").at(-1)?.state, disconnect: () => discListeners.forEach((f) => f()) };
    },
  };

  return { browser, sim };
}

export const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
