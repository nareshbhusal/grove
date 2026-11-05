import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";

// ---- a panel's own bookmarks ----

const OTHER = "unfiled_____";
const U = (n) => `https://${n}.test/`;
const folderTitles = async (t, id) => (await t.browser.bookmarks.getChildren(id)).filter((k) => k.type === "folder").map((k) => k.title);
const panelOf = (t, id) => t.ctx.store.get("panels").find((p) => p.id === id);

async function setup() {
  const t = await boot({ seed: [{ url: U("a"), active: true }] });
  t.sim.seedBookmarks(OTHER, [{ title: "Doc", url: U("doc") }]);
  return t;
}

test("a panel gets its own folder, Other Bookmarks › Grove › <panel>, and shows it", async () => {
  const t = await setup();
  const id = await t.run("panel:create", { name: "Work" });
  const folder = await t.run("panel:setBookmarksFolder", { id, create: true });
  const p = panelOf(t, id);
  assert.equal(p.bookmarksFolder, folder);
  assert.equal(p.showBookmarks, true);
  assert.deepEqual(await folderTitles(t, OTHER), ["Grove"]);
  const [grove] = (await t.browser.bookmarks.getChildren(OTHER)).filter((k) => k.title === "Grove");
  assert.deepEqual(await folderTitles(t, grove.id), ["Work"]);
  // doing it again reuses the folder: nothing is doubled
  assert.equal(await t.run("panel:setBookmarksFolder", { id, create: true }), folder);
  assert.deepEqual(await folderTitles(t, grove.id), ["Work"]);
});

test("any real folder can be chosen; a missing one, a bookmark or a private panel cannot", async () => {
  const t = await setup();
  const id = await t.run("panel:create", { name: "Work" });
  const mine = (await t.browser.bookmarks.create({ parentId: OTHER, title: "Mine", type: "folder" })).id;
  await t.run("panel:setBookmarksFolder", { id, folderId: mine });
  assert.equal(panelOf(t, id).bookmarksFolder, mine);
  await assert.rejects(() => t.run("panel:setBookmarksFolder", { id, folderId: "nope" }), /no longer exists/);
  const doc = (await t.browser.bookmarks.getChildren(OTHER)).find((k) => k.title === "Doc");
  await assert.rejects(() => t.run("panel:setBookmarksFolder", { id, folderId: doc.id }), /no longer exists/);
  assert.equal(panelOf(t, id).bookmarksFolder, mine, "unchanged by the refusals");

  t.ctx.store.update("panels", (list) => { list.find((p) => p.id === id).private = true; return list; });
  await assert.rejects(() => t.run("panel:setBookmarksFolder", { id, create: true }), /Private panels/);
});

test("unlinking hides the section and forgets the folder, which stays in Firefox", async () => {
  const t = await setup();
  const id = await t.run("panel:create", { name: "Work" });
  const folder = await t.run("panel:setBookmarksFolder", { id, create: true });
  await t.run("panel:update", { id, showBookmarks: false });
  assert.equal(panelOf(t, id).bookmarksFolder, folder, "hiding keeps the link");
  await t.run("panel:setBookmarksFolder", { id, folderId: null });
  assert.deepEqual([panelOf(t, id).bookmarksFolder, panelOf(t, id).showBookmarks], [null, false]);
  assert.ok((await t.browser.bookmarks.get(folder)).length, "the folder is still there");
});

test("a folder deleted in Firefox is dropped from the panel", async () => {
  const t = await setup();
  const id = await t.run("panel:create", { name: "Work" });
  const folder = await t.run("panel:setBookmarksFolder", { id, create: true });
  await t.browser.bookmarks.removeTree(folder);
  await settle(400);
  assert.deepEqual([panelOf(t, id).bookmarksFolder, panelOf(t, id).showBookmarks], [null, false]);
});

test("a bookmark opened from a panel's section switches only to a tab of THIS panel", async () => {
  const t = await setup();
  const other = await t.run("panel:create", { name: "Other panel" });
  await t.run("tab:new", { windowId: t.winId, panelId: other, url: U("doc"), active: false });
  await settle(100);
  const doc = (await t.browser.bookmarks.getChildren(OTHER)).find((k) => k.title === "Doc");
  const before = t.sim.tabs.size;

  await t.run("bookmarks:open", { id: doc.id, windowId: t.winId, here: true });
  await settle(100);
  assert.equal(t.sim.tabs.size, before + 1, "the page open in another panel does not count: it opens here");
  const mine = t.sim.byUrl(U("doc")).filter((x) => t.m.tree.get(t.nodeOf(x.id)).panelId === t.panelId);
  assert.equal(mine.length, 1);

  await t.run("bookmarks:open", { id: doc.id, windowId: t.winId, here: true });
  await settle(100);
  assert.equal(t.sim.tabs.size, before + 1, "now one is open here: switch to it");
});

test("a panel's bookmarks folder travels in an export as its place, and is linked again by an import", async () => {
  const src = await setup();
  const id = await src.run("panel:create", { name: "Work" });
  await src.run("panel:setBookmarksFolder", { id, create: true });
  const file = await src.run("io:export", { scope: "all", format: "json" });
  const data = JSON.parse(file.text);
  const work = data.panels.find((p) => p.name === "Work");
  assert.deepEqual(work.bookmarksFolder, { root: OTHER, path: ["Grove", "Work"] }, "a place, not an id of this profile");
  assert.equal(work.showBookmarks, true);

  const dst = await boot({ seed: [{ url: U("x"), active: true }] });
  await dst.run("io:import", { text: file.text, mode: "merge" });
  const made = dst.ctx.store.get("panels").find((p) => p.name === "Work");
  assert.ok(made.bookmarksFolder, "linked");
  assert.equal(made.showBookmarks, true);
  const [node] = await dst.browser.bookmarks.get(made.bookmarksFolder);
  assert.equal(node.title, "Work");
  const [grove] = await dst.browser.bookmarks.get(node.parentId);
  assert.equal(grove.title, "Grove");
  // importing the same file again changes nothing: no second Grove folder
  await dst.run("io:import", { text: file.text, mode: "merge" });
  assert.deepEqual((await folderTitles(dst, OTHER)).filter((x) => x === "Grove"), ["Grove"]);
});

test("a hostile file cannot make Grove create folders outside the built-in ones or nest without limit", async () => {
  const dst = await boot({ seed: [{ url: U("x"), active: true }] });
  const evil = JSON.stringify({ grove: 1, panels: [
    { name: "P1", bookmarksFolder: { root: "root________", path: ["x"] }, tree: [] },
    { name: "P2", bookmarksFolder: { root: OTHER, path: Array.from({ length: 50 }, (_, i) => `d${i}`) }, tree: [] },
    { name: "P3", bookmarksFolder: { root: OTHER, path: [{ a: 1 }] }, tree: [] },
  ] });
  await dst.run("io:import", { text: evil, mode: "merge" });
  for (const name of ["P1", "P2", "P3"]) assert.equal(dst.ctx.store.get("panels").find((p) => p.name === name).bookmarksFolder, null);
});
