// Sidebar entry: composes the panel bar, breadcrumb, toolbar, tree view and note
// editor around a single state object pushed from the background.

import { connect, h, run } from "./ui/client.js";
import { createTreeView, viewOf } from "./ui/tree-view.js";
import { createPanelBar } from "./ui/panel-bar.js";
import { createBreadcrumb } from "./ui/breadcrumb.js";
import { createContextMenu } from "./ui/context-menu.js";
import { createNoteEditor } from "./ui/note-editor.js";
import { createSearchBar } from "./ui/search-bar.js";
import { askText } from "./ui/dialog.js";
import { icon } from "./ui/icons.js";
import { createHover } from "./ui/hover.js";

let windowId = null;
let incognito = false;
let state = null;

const $ = (id) => document.getElementById(id);
const getState = () => state;
const getWindowId = () => windowId;

const menu = createContextMenu({
  root: $("menu"),
  getContainers: () => tree.getContainers(),
  getWindowId,
});

// A note opens in a pane under the list; the tabs stay in view while you read it.
const editor = createNoteEditor({
  root: $("note"),
  splitter: $("splitter"),
  list: $("tree"),
  onChange: () => tree.render(), // marks (or unmarks) the open note in the list
});

const tree = createTreeView({
  root: $("tree"),
  getState,
  getWindowId,
  openMenu: (e, id, ids) => menu.openForNode(e, id, ids, ids ? () => tree.clearSelection() : null),
  onSelectionChange: (n) => updateSelectionBar(n),
  peekRoot: $("peek"),
  onPeekChange: (id) => bar.setPeeking(id),
  openNote: (id) => editor.open(id),
  getOpenNoteId: () => (editor.isOpen() ? editor.currentId() : null),
  getQuery: () => search.query(),
  onResults: ({ count, searching }) => search.setCount(count, searching),
  onOpenFolder: () => search.close(), // going into a folder from the results ends the search
});

// The picture and text that appear when you rest on a tab (settings → hover).
const hover = createHover({ root: $("tree"), card: $("preview"), getState, getWindowId });

// Collapsed until asked for. The list filters itself; the bar only holds the field.
const search = createSearchBar({
  root: $("searchbar"),
  onChange: () => tree.render(),
  onMove: (d) => tree.moveCursor(d),
  onEnter: () => tree.activateCursor(),
  onToggle: (on) => {
    $("toolbar").querySelector(".search-toggle")?.setAttribute("aria-pressed", String(on));
    tree.render();
  },
});

// A quiet reminder that several rows are selected, with a way out.
function updateSelectionBar(count) {
  const el = $("selbar");
  el.hidden = count < 1;
  if (count < 1) return el.replaceChildren();
  el.replaceChildren(
    h("span", {}, `${count} selected`),
    h("span", { class: "hint" }, count > 1 ? "Right-click for actions" : "Ctrl-click adds more, Shift-click selects a range"),
    h("button", { class: "tool", title: "Clear selection (Esc)", "aria-label": "Clear selection", onclick: () => tree.clearSelection() }, icon("close", { size: 14 }))
  );
}

const bar = createPanelBar({
  root: $("panelbar"),
  getState,
  getWindowId,
  getDraggingIds: () => tree.getDraggingIds(),
  showMenu: (e, items) => menu.show(e, items),
  onHoverPanel: (id) => tree.setPeek(id), // rest on a panel while dragging: see its tree
});

const crumbs = createBreadcrumb({
  root: $("crumbbar"),
  getState,
  getWindowId,
  getDraggingIds: () => tree.getDraggingIds(),
});

const view = () => viewOf(state, windowId);

function toolButton(name, title, onclick, cls = "") {
  return h("button", { class: `tool ${cls}`.trim(), title, "aria-label": title, onclick }, icon(name, { size: 18 }));
}

// Where "new" things go, in words: the buttons say it in their tooltips.
function placeName() {
  const v = view();
  const folder = v.folderId ? state.nodes[v.folderId] : null;
  return folder ? `“${folder.name || "Folder"}”` : `“${state.panels.find((p) => p.id === v.panelId)?.name ?? "this panel"}”`;
}

function buildToolbar() {
  const el = $("toolbar");
  const inFolder = !!(state && view().folderId);
  const where = state ? placeName() : "here";
  el.replaceChildren(
    ...[
      // The one thing you do all day gets a label; the rarer ones are icons that say what they make.
      h("button", { class: "new-tab", title: `New tab in ${where}`, onclick: () => run("tab:new", { windowId, panelId: view().panelId }) },
        icon("plus", { size: 14 }), h("span", { class: "label" }, "New tab")),
      toolButton("folderPlus", `New folder in ${where}`, async () => {
        const name = await askText("Folder name", "New folder");
        if (name) run("folder:create", { name, windowId, panelId: view().panelId });
      }, "make"),
      inFolder
        ? toolButton("notePlus", `New note in ${where}`, async () => {
            const name = await askText("Note title", "Untitled note");
            if (!name) return;
            const id = await run("note:create", { folderId: view().folderId, name });
            if (id) editor.open(id);
          }, "make")
        : null,
      h("span", { class: "spacer" }),
      h("button", { class: "tool search-toggle", title: "Search this view (Ctrl+F)", "aria-label": "Search", "aria-pressed": String(search.isOpen()), onclick: () => search.toggle() }, icon("search", { size: 18 })),
      toolButton("collapseAll", "Collapse all", () => run("tree:collapseAll", { panelId: view().panelId })),
      toolButton("expandAll", "Expand all", () => run("tree:expandAll", { panelId: view().panelId })),
      toolButton("gear", "Settings, rules and export", () => browser.runtime.openOptionsPage()),
    ].filter(Boolean)
  );
}

let toolbarKey = "";
function renderAll() {
  if (!state) return;
  bar.render();
  crumbs.render();
  const v = view();
  // Rebuilt when you move to another panel or folder, so the tooltips name the right place.
  const key = `${v.panelId}:${v.folderId ?? ""}:${v.folderId ? state.nodes[v.folderId]?.name : state.panels.find((p) => p.id === v.panelId)?.name}`;
  if (key !== toolbarKey) {
    toolbarKey = key;
    buildToolbar();
  }
  search.setScope(v.folderId ? `in ${placeName()} and subfolders` : `in ${placeName()}`);
  tree.render();
  hover.refresh();
}

async function main() {
  const win = await browser.windows.getCurrent();
  windowId = win.id;
  incognito = !!win.incognito;
  document.body.classList.toggle("private", incognito);
  connect((next) => {
    // The first state can arrive before the background has learned this window is private;
    // never draw a state meant for the other kind of window.
    if (!!next.private !== incognito) return;
    state = next;
    // Close the editor only if its note was deleted. Switching panel or folder
    // leaves it open: that is the point of having it beside the tabs.
    if (editor.isOpen() && !state.nodes[editor.currentId()]) editor.close();
    renderAll();
  }, { windowId });
  // The same keys as on a page (gt, t, H, ...), while the sidebar has the focus.
  globalThis.groveVimKeys?.install(window, {
    active: () => !!state?.settings?.vim?.enabled,
    send: (action) => run("vim:do", { action, windowId }),
  });
}

main();
