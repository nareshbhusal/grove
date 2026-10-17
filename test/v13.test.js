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
  t.grove = async () => {
    const { roots, groveId } = await t.run("bookmarks:tree");
    return groveId ? roots.find((r) => r.id === OTHER).children.find((c) => c.id === groveId) : null;
  };
  return t;
}
const shape = (list) => list.map((n) => (n.type === "folder" ? { [n.title]: shape(n.children) } : n.url));

// ---- the tree ----

test("the bookmark tree is the browser's own, with its four built-in folders", async () => {
  const t = await setup();
  t.sim.seedBookmarks("toolbar_____", [{ title: "News", url: "https://news.test/" }]);
  const { roots, groveId } = await t.run("bookmarks:tree");
  assert.deepEqual(roots.map((r) => r.id), ["menu________", "toolbar_____", "unfiled_____", "mobile______"]);
  assert.equal(groveId, null, "no Grove folder until something is saved");
  assert.equal(roots[1].children[0].url, "https://news.test/");
});

// ---- saving tabs ----

test("a tab is saved into a Grove folder inside Other Bookmarks, made when first needed", async () => {
  const t = await setup();
  const r = await t.run("bookmarks:save", { ids: [t.node("a")] });
  assert.equal(r.saved, 1);
  assert.deepEqual(shape([await t.grove()]), [{ Grove: [U("a")] }]);
  const other = (await t.marks()).find((x) => x.id === OTHER);
  assert.equal(other.children.filter((c) => c.title === "Grove").length, 1);
  await t.run("bookmarks:save", { ids: [t.node("b")] });
  assert.equal((await t.marks()).find((x) => x.id === OTHER).children.filter((c) => c.title === "Grove").length, 1, "the same folder is used again");
});

test("the folder's name is a setting", async () => {
  const t = await setup();
  await t.run("settings:set", { module: "bookmarks", key: "folder", value: "Read later" });
  await t.run("bookmarks:save", { ids: [t.node("a")] });
  const other = (await t.marks()).find((x) => x.id === OTHER);
  assert.deepEqual(other.children.map((c) => c.title), ["Read later"]);
});

test("a tab with children becomes a folder in the same shape; a Grove folder too; notes stay behind", async () => {
  const t = await setup(["a", "kid", "grand", "solo"]);
  await t.run("tree:move", { id: t.node("kid"), parentId: t.node("a"), index: 0 });
  await t.run("tree:move", { id: t.node("grand"), parentId: t.node("kid"), index: 0 });
  const f = await t.run("folder:create", { name: "Research", panelId: t.panelId, nodeIds: [t.node("solo")] });
  await t.run("note:create", { folderId: f, name: "Thoughts" });
  const r = await t.run("bookmarks:save", { ids: [t.node("a")] });
  assert.equal(r.saved, 3);
  assert.deepEqual(shape((await t.grove()).children), [{ [t.m.tree.get(t.node("a")).title]: [U("a"), { [t.m.tree.get(t.node("kid")).title]: [U("kid"), U("grand")] }] }]);
  const r2 = await t.run("bookmarks:save", { ids: [f] });
  assert.equal(r2.saved, 1);
  assert.equal(r2.skipped, 1, "the note is not saved");
  assert.ok(shape((await t.grove()).children).some((x) => x.Research && x.Research[0] === U("solo")));
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
  const g = await t.grove();
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
  assert.equal(await t.grove(), null, "no empty Grove folder either");
});

test("saving tells the window it was saved from", async () => {
  const t = await setup();
  const ui = t.sim.connectUi({ windowId: t.winId });
  const other = t.sim.addWindow();
  const elsewhere = t.sim.connectUi({ windowId: other.id });
  await settle();
  await t.run("bookmarks:save", { ids: [t.node("a")], windowId: t.winId });
  const toast = ui.received.find((m) => m.type === "toast");
  assert.match(toast.text, /1 bookmark saved to “Grove”/);
  assert.ok(!elsewhere.received.some((m) => m.type === "toast"));
});

test("the menu offers to bookmark a tab, a branch, a folder and a selection", async () => {
  const t = await setup(["a", "b"]);
  const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label);
  assert.ok(labels(await t.run("ui:menu", { id: t.node("a") })).includes("Bookmark tab"));
  await t.run("tree:move", { id: t.node("b"), parentId: t.node("a"), index: 0 });
  assert.ok(labels(await t.run("ui:menu", { id: t.node("a") })).includes("Bookmark tab and children"));
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId, nodeIds: [t.node("a")] });
  assert.ok(labels(await t.run("ui:menu", { id: f })).includes("Save folder to bookmarks"));
  const note = await t.run("note:create", { folderId: f, name: "n" });
  assert.ok(!labels(await t.run("ui:menu", { id: note })).some((l) => /ookmark/.test(l)), "a note has no address");
  const sel = await t.run("ui:menu", { ids: [t.node("a"), t.node("b")] });
  assert.ok(labels(sel).includes("Bookmark 2 items"));
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

test("the setting decides how much of the bookmarks is exported", async () => {
  const t = await setup(["a"]);
  t.sim.seedBookmarks("toolbar_____", [{ title: "News", url: U("news") }]);
  await t.run("bookmarks:save", { ids: [t.node("a")] });
  await t.run("settings:set", { module: "bookmarks", key: "backup", value: "grove" });
  let file = JSON.parse((await t.run("io:export", { scope: "all", format: "json" })).text);
  assert.deepEqual(file.bookmarks.roots.map((r) => r.root), ["unfiled_____"]);
  assert.deepEqual(shape(file.bookmarks.roots[0].children), [{ Grove: [U("a")] }], "only the Grove folder");
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
