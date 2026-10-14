import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";

const A = "https://a.test/";

// ---- Ctrl+T in a panel with a default container ----

// Firefox may announce a Ctrl+T tab as about:blank and give it the new-tab page afterwards.
async function ctrlTAsBlank(t) {
  const tab = await t.browser.tabs.create({ windowId: t.winId, url: "about:blank" });
  await settle();
  return tab;
}
async function becomes(t, tab, url) {
  t.sim.tabs.get(tab.id).url = url;
  await t.sim.E.tabUpdated.dispatch(tab.id, { url }, { ...t.sim.tabs.get(tab.id) });
  await settle(100);
}

test("Ctrl+T announced as about:blank, then about:newtab, still lands in the panel's container", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  const tab = await ctrlTAsBlank(t);
  await becomes(t, tab, "about:newtab");
  const fresh = [...t.sim.tabs.values()].filter((x) => x.url === "about:newtab");
  assert.equal(fresh.length, 1, "the plain tab was replaced, not duplicated");
  assert.equal(fresh[0].cookieStoreId, work);
  assert.ok(!t.sim.tabs.has(tab.id));
});

test("a blank tab that turns into a page is left alone", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  const tab = await ctrlTAsBlank(t);
  await becomes(t, tab, "https://typed.test/");
  assert.ok(t.sim.tabs.has(tab.id), "not swapped for an empty one: that would lose the address");
});

test("Ctrl+T announced directly as about:newtab still works", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.sim.userNewTab();
  await settle(100);
  assert.equal([...t.sim.tabs.values()].find((x) => x.url === "about:newtab").cookieStoreId, work);
});

// ---- move out one level ----

async function family() {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const parent = t.nodeByUrl(A);
  const mk = async (url, parentId) => {
    await t.run("tab:new", { windowId: t.winId, url, parentId });
    await settle();
    return t.nodeByUrl(url);
  };
  const c1 = await mk("https://c1.test/", parent);
  const c2 = await mk("https://c2.test/", parent);
  const g1 = await mk("https://g1.test/", c1);
  return { t, parent, c1, c2, g1 };
}

test("tab:outdent puts a child right after its parent and takes its own children along", async () => {
  const { t, parent, c1, c2, g1 } = await family();
  assert.equal(t.m.tree.get(c1).parentId, parent);
  assert.equal(await t.run("tab:outdent", { id: c1 }), 1);
  const n = t.m.tree.get(c1);
  assert.equal(n.parentId, null, "now beside its parent");
  assert.equal(t.m.tree.get(g1).parentId, c1, "its children came with it");
  assert.equal(t.m.tree.get(c2).parentId, parent, "its siblings stay under the parent");
  const labels = t.rows().map((r) => r.id);
  assert.ok(labels.indexOf(c1) === labels.indexOf(parent) + (1 + 1), "right after the parent's remaining children");
});

test("outdent: lands right after the parent among the parent's siblings, one level only", async () => {
  const { t, parent, c1, g1 } = await family();
  await t.run("tab:outdent", { id: g1 });
  assert.equal(t.m.tree.get(g1).parentId, parent, "a grandchild becomes a child of the grandparent, one level up");
  const sibs = t.rows().filter((r) => t.m.tree.get(r.id).parentId === parent).map((r) => r.id);
  assert.deepEqual(sibs.slice(0, 2), [c1, g1], "directly after the former parent");
});

test("a top-level tab, or a tab inside a folder, is not moved", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  assert.equal(await t.run("tab:outdent", { id: t.nodeByUrl(A) }), 0);
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  await t.run("tab:openUrls", { urls: [{ url: "https://in.test/" }], windowId: t.winId, parentId: f, panelId: t.panelId });
  await settle();
  assert.equal(await t.run("tab:outdent", { id: t.nodeByUrl("https://in.test/") }), 0, "folders keep their tabs");
  assert.equal(t.m.tree.get(t.nodeByUrl("https://in.test/")).parentId, f);
});

test("several selected rows: a branch moves once, from its top", async () => {
  const { t, parent, c1, c2, g1 } = await family();
  assert.equal(await t.run("tab:outdent", { ids: [c1, g1, c2] }), 2);
  assert.equal(t.m.tree.get(c1).parentId, null);
  assert.equal(t.m.tree.get(c2).parentId, null);
  assert.equal(t.m.tree.get(g1).parentId, c1, "g1 rode along with c1");
});

test("the keyboard shortcut moves the active tab out, and the setting turns it off", async () => {
  const { t, c1 } = await family();
  await t.browser.tabs.update(t.tabByUrl("https://c1.test/").id, { active: true });
  await settle();
  await t.sim.E.command.dispatch("outdent-tab");
  await settle();
  assert.equal(t.m.tree.get(c1).parentId, null, "out of its parent");

  const { t: t2, c1: d1, parent } = await family();
  await t2.run("settings:set", { module: "tabs", key: "outdentShortcut", value: false });
  await t2.browser.tabs.update(t2.tabByUrl("https://c1.test/").id, { active: true });
  await settle();
  await t2.sim.E.command.dispatch("outdent-tab");
  await settle();
  assert.equal(t2.m.tree.get(d1).parentId, parent, "setting off: the shortcut does nothing");
  assert.equal(await t2.run("tab:outdent", { id: d1 }), 1, "the menu command still works");
});

