// The bookmark viewer and manager: Firefox's own bookmarks, in the sidebar, in place of the tab list while
// it is open. There is no copy: every change here is a change to the real bookmarks, and changes made
// elsewhere (Firefox's own library, sync, another tool) show up here as they happen.
//
//   click          open it (switches to the tab if it is already open)
//   Ctrl-click, middle-click   open it behind the current tab      Shift-click   open it as a child of the current tab
//   right-click    open, rename, change the address, delete; a folder opens as "saved" tabs (not loaded)
//   drag           reorder, move into a folder; a link dragged in from a page is added where you drop it
//   Up/Down/Left/Right move around, Enter opens, F2 renames, Delete deletes (and offers to undo), / searches, Esc leaves

import { h, run, cmd, toast } from "./client.js";
import { icon, twistyIcon } from "./icons.js";
import { askText } from "./dialog.js";
import { favicon } from "./tree-view.js";
import { filterTree, hostOf, samePage } from "../../lib/bookmarks.js";
import { highlight } from "../../lib/search.js";
import { isExternal, readLinks } from "./external-drop.js";

const SCOPES = [
  ["grove", "Grove"],
  ["toolbar_____", "Toolbar"],
  ["menu________", "Menu"],
  ["unfiled_____", "Other"],
  ["mobile______", "Mobile"],
];
const KEY = "grove:bookmarks-view";

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window or blocked storage: it just is not remembered */ } };

