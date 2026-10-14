# Grove

Tree-style tabs, switchable panels, per-domain containers, folders and
export/import for Firefox. Small core, every feature is a module.

## Install

**To try it** (gone after Firefox restarts): `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → pick `manifest.json`. Open the sidebar with `Alt+Shift+G`.

**To keep it** (survives restarts). Release Firefox only runs signed add-ons, so pick one:

1. *Any Firefox, recommended: sign it for yourself.* Free, not published anywhere.
   - Make an account at addons.mozilla.org, then create API credentials at
     `https://addons.mozilla.org/developers/addon/api/key/`.
   - In this folder run `npm install` once, then (needs Node):
     `WEB_EXT_API_KEY=<issuer> WEB_EXT_API_SECRET=<secret> npm run sign`
   - It writes a signed `.xpi` into `web-ext-artifacts/`. Open that file in Firefox
     (drag it onto a window, or `about:addons` → gear → *Install Add-on From File…*).
   - Every signing needs a higher `version` in `manifest.json` than the last one you signed.
     Install a newer signed file over the old one; your data stays.
2. *Developer Edition, Nightly or ESR, unsigned:* set `xpinstall.signing.required` to `false`
   in `about:config`, then build the package with just Python 3 (already on Ubuntu; no npm,
   no extra packages):
   `./scripts/make-xpi.py` (or `python3 scripts/make-xpi.py`). It writes
   `dist/grove-<version>.xpi`; install that from file (`about:addons` → gear → *Install
   Add-on From File…*). Release and Beta ignore that setting.
   Always install the `.xpi` that script makes, not a zip of the folder: Firefox calls the
   package "corrupt" unless `manifest.json` sits at the top of the archive. The script
   checks that, and that every file the manifest names is in the package.

Before switching between install kinds, export your data once (settings page → Export JSON).
The add-on id is `grove@local`; if addons.mozilla.org rejects it, change `id` in
`manifest.json`, but note that a new id is a new add-on with empty storage, so import your export.

