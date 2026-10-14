// favicons: decides which icon a tab row shows.
//
// Firefox's tab.favIconUrl is not always usable as-is:
//   - inline data: icons are common and can be large (v0.1 dropped anything over 4 KB)
//   - internal pages report chrome:// / resource:// icons that an extension page cannot load
//   - the icon can be briefly missing while a page loads, or never set
//
// So: keep any http(s) icon and data: icons up to 32 KB, ignore the rest, and
// when a tab has no usable icon fall back to the last good one seen for the
// same host. Only short http(s) URLs go in the persistent cache, so it stays small.

import { hostOf } from "../lib/util.js";

const MAX_DATA = 32 * 1024;
const MAX_URL = 2048;
const MAX_CACHED_URL = 512;
const MAX_HOSTS = 300;

export function usableIcon(url) {
  if (!url || typeof url !== "string") return null;
  if (/^https?:/i.test(url)) return url.length <= MAX_URL ? url : null;
  if (/^data:image\//i.test(url)) return url.length <= MAX_DATA ? url : null;
  return null; // chrome://, resource://, moz-extension://, about:
}

export default {
  name: "favicons",

  setup({ store }) {
    store.defaults("favicons", {});
    const cache = () => store.get("favicons");

    function remember(host, url) {
      if (!host || !/^https?:/i.test(url) || url.length > MAX_CACHED_URL) return;
      const map = cache();
      if (map[host] === url) return;
      delete map[host]; // re-insert so the newest are last
      map[host] = url;
      const keys = Object.keys(map);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_HOSTS))) delete map[k];
      store.set("favicons", map, { silent: true });
    }

    // The icon to show for a browser tab (a url string or null).
    function resolve(tab) {
      const host = hostOf(tab.url);
      const own = usableIcon(tab.favIconUrl);
      if (own) {
        if (!tab.incognito) remember(host, own); // the cache is saved: a private tab must not add its site to it
        return own;
      }
      return (host && cache()[host]) || null;
    }

    return { exports: { resolve, usableIcon } };
  },
};