export function createBookmarksView({ root, getState, getWindowId, showMenu, onToggle = () => {} }) {
  let open = false;
  let data = null; // { roots, groveId }
  let loading = false;
  const saved = read();
  let scope = saved.scope ?? "grove";
  const expanded = new Set(saved.expanded ?? []);
  let query = "";
  let cursor = null;
  let dragging = null;
  let undoTimer = null;
  let index = new Map(); // id -> { node, parent, at }

  const remember = () => write({ scope, expanded: [...expanded].slice(-400) });

  // ---- parts ------------------------------------------------------------

  const back = h("button", { class: "tool", title: "Back to your tabs (Esc)", "aria-label": "Back to your tabs", onclick: () => api.hide() }, icon("back", { size: 18 }));
  const newFolder = h("button", { class: "tool make", title: "New folder here", "aria-label": "New folder here", onclick: () => makeFolder(null) }, icon("folderPlus", { size: 18 }));
  const search = h("input", { type: "text", class: "search-input marks-search", placeholder: "Search all bookmarks", spellcheck: "false", autocomplete: "off", "aria-label": "Search bookmarks" });
  const status = h("span", { class: "search-status", "aria-live": "polite" });
  const head = h("div", { class: "marks-head" }, back, h("span", { class: "marks-title" }, "Bookmarks"), h("span", { class: "spacer" }), newFolder);
  const box = h("div", { class: "search-box marks-box" }, icon("search", { size: 14, cls: "search-glass" }), search, status);
  const scopes = h("div", { class: "marks-scopes", role: "tablist", "aria-label": "Bookmark folders" });
  const list = h("div", { class: "marks-list", role: "tree", tabindex: "0", "aria-label": "Bookmarks" });
  const undo = h("div", { class: "marks-undo", role: "status", hidden: true });
  const hint = h("div", { class: "marks-hint" }, "Ctrl-click: behind · Shift-click: as child · right-click: more");
  root.replaceChildren(head, h("div", { class: "marks-controls" }, box, scopes), list, hint, undo);

  // ---- what is shown ----------------------------------------------------

  const rootsById = () => new Map((data?.roots ?? []).map((r) => [r.id, r]));
  const scopeRoot = () => {
    if (scope === "grove") return (rootsById().get("unfiled_____")?.children ?? []).find((c) => c.id === data?.groveId) ?? null;
    return rootsById().get(scope) ?? null;
  };

  // Where things go when you drop on the empty part of the list, or press "new folder".
  const scopeParentId = () => (scope === "grove" ? data?.groveId ?? "unfiled_____" : scope);

  function visibleItems() {
    if (!data) return { items: [], filter: null };
    const filter = query.trim() ? { ...filterTree(data.roots, query) } : null;
    // Searching looks everywhere: each built-in folder is a group of results.
    const items = filter ? data.roots.filter((r) => r.children?.length || r.id !== "mobile______") : (scopeRoot()?.children ?? []);
    return { items, filter: filter?.keep ? filter : null };
  }

  // Favicons Grove already has for the sites of open tabs; and which pages are open right now.
  function knowledge() {
    const icons = new Map();
    const live = [];
    for (const n of Object.values(getState()?.nodes ?? {})) {
      if (n.type !== "tab" || !n.url) continue;
      const host = hostOf(n.url);
      if (n.favIconUrl && host && !icons.has(host)) icons.set(host, n.favIconUrl);
      if (n.tabId != null) live.push(n.url);
    }
    return { icons, live };
  }

  function flatten(items, filter, depth, parent, out) {
    items.forEach((node, at) => {
      if (filter && !filter.keep.has(node.id)) return;
      index.set(node.id, { node, parent, at });
      out.push({ node, depth });
      const showKids = node.type === "folder" && (filter ? true : expanded.has(node.id));
      if (showKids) flatten(node.children ?? [], filter, depth + 1, node, out);
    });
    return out;
  }

  function render() {
    scopes.replaceChildren(
      ...SCOPES.filter(([id]) => id !== "mobile______" || (rootsById().get(id)?.children?.length ?? 0) || scope === id).map(([id, label]) =>
        h("button", { class: "chip", role: "tab", "aria-selected": String(!query && scope === id), onclick: () => pick(id) }, label))
    );
    scopes.hidden = !!query.trim();
    const { items, filter } = visibleItems();
    index = new Map();
    const rows = flatten(items, filter, 0, scopeRoot() ?? null, []);
    if (!rows.some((r) => r.node.id === cursor)) cursor = rows[0]?.node.id ?? null;
    const { icons, live } = knowledge();
    const terms = filter?.terms ?? [];
    status.textContent = !filter ? "" : rows.length ? `${rows.filter((r) => r.node.type !== "folder").length} found` : "No matches";
    status.classList.toggle("none", !!filter && !rows.length);

    if (!data) {
      list.replaceChildren(h("div", { class: "empty" }, loading ? "Loading bookmarks…" : "Bookmarks are not available."));
      return;
    }
    if (!rows.length) {
      list.replaceChildren(h("div", { class: "empty" },
        filter ? "Nothing matches." :
        scope === "grove" && !data.groveId ? "Nothing saved yet. Right-click a tab, a branch or a folder in the tab list and choose Bookmark, and it lands here (a branch keeps its shape as a folder)." :
        "Empty. Drag a link here, or press the folder button to make a folder."));
      return;
    }
    list.replaceChildren(...rows.map(({ node, depth }) => row(node, depth, icons, live, terms)));
    list.querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  }

  function row({ id, title, url, type, children }, depth, icons, live, terms) {
    const folder = type === "folder";
    const isOpen = folder && (terms.length || expanded.has(id));
    const label = title || (folder ? "Untitled folder" : url);
    const el = h("div", {
      class: `row mrow${folder ? " is-folder" : ""}${id === cursor ? " cursor hit-current" : ""}${!folder && live.some((u) => samePage(u, url)) ? " is-open" : ""}`,
      role: "treeitem", "aria-level": String(depth + 1), "aria-expanded": folder ? String(!!isOpen) : null,
      draggable: "true", dataset: { id }, title: folder ? label : `${label}\n${url}`,
      style: { paddingLeft: `${4 + depth * 14}px` },
    });
    const twisty = h("span", { class: `twisty${folder ? " has" : ""}${isOpen ? " open" : ""}` }, folder ? twistyIcon() : null);
    const mark = folder ? icon("folder", { cls: "folder-icon" }) : favicon({ url, favIconUrl: icons.get(hostOf(url)) });
    const text = h("span", { class: "title" });
    text.append(...(terms.length ? highlight(label, terms).map((p) => (p.hit ? h("mark", {}, p.text) : p.text)) : [label]));
    el.append(twisty, mark, text);
    if (folder) el.append(h("span", { class: "where" }, String(countLeaves(children))));
    else el.append(h("span", { class: "where" }, hostOf(url)));
    if (!folder) el.append(h("span", { class: "live-dot", title: "Open in a tab now", "aria-hidden": "true" }));
    return el;
  }

  const countLeaves = (list) => (list ?? []).reduce((n, c) => n + (c.type === "folder" ? countLeaves(c.children) : 1), 0);

  // ---- loading ----------------------------------------------------------

  let again = false;
  async function load() {
    if (loading) { again = true; return; }
    loading = true;
    try {
      data = await cmd("bookmarks:tree");
    } catch (err) {
      data = null;
      toast(err.message);
    } finally {
      loading = false;
    }
    if (open) render();
    if (again) { again = false; load(); }
  }

  function pick(id) {
    scope = id;
    remember();
    render();
  }

  // ---- doing things ----------------------------------------------------

  const windowId = () => getWindowId();
  const nodeOf = (id) => index.get(id)?.node ?? null;

  function openNode(node, mode = "tab") {
    if (node.type === "folder") return toggle(node.id);
    return run("bookmarks:open", { id: node.id, windowId: windowId(), mode });
  }

  function toggle(id, force) {
    const want = force ?? !expanded.has(id);
    if (want) expanded.add(id); else expanded.delete(id);
    remember();
    render();
  }

  async function makeFolder(parentId) {
    const name = await askText("Folder name", "New folder");
    if (!name) return;
    const into = parentId ?? scopeParentId();
    const id = await run("bookmarks:create", { parentId: into, title: name });
    if (parentId) expanded.add(parentId);
    if (id) { cursor = id; if (into === "unfiled_____" && scope === "grove") scope = "unfiled_____"; }
    remember();
  }

  async function rename(node) {
    const name = await askText(node.type === "folder" ? "Folder name" : "Name", node.title);
    if (name != null) run("bookmarks:update", { id: node.id, title: name });
  }

  async function readdress(node) {
    const url = await askText("Address", node.url);
    if (url && url !== node.url) run("bookmarks:update", { id: node.id, url });
  }

  async function remove(node) {
    const next = [...list.querySelectorAll(".mrow")].map((r) => r.dataset.id);
    const at = next.indexOf(node.id);
    cursor = next[at + 1] ?? next[at - 1] ?? null;
    const ok = await run("bookmarks:remove", { id: node.id });
    if (!ok) return toast("That one cannot be deleted");
    offerUndo(node.type === "folder" ? `Deleted the folder “${node.title || "Untitled"}” and what was in it` : `Deleted “${node.title || node.url}”`);
  }

  function offerUndo(message) {
    clearTimeout(undoTimer);
    undo.hidden = false;
    undo.replaceChildren(
      h("span", {}, message),
      h("button", { class: "primary", onclick: async () => { undo.hidden = true; await run("bookmarks:undo"); } }, "Undo")
    );
    undoTimer = setTimeout(() => { undo.hidden = true; }, 12000);
  }

  function menuFor(e, node) {
    const folder = node.type === "folder";
    const items = folder
      ? [
          { label: "Open as saved tabs (not loaded)", onSelect: () => run("bookmarks:openFolder", { id: node.id, windowId: windowId() }) },
          { label: "Open and load all", onSelect: () => run("bookmarks:openFolder", { id: node.id, windowId: windowId(), loaded: true }) },
          { separator: true },
          { label: "New folder inside…", onSelect: () => makeFolder(node.id) },
        ]
      : [
          { label: "Open", onSelect: () => openNode(node) },
          { label: "Open behind this tab", onSelect: () => openNode(node, "background") },
          { label: "Open as child of this tab", onSelect: () => openNode(node, "child") },
          { separator: true },
          { label: "Copy address", onSelect: () => navigator.clipboard?.writeText(node.url).then(() => toast("Address copied"), () => toast("Could not copy")) },
        ];
    showMenu(e, [
      ...items,
      ...(folder ? [] : [{ label: "Change address…", onSelect: () => readdress(node) }]),
      { label: "Rename…", onSelect: () => rename(node) },
      { separator: true },
      { label: folder ? "Delete folder and contents" : "Delete", danger: true, onSelect: () => remove(node) },
    ]);
  }

  // ---- mouse ------------------------------------------------------------

  const rowOf = (e) => e.target.closest?.(".mrow");

  list.addEventListener("click", (e) => {
    const r = rowOf(e);
    if (!r) return;
    const node = nodeOf(r.dataset.id);
    if (!node) return;
    cursor = node.id;
    if (node.type === "folder") return toggle(node.id);
    openNode(node, e.ctrlKey || e.metaKey ? "background" : e.shiftKey ? "child" : "tab");
    render();
  });
  list.addEventListener("auxclick", (e) => {
    const r = rowOf(e);
    const node = r && nodeOf(r.dataset.id);
    if (e.button === 1 && node && node.type !== "folder") { e.preventDefault(); openNode(node, "background"); }
  });
  list.addEventListener("contextmenu", (e) => {
    const r = rowOf(e);
    const node = r && nodeOf(r.dataset.id);
    if (!node) return;
    e.preventDefault();
    cursor = node.id;
    menuFor(e, node);
  });

  // ---- drag and drop ----------------------------------------------------

  const clearDrop = () => list.querySelectorAll(".drop-before,.drop-after,.drop-inside").forEach((x) => x.classList.remove("drop-before", "drop-after", "drop-inside"));
  const within = (id, ancestorId) => {
    for (let p = index.get(id)?.parent; p; p = index.get(p.id)?.parent) if (p.id === ancestorId) return true;
    return false;
  };

  // Where a drop at this pointer lands: { parentId, at } (at null = the end), and which marker to draw.
  function spotFor(e, r) {
    if (!r) return { parentId: scopeParentId(), at: null, mark: null, target: null };
    const info = index.get(r.dataset.id);
    const box = r.getBoundingClientRect();
    const f = (e.clientY - box.top) / box.height;
    const folder = info.node.type === "folder";
    const parentId = info.parent?.id ?? scopeParentId();
    if (folder && f > 0.28 && f < 0.72) return { parentId: info.node.id, at: null, mark: "drop-inside", target: r };
    return f < 0.5 ? { parentId, at: info.at, mark: "drop-before", target: r } : { parentId, at: info.at + 1, mark: "drop-after", target: r };
  }

  list.addEventListener("dragstart", (e) => {
    const r = rowOf(e);
    if (!r) return;
    dragging = r.dataset.id;
    const node = nodeOf(dragging);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-grove-bookmark", dragging);
    if (node?.url) { e.dataTransfer.setData("text/uri-list", node.url); e.dataTransfer.setData("text/plain", node.url); }
    r.classList.add("dragging");
  });
  list.addEventListener("dragend", () => { dragging = null; clearDrop(); list.querySelector(".dragging")?.classList.remove("dragging"); });
  list.addEventListener("dragover", (e) => {
    const external = !dragging && isExternal(e.dataTransfer);
    if (!dragging && !external) return;
    const r = rowOf(e);
    if (dragging && r && (r.dataset.id === dragging || within(r.dataset.id, dragging))) return clearDrop();
    e.preventDefault();
    e.dataTransfer.dropEffect = external ? "copy" : "move";
    const spot = spotFor(e, r);
    clearDrop();
    spot.target?.classList.add(spot.mark);
  });
  list.addEventListener("dragleave", (e) => { if (!list.contains(e.relatedTarget)) clearDrop(); });
  list.addEventListener("drop", async (e) => {
    const r = rowOf(e);
    const spot = spotFor(e, r);
    clearDrop();
    if (dragging) {
      e.preventDefault();
      const id = dragging;
      dragging = null;
      if (r && (r.dataset.id === id || within(r.dataset.id, id))) return;
      const from = index.get(id);
      let at = spot.at;
      // Where it ends up among its new siblings: taking it out first shifts what is below it up by one.
      if (at != null && from?.parent?.id === spot.parentId && from.at < at) at -= 1;
      if (spot.parentId && spot.mark === "drop-inside") expanded.add(spot.parentId);
      await run("bookmarks:move", { id, parentId: spot.parentId, ...(at != null ? { index: at } : {}) });
      return;
    }
    if (!isExternal(e.dataTransfer)) return;
    e.preventDefault();
    const { links } = readLinks(e.dataTransfer);
    let at = spot.at;
    for (const l of links) {
      await run("bookmarks:create", { parentId: spot.parentId, title: l.title || hostOf(l.url) || l.url, url: l.url, ...(at != null ? { index: at++ } : {}) });
    }
    if (links.length) toast(`${links.length} bookmark${links.length === 1 ? "" : "s"} added`);
  });

  // ---- keyboard ---------------------------------------------------------

  search.addEventListener("input", () => { query = search.value; render(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (query) { search.value = ""; query = ""; render(); } else list.focus(); }
    else if (e.key === "ArrowDown" || e.key === "Enter" && !query) { e.preventDefault(); list.focus(); }
    else if (e.key === "Enter") { e.preventDefault(); const n = nodeOf(cursor); if (n) openNode(n); }
  });

  list.addEventListener("keydown", (e) => {
    const ids = [...list.querySelectorAll(".mrow")].map((r) => r.dataset.id);
    const at = ids.indexOf(cursor);
    const node = nodeOf(cursor);
    const go = (i) => { cursor = ids[Math.max(0, Math.min(ids.length - 1, i))] ?? null; render(); };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return go(at + 1);
      case "ArrowUp": e.preventDefault(); return go(at - 1);
      case "Home": e.preventDefault(); return go(0);
      case "End": e.preventDefault(); return go(ids.length - 1);
      case "ArrowRight":
        if (node?.type === "folder") { e.preventDefault(); if (!expanded.has(node.id)) toggle(node.id, true); else go(at + 1); }
        return;
      case "ArrowLeft": {
        if (!node) return;
        e.preventDefault();
        if (node.type === "folder" && expanded.has(node.id)) return toggle(node.id, false);
        const parent = index.get(node.id)?.parent;
        if (parent && index.has(parent.id)) { cursor = parent.id; render(); }
        return;
      }
      case "Enter": if (node) { e.preventDefault(); openNode(node, e.ctrlKey || e.metaKey ? "background" : e.shiftKey ? "child" : "tab"); } return;
      case "F2": if (node) { e.preventDefault(); rename(node); } return;
      case "Delete": if (node) { e.preventDefault(); remove(node); } return;
      case "Escape": if (document.getElementById("menu")?.hidden === false) return; e.preventDefault(); api.hide(); return; // a menu open: Esc closes just that
      case "/": e.preventDefault(); search.focus(); search.select(); return;
    }
  });

  // ---- the part the sidebar sees ---------------------------------------

  const api = {
    isOpen: () => open,
    el: list,
    show() {
      if (open) return;
      open = true;
      root.hidden = false;
      document.body.classList.add("marks-open");
      onToggle(true);
      render(); // what we have, now; fresh data a moment later
      load();
      list.focus({ preventScroll: true });
    },
    hide() {
      if (!open) return;
      open = false;
      root.hidden = true;
      document.body.classList.remove("marks-open");
      undo.hidden = true;
      onToggle(false);
    },
    toggle() { open ? api.hide() : api.show(); },
    focusSearch() { api.show(); search.focus(); search.select(); },
    // The bookmarks changed somewhere: fetch again, if anyone is looking.
    changed() { if (open) load(); },
    // The tabs changed (icons, which pages are open): redraw from what we have.
    redraw() { if (open && data) render(); },
  };
  return api;
}
