import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";
import * as B from "../src/lib/bookmarks.js";

const U = (n) => `https://${n}.test/`;
const OTHER = "unfiled_____";

async function setup(urls = ["a", "b"]) {
  const t = await boot({ seed: urls.map((n, i) => ({ url: U(n), active: i === 0 })) });
  t.node = (n) => t.nodeByUrl(U(n));
  t.marks = async () => (await t.run("bookmarks:tree")).roots;
  t.other = async () => (await t.marks()).find((r) => r.id === OTHER);
  return t;
}
const shape = (list) => list.map((n) => (n.type === "folder" ? { [n.title]: shape(n.children) } : n.url));

// ---- the tree ----

test("the bookmark tree is the browser's own, with its four built-in folders", async () => {
  const t = await setup();
  t.sim.seedBookmarks("toolbar_____", [{ title: "News", url: "https://news.test/" }]);
  const { roots, groveId } = await t.run("bookmarks:tree");
  assert.deepEqual(roots.map((r) => r.id), ["menu________", "toolbar_____", "unfiled_____", "mobile______"]);
  assert.equal(groveId, undefined, "Grove makes no folder of its own");
  assert.equal(roots[1].children[0].url, "https://news.test/");
});

// ---- saving tabs ----

test("a tab with no folder chosen goes to Other Bookmarks, and Grove makes no folder of its own", async () => {
  const t = await setup();
  const r = await t.run("bookmarks:save", { ids: [t.node("a")] });
  assert.equal(r.saved, 1);
  assert.equal(r.parentId, OTHER);
  assert.deepEqual(shape((await t.other()).children), [U("a")]);
  assert.ok(!JSON.stringify(await t.marks()).includes('"Grove"'));
});

test("a tab goes where you chose, and that is remembered as the place last used", async () => {
  const t = await setup();
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Read", url: undefined });
  const r = await t.run("bookmarks:save", { ids: [t.node("a")], parentId: dir });
  assert.equal(r.parentId, dir);
  assert.deepEqual(shape((await t.marks()).find((x) => x.id === "toolbar_____").children), [{ Read: [U("a")] }]);
  assert.equal((await t.run("bookmarks:prefs")).lastId, dir);
  assert.deepEqual(shape((await t.other()).children), []);
});

test("a folder that is gone, or is not a folder, falls back instead of failing", async () => {
  const t = await setup();
  const bm = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "B", url: U("x") });
  for (const parentId of ["nope", bm, "root________"]) {
    const r = await t.run("bookmarks:save", { ids: [t.node("a")], parentId });
    assert.equal(r.parentId, OTHER, String(parentId));
  }
});

test("a default folder is used when none is chosen; one that is later deleted is forgotten", async () => {
  const t = await setup();
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Inbox" });
  assert.equal(await t.run("bookmarks:setDefault", { id: dir }), true);
  let p = await t.run("bookmarks:prefs");
  assert.equal(p.defaultId, dir);
  assert.equal(p.defaultTitle, "Inbox");
  assert.equal(p.ask, true, "still asking until told to stop");
  assert.equal((await t.run("bookmarks:save", { ids: [t.node("a")] })).parentId, dir);
  await t.run("bookmarks:remove", { id: dir });
  p = await t.run("bookmarks:prefs");
  assert.equal(p.defaultId, null);
  assert.equal(p.ask, true);
  assert.equal((await t.run("bookmarks:save", { ids: [t.node("b")] })).parentId, OTHER);
});

test("stop asking needs a real default; an invalid one clears it", async () => {
  const t = await setup();
  await t.run("bookmarks:setDefault", { id: "nope", stopAsking: true });
  assert.equal((await t.run("bookmarks:prefs")).defaultId, null);
  assert.equal(t.m.settings.get("bookmarks", "ask"), true, "nothing to fall back on: keep asking");
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Inbox" });
  await t.run("bookmarks:setDefault", { id: dir, stopAsking: true });
  assert.equal(t.m.settings.get("bookmarks", "ask"), false);
  assert.equal((await t.run("bookmarks:prefs")).ask, false);
  await t.run("bookmarks:setDefault", { id: null });
  assert.equal((await t.run("bookmarks:prefs")).ask, true, "no default: it has to ask");
});

