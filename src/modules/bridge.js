// bridge: the only door between the background and the UI pages (sidebar,
// options). Pages never touch the store or other modules directly.
//
//   page -> background   runtime.sendMessage({ type: "cmd", name, args })  -> result
//   background -> page   a long-lived port named "grove-ui" receives
//                        { type: "state", state } whenever anything changes
//
// Extension points for other modules:
//   hooks "ui:state"   (state, ctx)        add data to what the UI receives
//   hooks "ui:menu"    (items, { node, selection })   add context-menu items
//                      node: the row, or null; selection: ids when several rows are selected
//     item: { id, label, command, args?, separator?, danger? }

import { debounce } from "../lib/util.js";
import * as T from "../lib/tree.js";

export default {
  name: "bridge",
  deps: ["tree", "panels", "windows", "tabs", "settings"],

  setup({ api, bus, hooks, commands, store, log, modules }) {
    const { tree, windows, tabs } = modules;
    // port -> { private }. A port is normal until it says which window it belongs to
    // and the background confirms that window is private.
    const ports = new Map();

    // One state per audience. Private tabs exist only in memory and only ever go to the
    // sidebar of a private window; everything else gets the same state it always did.
    async function buildState({ private: priv = false } = {}) {
      const nodes = T.visibleTo(tree.all(), priv);
      // Only windows of the same kind are listed, so a private window's panel and tab ids
      // never reach a normal sidebar either.
      const wins = windows.windowIds().filter((w) => windows.isPrivate(w) === priv);
      const base = {
        private: priv,
        panels: store.get("panels").filter((p) => !!p.private === priv),
        nodes,
        activePanels: Object.fromEntries(wins.map((w) => [w, windows.getView(w).panelId])),
        views: Object.fromEntries(wins.map((w) => [w, windows.getView(w)])),
        activeNodes: Object.fromEntries(
          wins.map((w) => {
            const id = tabs.activeNode(w) ?? null;
            return [w, id && nodes[id] ? id : null];
          })
        ),
        rules: store.get("rules") ?? [],
        settings: store.get("settings"),
      };
      return hooks.run("ui:state", base, { private: priv });
    }

    let sending = false;
    let again = false;
    async function push() {
      if (sending) {
        again = true;
        return;
      }
      sending = true;
      try {
        do {
          again = false;
          if (ports.size === 0) break;
          const cache = new Map(); // build each audience's state once
          for (const [p, scope] of [...ports]) {
            try {
              if (!cache.has(scope.private)) cache.set(scope.private, await buildState(scope));
              p.postMessage({ type: "state", state: cache.get(scope.private) });
            } catch {
              ports.delete(p);
            }
          }
        } while (again);
      } finally {
        sending = false;
      }
    }
    const schedulePush = debounce(push, 30);

    for (const ev of [
      "tree:changed", "panel:changed", "panel:deleted", "window:viewChanged",
      "tab:activated", "settings:changed", "store:changed", "containers:changed",
    ]) {
      bus.on(ev, schedulePush);
    }

    const onConnect = (port) => {
      if (port.name !== "grove-ui") return;
      const scope = { private: false };
      ports.set(port, scope);
      port.onDisconnect.addListener(() => ports.delete(port));
      const send = () =>
        buildState(scope)
          .then((state) => port.postMessage({ type: "state", state }))
          .catch((e) => log.error(e));
      port.onMessage.addListener(async (msg) => {
        if (msg?.type !== "hello") return;
        // Never trust the page's word for it: ask the browser whether that window is private.
        if (msg.windowId != null) {
          scope.private = await api.windows.get(msg.windowId).then((w) => !!w.incognito, () => false);
        }
        send();
      });
      send();
    };
    api.runtime.onConnect.addListener(onConnect);

    const onMessage = (msg) => {
      if (!msg || msg.type !== "cmd") return undefined;
      return commands
        .run(msg.name, msg.args ?? {})
        .then((result) => ({ ok: true, result }))
        .catch((err) => {
          log.error(`command ${msg.name} failed`, err);
          return { ok: false, error: String(err?.message ?? err) };
        });
    };
    api.runtime.onMessage.addListener(onMessage);

    // ---- commands for the UI ---------------------------------------------

    // One row, or `ids` (several selected rows, in the order they appear).
    commands.register("ui:menu", async ({ id = null, ids = null }) => {
      const selection = Array.isArray(ids) && ids.length > 1 ? ids.filter((i) => tree.get(i)) : null;
      const node = selection ? null : tree.get(id) ?? null;
      const items = await hooks.run("ui:menu", [], { node, selection });
      return items;
    });

    commands.register("ui:state", () => buildState());
    commands.register("commands:list", () => commands.list());

    // Keyboard shortcuts declared in manifest.json map straight onto commands.
    const onCommand = async (name) => {
      const win = await api.windows.getLastFocused().catch(() => null);
      if (!win) return;
      const windowId = win.id;
      if (name === "panel-next") return commands.run("panel:next", { windowId });
      if (name === "panel-prev") return commands.run("panel:prev", { windowId });
      if (name === "outdent-tab") return commands.run("tab:outdentActive", { windowId });
    };
    api.commands?.onCommand.addListener(onCommand);

    return {
      exports: { push, buildState },
      teardown() {
        api.runtime.onConnect.removeListener(onConnect);
        api.runtime.onMessage.removeListener(onMessage);
        api.commands?.onCommand.removeListener(onCommand);
      },
    };
  },
};
