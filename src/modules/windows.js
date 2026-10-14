// windows: remembers each browser window's *view*: which panel is active and,
// optionally, which folder inside it is open. Switching the view is a context
// switch (see panels.js: tabs outside the view are hidden).
//
//   view = { panelId, folderId | null }
//
// The view is stamped on the window (sessions.setWindowValue) so it survives a
// session restore. Each window also remembers the last folder it had open in
// every panel, so coming back to a panel returns you to where you were.
//
// Private windows have a space of their own: private panels (flagged `private`, kept in
// memory only, never saved) and the folders, notes and tabs in them. A window only ever
// uses panels of its own kind.
//
// Events: window:viewChanged { windowId, panelId, folderId, previous, changed }
//         window:closed { windowId, private }

const VIEW_KEY = "grove:view";
const LEGACY_PANEL_KEY = "grove:panel"; // v0.1 stored only the panel id

export default {
  name: "windows",
  deps: ["tree"],

  async setup({ api, bus, store, log, modules }) {
    const { tree } = modules;
    store.defaults("panels", [{ id: "p_main", name: "Main", color: "#4f8cff", defaultContainer: null }]);
    // Never saved: the private space lives and dies with the private windows.
    store.persistFilter("panels", (list) => (Array.isArray(list) ? list.filter((p) => !p.private) : list));
    const PRIVATE_PANEL = { id: "p_private", name: "Private", color: "#8b5cf6", defaultContainer: null, private: true };

    const privateWindows = new Set(); // ids of windows that are private
    const isPrivate = (windowId) => privateWindows.has(windowId);

    const views = new Map(); // windowId -> view
    const lastFolder = new Map(); // windowId -> Map(panelId -> folderId)

    const panels = (priv = false) => store.get("panels").filter((p) => !!p.private === !!priv);
    const panelExists = (id, priv = false) => panels(priv).some((p) => p.id === id);
    const firstPanelId = (priv = false) => panels(priv)[0]?.id ?? null;
    const isPrivatePanel = (id) => !!store.get("panels").find((p) => p.id === id)?.private;

    // A private window needs at least one private panel to put its tabs in.
    function ensurePrivatePanel() {
      if (panels(true).length) return;
      store.set("panels", [...store.get("panels"), { ...PRIVATE_PANEL }]);
      bus.emit("panel:changed", { reason: "private" });
    }

    function sanitize(view, priv = false) {
      let panelId = view?.panelId;
      if (!panelExists(panelId, priv)) panelId = firstPanelId(priv);
      let folderId = view?.folderId ?? null;
      if (folderId) {
        const f = tree.get(folderId);
        if (!f || f.type !== "folder" || f.panelId !== panelId) folderId = null;
      }
      return { panelId, folderId };
    }

    function remember(windowId, view) {
      if (!lastFolder.has(windowId)) lastFolder.set(windowId, new Map());
      lastFolder.get(windowId).set(view.panelId, view.folderId);
    }

    async function restore(windowId, priv = false) {
      if (priv) {
        // Nothing about a private window is remembered: it starts on its first private panel.
        privateWindows.add(windowId);
        ensurePrivatePanel();
        const view = sanitize(null, true);
        views.set(windowId, view);
        remember(windowId, view);
        return;
      }
      let saved = null;
      try {
        saved = await api.sessions.getWindowValue(windowId, VIEW_KEY);
        if (!saved) {
          const legacy = await api.sessions.getWindowValue(windowId, LEGACY_PANEL_KEY);
          if (legacy) saved = { panelId: legacy, folderId: null };
        }
      } catch {
        // sessions API unavailable for this window
      }
      const view = sanitize(saved);
      views.set(windowId, view);
      remember(windowId, view);
    }

    function getView(windowId) {
      const view = sanitize(views.get(windowId), isPrivate(windowId));
      views.set(windowId, view);
      return view;
    }

    async function setView(windowId, next) {
      const priv = isPrivate(windowId);
      const view = sanitize(next, priv);
      const previous = views.get(windowId) ?? null;
      views.set(windowId, view);
      remember(windowId, view);
      if (!priv) {
        try {
          await api.sessions.setWindowValue(windowId, VIEW_KEY, view);
        } catch (err) {
          log.debug("could not stamp window", err);
        }
      }
      const changed = !previous || previous.panelId !== view.panelId || previous.folderId !== view.folderId;
      await bus.emit("window:viewChanged", { windowId, ...view, previous, changed });
      return true;
    }

    // Switch panel. Clicking the panel you are already on goes to its top level;
    // switching to another panel returns to the folder you last had open there.
    async function setActive(windowId, panelId) {
      if (!panelExists(panelId, isPrivate(windowId))) return false;
      const current = views.get(windowId);
      const back = current?.panelId === panelId ? null : lastFolder.get(windowId)?.get(panelId) ?? null;
      return setView(windowId, { panelId, folderId: back });
    }

    for (const w of await api.windows.getAll()) await restore(w.id, !!w.incognito);

    const onCreated = (w) => restore(w.id, !!w.incognito);
    const onRemoved = (id) => {
      const priv = isPrivate(id);
      views.delete(id);
      lastFolder.delete(id);
      privateWindows.delete(id);
      bus.emit("window:closed", { windowId: id, private: priv, privateLeft: privateWindows.size });
    };
    api.windows.onCreated.addListener(onCreated);
    api.windows.onRemoved.addListener(onRemoved);

    return {
      exports: {
        getView,
        setView,
        isPrivate,
        isPrivatePanel,
        panelsFor: panels,
        getActive: (windowId) => getView(windowId).panelId,
        setActive,
        all: () => Object.fromEntries([...views.keys()].map((id) => [id, getView(id).panelId])),
        views: () => Object.fromEntries([...views.keys()].map((id) => [id, getView(id)])),
        windowIds: () => [...views.keys()],
      },
      teardown() {
        api.windows.onCreated.removeListener(onCreated);
        api.windows.onRemoved.removeListener(onRemoved);
      },
    };
  },
};