test("a tab with children becomes a folder in the same shape; a Grove folder too; notes stay behind", async () => {
  const t = await setup(["a", "kid", "grand", "solo"]);
  await t.run("tree:move", { id: t.node("kid"), parentId: t.node("a"), index: 0 });
  await t.run("tree:move", { id: t.node("grand"), parentId: t.node("kid"), index: 0 });
  const f = await t.run("folder:create", { name: "Research", panelId: t.panelId, nodeIds: [t.node("solo")] });
  await t.run("note:create", { folderId: f, name: "Thoughts" });
  const r = await t.run("bookmarks:save", { ids: [t.node("a")] });
  assert.equal(r.saved, 3);
  const kids = async () => (await t.other()).children;
  assert.deepEqual(shape(await kids()), [{ [t.m.tree.get(t.node("a")).title]: [U("a"), { [t.m.tree.get(t.node("kid")).title]: [U("kid"), U("grand")] }] }]);
  const r2 = await t.run("bookmarks:save", { ids: [f] });
  assert.equal(r2.saved, 1);
  assert.equal(r2.skipped, 1, "the note is not saved");
  assert.ok(shape(await kids()).some((x) => x.Research && x.Research[0] === U("solo")));
});

test("saving the same thing twice changes nothing", async () => {
  const t = await setup(["a", "b"]);
  const f = await t.run("folder:create", { name: "Pair", panelId: t.panelId, nodeIds: [t.node("a"), t.node("b")] });
  await t.run("bookmarks:save", { ids: [f] });
  const before = JSON.stringify(t.sim.bookmarkTree());
  const r = await t.run("bookmarks:save", { ids: [f] });
  assert.equal(r.saved, 0);
  assert.equal(r.duplicates, 2);
  assert.equal(JSON.stringify(t.sim.bookmarkTree()), before);
});

test("several tabs at once keep together in a folder named for the moment", async () => {
  const t = await setup(["a", "b", "c"]);
  await t.run("bookmarks:save", { ids: [t.node("c"), t.node("a")] });
  const g = await t.other();
  assert.equal(g.children.length, 1);
  assert.match(g.children[0].title, /^Saved \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(shape(g.children[0].children), [U("a"), U("c")], "in the order they are shown, whatever order they were picked in");
});

test("a new tab is not worth keeping, and nothing is made when there is nothing to keep", async () => {
  const t = await setup(["a"]);
  const blank = await t.browser.tabs.create({ windowId: t.winId, url: "about:newtab" });
  await settle();
  const r = await t.run("bookmarks:save", { ids: [t.m.tabs.nodeIdOf(blank.id)] });
  assert.equal(r.saved, 0);
  assert.deepEqual((await t.other()).children, [], "and nothing is made for it");
});

test("saving tells the window it was saved from", async () => {
  const t = await setup();
  const ui = t.sim.connectUi({ windowId: t.winId });
  const other = t.sim.addWindow();
  const elsewhere = t.sim.connectUi({ windowId: other.id });
  await settle();
  await t.run("bookmarks:save", { ids: [t.node("a")], windowId: t.winId });
  const toast = ui.received.find((m) => m.type === "toast");
  assert.match(toast.text, /1 bookmark saved to “Other Bookmarks”/);
  assert.ok(!elsewhere.received.some((m) => m.type === "toast"));
});

test("the menu offers to bookmark a tab, a branch, a folder and a selection; each opens the folder picker", async () => {
  const t = await setup(["a", "b"]);
  const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);
  const find = (items, label) => items.find((i) => i.label === label);
  const tab = await t.run("ui:menu", { id: t.node("a") });
  const item = find(tab, "Bookmark tab…");
  assert.ok(item);
  assert.equal(item.ui, "bookmark");
  assert.deepEqual(item.args.ids, [t.node("a")]);
  assert.equal(item.initial, OTHER, "no default and nothing saved yet: Other Bookmarks");
  await t.run("tree:move", { id: t.node("b"), parentId: t.node("a"), index: 0 });
  assert.ok(labels(await t.run("ui:menu", { id: t.node("a") })).includes("Bookmark tab and children…"));
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId, nodeIds: [t.node("a")] });
  assert.ok(labels(await t.run("ui:menu", { id: f })).includes("Save folder to bookmarks…"));
  const note = await t.run("note:create", { folderId: f, name: "n" });
  assert.ok(!labels(await t.run("ui:menu", { id: note })).some((l) => /ookmark/.test(l)), "a note has no address");
  const sel = await t.run("ui:menu", { ids: [t.node("a"), t.node("b")] });
  assert.ok(labels(sel).includes("Bookmark 2 items…"));
});

