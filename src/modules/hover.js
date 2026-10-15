// hover: what the sidebar shows when you rest the pointer on a tab.
//
// The tooltip (address, title, or both) and the preview popover are drawn by the
// sidebar from the "hover" settings. This module supplies the pictures.
//
// A preview is a screenshot of the tab (tabs.captureTab), taken while the tab is in front,
// a moment after it finishes loading and when you arrive on it. Firefox can only draw the tab
// you are looking at, so a tab you have never visited has no picture yet, and the sidebar
// says so. Pictures live in memory only: never saved, never in an export or a backup, and a
// private window's pictures go only to private windows' sidebars.
//
//   thumb:get { id, windowId } -> { dataUrl, ratio, at } | null

import { previewable, previewMode } from "../lib/hover.js";

const MAX_WIDTH = 640; // pixels; bigger than any preview is shown, so the width setting never upscales
const KEEP = 150; // pictures kept; the least recently taken go first
const STALE_MS = 10 * 60_000; // arriving on a tab refreshes a picture older than this

export default {
  name: "hover",
  deps: ["tree", "windows", "tabs", "settings"],

  setup({ api, bus, commands, log, modules }) {
    const { tree, windows, tabs, settings } = modules;

    settings.register("hover", {
      tooltip: {
        type: "select",
        label: "Hovering a tab shows",
        default: "url",
        options: [["url", "Its address"], ["title", "Its title"], ["both", "Its title and address"]],
      },
      preview: {
        type: "select",
        label: "Page preview (a picture of the page, taken while you view the tab)",
        default: "off",
        options: [["off", "Off"], ["row", "On, when hovering the tab"], ["favicon", "On, when hovering its icon only"]],
      },
      previewWidth: { type: "number", label: "Preview width in pixels (never wider than the sidebar)", default: 260, min: 120, max: 600 },
      previewDelay: { type: "number", label: "Wait this long before showing the preview (milliseconds)", default: 400, min: 0, max: 3000 },
    });

    const mode = () => previewMode({ preview: settings.get("hover", "preview") });
    const thumbs = new Map(); // node id -> { dataUrl, pageUrl, at, ratio }
    const timers = new Map(); // tab id -> timeout

    function put(nodeId, thumb) {
      thumbs.delete(nodeId);
      thumbs.set(nodeId, thumb);
      while (thumbs.size > KEEP) thumbs.delete(thumbs.keys().next().value);
    }

    // Take the picture of a tab, if it is in front and showing a real page.
    async function capture(tabId) {
      timers.delete(tabId);
      if (mode() === "off" || !api.tabs.captureTab) return false;
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (!tab || !tab.active || tab.discarded || !previewable({ type: "tab", url: tab.url })) return false;
      const nodeId = tabs.nodeIdOf(tabId);
      if (!nodeId) return false;
      const scale = tab.width > 0 ? Math.min(1, MAX_WIDTH / tab.width) : 0.5;
      let dataUrl;
      try {
        dataUrl = await api.tabs.captureTab(tabId, { format: "jpeg", quality: 70, scale });
      } catch (err) {
        log.debug("could not capture a tab", err); // a page Firefox will not draw, a minimised window...
        return false;
      }
      if (!dataUrl) return false;
      const now = await api.tabs.get(tabId).catch(() => null);
      if (!now || now.url !== tab.url) return false; // it moved on while the picture was taken
      const ratio = tab.width > 0 && tab.height > 0 ? tab.height / tab.width : 0.62;
      put(nodeId, { dataUrl, pageUrl: tab.url, at: Date.now(), ratio });
      return true;
    }

    function schedule(tabId, ms) {
      if (mode() === "off") return;
      clearTimeout(timers.get(tabId));
      const t = setTimeout(() => capture(tabId), ms);
      t.unref?.();
      timers.set(tabId, t);
    }

    bus.on("tab:updated", ({ tabId, changeInfo, tab }) => {
      if (changeInfo?.status === "complete" && tab?.active) schedule(tabId, 1000); // let the page paint
    });
    bus.on("tab:activated", ({ tabId, nodeId }) => {
      const have = thumbs.get(nodeId);
      const node = tree.get(nodeId);
      if (!have || have.pageUrl !== node?.url || Date.now() - have.at > STALE_MS) schedule(tabId, 700);
    });
    bus.on("tab:removed", ({ tabId }) => {
      clearTimeout(timers.get(tabId));
      timers.delete(tabId);
    });
    bus.on("tree:removed", ({ ids }) => ids.forEach((id) => thumbs.delete(id)));

    // Switching it on takes the pictures of what is in front now; off lets go of them all.
    bus.on("settings:changed", async ({ module }) => {
      if (module !== "hover") return;
      if (mode() === "off") {
        thumbs.clear();
        timers.forEach((t) => clearTimeout(t));
        timers.clear();
        return;
      }
      for (const t of await api.tabs.query({ active: true }).catch(() => [])) schedule(t.id, 300);
    });

    commands.register("thumb:get", ({ id, windowId = null }) => {
      const node = tree.get(id);
      const have = thumbs.get(id);
      if (!node || !have || mode() === "off") return null;
      // A private tab's picture goes only to a private window, and a normal one never to it.
      if (!!node.private !== (windowId != null && windows.isPrivate(windowId))) return null;
      if (have.pageUrl !== node.url) return null; // the tab has gone elsewhere since
      return { dataUrl: have.dataUrl, ratio: have.ratio, at: have.at };
    });

    return {
      exports: { capture, thumbCount: () => thumbs.size },
      teardown() {
        timers.forEach((t) => clearTimeout(t));
      },
    };
  },
};