test("the context menu offers it only for a child of a tab", async () => {
  const { t, parent, c1 } = await family();
  const ids = async (id) => (await t.run("ui:menu", { id })).map((i) => i.id);
  assert.ok((await ids(c1)).includes("outdent"));
  assert.ok(!(await ids(parent)).includes("outdent"));
  assert.ok((await t.run("ui:menu", { ids: [c1, parent] })).some((i) => i.id === "sel-outdent"));
});

// ---- quiet downloads ----

async function withBackup(settings = {}) {
  const t = await boot({ seed: [{ url: A, active: true }] });
  for (const [key, value] of Object.entries(settings)) await t.run("settings:set", { module: "backup", key, value });
  return t;
}
const listed = (t) => [...t.sim.downloads.values()].filter((d) => !d.erased);

test("the up-to-date file is taken out of the download list once saved, and stays on disk", async () => {
  const t = await withBackup({ latest: true });
  await t.m.backup.auto("latest");
  const [d] = [...t.sim.downloads.values()];
  assert.equal(listed(t).length, 1, "listed while it downloads");
  await t.sim.finishDownload(d.id);
  assert.equal(listed(t).length, 0, "gone from the list when done");
  assert.equal(d.removed, false, "the file itself is untouched");
  await t.run("folder:create", { name: "F", panelId: t.panelId });
  await t.m.backup.auto("latest");
  await t.sim.finishDownload([...t.sim.downloads.keys()].at(-1));
  assert.equal(listed(t).length, 0, "every later save too: no pile-up");
});

test("a download that is already finished when the call returns is handled too", async () => {
  const t = await withBackup({ latest: true });
  t.sim.instantDownloads = true;
  await t.m.backup.auto("latest");
  await settle();
  assert.equal(listed(t).length, 0);
});

test("quiet can be switched off; a manual export is always listed", async () => {
  const t = await withBackup({ latest: true, quiet: false });
  await t.m.backup.auto("latest");
  await t.sim.finishDownload([...t.sim.downloads.keys()].at(-1));
  assert.equal(listed(t).length, 1);
  await t.run("settings:set", { module: "backup", key: "quiet", value: true });
  const r = await t.run("backup:save", { format: "json" });
  await t.sim.finishDownload([...t.sim.downloads.keys()].at(-1));
  assert.ok(r.filename);
  assert.ok(listed(t).some((d) => d.filename === r.filename), "what you saved by hand stays visible");
});

test("timestamped copies: hidden when all are kept, listed while they can still be pruned", async () => {
  const t = await withBackup({ periodic: true, keep: 0 });
  await t.m.backup.auto("periodic");
  await t.sim.finishDownload([...t.sim.downloads.keys()].at(-1));
  assert.equal(listed(t).length, 0);
  assert.deepEqual(t.ctx.store && (await t.browser.storage.local.get("grove:backup"))["grove:backup"].files, [], "no ever-growing list when nothing is pruned");

  const u = await withBackup({ periodic: true, keep: 2 });
  for (let i = 0; i < 3; i++) {
    await u.run("folder:create", { name: `F${i}`, panelId: u.panelId });
    await u.m.backup.auto("periodic");
    await u.sim.finishDownload([...u.sim.downloads.keys()].at(-1));
    await new Promise((r) => setTimeout(r, 1100)); // the file name carries the second
  }
  assert.equal(listed(u).length, 2, "only the copies kept are listed; the oldest was deleted and cleared");
  assert.equal([...u.sim.downloads.values()].filter((d) => d.removed).length, 1);
});

test("entries left behind by the up-to-date file are swept when it is switched on", async () => {
  const t = await withBackup();
  for (let i = 0; i < 3; i++) {
    const id = await t.browser.downloads.download({ url: "blob:x", filename: "Grove/grove-latest.json", conflictAction: "overwrite" });
    await t.sim.finishDownload(id);
  }
  const other = await t.browser.downloads.download({ url: "blob:y", filename: "Grove/something-else.json" });
  await t.sim.finishDownload(other);
  assert.equal(listed(t).length, 4);
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await settle();
  assert.deepEqual(listed(t).map((d) => d.filename), ["Grove/something-else.json"], "only the up-to-date file's entries went");
});

test("a failed automatic save is still reported, then cleared from the list", async () => {
  const t = await withBackup({ latest: true });
  await t.m.backup.auto("latest");
  await t.sim.finishDownload([...t.sim.downloads.keys()].at(-1), "interrupted", "FILE_ACCESS_DENIED");
  assert.match((await t.run("backup:status")).lastError, /FILE_ACCESS_DENIED/);
  assert.equal(listed(t).length, 0);
});

test("Ctrl+T: even if Firefox never reports the address change, looking again finds the new-tab page", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  const tab = await ctrlTAsBlank(t);
  t.sim.tabs.get(tab.id).url = "about:newtab"; // no onUpdated at all
  await settle(500);
  const fresh = [...t.sim.tabs.values()].filter((x) => x.url === "about:newtab");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].cookieStoreId, work);
});

test("Ctrl+T: a tab with an empty address is watched the same way, and the watch is logged", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.run("diag:clear");
  const tab = await t.browser.tabs.create({ windowId: t.winId, url: "" });
  await settle();
  t.sim.tabs.get(tab.id).url = "about:home";
  await settle(500);
  assert.equal([...t.sim.tabs.values()].filter((x) => x.cookieStoreId === work).length, 1, "swapped into the panel's container");
  assert.ok(!t.sim.tabs.has(tab.id));
  assert.ok((await t.run("diag:list")).some((e) => /watch/.test(JSON.stringify(e))), "the log says a blank tab was being watched");
});