test("with a default and asking off, the menu saves straight there and keeps a way to choose", async () => {
  const t = await setup(["a"]);
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Inbox" });
  await t.run("bookmarks:setDefault", { id: dir, stopAsking: true });
  const items = await t.run("ui:menu", { id: t.node("a") });
  const direct = items.find((i) => i.label === "Bookmark tab to “Inbox”");
  assert.ok(direct);
  assert.equal(direct.command, "bookmarks:save");
  assert.equal(direct.args.parentId, dir);
  const pick = items.find((i) => i.label === "Bookmark tab to…");
  assert.equal(pick.ui, "bookmark");
  assert.equal(pick.initial, dir);
  assert.ok(!items.some((i) => i.label === "Bookmark tab…"));
  await t.run("settings:set", { module: "bookmarks", key: "ask", value: true });
  assert.ok((await t.run("ui:menu", { id: t.node("a") })).some((i) => i.label === "Bookmark tab…"), "asking again brings the picker back");
});

test("the picker starts at the place last used when there is no default", async () => {
  const t = await setup(["a"]);
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Read" });
  await t.run("bookmarks:save", { ids: [t.node("a")], parentId: dir });
  const item = (await t.run("ui:menu", { id: t.node("a") })).find((i) => i.ui === "bookmark");
  assert.equal(item.initial, dir);
});

// ---- managing ----

test("create, rename, change the address, move and delete work on the real bookmarks", async () => {
  const t = await setup();
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Work" });
  const a = await t.run("bookmarks:create", { parentId: dir, title: "A", url: U("x") });
  const b = await t.run("bookmarks:create", { parentId: dir, title: "B", url: U("y") });
  await t.run("bookmarks:update", { id: a, title: "Alpha", url: U("z") });
  const find = async () => (await t.marks()).find((r) => r.id === "toolbar_____").children[0].children;
  assert.deepEqual((await find()).map((n) => [n.title, n.url]), [["Alpha", U("z")], ["B", U("y")]]);
  await t.run("bookmarks:move", { id: a, parentId: dir, index: 1 });
  assert.deepEqual((await find()).map((n) => n.title), ["B", "Alpha"], "index is where it ends up");
  await t.run("bookmarks:move", { id: b, parentId: "menu________" });
  assert.equal((await t.marks())[0].children[0].title, "B");
  assert.equal(await t.run("bookmarks:remove", { id: "toolbar_____" }), false, "a built-in folder cannot be deleted");
});

test("a deleted folder comes back, contents and place included", async () => {
  const t = await setup();
  t.sim.seedBookmarks("toolbar_____", [{ title: "first", url: U("1") }, { title: "Dir", children: [{ title: "in", url: U("2") }, { title: "Sub", children: [{ title: "deep", url: U("3") }] }] }, { title: "last", url: U("4") }]);
  const dir = (await t.marks()).find((r) => r.id === "toolbar_____").children[1];
  assert.equal(await t.run("bookmarks:remove", { id: dir.id }), true);
  assert.deepEqual(shape((await t.marks()).find((r) => r.id === "toolbar_____").children), [U("1"), U("4")]);
  assert.equal(await t.run("bookmarks:undo"), true);
  assert.deepEqual(shape((await t.marks()).find((r) => r.id === "toolbar_____").children), [U("1"), { Dir: [U("2"), { Sub: [U("3")] }] }, U("4")]);
  assert.equal(await t.run("bookmarks:undo"), false, "only the last delete is kept");
});

test("changes in the bookmarks reach every sidebar", async () => {
  const t = await setup();
  const ui = t.sim.connectUi({ windowId: t.winId });
  await settle();
  await t.browser.bookmarks.create({ parentId: "toolbar_____", title: "x", url: U("x") });
  await settle(200);
  assert.ok(ui.received.some((m) => m.type === "bookmarks"));
});

// ---- opening ----

test("opening a bookmark switches to the tab that has it, or opens one", async () => {
  const t = await setup(["a", "b"]);
  const bm = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "B", url: U("b") });
  await t.run("bookmarks:open", { id: bm, windowId: t.winId });
  await settle();
  assert.equal([...t.sim.tabs.values()].filter((x) => x.url === U("b")).length, 1, "no second tab");
  assert.equal(t.tabByUrl(U("b")).active, true);

  const fresh = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "N", url: U("n") });
  await t.run("bookmarks:open", { id: fresh, windowId: t.winId });
  await settle();
  assert.equal(t.sim.byUrl(U("n")).length, 1);

  await t.run("settings:set", { module: "bookmarks", key: "reuse", value: false });
  await t.run("bookmarks:open", { id: bm, windowId: t.winId });
  await settle();
  assert.equal(t.sim.byUrl(U("b")).length, 2, "when asked, always a new tab");
});

