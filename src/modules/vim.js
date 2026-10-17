// vim: keyboard navigation in the style of Vim and Vimium, working on web pages and
// while the sidebar has the focus (src/content/keys.js recognises the keys).
//
//   gt  next tab            gT, gs  previous tab      (in the order of the sidebar)
//   t   new tab in the current panel (honours the panel's container)
//   x   close the tab (never the window: the last tab is replaced by a new one)     r   reload
//   /   search: on a page a find bar (content/find.js, handled right there); in the sidebar Grove's tab search
//   H   back                L       forward
//   <<  move the tab up     >>      move it down      (among its siblings, never across levels)
//   j k d u gg G  scroll the page (done by src/content/keys.js on the page itself; a setting turns them off)
//   f   label what can be clicked (src/content/hints.js, on the page itself); Shift + the last letter
//       of a link's label opens it in a new tab as a child of this one (here, in the background)
//
// Off by default; Settings → vim turns it on, pauses it, lists sites where it stays out
// of the way, and says whether next/previous stop on tabs that are not loaded.
//
// Messages from pages:  { type: "vim:config" } -> { active, scroll, hints, hintChars }
//                       { type: "vim:key", action }     { type: "vim:hint", url }
// Command for the sidebar:  vim:do { action, windowId }

import * as T from "../lib/tree.js";
import { compilePattern, hostname } from "../lib/rules.js";

export default {
  name: "vim",
  deps: ["tree", "windows", "tabs", "settings", "diagnostics"],

  setup({ api, bus, commands, log, modules }) {
    const { tree, windows, tabs, settings, diagnostics } = modules;

    settings.register("vim", {
      enabled: {
        type: "boolean",
        label: "Vim-style keys: gt / gs / gT next and previous tab, t new tab, x close tab, r reload, / search (find in the page, or Grove's search in the sidebar), H / L back and forward, << and >> move the tab up and down. Works on pages and while the sidebar is focused. Untick to pause",
        default: false,
      },
      scrollKeys: {
        type: "boolean",
        label: "Also scroll with j / k (a little), d / u (half a page), gg / G (top, bottom of the page). Untick if another extension owns these",
        default: true,
      },
      hints: {
        type: "boolean",
        label: "f labels everything clickable on the page; type a label to click it. Shift with the last letter of a link's label opens it in a new tab, as a child of this one",
        default: true,
      },
      hintChars: {
        type: "text",
        label: "Letters the labels are made of (at least four, letters only; the first ones get the shortest labels)",
        default: "asdfghjklqwertyuiop",
      },
      hintForeground: {
        type: "boolean",
        label: "A link opened with Shift + its label comes to the front (otherwise it opens behind, so you can keep reading)",
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
    // What a page is told: whether its keys are on, and how.
    const configFor = (url) => {
      const active = activeFor(url);
      return { active, scroll: !!get("scrollKeys"), hints: active && !!get("hints"), hintChars: String(get("hintChars") ?? "") };
    };

    // ---- what the keys do ------------------------------------------------

    const BLANK = /^(about:(blank|newtab|home)|)$/i;

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
        case "reload": {
          const id = tabId ?? tabs.tabIdOf(currentNode(windowId, null));
          if (id == null) return false;
          try {
            await api.tabs.reload(id);
            return true;
          } catch {
            return false;
          }
        }
        case "search":
          return commands.run("ui:search", { windowId });
        case "close": {
          const id = currentNode(windowId, tabId);
          if (!id) return false;
          // Closing the only tab would close the window. Never: a new tab takes its place
          // (and if this one is already empty there is nothing to do).
          if (tabs.tabIdOf(id) != null) {
            const open = (await api.tabs.query({ windowId })).filter((t) => !t.hidden);
            if (open.length <= 1) {
              if (BLANK.test(open[0]?.url ?? "")) return false;
              await commands.run("tab:new", { windowId, panelId: windows.getView(windowId).panelId });
            }
          }
          return commands.run("tab:close", { id, mode: "self" });
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

    // ---- stray repeats ---------------------------------------------------
    // One press of a key must do one thing. If the same key reaches us twice (a second listener
    // for the same keystroke), the second is dropped: the same action again, or a bare `t` right after
    // a sequence such as gt. A person cannot type either that fast (milliseconds, against
    // the 150 or more between keystrokes), so nothing real is lost.
    const guard = { same: 100, newAfterSequence: 100 };
    const SEQUENCE = new Set(["next", "prev", "up", "down"]);
    const recent = new Map(); // windowId -> { action, at }
    function stray(windowId, action) {
      const last = recent.get(windowId);
      if (!last) return null;
      const age = Date.now() - last.at;
      if (action === last.action && age < guard.same) return "the same key arrived twice";
      if (action === "new" && SEQUENCE.has(last.action) && age < guard.newAfterSequence) return `a bare t right after ${last.action}`;
      return null;
    }

    // Every key goes through here, from a page or from the sidebar.
    async function press(action, { windowId, tabId = null }, from) {
      const why = stray(windowId, action);
      diagnostics.log("vim", { action, from, result: why ? `ignored: ${why}` : "done" });
      if (why) return false;
      recent.set(windowId, { action, at: Date.now() });
      return act(action, { windowId, tabId });
    }

    // ---- doors -----------------------------------------------------------

    const onMessage = (msg, sender) => {
      if (msg?.type === "vim:config") return Promise.resolve(configFor(sender?.tab?.url));
      if (msg?.type === "vim:hint") return hint(msg.url, sender);
      if (msg?.type === "vim:key") {
        if (!activeFor(sender?.tab?.url)) return Promise.resolve(false);
        const from = `page${sender.frameId ? ` (frame ${sender.frameId})` : ""}`;
        return press(msg.action, { windowId: sender.tab?.windowId, tabId: sender.tab?.id }, from).catch((e) => { log.warn("vim key failed", e); return false; });
      }
      return undefined;
    };
    api.runtime.onMessage.addListener(onMessage);

    // Shift + the last letter of a link's label: a new tab, as a child of the one the key was pressed in,
    // in the same container, behind it (unless settings say otherwise).
    async function hint(url, sender) {
      const tab = sender?.tab;
      if (!tab || !activeFor(tab.url) || !get("hints") || !/^(https?|ftp|file):\/\//i.test(String(url ?? ""))) return false;
      diagnostics.log("vim", { action: "hint", from: "page", result: "done" });
      try {
        return await commands.run("tab:new", {
          windowId: tab.windowId,
          parentId: tabs.nodeIdOf(tab.id) ?? null,
          url,
          cookieStoreId: tab.cookieStoreId,
          active: !!get("hintForeground"),
        });
      } catch (e) {
        log.warn("could not open a hinted link", e);
        return false;
      }
    }

    commands.register("vim:do", ({ action, windowId }) => (get("enabled") ? press(action, { windowId }, "sidebar") : false));

    // Pausing, or changing the exceptions, reaches pages that are already open.
    async function tellPages() {
      const all = await api.tabs.query({}).catch(() => []);
      for (const t of all) api.tabs.sendMessage?.(t.id, { type: "vim:active", ...configFor(t.url) })?.catch?.(() => {});
    }
    const onSettings = ({ module }) => module === "vim" && tellPages();
    bus.on("settings:changed", onSettings);

    return {
      exports: { act, activeFor, excluded, guard },
      teardown() {
        api.runtime.onMessage.removeListener(onMessage);
        bus.off("settings:changed", onSettings);
      },
    };
  },
};
