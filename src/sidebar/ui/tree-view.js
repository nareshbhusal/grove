// Tree view: renders the rows of the current view (a whole panel, or one open
// folder) and handles click, collapse, mute and drag and drop.
//
// Clicking a row: a tab activates, a folder opens as the current context, a
// note opens in the editor. The chevron expands a folder or branch in place.
//
// Drag zones on a row: top quarter = before, bottom quarter = after, middle =
// inside (becomes a child). Only legal drops show an indicator (tabs can hold
// tabs, folders hold anything, notes live only inside folders).

import { flatten, resolveDrop, dropAllowed, descendantsOf, countInside, validSpot } from "../../lib/tree.js";
import { searchView, highlight } from "../../lib/search.js";
import { isExternal, readLinks } from "./external-drop.js";
import { h, run, cmd, toast } from "./client.js";
import { icon, twistyIcon } from "./icons.js";
import { askConfirm } from "./dialog.js";
import { tooltipText, previewable, previewMode } from "../../lib/hover.js";

const COLORS = {
  blue: "#37adff", turquoise: "#00c79a", green: "#51cd00", yellow: "#ffcb00",
  orange: "#ff9f00", red: "#ff613d", pink: "#ff4bda", purple: "#af51f5", toolbar: "#808080",
};

export function viewOf(state, windowId) {
  const v = state?.views?.[windowId];
  if (v) return v;
  return { panelId: state?.activePanels?.[windowId] ?? state?.panels?.[0]?.id ?? null, folderId: null };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// A letter tile for pages without a usable icon, coloured from the host so the
// same site always looks the same.
function tile(url) {
  const host = hostOf(url);
  const letter = host ? host[0].toUpperCase() : "";
  let hash = 0;
  for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const el = h("span", { class: `favicon tile${host ? "" : " blank"}` }, letter);
  if (host) el.style.background = `hsl(${hash % 360} 42% 42%)`;
  return el;
}

// Pages Firefox gives no usable icon for get a symbol for the kind of page they
// are, instead of a blank tile: local files, Firefox's own about: pages, add-on pages.
function systemIcon(url) {
  if (/^file:/i.test(url)) return "file";
  if (/^about:(blank|newtab|home)?$/i.test(url)) return "page";
  if (/^(about|chrome|resource|view-source|moz-src):/i.test(url)) return "internal";
  if (/^(moz-extension|moz-)/i.test(url)) return "puzzle";
  return null;
}

function favicon(node) {
  const sys = !node.favIconUrl && systemIcon(node.url ?? "");
  if (sys) return icon(sys, { size: 14, cls: "favicon sys" });
  if (!node.favIconUrl) return tile(node.url);
  const img = h("img", { class: "favicon", src: node.favIconUrl, alt: "", referrerpolicy: "no-referrer", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(tile(node.url)), { once: true });
  return img;
}

export function createTreeView({ root, getState, getWindowId, openMenu, openNote, getOpenNoteId = () => null, onSelectionChange = () => {}, peekRoot = null, onPeekChange = () => {}, getQuery = () => "", onResults = () => {}, onOpenFolder = () => {} }) {
  let containers = new Map();
  let draggingId = null;
  let dragIds = []; // everything the current drag carries (the selection, or just the row)

  // Selection: Ctrl/Cmd+click toggles a row, Shift+click selects a range, a plain
  // click or Escape clears it. Selected rows can be dragged together and share
  // one context menu.
  const selected = new Set();
  let anchor = null;
  let visibleOrder = []; // ids of the rows on screen, top to bottom

  function paintSelection() {
    root.querySelectorAll(".row").forEach((el) => el.classList.toggle("selected", selected.has(el.dataset.id)));
    onSelectionChange(selected.size);
  }
  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    anchor = null;
    paintSelection();
  }
  // A folded row stands for everything inside it: selecting it selects all of that too.
  function hiddenBelow(id) {
    const state = getState();
    return state?.nodes[id]?.collapsed ? descendantsOf(state.nodes, id) : [];
  }
  // The selection in screen order, each folded row followed by what is folded inside it.
  function selectionInOrder() {
    const out = [];
    for (const id of visibleOrder) {
      if (!selected.has(id)) continue;
      out.push(id);
      for (const d of hiddenBelow(id)) if (selected.has(d)) out.push(d);
    }
    return out;
  }
  function toggleSelect(id) {
    if (selected.has(id)) {
      selected.delete(id);
      for (const d of hiddenBelow(id)) selected.delete(d);
    } else {
      selected.add(id);
      for (const d of hiddenBelow(id)) selected.add(d);
    }
    anchor = id;
    paintSelection();
  }
  function selectRange(id) {
    const from = visibleOrder.indexOf(anchor ?? id);
    const to = visibleOrder.indexOf(id);
    if (from < 0 || to < 0) return toggleSelect(id);
    selected.clear();
    for (const rid of visibleOrder.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      selected.add(rid);
      for (const d of hiddenBelow(rid)) selected.add(d);
    }
    paintSelection();
  }
  // Is this selected row out of sight only because a selected row above it is folded?
  function foldedIntoSelection(id) {
    const nodes = getState()?.nodes ?? {};
    for (let p = nodes[id]?.parentId; p; p = nodes[p]?.parentId) if (selected.has(p) && nodes[p]?.collapsed) return true;
    return false;
  }
  // Rows whose ancestor is also in the list travel with that ancestor.
  function withoutDescendants(ids) {
    const nodes = getState().nodes;
    const set = new Set(ids);
    return ids.filter((id) => {
      for (let p = nodes[id]?.parentId; p; p = nodes[p]?.parentId) if (set.has(p)) return false;
      return true;
    });
  }
  let deferred = false;
  let lastContainerFetch = 0;
  let lastActive = null;

  async function refreshContainers() {
    lastContainerFetch = Date.now();
    try {
      const list = await cmd("containers:list");
      containers = new Map(list.map((c) => [c.cookieStoreId, c]));
      render();
    } catch {
      /* containers unavailable, rows simply show no stripe */
    }
  }

  function containerColor(id) {
    const c = containers.get(id);
    if (!c || id === "firefox-default") return null;
    return COLORS[c.color] ?? c.colorCode ?? null;
  }

  function zoneFor(e, row) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (y < 0.25) return "before";
    if (y > 0.75) return "after";
    return "inside";
  }

  // The drop a pointer position means, or null if it would be illegal.
  function spotFor(e, row, targetId) {
    const nodes = getState().nodes;
    let zone = zoneFor(e, row);
    let spot = resolveDrop(nodes, targetId, zone);
    // A link from outside becomes a new tab, so it only needs a place that may hold a tab.
    const external = !draggingId;
    const fits = (s) => (external ? !!validSpot(nodes, s.parentId, s.index, { type: "tab" }) : dragIds.every((id) => dropAllowed(nodes, id, s)));
    if (spot && fits(spot)) return { zone, spot };
    if (zone === "inside") {
      // Cannot go inside (a note, or a folder onto a tab): fall back to above/below.
      const r = row.getBoundingClientRect();
      zone = e.clientY - r.top < r.height / 2 ? "before" : "after";
      spot = resolveDrop(nodes, targetId, zone);
      if (spot && fits(spot)) return { zone, spot };
    }
    return null;
  }

  // Every way a drag can finish (drop, cancel, release in place, Escape, the row
  // being re-rendered under the pointer) ends up here, and clears everything.
  // ---- peek: hovering a panel while dragging shows that panel's tree over the
  // list, so you can drop on a precise spot there. It is only a picture drawn on
  // top: the window's real view and active tab are never touched, and the list
  // underneath (including the row being dragged) stays in the page.
  let peek = null; // { panelId }
  let lastDragOver = 0;
  let peekWatch = null;
  document.addEventListener("dragover", () => (lastDragOver = Date.now()), true);

  function placePeek() {
    if (!peek || !peekRoot) return;
    const r = root.getBoundingClientRect();
    Object.assign(peekRoot.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function renderPeek() {
    if (!peekRoot) return;
    peekRoot.hidden = !peek;
    if (!peek) return peekRoot.replaceChildren();
    const state = getState();
    const panel = state.panels.find((p) => p.id === peek.panelId);
    if (!panel) return setPeek(null);
    peekRoot.style.setProperty("--panel-color", panel.color);
    const rows = flatten(state.nodes, panel.id, null).filter((r) => !r.node.pinned);
    const ctx = { state, activeNodeId: null, hasActive: new Set(), loud: new Set(), peek: true };
    placePeek();
    peekRoot.replaceChildren(
      h("div", { class: "peek-head" }, h("span", { class: "dot" }), `Drop into “${panel.name}”`),
      ...(rows.length ? rows.map((r) => buildRow(r, ctx)) : [h("div", { class: "empty" }, "Nothing here yet. Drop to add it.")])
    );
  }

  function setPeek(panelId) {
    const same = (peek?.panelId ?? null) === (panelId ?? null);
    peek = panelId ? { panelId } : null;
    clearTimeout(peekWatch);
    peekWatch = null;
    if (peek) {
      // A drag that ends outside the sidebar tells us nothing; stop when dragover stops.
      const watch = () => {
        if (!peek) return;
        if (Date.now() - lastDragOver > 1500) return setPeek(null);
        peekWatch = setTimeout(watch, 500);
      };
      lastDragOver = Date.now();
      peekWatch = setTimeout(watch, 500);
    }
    if (!same) onPeekChange(peek?.panelId ?? null);
    renderPeek();
  }
  window.addEventListener("resize", placePeek);

  let dragToken = null;
  function endDrag() {
    setPeek(null);
    dragToken = null;
    draggingId = null;
    dragIds = [];
    clearDropMarks();
    root.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
    if (deferred) {
      deferred = false;
      render();
    }
  }
  // Safety nets: dragend can be lost when the dragged row left the page, and a
  // drop outside the list never reaches a row.
  document.addEventListener("dragend", endDrag, true);
  document.addEventListener("drop", () => setTimeout(() => (draggingId ? endDrag() : setPeek(null)), 0), true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && draggingId && endDrag());

  function clearDropMarks() {
    root.querySelectorAll(".drop-before,.drop-after,.drop-inside").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-inside"));
  }

  function countDescendants(nodes, id) {
    return descendantsOf(nodes, id).length;
  }

  // What opening a row does: a tab is activated, a folder becomes the view, a note opens.
  function activate(node) {
    if (node.type === "folder") {
      onOpenFolder(); // a search ends when you go into a folder
      run("folder:enter", { windowId: getWindowId(), id: node.id });
    } else if (node.type === "note") openNote(node.id);
    else run("tab:activate", { id: node.id, windowId: getWindowId() });
  }

  function buildRow(entry, ctx) {
    const { state, activeNodeId, hasActive, loud } = ctx;
    const { node, depth, hasChildren, collapsed, where = null } = entry;
    const isFolder = node.type === "folder";
    const isNote = node.type === "note";
    const title = isFolder ? node.name || "Folder" : isNote ? node.name || "Untitled note" : node.customTitle || node.title || node.url || "New tab";
    const ghost = !isFolder && !isNote && node.tabId == null;
    // Asleep: the tab exists in Firefox but its page is not loaded (memory saved).
    const unloaded = !isFolder && !isNote && !ghost && !!node.discarded;
    const color = isFolder || isNote ? null : containerColor(node.cookieStoreId);

    // The browser's own tooltip, as the hover settings ask. When the preview card appears for the whole
    // row it carries the same text, so the tooltip steps aside.
    const hv = state.settings?.hover ?? {};
    const note = unloaded ? "Not loaded yet. It loads when you open it.\n" : ghost ? "Not open in Firefox. Click to open it.\n" : "";
    const tip = previewMode(hv) === "row" && previewable(node) ? null : tooltipText(node, hv.tooltip, title, note);

    const twisty = h("span", {
      class: `twisty${hasChildren ? " has" : ""}${hasChildren && !collapsed ? " open" : ""}`,
      onclick: (e) => {
        e.stopPropagation();
        if (hasChildren) run("tree:toggle", { id: node.id });
      },
    });
    if (hasChildren) twisty.appendChild(twistyIcon());

    const iconEl = isFolder ? icon("folder", { cls: "folder-icon" }) : isNote ? icon("note", { cls: "note-icon" }) : favicon(node);

    // Sound: a button on the tab itself; a quiet indicator on a collapsed branch hiding a noisy tab.
    let sound = null;
    if (!isFolder && !isNote && (node.audible || node.muted)) {
      sound = h("button", {
        class: `sound${node.muted ? " muted" : ""}`,
        title: node.muted ? "Unmute tab" : "Mute tab",
        "aria-label": node.muted ? "Unmute tab" : "Mute tab",
        onclick: (e) => {
          e.stopPropagation();
          run("tab:mute", { id: node.id });
        },
      }, icon(node.muted ? "speakerMuted" : "speaker", { size: 14 }));
    } else if (collapsed && loud.has(node.id)) {
      sound = h("span", { class: "sound indirect", title: "A tab inside is playing sound" }, icon("speaker", { size: 14 }));
    }

    const kids = hasChildren ? countDescendants(state.nodes, node.id) : 0;
    // A folder always shows how much is inside it (open or closed); a collapsed
    // branch of tabs shows how many tabs it hides.
    const inside = isFolder ? countInside(state.nodes, node.id) : null;
    const insideTip = inside && [inside.tabs && `${inside.tabs} tab${inside.tabs === 1 ? "" : "s"}`, inside.notes && `${inside.notes} note${inside.notes === 1 ? "" : "s"}`, inside.folders && `${inside.folders} subfolder${inside.folders === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    const row = h(
      "div",
      {
        class: ["row", selected.has(node.id) && "selected", node.id === activeNodeId && "active", collapsed && hasActive.has(node.id) && "has-active", ghost && "ghost", unloaded && "unloaded", node.pinned && "pinned", isFolder && "is-folder", isNote && "is-note", isNote && node.id === getOpenNoteId() && "note-open"]
          .filter(Boolean)
          .join(" "),
        role: "treeitem",
        "aria-level": depth + 1,
        "aria-expanded": hasChildren ? String(!collapsed) : null,
        draggable: ctx.peek ? null : "true",
        dataset: { id: node.id },
        style: { paddingLeft: `${depth * 14 + 2}px`, "--guide": `${depth * 14}px`, "--ctr": color },
        onclick: (e) => {
          if (e.ctrlKey || e.metaKey) return toggleSelect(node.id);
          if (e.shiftKey) return selectRange(node.id);
          clearSelection();
          activate(node);
        },
        onauxclick: (e) => {
          if (e.button === 1 && !isFolder && !isNote) {
            e.preventDefault();
            run("tab:close", { id: node.id, mode: "self" });
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          if (selected.size > 1 && selected.has(node.id)) {
            openMenu(e, null, selectionInOrder()); // one menu for the whole selection
          } else {
            clearSelection();
            openMenu(e, node.id, null);
          }
        },
      },
      twisty,
      color ? h("span", { class: "ctr" }) : null,
      iconEl,
      h("span", { class: "title", title: tip },
        ...(ctx.terms ? highlight(title, ctx.terms).map((p) => (p.hit ? h("mark", {}, p.text) : p.text)) : [title])),
      where ? h("span", { class: "where", title: where }, where) : null,
      node.split ? h("span", { class: "split", title: "Shown side by side with another tab (split view)" }, icon("split", { size: 12 })) : null,
      isFolder && inside.total ? h("span", { class: "badge", title: insideTip }, String(inside.total)) : null,
      !isFolder && collapsed && kids ? h("span", { class: "badge" }, String(kids)) : null,
      sound,
      h("button", {
        class: "close",
        title: isNote ? "Delete note" : isFolder ? "Delete folder (keeps its contents)" : "Close",
        onclick: async (e) => {
          e.stopPropagation();
          if (isNote) {
            if (await askConfirm(`Delete “${title}”? This cannot be undone.`, "Delete")) run("note:delete", { id: node.id });
          } else run(isFolder ? "folder:delete" : "tab:close", { id: node.id });
        },
      }, icon("close", { size: 12 }))
    );

    row.addEventListener("dragstart", (e) => {
      draggingId = node.id;
      // Dragging one of several selected rows carries them all, in screen order.
      dragIds = selected.size > 1 && selected.has(node.id) ? withoutDescendants(selectionInOrder()) : [node.id];
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragIds.join(","));
      // The class is added a tick later so the drag image is not greyed. A quick
      // release can end the drag before that tick, so only add it while the drag
      // is still the current one (otherwise the row stayed grey for good).
      const mine = (dragToken = Symbol());
      setTimeout(() => {
        if (dragToken !== mine || draggingId !== node.id) return;
        for (const id of dragIds) root.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.classList.add("dragging");
      }, 0);
    });
    row.addEventListener("dragend", endDrag);
    row.addEventListener("dragover", (e) => {
      if (draggingId ? dragIds.includes(node.id) : !isExternal(e.dataTransfer)) return;
      const hit = spotFor(e, row, node.id);
      clearDropMarks();
      if (!hit) return; // illegal here: no indicator, no drop
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add(`drop-${hit.zone}`);
    });
    row.addEventListener("dragleave", (e) => {
      if (!row.contains(e.relatedTarget)) row.classList.remove("drop-before", "drop-after", "drop-inside");
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggingId) {
        const hit = spotFor(e, row, node.id);
        clearDropMarks();
        dropExternal(e.dataTransfer, hit?.spot ?? null);
        return;
      }
      const hit = !dragIds.includes(node.id) ? spotFor(e, row, node.id) : null;
      clearDropMarks();
      if (hit) run("tree:moveMany", { ids: dragIds, ...hit.spot });
    });
    return row;
  }

  // Open what was dropped from outside at `spot`: links, bookmarks and downloads as
  // tabs, or text with no link in it as a search (in the background).
  async function dropExternal(dt, spot) {
    const { links, files, text } = readLinks(dt);
    if (!links.length && !text) {
      toast(files ? "Firefox does not tell extensions where a dragged file is. Drag it from the Downloads panel instead, or open it from the address bar." : "Nothing to open in what you dropped.");
      return;
    }
    if (!spot) return toast("A tab cannot go there.");
    const res = links.length
      ? await run("tab:openUrls", { urls: links, windowId: getWindowId(), ...spot })
      : await run("tab:search", { text, windowId: getWindowId(), ...spot });
    if (res?.error) toast(res.error);
  }

  // Drop on empty space at the bottom of the list = end of the current view.
  function bindEmptyDrop(el, getView) {
    el.addEventListener("dragover", (e) => {
      if (e.target.closest(".row")) return;
      if (!draggingId) return isExternal(e.dataTransfer) && e.preventDefault();
      const state = getState();
      const view = getView();
      if (!dragIds.every((id) => dropAllowed(state.nodes, id, { parentId: view.folderId }))) return;
      e.preventDefault();
    });
    el.addEventListener("drop", (e) => {
      if (e.target.closest(".row")) return;
      e.preventDefault();
      const view = getView();
      if (!draggingId) return dropExternal(e.dataTransfer, { parentId: view.folderId, index: null, panelId: view.panelId });
      run("tree:moveMany", { ids: dragIds, parentId: view.folderId, index: null, panelId: view.panelId });
    });
  }
  bindEmptyDrop(root, () => viewOf(getState(), getWindowId()));
  if (peekRoot) bindEmptyDrop(peekRoot, () => ({ panelId: peek?.panelId, folderId: null }));
  // A click on empty space, or Escape, drops the selection.
  root.addEventListener("click", (e) => { if (!e.target.closest(".row")) clearSelection(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !draggingId) clearSelection(); });

  // The highlighted result while searching: Up/Down move it, Enter opens it.
  let cursor = 0;
  let lastQuery = "";
  function paintCursor(scroll = true) {
    const rows = [...root.querySelectorAll(".row")];
    rows.forEach((el, i) => el.classList.toggle("hit-current", i === cursor));
    if (scroll) rows[cursor]?.scrollIntoView({ block: "nearest" });
  }
  function moveCursor(delta) {
    const n = visibleOrder.length;
    if (!n) return;
    cursor = Math.max(0, Math.min(n - 1, cursor + delta));
    paintCursor();
  }
  function activateCursor() {
    const node = getState()?.nodes[visibleOrder[cursor]];
    if (node) activate(node);
  }

  function render() {
    if (draggingId) {
      deferred = true;
      return;
    }
    const state = getState();
    if (!state) return;
    const windowId = getWindowId();
    const view = viewOf(state, windowId);
    // Searching replaces the tree with the matches inside this view, in tree order.
    const query = getQuery();
    const found = query.trim() ? searchView(state.nodes, view, query) : null;
    const searching = !!found?.terms.length;
    const rows = searching
      ? found.results.map((r) => ({ node: r.node, depth: 0, hasChildren: false, collapsed: false, where: r.where }))
      : flatten(state.nodes, view.panelId, view.folderId).filter((r) => !r.node.pinned);
    if (query !== lastQuery) { cursor = 0; lastQuery = query; }
    cursor = Math.max(0, Math.min(cursor, rows.length - 1));
    onResults({ count: rows.length, searching });
    const activeNodeId = state.activeNodes[windowId] ?? null;
    visibleOrder = rows.map((r) => r.node.id);
    // Forget selected rows that are gone or no longer on screen.
    const before = selected.size;
    for (const id of [...selected]) if (!visibleOrder.includes(id) && !foldedIntoSelection(id)) selected.delete(id);
    if (anchor && !selected.has(anchor) && !visibleOrder.includes(anchor)) anchor = null;
    if (selected.size !== before) onSelectionChange(selected.size);

    if (!containers.size || Object.values(state.nodes).some((n) => n.cookieStoreId && !containers.has(n.cookieStoreId))) {
      if (Date.now() - lastContainerFetch > 4000) refreshContainers();
    }

    // Ancestors of the active tab and of every playing tab, for the quiet hints on collapsed branches.
    const ancestorsOf = (id) => {
      const out = [];
      for (let p = state.nodes[id]?.parentId; p && state.nodes[p]; p = state.nodes[p].parentId) out.push(p);
      return out;
    };
    const hasActive = new Set(activeNodeId ? ancestorsOf(activeNodeId) : []);
    const loud = new Set();
    for (const n of Object.values(state.nodes)) if (n.audible && !n.muted) ancestorsOf(n.id).forEach((a) => loud.add(a));

    const ctx = { state, activeNodeId, hasActive, loud, terms: searching ? found.terms : null };
    const scroll = root.scrollTop;
    const empty = searching
      ? "Nothing here matches. Searching covers this panel, or the open folder and its subfolders."
      : view.folderId ? "This folder is empty. Drag tabs here, or add a note." : "No tabs in this panel yet.";
    root.replaceChildren(...(rows.length ? rows.map((r) => buildRow(r, ctx)) : [h("div", { class: "empty" }, empty)]));
    root.scrollTop = scroll;
    if (searching && rows.length) paintCursor(false);

    // Keep the tab you are on in sight when it changes.
    if (activeNodeId && activeNodeId !== lastActive) {
      root.querySelector(`.row[data-id="${CSS.escape(activeNodeId)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    lastActive = activeNodeId;
  }

  return {
    render,
    refreshContainers,
    getDraggingIds: () => (draggingId ? dragIds : []),
    setPeek,
    getPeek: () => peek?.panelId ?? null,
    clearSelection,
    moveCursor,
    activateCursor,
    selectionSize: () => selected.size,
    getContainers: () => [...containers.values()],
  };
}
