// Bookmarks, as plain data: no browser calls here, so it can be tested and shared with the sidebar.
//
// A native bookmark node (browser.bookmarks) looks like
//   { id, parentId, index, title, url?, type: "bookmark" | "folder" | "separator", children? }
// "Simple" nodes are what Grove passes around: { id, title, url?, type, children?, added }.
// A "plan" is what is to be created: [{ type: "folder" | "bookmark", title, url?, children? }].

import { childrenOf } from "./tree.js";
import { fold, parseQuery } from "./search.js";

export const ROOT = "root________";
export const OTHER = "unfiled_____";
export const ROOT_NAMES = { menu________: "Menu", toolbar_____: "Toolbar", unfiled_____: "Other", mobile______: "Mobile" };

// Tabs that are not a page: nothing worth keeping.
export const saveable = (url) => !!url && !/^(about:(blank|newtab|home|privatebrowsing)|javascript:|data:)/i.test(url);

export function simplify(n) {
  if (!n) return null;
  const type = n.type === "folder" ? "folder" : n.type === "separator" ? "separator" : "bookmark";
  const out = { id: n.id, title: n.title ?? "", type, added: n.dateAdded ?? 0 };
  if (type === "bookmark") out.url = n.url ?? "";
  if (type === "folder") out.children = (n.children ?? []).map(simplify).filter((c) => c && c.type !== "separator");
  return out;
}

// The shape written into backups: no ids (they belong to a profile), no separators.
export function toSnapshotItems(list) {
  return (list ?? [])
    .filter((n) => n && n.type !== "separator")
    .map((n) => (n.type === "folder"
      ? { type: "folder", title: n.title ?? "", children: toSnapshotItems(n.children) }
      : { type: "bookmark", title: n.title ?? "", url: n.url ?? "" }))
    .filter((n) => n.type === "folder" || n.url);
}

// What a file may hold: anything else is left out rather than trusted.
export function cleanSnapshotItems(list, depth = 0) {
  if (!Array.isArray(list) || depth > 40) return [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "folder") out.push({ type: "folder", title: String(n.title ?? ""), children: cleanSnapshotItems(n.children, depth + 1) });
    else if (typeof n.url === "string" && n.url && !/^(javascript:)/i.test(n.url)) out.push({ type: "bookmark", title: String(n.title ?? ""), url: n.url });
  }
  return out;
}

export const countPlan = (items) =>
  (items ?? []).reduce((c, n) => {
    if (n.type === "folder") {
      const inner = countPlan(n.children);
      return { folders: c.folders + 1 + inner.folders, bookmarks: c.bookmarks + inner.bookmarks };
    }
    return { folders: c.folders, bookmarks: c.bookmarks + 1 };
  }, { folders: 0, bookmarks: 0 });

const titleOf = (n) => n.customTitle || n.title || n.url || "Untitled";

// Tabs and folders of the tree -> a plan. A tab with tabs under it becomes a folder (its own page first, then
// what is under it), a folder stays a folder, a note has no address and is left out.
// Returns { plan, skipped: { notes, pages } } (pages: tabs with nothing worth saving, such as a new tab).
export function planFromTree(all, ids) {
  const picked = new Set(ids.filter((i) => all[i]));
  const top = [...picked].filter((id) => {
    for (let p = all[id].parentId; p; p = all[p]?.parentId) if (picked.has(p)) return false;
    return true;
  });
  // In the order they are shown.
  const where = (id) => {
    const chain = [];
    for (let n = all[id]; n; n = n.parentId ? all[n.parentId] : null) chain.unshift(n.order ?? 0);
    return chain;
  };
  top.sort((a, b) => {
    const x = where(a), y = where(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  const skipped = { notes: 0, pages: 0 };
  const build = (n) => {
    if (n.type === "note") { skipped.notes++; return []; }
    const kids = childrenOf(all, n.id).flatMap(build);
    if (n.type === "folder") return [{ type: "folder", title: n.name || "Folder", children: kids }];
    const own = saveable(n.url) ? [{ type: "bookmark", title: titleOf(n), url: n.url }] : (skipped.pages++, []);
    return kids.length ? [{ type: "folder", title: titleOf(n), children: [...own, ...kids] }] : own;
  };
  return { plan: top.flatMap((id) => build(all[id])), skipped };
}

// ---- searching the viewer ----------------------------------------------------

// Every term in the title or address (same rules as searching tabs). -> the ids to show, folders that
// hold a match included, in order; or null when there is nothing to search for.
export function filterTree(items, input) {
  const terms = parseQuery(input);
  if (!terms.length) return null;
  const keep = new Set();
  const walk = (list) => {
    let any = false;
    for (const n of list) {
      if (n.type === "folder") {
        const inner = walk(n.children ?? []);
        const own = terms.every((t) => fold(n.title).s.includes(t));
        if (inner || own) { keep.add(n.id); any = true; }
      } else {
        const hay = `${fold(n.title).s}\n${fold(safeDecode(n.url)).s}`;
        if (terms.every((t) => hay.includes(t))) { keep.add(n.id); any = true; }
      }
    }
    return any;
  };
  walk(items);
  return { keep, terms };
}

function safeDecode(s) {
  try { return decodeURIComponent(s ?? ""); } catch { return s ?? ""; }
}

export const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

// Same page for "is it already open": the address without a #fragment or a trailing slash.
export const samePage = (a, b) => {
  const norm = (u) => String(u ?? "").split("#")[0].replace(/\/$/, "");
  return !!a && !!b && norm(a) === norm(b);
};