test("a bookmark can open as a child of the current tab, or behind it", async () => {
  const t = await setup(["a"]);
  const bm = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "K", url: U("kid") });
  const bg = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "G", url: U("bg") });
  await t.run("bookmarks:open", { id: bm, windowId: t.winId, mode: "child" });
  await t.run("bookmarks:open", { id: bg, windowId: t.winId, mode: "background" });
  await settle(100);
  assert.equal(t.m.tree.get(t.nodeByUrl(U("kid"))).parentId, t.node("a"));
  assert.equal(t.tabByUrl(U("bg")).active, false);
});

test("a bookmark folder opens as a Grove folder of saved tabs that are not loaded", async () => {
  const t = await setup(["a"]);
  t.sim.seedBookmarks("toolbar_____", [{ title: "Trip", children: [{ title: "Flights", url: U("f") }, { title: "Hotels", children: [{ title: "H1", url: U("h1") }] }] }]);
  const dir = (await t.marks()).find((r) => r.id === "toolbar_____").children[0];
  const before = t.sim.tabs.size;
  const root = await t.run("bookmarks:openFolder", { id: dir.id, windowId: t.winId });
  await settle();
  assert.equal(t.sim.tabs.size, before, "no browser tab was opened");
  const n = t.m.tree.get(root);
  assert.equal(n.type, "folder");
  assert.equal(n.name, "Trip");
  assert.equal(n.panelId, t.panelId);
  const kids = (id) => Object.values(t.m.tree.all()).filter((x) => x.parentId === id).sort((p, q) => p.order - q.order);
  const [fl, hotels] = kids(root);
  assert.equal(fl.url, U("f"));
  assert.equal(fl.saved, true);
  assert.equal(fl.tabId ?? null, null);
  assert.equal(hotels.name, "Hotels");
  assert.equal(kids(hotels.id)[0].url, U("h1"));
  // clicking one opens it
  await t.run("tab:activate", { id: fl.id, windowId: t.winId });
  await settle();
  assert.equal(t.sim.byUrl(U("f")).length, 1);
});

test("a bookmark folder opens inside the folder you have open, and can open loaded", async () => {
  const t = await setup(["a"]);
  const mine = await t.run("folder:create", { name: "Mine", panelId: t.panelId });
  await t.run("folder:enter", { windowId: t.winId, id: mine });
  t.sim.seedBookmarks("toolbar_____", [{ title: "Pair", children: [{ title: "1", url: U("1") }, { title: "2", url: U("2") }] }]);
  const dir = (await t.marks()).find((r) => r.id === "toolbar_____").children[0];
  const root = await t.run("bookmarks:openFolder", { id: dir.id, windowId: t.winId, loaded: true });
  await settle(100);
  assert.equal(t.m.tree.get(root).parentId, mine);
  assert.equal(t.sim.byUrl(U("1")).length + t.sim.byUrl(U("2")).length, 2, "loaded: real tabs");
});

test("in a private window a bookmark folder opens in the private space only", async () => {
  const t = await setup(["a"]);
  const w = t.sim.addWindow({ incognito: true });
  await settle(50);
  t.sim.seedBookmarks("toolbar_____", [{ title: "P", children: [{ title: "1", url: U("p1") }] }]);
  const dir = (await t.marks()).find((r) => r.id === "toolbar_____").children[0];
  const root = await t.run("bookmarks:openFolder", { id: dir.id, windowId: w.id });
  const n = t.m.tree.get(root);
  assert.equal(n.private, true);
  assert.equal(t.m.windows.isPrivatePanel(n.panelId), true);
  assert.ok(Object.values(t.m.tree.all()).filter((x) => x.parentId === root).every((x) => x.private));
});

// ---- backups ----

test("a JSON export carries the bookmarks, and importing it elsewhere adds only what is missing", async () => {
  const t = await setup(["a"]);
  t.sim.seedBookmarks("toolbar_____", [{ title: "News", url: U("news") }, { title: "Dir", children: [{ title: "in", url: U("in") }] }]);
  t.sim.seedBookmarks("unfiled_____", [{ title: "loose", url: U("loose") }]);
  const out = await t.run("io:export", { scope: "all", format: "json" });
  const file = JSON.parse(out.text);
  assert.equal(file.bookmarks.scope, "all");
  assert.deepEqual(file.bookmarks.roots.map((r) => r.root), ["menu________", "toolbar_____", "unfiled_____", "mobile______"]);
  assert.ok(!JSON.stringify(file.bookmarks).includes('"id"'), "no ids: they belong to a profile");

  const fresh = await setup(["z"]);
  fresh.sim.seedBookmarks("toolbar_____", [{ title: "News", url: U("news") }]);
  const r = await fresh.run("io:import", { text: out.text, mode: "merge" });
  assert.equal(r.bookmarks.saved, 2, "news was already there");
  assert.equal(r.bookmarks.folders, 1);
  assert.equal(r.bookmarks.duplicates, 1);
  const tb = (await fresh.marks()).find((x) => x.id === "toolbar_____").children;
  assert.deepEqual(shape(tb), [U("news"), { Dir: [U("in")] }]);
  const again = await fresh.run("io:import", { text: out.text, mode: "merge" });
  assert.equal(again.bookmarks.saved, 0, "importing twice changes nothing");
  assert.deepEqual(shape((await fresh.marks()).find((x) => x.id === "toolbar_____").children), [U("news"), { Dir: [U("in")] }]);
});