Optional: hide Firefox's own tab strip so only Grove shows tabs. Extensions cannot
do this themselves (Firefox does not allow it), so it is a one-time profile change:
set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true` in `about:config`, then
put this in `<profile folder>/chrome/userChrome.css` (the settings page walks through it):

```css
#TabsToolbar { visibility: collapse !important; }
```

Pinned tabs are not listed by Grove yet, so with the strip hidden they are out of sight.

## What it does

| Feature | Where |
|---|---|
| Panels: separate contexts; switching hides other panels' tabs (`tabs.hide`) | `modules/panels.js` |
| Tree tabs: links become children, your own new tabs become siblings; drag and drop, collapse | `modules/tabs.js`, `modules/tree.js`, `lib/tree.js` |
| Folders as contexts: click a folder to work inside it (breadcrumb, tabs outside are hidden) | `modules/folders.js`, `modules/windows.js` |
| Notes: plain-text files that live inside folders | `modules/notes.js` |
| Containers by panel and domain; blocking reroute before any request | `modules/containers.js`, `lib/rules.js` |
| Select several rows (Ctrl/Cmd-click, Shift-click a range), drag them together, right-click for unload / load / close / move into a new folder / move to a panel | `sidebar/ui/tree-view.js`, `modules/menu.js` |
| Search (the magnifier, Ctrl+F or `/`): aimed at the panel you are in, or the open folder and its subfolders; matches titles and addresses; `AND`, "quotes" | `lib/search.js`, `sidebar/ui/search-bar.js` |
| Drop a link, bookmark or downloaded file onto the list (or a panel tab) to open it as a tab right there | `sidebar/ui/external-drop.js`, `modules/tabs.js` |
| Rest on a panel tab while dragging to see that panel's tree and drop on an exact spot, without leaving your tab | `sidebar/ui/tree-view.js` |
| Folders show how many tabs and notes they hold, open or closed | `sidebar/ui/tree-view.js` |
| Exports named with date and time, saved into a folder inside Downloads; optional automatic backups | `modules/backup.js` |
| Notes open in a pane under the tab list (drag the divider), so tabs stay in view | `sidebar/ui/note-editor.js` |
| Unloaded tabs are shown dimmed; "Unload tab" / "Load tab" in the menu; tabs that were loaded are loaded again after a restart | `modules/tabs.js` |
| Mute / unmute from the speaker icon; playing-sound hints on panels and collapsed branches | `modules/tabs.js`, `sidebar/ui/tree-view.js` |
| Export JSON / Markdown / bookmarks HTML; import JSON (merge or replace); notes included | `modules/io.js` |
| Settings page generated from module-declared schemas, plus a diagnostics log you can switch off | `modules/settings.js`, `modules/diagnostics.js`, `options/` |

Shortcuts: `Alt+Shift+Period` / `Alt+Shift+Comma` next/previous panel.
Everything is also reachable from the background console: `__grove.ctx.commands.list()`.

### Where new tabs go

Tree position means "where did this come from":

- a link opened from a tab: **child** of that tab, appended so children read in the order you opened them
- a tab you open yourself (Ctrl+T, the + button): **sibling** of the current tab, after the current tab's whole subtree (setting: child, or end of list)
- inside an open folder, new tabs land in that folder

Whether a tab came from a link is decided from two independent signals
(`tab.openerTabId` and `webNavigation.onCreatedNavigationTarget`, which may
arrive late and then moves the tab under its opener). If neither fires, the tab
is treated as opened by you, so it lands right beside where you were. Every
decision is listed under **Diagnostics** on the settings page.

### Folders, notes and the containment rules

```
folder  holds folders, tabs and notes (and may sit at the top of a panel)
tab     holds only tabs (children = "opened from this")
note    holds nothing, and only exists inside a folder
```

Clicking a folder opens it as a context, like switching panel: the sidebar shows
its contents, tabs outside it are hidden, one of its tabs becomes active. The
chevron still expands a folder in place in the whole-panel view. Leaving a panel
and coming back returns you to the folder you had open; clicking the active
panel goes to its top level. Activating a tab outside the open folder (from the
browser) widens the view so you never look at a tab that is not in the list.

Notes are stored under their own storage keys, not in the tree, so long texts do
not slow down sidebar updates. Ungrouping a folder is refused when that would
leave notes outside any folder.

### Selecting folded rows

Ctrl/Shift-selecting a folded tab or folder selects everything folded inside it as well; deselecting it clears them.
Menus, drags and closing act on the whole selection.

### Moving a tab out one level

A link opened from a page becomes a child of the tab it came from. When it should have been a sibling, take it out
with **Alt+Shift+Left** (works from the page, no need to click the sidebar) or right-click → "Move out one level" (also for
several selected rows). The tab lands right after its former parent, and its own children come with it. Only a child of
a tab moves; tabs inside a folder stay in their folder. The shortcut can be turned off under Settings → tabs, or
changed in about:addons → ⚙ → Manage Extension Shortcuts.

### Vim-style keys

Settings → vim (off until you tick it; untick to pause). They work on web pages and while the sidebar has the focus,
and are ignored while you type in a field or hold Ctrl, Alt or Meta.

| Keys | Does |
| --- | --- |
| `gt` | next tab |
| `gT`, `gs` | previous tab |
| `t` | new tab in the current panel (goes into the panel's container, like the + button) |
| `H`, `L` | back, forward (the arrows next to the address bar) |
| `<<`, `>>` | move the tab up, down among its siblings (Shift+, and Shift+. pressed twice); never across levels, children travel with it |

Next/previous follow the order of the sidebar, wrap around, step over what is folded away, and stay in the open
panel (or folder). The settings say whether tabs that are not loaded count (they load when you arrive), and list
sites where the keys stay out of the way (same patterns as container rules: `github.com`, `*.example.com`,
`example.com/docs`, `=example.com`, `/regex/`; `#` starts a comment). The exceptions apply to pages, not to the sidebar.

Limits: Firefox does not run extension scripts on its own pages (about:…), on addons.mozilla.org, in the PDF viewer or in
view-source, so the keys do nothing there unless the sidebar is focused. A `g` or `<` that begins a sequence is not passed
to the page; use the exceptions for sites with their own shortcuts.

### Container rules

