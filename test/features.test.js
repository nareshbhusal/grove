import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, settle, T } from "./helpers.js";

const A = "https://a.test/", B = "https://b.test/", C = "https://c.test/";

// ---- new tab placement ----------------------------------------------------

test("a tab you open yourself becomes a sibling placed after the current tab's subtree", async () => {
  const t = await boot({ seed: [{ url: A, active: true }, { url: B }] });
  await t.sim.openFrom(t.tabByUrl(A).id, C); // child of A
  await settle();
  await t.sim.E.tabActivated.dispatch({ tabId: t.tabByUrl(A).id, windowId: t.winId });
  await t.sim.tabs.get(t.tabByUrl(A).id) && await t.browser.tabs.update(t.tabByUrl(A).id, { active: true });
  await t.sim.userNewTab();
  await settle();
  assert.deepEqual(t.labels(), [A, `-${C}`, "about:newtab", B], "after A and its child, before B, at A's depth");
});

test("tabs opened from links are children and read in the order opened", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const a = t.tabByUrl(A).id;
  await t.sim.openFrom(a, B);
  await t.sim.openFrom(a, C);
  await settle();
  assert.deepEqual(t.labels(), [A, `-${B}`, `-${C}`]);
});

test("the second signal (webNavigation) also makes a child, even when it arrives late", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const a = t.tabByUrl(A).id;
  await t.sim.openFrom(a, B, { signal: "navigation" });
  await t.sim.openFrom(a, C, { signal: "late" });
  await settle();
  assert.deepEqual(t.labels(), [A, `-${B}`, `-${C}`]);
  const log = await t.run("diag:list", { kind: "placement" });
  assert.ok(log.some((e) => e.signal === "navigation (late)"), "late correction is recorded");
});

test("with no evidence at all the tab lands right beside where you were: a harmless miss", async () => {
  const t = await boot({ seed: [{ url: A, active: true }, { url: B }] });
  await t.sim.openFrom(t.tabByUrl(A).id, C, { signal: "none" });
  await settle();
  assert.deepEqual(t.labels(), [A, C, B]);
  const log = await t.run("diag:list", { kind: "placement" });
  assert.equal(log[0].signal, "none");
});

test("a late navigation hint does not re-parent a tab you have already moved", async () => {
  const t = await boot({ seed: [{ url: A, active: true }, { url: B }] });
  const a = t.tabByUrl(A).id;
  const tab = await t.sim.openFrom(a, C, { signal: "none" });
  await settle();
  await t.run("tree:move", { id: t.nodeOf(tab.id), parentId: t.nodeByUrl(B) });
  await t.sim.E.navTarget.dispatch({ sourceTabId: a, tabId: tab.id });
  await settle();
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).parentId, t.nodeByUrl(B));
});

test("a popup in another window never becomes a child across windows", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const w2 = t.sim.addWindow();
  await settle();
  await t.browser.tabs.create({ windowId: w2.id, url: C, openerTabId: t.tabByUrl(A).id });
  await settle();
  const node = t.m.tree.get(t.nodeByUrl(C));
  assert.equal(node.parentId, null);
});

test("setting: a tab you open yourself can be a child or go to the end", async () => {
  const t = await boot({ seed: [{ url: A, active: true }, { url: B }] });
  await t.run("settings:set", { module: "tabs", key: "newTabPlacement", value: "child" });
  await t.sim.userNewTab();
  await settle();
  assert.deepEqual(t.labels(), [A, "-about:newtab", B], "child of the active tab (A)");

  await t.run("settings:set", { module: "tabs", key: "newTabPlacement", value: "end" });
  await t.browser.tabs.update(t.tabByUrl(A).id, { active: true });
  await t.sim.userNewTab();
  await settle();
  const labels = t.labels();
  assert.equal(labels.at(-1), "about:newtab", "end of the list");
  assert.equal(labels.at(-1).startsWith("-"), false);
});

test("a new background child opens a collapsed branch only when it becomes active", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const a = t.tabByUrl(A).id;
  await t.run("tree:toggle", { id: t.nodeOf(a), value: true });
  const child = await t.sim.openFrom(a, B);
  await settle();
  assert.equal(t.m.tree.get(t.nodeOf(a)).collapsed, true, "stays collapsed for a background tab");
  await t.browser.tabs.update(child.id, { active: true });
  await settle();
  assert.equal(t.m.tree.get(t.nodeOf(a)).collapsed, false, "activating a tab reveals it");
});

// ---- folder contexts ------------------------------------------------------

async function withFolder() {
  const t = await boot({ seed: [{ url: A, active: true }, { url: B }, { url: C }] });
  const f = await t.run("folder:create", { name: "Research", nodeIds: [t.nodeByUrl(B), t.nodeByUrl(C)], windowId: t.winId });
  await settle();
  return { t, f };
}