test("the setting decides whether the bookmarks are exported", async () => {
  const t = await setup(["a"]);
  t.sim.seedBookmarks("toolbar_____", [{ title: "News", url: U("news") }]);
  let file = JSON.parse((await t.run("io:export", { scope: "all", format: "json" })).text);
  assert.deepEqual(file.bookmarks.roots.map((r) => r.root), ["menu________", "toolbar_____", "unfiled_____", "mobile______"]);
  await t.run("settings:set", { module: "bookmarks", key: "backup", value: "grove" }).catch(() => {});
  file = JSON.parse((await t.run("io:export", { scope: "all", format: "json" })).text);
  assert.ok(file.bookmarks, "an old value from the Grove-folder days still exports everything");
  await t.run("settings:set", { module: "bookmarks", key: "backup", value: "none" });
  file = JSON.parse((await t.run("io:export", { scope: "all", format: "json" })).text);
  assert.equal(file.bookmarks, undefined);
  const panelOnly = JSON.parse((await t.run("io:export", { scope: "panel", panelId: t.panelId, format: "json" })).text);
  assert.equal(panelOnly.bookmarks, undefined, "a one-panel export has no bookmarks");
});

test("a file with damaged or dangerous bookmark entries only adds the good ones", async () => {
  const t = await setup(["a"]);
  const r = await t.m.bookmarks.restore({ roots: [{ root: "toolbar_____", children: [
    { type: "bookmark", title: "ok", url: "https://ok.test/" },
    { type: "bookmark", title: "bad", url: "javascript:alert(1)" },
    { type: "bookmark", title: "nourl" }, null, 5, { type: "folder", title: "F", children: "nope" },
  ] }, { root: "no-such-root", children: [{ type: "bookmark", title: "x", url: "https://x.test/" }] }] });
  assert.equal(r.saved, 2);
  assert.deepEqual(shape((await t.marks()).find((x) => x.id === "toolbar_____").children), ["https://ok.test/", { F: [] }]);
  assert.ok(shape((await t.marks()).find((x) => x.id === OTHER).children).includes("https://x.test/"), "an unknown root falls back to Other Bookmarks");
});

test("a backup file is written again when the bookmarks change", async () => {
  const t = await setup(["a"]);
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await t.run("settings:set", { module: "backup", key: "quietSeconds", value: 5 });
  const s1 = await t.run("backup:status");
  assert.equal(s1.latest, true);
  await t.browser.bookmarks.create({ parentId: "toolbar_____", title: "x", url: U("x") });
  await settle(250);
  assert.equal((await t.run("backup:status")).pending, true, "the change is noticed");
});

// ---- the helpers ----

test("viewer search: every word in the title or address; folders with a match stay", () => {
  const items = [
    { id: "1", type: "folder", title: "Cooking", children: [{ id: "2", type: "bookmark", title: "Pasta", url: "https://food.test/carbonara" }, { id: "3", type: "bookmark", title: "Bread", url: "https://bake.test/" }] },
    { id: "4", type: "bookmark", title: "Café", url: "https://news.test/" },
  ];
  assert.deepEqual([...B.filterTree(items, "pasta food").keep].sort(), ["1", "2"]);
  assert.deepEqual([...B.filterTree(items, "cafe").keep], ["4"], "accents are ignored");
  assert.deepEqual([...B.filterTree(items, "cooking").keep].sort(), ["1"], "a folder's own name matches");
  assert.equal(B.filterTree(items, "   "), null);
  assert.equal(B.filterTree(items, "zzz").keep.size, 0);
});

test("samePage ignores the fragment and a trailing slash", () => {
  assert.equal(B.samePage("https://a.test/x#top", "https://a.test/x"), true);
  assert.equal(B.samePage("https://a.test/", "https://a.test"), true);
  assert.equal(B.samePage("https://a.test/x", "https://a.test/y"), false);
  assert.equal(B.samePage("", ""), false);
});
