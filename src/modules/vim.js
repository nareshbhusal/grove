// vim: keyboard navigation in the style of Vim and Vimium, working on web pages and
// while the sidebar has the focus (src/content/keys.js recognises the keys).
//
//   gt  next tab            gT, gs  previous tab      (in the order of the sidebar)
//   t   new tab in the current panel (honours the panel's container)
//   H   back                L       forward
//   <<  move the tab up     >>      move it down      (among its siblings, never across levels)
//
// Off by default; Settings → vim turns it on, pauses it, lists sites where it stays out
// of the way, and says whether next/previous stop on tabs that are not loaded.
//
// Messages from pages:  { type: "vim:config" } -> { active }     { type: "vim:key", action }
// Command for the sidebar:  vim:do { action, windowId }

import * as T from "../lib/tree.js";
import { compilePattern, hostname } from "../lib/rules.js";

export default {
  name: "vim",
  deps: ["tree", "windows", "tabs", "settings"],

  setup({ api, bus, commands, log, modules }) {
    const { tree, windows, tabs, settings } = modules;

    settings.register("vim", {
      enabled: {
        type: "boolean",
        label: "Vim-style keys: gt / gs / gT next and previous tab, t new tab, H / L back and forward, << and >> move the tab up and down. Works on pages and while the sidebar is focused. Untick to pause",
        default: false,
      },
      includeUnloaded: {
        type: "boolean",
        label: "Next and previous tab also stop on tabs that are not loaded (loading them when you arrive)",
        default: true,
      },
      exceptions: {
        type: "lines",
        label: "Leave these sites alone, one pattern per line (github.com, *.example.com, example.com/docs, =example.com, or /regex/). Lines starting with # are ignored",
        default: "",
      },
    });

    const get = (k) => settings.get("vim", k);

    // ---- which pages -----------------------------------------------------

    let compiled = null;
    const patterns = () => {
      if (compiled?.src !== get("exceptions")) {
        const src = String(get("exceptions") ?? "");
        const tests = src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(compilePattern).filter(Boolean);
        compiled = { src: get("exceptions"), tests };
      }
      return compiled.tests;
    };
    const excluded = (url) => {
      if (!url) return false;
      const host = hostname(url);
      return patterns().some((test) => test(url, host));
    };
    const activeFor = (url) => !!get("enabled") && !excluded(url);

    // ---- what the keys do ------------------------------------------------

    // The tab the key was pressed in; from the sidebar, the active tab of the window.
    function currentNode(windowId, tabId) {
      if (tabId != null) return tabs.nodeIdOf(tabId) ?? null;
      return tabs.activeNode(windowId) ?? null;
    }

    // Tabs in the order the sidebar shows them (what is folded away is skipped).
    function order(windowId) {
      const view = windows.getView(windowId);
      const includeUnloaded = !!get("includeUnloaded");
      return T.flatten(tree.all(), view.panelId, view.folderId)
        .map((r) => r.node)
        .filter((n) => n.type === "tab" && !n.pinned && tabs.tabIdOf(n.id) != null && (includeUnloaded || !n.discarded));
    }

    async function step(windowId, tabId, dir) {
      const rows = order(windowId);
      if (!rows.length) return false;
      const at = rows.findIndex((n) => n.id === currentNode(windowId, tabId));
      let next;
      if (at < 0) next = dir > 0 ? rows[0] : rows[rows.length - 1]; // pinned, or outside this view
      else next = rows[(at + dir + rows.length) % rows.length];
      if (next.id === currentNode(windowId, tabId)) return false;
      return commands.run("tab:activate", { id: next.id, windowId });
    }

    async function act(action, { windowId, tabId = null }) {
      if (windowId == null) return false;
      switch (action) {
        case "next": return step(windowId, tabId, 1);
        case "prev": return step(windowId, tabId, -1);
        case "new": return commands.run("tab:new", { windowId, panelId: windows.getView(windowId).panelId });
        case "back":
        case "forward": {
          const id = tabId ?? tabs.tabIdOf(currentNode(windowId, null));
          if (id == null) return false;
          try {
            await (action === "back" ? api.tabs.goBack(id) : api.tabs.goForward(id));
            return true;
          } catch {
            return false; // nowhere to go
          }
        }
        case "up":
        case "down": {
          const id = currentNode(windowId, tabId);
          return id ? commands.run("tab:shift", { id, dir: action }) : false;
        }
        default:
          return false;
      }
    }

    // ---- doors -----------------------------------------------------------

    const onMessage = (msg, sender) => {
      if (msg?.type === "vim:config") return Promise.resolve({ active: activeFor(sender?.tab?.url) });
      if (msg?.type === "vim:key") {
        if (!activeFor(sender?.tab?.url)) return Promise.resolve(false);
        return act(msg.action, { windowId: sender.tab?.windowId, tabId: sender.tab?.id }).catch((e) => { log.warn("vim key failed", e); return false; });
      }
      return undefined;
    };
    api.runtime.onMessage.addListener(onMessage);

    commands.register("vim:do", ({ action, windowId }) => (get("enabled") ? act(action, { windowId }) : false));

    // Pausing, or changing the exceptions, reaches pages that are already open.
    async function tellPages() {
      const all = await api.tabs.query({}).catch(() => []);
      for (const t of all) api.tabs.sendMessage?.(t.id, { type: "vim:active", active: activeFor(t.url) })?.catch?.(() => {});
    }
    const onSettings = ({ module }) => module === "vim" && tellPages();
    bus.on("settings:changed", onSettings);

    return {
      exports: { act, activeFor, excluded },
      teardown() {
        api.runtime.onMessage.removeListener(onMessage);
        bus.off("settings:changed", onSettings);
      },
    };
  },
};