test("opening a folder is a context switch: only its tabs are visible and one of them is active", async () => {
  const { t, f } = await withFolder();
  assert.equal(t.sim.hidden(t.winId).length, 0, "whole-panel view shows everything, including tabs in folders");
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await settle();
  assert.deepEqual(t.sim.visible(t.winId).map((x) => x.url).sort(), [B, C]);
  assert.deepEqual(t.sim.hidden(t.winId).map((x) => x.url), [A]);
  assert.ok(t.sim.visible(t.winId).some((x) => x.active), "active tab moved into the folder");
  assert.deepEqual(t.labels(), [B, C], "the sidebar lists the folder's contents");
  assert.deepEqual(t.view(), { panelId: t.panelId, folderId: f });
});

test("folder view: new tabs open inside it; going up restores the whole panel", async () => {
  const { t, f } = await withFolder();
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await settle();
  await t.sim.userNewTab();
  await settle();
  assert.equal(T.isWithin(t.m.tree.all(), t.nodeByUrl("about:newtab"), f), true);
  await t.run("folder:up", { windowId: t.winId });
  await settle();
  assert.equal(t.sim.hidden(t.winId).length, 0);
  assert.equal(t.view().folderId, null);
});

test("an empty folder gets one blank tab so the window still has something to show", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const f = await t.run("folder:create", { name: "Empty", windowId: t.winId });
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await settle();
  const tabs = t.sim.visible(t.winId);
  assert.equal(tabs.length, 1);
  assert.equal(t.m.tree.get(t.nodeOf(tabs[0].id)).parentId, f);
});

test("switching panel remembers the open folder; clicking the active panel goes to its top", async () => {
  const { t, f } = await withFolder();
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await t.run("panel:switch", { windowId: t.winId, panelId: other });
  await settle();
  assert.equal(t.view().folderId, null);
  await t.run("panel:switch", { windowId: t.winId, panelId: t.panelId });
  await settle();
  assert.equal(t.view().folderId, f, "back where you left it");
  await t.run("panel:switch", { windowId: t.winId, panelId: t.panelId });
  assert.equal(t.view().folderId, null, "same panel again = top level");
});

test("activating a tab outside the open folder widens the view so it stays visible", async () => {
  const { t, f } = await withFolder();
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await settle();
  await t.sim.E.tabActivated.dispatch({ tabId: t.tabByUrl(A).id, windowId: t.winId });
  await settle();
  assert.equal(t.view().folderId, null);
});

test("the open folder survives a restart", async () => {
  const { t, f } = await withFolder();
  await t.run("folder:enter", { windowId: t.winId, id: f });
  await settle();
  await t.kernel.stop();
  const again = await boot({ existing: t });
  assert.equal(again.view().folderId, f);
});

// ---- containment rules through the commands -------------------------------

test("commands refuse folders inside tabs and notes outside folders", async () => {
  const { t, f } = await withFolder();
  const noteId = await t.run("note:create", { folderId: f, name: "n" });
  assert.equal(await t.run("tree:move", { id: f, parentId: t.nodeByUrl(A) }), false);
  assert.equal(await t.run("tree:move", { id: noteId, parentId: null }), false);
  await assert.rejects(() => t.run("note:create", { folderId: t.nodeByUrl(A) }), /inside a folder/);
});

test("grouping a nested tab into a new folder puts the folder beside, not inside, its parent tab", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const child = await t.sim.openFrom(t.tabByUrl(A).id, B);
  await settle();
  const f = await t.run("folder:create", { name: "F", nodeIds: [t.nodeOf(child.id)] });
  assert.equal(t.m.tree.get(f).parentId, null, "a tab cannot hold a folder");
  assert.equal(t.m.tree.get(t.nodeOf(child.id)).parentId, f);
});

// ---- notes ----------------------------------------------------------------

test("notes: create, edit, rename and delete, with the text stored apart from the tree", async () => {
  const { t, f } = await withFolder();
  const id = await t.run("note:create", { folderId: f, name: "Ideas", text: "first" });
  assert.deepEqual(await t.run("note:get", { id }), { id, name: "Ideas", text: "first" });
  await t.run("note:save", { id, text: "second", name: "Renamed" });
  assert.deepEqual(await t.run("note:get", { id }), { id, name: "Renamed", text: "second" });
  assert.ok(!JSON.stringify(t.ctx.store.dump()).includes("second"), "text is not in the tree store");
  assert.ok(`grove:note:${id}` in t.sim.storage);
  await t.run("note:delete", { id });
  assert.ok(!(`grove:note:${id}` in t.sim.storage), "body removed with the note");
});