A rule maps an address pattern to a container, in the panels you tick (none ticked =
every panel). There is one rule per pattern; so the same site cannot go to different
containers in different panels, but one rule can cover as many panels as you like.
Rules saved by earlier versions are merged on upgrade (the old list is kept under
`rulesBefore`, and any rule that had to be dropped is listed in Diagnostics).
Patterns: `example.com`, `=example.com`, `*.example.com`, `example.com/work`
(path prefix), `/regex/`; a pasted address works. Rules apply to every tab,
including tabs already in a container, except tabs you reopened in a container
yourself ("Reopen in container…"). A panel's default container is where tabs
opened in that panel start: tabs Grove opens (the + button, dropped links, searches) go
straight into it, and a new tab you open yourself (Ctrl+T) is swapped for an empty one in it.
A tab that already shows a page, or is loading a link, is not moved by it; a rule for its
address still is. The settings page has a tester ("what happens for this
address in this panel?") and a log of recent routing decisions.

## Private browsing

Allow Grove in private windows (about:addons → Grove → Run in Private Windows). Private windows get a
space of their own, kept apart from the normal one in both directions:

- A private window has its own panel ("Private", more can be added), and its own folders, notes and tabs, with
  drag and drop, search and the rest. It shows a small "Private" mark and a purple line under the panel bar.
- The normal space (panels, folders, notes, tabs) never appears in a private window, and the private space never
  appears in a normal one. Nothing can be moved between them.
- The private space exists **in memory only**: never written to storage, sessions values, the favicon cache, the
  diagnostics log, exports or automatic backups. Note texts written in a private window are kept in memory too.
- It ends with the last private window: its panels, folders and notes are removed along with its tabs, as Firefox
  forgets the window itself. Closing one of several private windows leaves the space in place.
- Importing never touches it. Container rules and panel default containers do not apply (private windows have no containers).
- Versions before 0.8.0 saved private tabs, and 0.8.0 still showed normal folders in private windows; entries saved
  by earlier versions stay until you delete them.

## Architecture

```
src/core/       kernel (module loader), events, hooks, commands, store
src/lib/        pure logic with no browser APIs (tree.js, rules.js)
src/modules/    one file per feature; index.js is the list that gets loaded
src/sidebar/    UI (talks to background only through the bridge)
src/options/    settings, rules, export/import page
```

Four primitives, and modules use only these to talk to each other:

- **commands** `commands.register("x:do", fn)` / `commands.run("x:do", args)`.
  The public API. The UI, shortcuts and other modules all use it.
- **events** `bus.on("tab:created", fn)` / `bus.emit(...)`. Notifications.
- **hooks** `hooks.tap("tab:placement", (value, ctx) => newValue)`. A pipeline
  that lets a module change a decision made elsewhere.
- **store** persisted state, one top-level key per module.

A failing module, listener or hook is logged and skipped; it never takes the
rest down. A module whose dependency failed is skipped too.

### Writing a module

```js
// src/modules/autocollapse.js
export default {
  name: "autocollapse",
  deps: ["tree", "settings"],
  setup({ bus, commands, modules }) {
    modules.settings.register("autocollapse", {
      enabled: { type: "boolean", label: "Collapse branches when I leave them", default: false },
    });
    bus.on("tab:activated", ({ nodeId }) => { /* ... */ });
    commands.register("autocollapse:now", () => { /* ... */ });
  },
};
```

Add it to `src/modules/index.js`. Its settings show up in the settings page
automatically. See `test/integration.test.js` ("extensibility") for a module that
changes tab placement and adds a context-menu item using hooks only.

Extension points currently defined:

| Hook | Purpose |
|---|---|
| `tab:placement` | change which panel/parent/position a new tab gets |
| `tree:move` | change or veto a move (return `null` to veto) |
| `ui:menu` | add context-menu items for a row |
| `ui:state` | add data to the state sent to the sidebar |

Other things a module can use: `modules.diagnostics.log(kind, data)` to show
decisions on the settings page, and the `tree:removed` / `window:viewChanged` events.

## Data model

One flat map `nodes[id]` of `{ type: "tab" | "folder" | "note", panelId, parentId, order, collapsed, ... }`.
Data saved by older versions is repaired on startup (`normalize`).
Tabs are stamped with their node id using `sessions.setTabValue`, so after a
restart or session restore each browser tab is matched back to its exact node.
Tabs from a closed window stay in the tree as greyed "ghosts" for 10 minutes
(configurable) and are re-linked when reopened.

## Tests

```
npm test
```

Export/import is tested as a round trip into a second profile whose container ids differ.
Unit tests cover the tree algorithms, rule matching, module ordering, hooks.
Integration tests run the real modules against an in-memory fake of the
Firefox API (`test/fake-browser.js`): panels, hiding, reroutes, restart,
export/import, the UI bridge, third-party modules.
The fake is not Firefox. Real-browser behaviour is the thing to check first.

### Backups

Automatic backups (Settings → backup) are off by default, and the two are independent,
so use either or both. *Keep one file up to date* rewrites a single file shortly after
anything changes; you choose its name (default `grove-latest.json`, `.json` is added if you
leave the extension off). *Also save a timestamped copy* adds a dated file every so often
and deletes the oldest beyond "keep". Each skips the write when nothing changed. Firefox only lets an extension save inside its Downloads
folder, so the setting is a folder name there (`Grove`, `Backups/Grove`). To land the
files somewhere else, point Firefox's download folder at it. Import is always manual.

Automatic saves are kept out of Firefox's download list (setting *quiet*, on by default): each one is
removed from the list as soon as it is done, and the file stays on disk. That keeps the toolbar's
download panel from filling up with every save. Timestamped copies are hidden only when "keep" is 0,
because Firefox can delete a file only through the entry that created it; with a number above 0 the
copies you keep stay listed. Saves you start by hand are always listed. An extension cannot stop
Firefox from flashing the downloads button when a save starts; if the panel opening by itself bothers you,
`browser.download.alwaysOpenPanel` = false in about:config should stop that (from memory, not checked here).

### Search

The magnifier in the toolbar (or Ctrl+F, or `/` when you are not typing) opens a search field;
it stays out of the way until then. What it searches depends on where you are: the whole panel,
or, inside an open folder, that folder with everything under it, subfolders included and
collapsed branches too. A tab matches on its title, a title you gave it, or its address
(percent-escapes are read, accents and case are ignored); a folder or note on its name.
Pinned tabs are not searched, and note text is not either (only the note's title).

Every word has to match, and `AND` between terms means the same, so `github AND pull` finds a page
whose address has github and whose title has Pull. Put words in "quotes" to keep them together as
a phrase, and quote `"and"` to search for the word itself. Results are listed in tree order with
the matched words marked and, on the right, the folder each is in (or the site). Up/Down move
the highlight, Enter opens it, Esc closes the search. Going into a folder from the results ends it.

### Importing

Each panel in the file goes to exactly one panel here, and no two go to the same one: first a
panel with the same id (the same profile, or a restored one), else one with the same name that
no other panel in the file has already taken, else a new panel. So two panels that share a name stay two
panels. Panels are created before their tabs, and the whole file is read and checked before anything
here is changed, so a damaged file is refused, or skipped entry by entry, and never half-applied.

### Dropping links

Text with no link in it, dragged in from a page, is searched for with your default search
engine, in a new tab at the drop place. It opens in the background, so you stay on what
you were reading. Links, bookmarks and downloads dragged into the sidebar open at the spot you drop on
(inside a folder, under a tab, or in another panel's list; dropped on a panel tab they
open at the end of that panel). A file dragged from the desktop cannot be opened this
way: Firefox gives pages the name of such a file but not where it is. Drag it from the
Downloads panel instead, which gives a `file://` address.

## Known limits

- Split view: Firefox 149+ tells extensions which tabs share a split view (Grove marks them),
  but there is no extension API to create or remove one yet (Mozilla bug 2016928), so Grove cannot open a tab in split view.
- After a restart Firefox restores tabs unloaded. Grove wakes the ones that were loaded when you left, one at a time
  (setting "tabs.restoreLoaded"), using `tabs.reload`, and falls back to navigating to the tab's address. Unverified in a real browser.
  While the browser reports being offline Grove waits and loads them when the connection returns: loading a page
  with no connection would only replace it with an error page. Firefox cannot be told to load a page from its cache
  while offline, so a page can only be "loaded" with a connection.
- Not in yet: a pinned section in the sidebar
  (pinned tabs stay in Firefox's own strip and are shared across panels), dragging a
  tab out of the sidebar into another window, sync between devices.
- Opening an empty folder opens one blank tab inside it (Firefox needs a visible tab).
- Container rerouting reopens the tab, so a navigation that must change
  container loses the old tab's history (the old tab is kept if it had a page).
- Private windows: see "Private browsing".
- The tests run against an in-memory fake of the Firefox API, not Firefox itself.
