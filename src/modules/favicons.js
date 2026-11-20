// favicons: decides which icon a tab row or a bookmark row shows.
//
// Firefox's tab.favIconUrl is not always usable as-is:
//   - inline data: icons are common and can be large (v0.1 dropped anything over 4 KB)
//   - internal pages report chrome:// / resource:// icons that an extension page cannot load
//   - the icon can be briefly missing while a page loads, or never set
//
// So: keep any http(s) icon and data: icons up to 32 KB, ignore the rest, and
// when a tab has no usable icon fall back to the last good one seen for the
// same SITE (host and port: localhost:3000 and localhost:5173 are different apps).
// Only short http(s) URLs go in the persistent cache, so it stays small.
//
// Bookmarks have no icon of their own in what extensions can read. They borrow the cache, and for sites the
// cache has never seen, the icon can be looked up in the background (`favicons:fill`): the page is fetched
// without cookies, its <link rel="icon"> read, and the icon checked. A site that has none is not asked again
// for a few days.
//
//   favicons:lookup { urls }   -> { [site]: iconUrl }     what is known now, for the sites of these addresses
//   favicons:fill   { urls }   -> { found, tried }        look the rest up (a few at a time), then say what was found

import { siteOf } from "../lib/util.js";

const MAX_DATA = 32 * 1024;
const MAX_URL = 2048;
const MAX_CACHED_URL = 512;
const MAX_SITES = 400;
const MISS_DAYS = 3;
const PER_RUN = 24; // sites looked up in one go
const PARALLEL = 3;
const PAGE_BYTES = 96 * 1024;
const TIMEOUT_MS = 8000;

export function usableIcon(url) {
  if (!url || typeof url !== "string") return null;
  if (/^https?:/i.test(url)) return url.length <= MAX_URL ? url : null;
  if (/^data:image\//i.test(url)) return url.length <= MAX_DATA ? url : null;
  return null; // chrome://, resource://, moz-extension://, about:
}

// The icon addresses a page's markup names, best first. `html` is the start of the page.
export function iconLinks(html, base) {
  const found = [];
  for (const tag of String(html ?? "").match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((x) => x != null);
    const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr("href");
    if (!href || !rel.some((r) => r === "icon" || r === "apple-touch-icon")) continue;
    let url;
    try { url = new URL(href.replace(/&amp;/g, "&"), base).href; } catch { continue; }
    const size = parseInt((attr("sizes") ?? "").split("x")[0], 10) || 0;
    // a plain icon beats a touch icon; among those the one nearest 32px
    found.push({ url, touch: rel.includes("apple-touch-icon") ? 1 : 0, off: size ? Math.abs(size - 32) : 16 });
  }
  return found.sort((a, b) => a.touch - b.touch || a.off - b.off).map((f) => f.url);
}

export default {
  name: "favicons",
  deps: ["settings"],

  setup({ store, commands, modules, log }) {
    const { settings } = modules;
    store.defaults("favicons", {});
    store.defaults("faviconMisses", {});
    const cache = () => store.get("favicons");

    settings.register("favicons", {
      lookup: {
        type: "boolean",
        label: "Look up missing bookmark icons in the background (fetches the bookmarked page without cookies, a few at a time, when you open your bookmarks; sites with no icon are not asked again for a few days)",
        default: true,
      },
    });

    function remember(site, url) {
      if (!site || !/^https?:/i.test(url) || url.length > MAX_CACHED_URL) return;
      const map = cache();
      if (map[site] === url) return;
      delete map[site]; // re-insert so the newest are last
      map[site] = url;
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) delete map[k];
      store.set("favicons", map, { silent: true });
    }

    // The icon to show for a browser tab (a url string or null).
    function resolve(tab) {
      const site = siteOf(tab.url);
      const own = usableIcon(tab.favIconUrl);
      if (own) {
        if (!tab.incognito) remember(site, own); // the cache is saved: a private tab must not add its site to it
        return own;
      }
      return (site && cache()[site]) || null;
    }

    function lookup(urls = []) {
      const map = cache();
      const out = {};
      for (const u of urls) {
        const site = siteOf(u);
        if (site && map[site]) out[site] = map[site];
      }
      return out;
    }

    // ---- looking up what is missing -----------------------------------------

    const get = async (url, { text = false } = {}) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", signal: ctl.signal, cache: "force-cache" });
        if (!res.ok) return null;
        if (!text) {
          const type = res.headers.get("content-type") ?? "";
          const len = Number(res.headers.get("content-length") ?? 0);
          void res.body?.cancel?.();
          return { res, type, len };
        }
        // only the start of the page: the icon link is in the <head>
        const reader = res.body?.getReader?.();
        if (!reader) return { res, html: (await res.text()).slice(0, PAGE_BYTES) };
        const dec = new TextDecoder();
        let html = "";
        while (html.length < PAGE_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          html += dec.decode(value, { stream: true });
          if (/<\/head>/i.test(html)) break;
        }
        void reader.cancel().catch(() => {});
        return { res, html };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    const looksLikeIcon = ({ type, len }, url) =>
      (/^image\//i.test(type) || (/octet-stream/i.test(type) && /\.ico(\?|$)/i.test(url))) && len <= 512 * 1024;

    async function discover(pageUrl) {
      const page = await get(pageUrl, { text: true });
      const base = page?.res?.url || pageUrl;
      const candidates = [...iconLinks(page?.html, base)];
      try { candidates.push(new URL("/favicon.ico", base).href); } catch { /* no base */ }
      for (const url of candidates.slice(0, 4)) {
        if (/^data:image\//i.test(url) && usableIcon(url)) return url;
        if (!/^https?:/i.test(url) || url.length > MAX_CACHED_URL) continue;
        const probe = await get(url);
        if (probe && looksLikeIcon(probe, url)) return url;
      }
      return null;
    }

    let running = null;
    async function fill(urls = []) {
      if (!settings.get("favicons", "lookup")) return { found: 0, tried: 0 };
      if (running) return running; // one at a time; the caller asks again when it needs more
      const map = cache();
      const misses = store.get("faviconMisses");
      const now = Date.now();
      const todo = new Map(); // site -> a page to read
      for (const u of urls) {
        const site = siteOf(u);
        if (!site || map[site] || todo.has(site)) continue;
        if (misses[site] && now - misses[site] < MISS_DAYS * 86_400_000) continue;
        todo.set(site, u);
        if (todo.size >= PER_RUN) break;
      }
      if (!todo.size) return { found: 0, tried: 0 };
      running = (async () => {
        let found = 0;
        const queue = [...todo];
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            const [site, page] = next;
            let icon = null;
            try { icon = await discover(page); } catch (err) { log.debug("icon lookup failed", site, err); }
            if (icon) { remember(site, icon); found++; delete misses[site]; } else misses[site] = Date.now();
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
        const keys = Object.keys(misses);
        for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) delete misses[k];
        store.set("faviconMisses", misses, { silent: true });
        return { found, tried: todo.size };
      })();
      try { return await running; } finally { running = null; }
    }

    commands.register("favicons:lookup", async ({ urls = [] } = {}) => lookup(urls), { title: "Known icons for these sites" });
    commands.register("favicons:fill", async ({ urls = [] } = {}) => fill(urls), { title: "Look up missing icons" });

    return { exports: { resolve, usableIcon, lookup, fill } };
  },
};