test("deleting a folder with its contents removes notes and their text; the tabs close", async () => {
  const { t, f } = await withFolder();
  const id = await t.run("note:create", { folderId: f, text: "x" });
  await t.run("folder:delete", { id: f, contents: true });
  await settle();
  assert.equal(t.m.tree.get(f), undefined);
  assert.equal(t.m.tree.get(id), undefined);
  assert.ok(!(`grove:note:${id}` in t.sim.storage));
  assert.deepEqual(t.sim.visible(t.winId).map((x) => x.url), [A]);
});

test("ungrouping a root-level folder that holds notes is refused with a clear message", async () => {
  const { t, f } = await withFolder();
  await t.run("note:create", { folderId: f, text: "x" });
  await assert.rejects(() => t.run("folder:ungroup", { id: f }), /holds notes/);
  assert.ok(t.m.tree.get(f));
  // inside another folder the notes have somewhere to go
  const outer = await t.run("folder:create", { name: "Outer", nodeIds: [f] });
  await t.run("folder:ungroup", { id: f });
  assert.equal(t.m.tree.get(outer).type, "folder");
});

test("orphaned note text is swept at startup", async () => {
  const { t } = await withFolder();
  t.sim.storage["grove:note:ghost"] = "left behind";
  await t.kernel.stop();
  await boot({ existing: t });
  assert.ok(!("grove:note:ghost" in t.sim.storage));
});

test("notes survive export and import, including their text", async () => {
  const { t, f } = await withFolder();
  await t.run("note:create", { folderId: f, name: "Plan", text: "line one\nline two" });
  const exp = await t.run("io:export", { format: "json" });
  const md = await t.run("io:export", { format: "markdown" });
  assert.match(md.text, /📝 \*\*Plan\*\*/);
  assert.match(md.text, /> line two/);

  const b = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  const res = await b.run("io:import", { text: exp.text, mode: "merge" });
  assert.equal(res.notes, 1);
  const note = Object.values(b.m.tree.all()).find((n) => n.type === "note");
  assert.equal(b.m.tree.get(note.parentId).type, "folder");
  assert.equal((await b.run("note:get", { id: note.id })).text, "line one\nline two");
});

test("importing a file from the old version repairs a folder that sat inside a tab", async () => {
  const t = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  const old = { grove: 1, panels: [{ name: "Old", tree: [{ type: "tab", url: A, children: [{ type: "folder", name: "Odd", children: [{ type: "tab", url: B, children: [] }] }] }] }] };
  await t.run("io:import", { text: JSON.stringify(old) });
  const panel = t.m.panels.list().find((p) => p.name === "Old");
  const rows = T.flatten(t.m.tree.all(), panel.id).map((r) => [r.node.name ?? r.node.url, r.depth]);
  assert.deepEqual(rows, [[A, 0], ["Odd", 0], [B, 1]]);
});

// ---- mute, audio, favicons ------------------------------------------------

test("audible tabs are flagged and can be muted and unmuted", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const tab = t.tabByUrl(A);
  const id = t.nodeOf(tab.id);
  await t.sim.setAudible(tab.id, true);
  assert.equal(t.m.tree.get(id).audible, true);
  await t.run("tab:mute", { id });
  assert.equal(t.m.tree.get(id).muted, true);
  assert.equal(t.sim.tabs.get(tab.id).mutedInfo.muted, true);
  await t.run("tab:mute", { id });
  assert.equal(t.m.tree.get(id).muted, false);
});

test("favicons: large inline icons are kept, internal ones dropped, and a host remembers its icon", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const tab = t.tabByUrl(A);
  const id = t.nodeOf(tab.id);
  const update = async (favIconUrl, url = A) => {
    Object.assign(t.sim.tabs.get(tab.id), { favIconUrl, url });
    await t.sim.E.tabUpdated.dispatch(tab.id, { favIconUrl }, { ...t.sim.tabs.get(tab.id) });
  };
  const big = "data:image/png;base64," + "A".repeat(12000); // v0.1 dropped anything over 4 KB
  await update(big);
  assert.equal(t.m.tree.get(id).favIconUrl, big);
  await update("https://a.test/favicon.ico");
  assert.equal(t.m.tree.get(id).favIconUrl, "https://a.test/favicon.ico");
  await update("chrome://global/skin/icons/info.svg");
  assert.equal(t.m.tree.get(id).favIconUrl, "https://a.test/favicon.ico", "internal icon ignored; the host's last good one is used");
  await update(undefined, "https://other.test/");
  assert.equal(t.m.tree.get(id).favIconUrl, null, "a different host does not inherit it");
});
