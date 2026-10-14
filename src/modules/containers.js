// containers: configure Firefox containers per panel and per domain.
//
//  - A rule maps a domain pattern (optionally limited to one panel) to a
//    container. Panel-specific rules beat global ones; see lib/rules.js.
//  - A panel can have a default container, used for NEW blank tabs in it
//    (a tab that already shows a page is left alone unless a rule matches).
//
// Enforcement happens in a blocking webRequest listener: a navigation that
// belongs in another container is cancelled before any request leaves the
// browser and reopened in the right container, keeping the tab's node, panel
// and place in the tree.
//
// Rules always win, with one exception: a tab YOU reopened in a container
// ("Reopen in container…") is locked there (setting "respectManual").
// Every decision is written to the diagnostics log, so "why didn't my rule
// fire" can be answered from the settings page.

import { uid } from "../lib/util.js";
import { DEFAULT_STORE, explain, compilePattern, normalizePattern, patternKey, migrateRules } from "../lib/rules.js";
import { openableUrl } from "./tabs.js";

const BLANK = /^(about:(newtab|blank|home)|)$/i;
const RETRY_AFTER_MS = 30_000;

export default {
  name: "containers",
  deps: ["tabs", "panels", "tree", "windows", "settings", "diagnostics"],

  async setup({ api, bus, commands, store, log, modules }) {
    const { tabs, panels, tree, windows, settings, diagnostics } = modules;

    store.defaults("rules", []);
    settings.register("containers", {
      enforce: { type: "boolean", label: "Open sites in their assigned containers", default: true },
      respectManual: {
        type: "boolean",
        label: "Never override a tab I reopened in a container myself",
        default: true,
      },
    });

    const rules = () => store.get("rules");

    // Rules from older versions: one rule per pattern, with a list of panels.
    // The old list is kept under "rulesBefore" and anything that had to be
    // dropped (same pattern, different containers) is written to the log.
    {
      const saved = rules();
      if (saved.some((r) => !Array.isArray(r.panelIds))) {
        const { rules: next, dropped } = migrateRules(saved);
        store.set("rulesBefore", saved);
        store.set("rules", next);
        for (const r of dropped) {
          diagnostics.log("route", { url: r.pattern, action: "migrated", wanted: r.containerId, reason: "dropped on upgrade: another rule for the same pattern already existed" });
          log.warn("container rule dropped on upgrade", r);
        }
      }
    }

    async function listContainers() {
      try {
        const res = await api.contextualIdentities.query({});
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
    }

    const ctx = () => ({ rules: rules(), panels: panels.list() });
    const desiredFor = (url, panelId) => explain(ctx(), url, panelId).containerId;

    // Containers that failed to open recently, so a deleted container does not
    // cause a loop. Entries expire, so one hiccup does not disable it for good.
    const failed = new Map();
    const recentlyFailed = (id) => (failed.get(id) ?? 0) > Date.now();

    // Where a tab Grove is about to open in `panelId` should go: the container a rule
    // gives for the address, else the panel's own. null = leave it as Firefox opens it.
    function containerForNew(url, panelId) {
      if (!settings.get("containers", "enforce")) return null;
      const id = desiredFor(url, panelId);
      if (!id || id === DEFAULT_STORE || recentlyFailed(id)) return null;
      return id;
    }
    function noteFailed(id, err) {
      failed.set(id, Date.now() + RETRY_AFTER_MS);
      log.warn("could not open a tab in container", id, err);
      diagnostics.log("route", { url: "", action: "error", wanted: id, reason: String(err?.message ?? err) });
    }

    // What should happen to this tab for this URL, and why.
    function decide({ node, tab, url, panelId }) {
      const hit = explain(ctx(), url, panelId);
      const out = (action, reason) => ({ action, reason, ...hit });
      if (hit.containerId == null) return out("none", "no rule matches and the panel has no default container");
      const why = hit.via === "rule" ? `rule “${hit.rule.pattern}”` : "the panel's default container";
      if (tab.cookieStoreId === hit.containerId) return out("skip", `already in the right container (${why})`);
      if (hit.via === "panel" && !BLANK.test(tab.url ?? "")) {
        return out("skip", "the panel's default container only applies to new blank tabs");
      }
      if (settings.get("containers", "respectManual") && node?.containerLocked) {
        return out("skip", "you reopened this tab in a container yourself");
      }
      if (recentlyFailed(hit.containerId)) return out("skip", "that container could not be opened a moment ago");
      return out("reroute", why);
    }

    function logDecision({ tab, url, panelId, d, note }) {
      diagnostics.log("route", {
        url,
        panel: panels.find(panelId)?.name ?? "?",
        tabContainer: tab.cookieStoreId,
        wanted: d?.containerId ?? null,
        action: d?.action ?? "skip",
        reason: note ?? d?.reason,
      });
    }

    // ---- rerouting -------------------------------------------------------

    // Reopen a tab's node in another container. Keeps the node, its place in
    // the tree and its panel; only the browser tab is replaced. `lock` marks the
    // node as chosen by you, so rules stop overriding it.
    async function reopen(nodeId, cookieStoreId, { url, closeOld = true, lock = false } = {}) {
      const node = tree.get(nodeId);
      const oldTabId = tabs.tabIdOf(nodeId);
      if (!node || oldTabId == null) return false;
      const old = await api.tabs.get(oldTabId);
      const props = { windowId: old.windowId, active: old.active, pinned: old.pinned, index: old.index + 1 };
      if (cookieStoreId && cookieStoreId !== DEFAULT_STORE) props.cookieStoreId = cookieStoreId;
      else if (old.cookieStoreId && old.cookieStoreId !== DEFAULT_STORE) props.cookieStoreId = DEFAULT_STORE;
      const target = openableUrl(url ?? old.url);
      if (target) props.url = target;

      if (lock) tree.mutate((all) => { if (all[nodeId]) all[nodeId].containerLocked = true; }, "lock");

      if (closeOld) {
        await tabs.createTab(props, { nodeId });
        tabs.ignoreRemoval(oldTabId);
        await api.tabs.remove(oldTabId);
      } else {
        // Keep the old tab (it has history); the new tab opens as its child.
        await tabs.createTab(props, { placement: { parentId: node.id, index: null, panelId: node.panelId } });
      }
      return true;
    }

    const rerouting = new Set();
    async function route(tabId, url, d) {
      if (rerouting.has(tabId)) return false;
      rerouting.add(tabId);
      try {
        const nodeId = await tabs.whenNode(tabId);
        if (!nodeId) return false;
        const tab = await api.tabs.get(tabId);
        const hadPage = !BLANK.test(tab.url ?? "");
        try {
          await reopen(nodeId, d.containerId, { url, closeOld: !hadPage });
          return true;
        } catch (err) {
          failed.set(d.containerId, Date.now() + RETRY_AFTER_MS);
          log.warn("could not reopen in container", d.containerId, err);
          diagnostics.log("route", { url, action: "error", wanted: d.containerId, reason: String(err?.message ?? err) });
          return false;
        }
      } finally {
        rerouting.delete(tabId);
      }
    }

    // Blocking webRequest: cancel and reroute before anything is sent.
    const onBeforeRequest = async (details) => {
      if (details.tabId < 0) return {};
      try {
        const enforce = settings.get("containers", "enforce");
        // The tab may not have been seen yet when its first request starts.
        const nodeId = await tabs.whenNode(details.tabId);
        const node = nodeId ? tree.get(nodeId) : null;
        const tab = await api.tabs.get(details.tabId);
        if (tab.incognito) return {};
        const panelId = node?.panelId ?? windows.getActive(tab.windowId);
        const d = decide({ node, tab, url: details.url, panelId });
        if (!enforce) {
          logDecision({ tab, url: details.url, panelId, d, note: "enforcement is turned off in settings" });
          return {};
        }
        if (d.action === "reroute" && !node) {
          logDecision({ tab, url: details.url, panelId, d, note: "Grove was not tracking this tab yet" });
          return {};
        }
        logDecision({ tab, url: details.url, panelId, d });
        if (d.action !== "reroute") return {};
        route(details.tabId, details.url, d); // fire and forget; the request is cancelled below
        return { cancel: true };
      } catch (err) {
        log.debug("webRequest check failed", err);
        diagnostics.log("route", { url: details.url, action: "error", reason: String(err?.message ?? err) });
        return {};
      }
    };

    api.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
      ["blocking"]
    );

    // A new tab you opened yourself (Ctrl+T, Firefox's + button) in a panel that has a
    // container: nothing is requested yet, so the request check above cannot see it.
    // Swap it for an identical empty tab in the panel's container right away.
    // Only the plain new-tab page is touched: a tab that is already loading something
    // (a link, an external app) would lose its address, and those are handled on request.
    const NEWTAB = /^about:(newtab|home)$/i;
    const EMPTY = /^(about:blank)?$/i;

    async function swapNewTab(tab, nodeId) {
      try {
        const node = nodeId ? tree.get(nodeId) : null;
        if (!node || node.private) return;
        const want = containerForNew("", node.panelId);
        if (!want || want === tab.cookieStoreId) return;
        diagnostics.log("route", { url: tab.url, panel: panels.find(node.panelId)?.name ?? "?", tabContainer: tab.cookieStoreId, wanted: want, action: "reroute", reason: "new tab opened in a panel with a default container" });
        try {
          await reopen(nodeId, want, { closeOld: true });
        } catch (err) {
          noteFailed(want, err);
        }
      } catch (err) {
        log.debug("new-tab container check failed", err);
      }
    }

    // Firefox may announce a Ctrl+T tab as about:blank (or with no address) and give it the
    // new-tab page a moment later, and not always with an event that says so. So a blank tab is
    // watched: on every update of it, and by looking again a few times. Once it shows the new-tab
    // page it is swapped; once it shows anything else it is a real page and left alone.
    const watching = new Map(); // tabId -> { timers }
    const stopWatching = (tabId) => {
      for (const t of watching.get(tabId) ?? []) clearTimeout(t);
      watching.delete(tabId);
    };

    async function check(tabId, nodeId, fallbackTab) {
      if (!watching.has(tabId)) return;
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab) return stopWatching(tabId);
      const url = tab.url ?? fallbackTab?.url ?? "";
      if (NEWTAB.test(url)) {
        stopWatching(tabId);
        await swapNewTab(tab, nodeId);
      } else if (!EMPTY.test(url)) {
        stopWatching(tabId); // a page: not ours to swap
        diagnostics.log("route", { url, action: "skip", reason: "blank tab became a page, not the new-tab page: left alone" });
      }
    }

    const onCreated = async ({ tab, nodeId, claimed }) => {
      if (claimed || tab.incognito) return;
      const url = tab.url ?? "";
      if (NEWTAB.test(url)) return swapNewTab(tab, nodeId);
      if (EMPTY.test(url)) {
        diagnostics.log("route", { url: url || "(no address)", action: "watch", reason: "tab opened blank: waiting to see whether it becomes the new-tab page" });
        stopWatching(tab.id);
        watching.set(tab.id, [150, 500, 1200, 3000].map((ms) => {
          const t = setTimeout(() => check(tab.id, nodeId), ms);
          t.unref?.();
          return t;
        }));
      }
    };
    const onUpdated = async ({ tabId, nodeId, tab }) => {
      if (watching.has(tabId)) await check(tabId, nodeId, tab);
    };
    bus.on("tab:updated", onUpdated);
    const onRemovedTab = ({ tabId }) => stopWatching(tabId);
    bus.on("tab:removed", onRemovedTab);
    bus.on("tab:created", onCreated);

    // ---- commands --------------------------------------------------------

    commands.register("containers:list", async () => [
      { cookieStoreId: DEFAULT_STORE, name: "No container", color: "grey", icon: "circle" },
      ...(await listContainers()),
    ]);

    commands.register("containers:create", async ({ name, color = "blue", icon = "fingerprint" }) => {
      const c = await api.contextualIdentities.create({ name, color, icon });
      await bus.emit("containers:changed", {});
      return c.cookieStoreId;
    });

    commands.register("containers:remove", async ({ cookieStoreId }) => {
      await api.contextualIdentities.remove(cookieStoreId);
      await bus.emit("containers:changed", {});
      return true;
    });

    // You chose this container for this tab: rules will not override it.
    commands.register("containers:reopen", ({ id, cookieStoreId }) =>
      reopen(id, cookieStoreId, { closeOld: true, lock: true }), { title: "Reopen in container" });

    // "What would happen for this URL in this panel?" (used by the settings page)
    commands.register("containers:test", ({ url, panelId = null }) => {
      let u = String(url ?? "").trim();
      if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
      const hit = explain(ctx(), u, panelId ?? panels.listFor(false)[0]?.id);
      return { url: u, containerId: hit.containerId, via: hit.via, pattern: hit.rule?.pattern ?? null };
    });

    const cleanPattern = (pattern) => {
      const cleaned = normalizePattern(pattern);
      if (!cleaned || !compilePattern(cleaned)) throw new Error(`Invalid pattern: ${pattern}`);
      return cleaned;
    };

    // One rule per pattern; panelIds empty = any panel.
    const cleanPanels = ({ panelIds, panelId }) => {
      const list = Array.isArray(panelIds) ? panelIds : panelId ? [panelId] : [];
      const known = new Set(panels.listFor(false).map((p) => p.id));
      return [...new Set(list)].filter((id) => known.has(id));
    };
    const assertUnique = (pattern, exceptId = null) => {
      const clash = rules().find((r) => r.id !== exceptId && patternKey(r.pattern) === patternKey(pattern));
      if (clash) throw new Error(`There is already a rule for “${clash.pattern}”. Edit that one and choose more panels instead.`);
    };

    commands.register("rules:add", ({ pattern, containerId, ...scope }) => {
      const cleaned = cleanPattern(pattern);
      assertUnique(cleaned);
      const rule = { id: uid("r"), pattern: cleaned, panelIds: cleanPanels(scope), containerId };
      store.set("rules", [...rules(), rule]);
      failed.clear();
      return rule.id;
    });

    commands.register("rules:update", ({ id, ...fields }) => {
      if ("pattern" in fields) {
        fields.pattern = cleanPattern(fields.pattern);
        assertUnique(fields.pattern, id);
      }
      if ("panelIds" in fields || "panelId" in fields) fields.panelIds = cleanPanels(fields);
      store.set(
        "rules",
        rules().map((r) =>
          r.id === id
            ? { ...r, ...Object.fromEntries(["pattern", "panelIds", "containerId"].filter((k) => k in fields).map((k) => [k, fields[k]])) }
            : r
        )
      );
      failed.clear();
      return true;
    });

    commands.register("rules:remove", ({ id }) => {
      store.set("rules", rules().filter((r) => r.id !== id));
      return true;
    });

    commands.register("rules:reorder", ({ ids }) => {
      const byId = new Map(rules().map((r) => [r.id, r]));
      const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
      for (const r of rules()) if (!ordered.includes(r)) ordered.push(r);
      store.set("rules", ordered);
      return true;
    });

    return {
      exports: { listContainers, desiredFor, containerForNew, noteFailed, reopen, route, decide },
      teardown() {
        bus.off("tab:created", onCreated);
        bus.off("tab:updated", onUpdated);
        bus.off("tab:removed", onRemovedTab);
        for (const id of [...watching.keys()]) stopWatching(id);
        api.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
      },
    };
  },
};
