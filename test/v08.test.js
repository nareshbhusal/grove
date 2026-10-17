import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";

const A = "https://a.test/";
const SECRET = "https://secret.test/private-page";

// A normal window with one tab, plus a private window with one tab.
async function twoWindows() {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const pw = t.sim.addWindow({ incognito: true });
  await settle();
  const tab = await t.browser.tabs.create({ windowId: pw.id, url: SECRET });
  await settle();
  t.pw = pw;
  t.privTab = tab;
  t.privNode = t.nodeOf(tab.id);
  return t;
}
const stored = (t) => JSON.stringify(t.sim.storage);
const flush = async (t) => { await t.ctx.store.flush(); await settle(); };

test("a private tab is a node in memory, flagged private", async () => {
  const t = await twoWindows();
  assert.ok(t.privNode, "the private tab is in the tree, so the sidebar can show it");
  assert.equal(t.m.tree.get(t.privNode).private, true);
  assert.equal(t.m.tree.get(t.nodeByUrl(A)).private, undefined);
});

test("nothing about a private tab reaches storage, sessions values or the favicon cache", async () => {
  const t = await twoWindows();
  Object.assign(t.sim.tabs.get(t.privTab.id), { favIconUrl: "https://secret.test/icon.png", title: "Secret title" });
  await t.sim.E.tabUpdated.dispatch(t.privTab.id, { favIconUrl: "https://secret.test/icon.png", title: "Secret title" }, { ...t.sim.tabs.get(t.privTab.id) });
  await flush(t);
  assert.ok(!stored(t).includes("secret.test"), "no URL, icon or host in storage");
  assert.ok(!stored(t).includes("Secret title"), "no title in storage");
  assert.ok(![...t.sim.tabValues.keys()].some((k) => k.startsWith(`${t.privTab.id}:`)), "no sessions value is stamped on a private tab");
  assert.ok(stored(t).includes("a.test"), "normal tabs are still saved");
});

test("exports and backups leave private tabs out", async () => {
  const t = await twoWindows();
  const out = await t.run("io:export", { scope: "all" });
  assert.ok(!out.text.includes("secret.test"));
  assert.ok(out.text.includes("a.test"));
  for (const format of ["html", "markdown", "text"]) {
    const r = await t.run("io:export", { scope: "all", format }).catch(() => null);
    if (r) assert.ok(!r.text.includes("secret.test"), `${format} export`);
  }
});

test("closing a private window removes its tabs instead of keeping ghosts", async () => {
  const t = await twoWindows();
  await t.sim.closeWindow(t.pw.id);
  await settle();
  assert.equal(t.m.tree.get(t.privNode), undefined, "no ghost left behind");
  await flush(t);
  assert.ok(!stored(t).includes("secret.test"));
  assert.ok(t.m.tree.get(t.nodeByUrl(A)), "the normal tab is untouched");
});

test("closing a normal window still leaves ghosts, as before", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const w2 = t.sim.addWindow();
  await settle();
  const tab = await t.browser.tabs.create({ windowId: w2.id, url: "https://b.test/" });
  await settle();
  const id = t.nodeOf(tab.id);
  await t.sim.closeWindow(w2.id);
  await settle();
  assert.ok(t.m.tree.get(id), "a normal tab survives its window as a ghost");
});

test("a private tab closed on its own is simply gone", async () => {
  const t = await twoWindows();
  await t.sim.closeTab?.(t.privTab.id);
  if (!t.sim.closeTab) {
    t.sim.tabs.delete(t.privTab.id);
    await t.sim.E.tabRemoved.dispatch(t.privTab.id, { windowId: t.pw.id, isWindowClosing: false });
  }
  await settle();
  assert.equal(t.m.tree.get(t.privNode), undefined);
});

test("state is scoped: a private window sees only the private space, a normal one never does", async () => {
  const t = await twoWindows();
  const folder = await t.run("folder:create", { name: "Shared", panelId: t.panelId });
  const normal = t.sim.connectUi({ windowId: t.winId });
  const priv = t.sim.connectUi({ windowId: t.pw.id });
  await settle();
  const ns = normal.last();
  const ps = priv.last();
  assert.equal(ns.private, false);
  assert.equal(ps.private, true);
  assert.ok(!JSON.stringify(ns).includes("secret.test"), "nothing private in a normal window's state");
  assert.ok(ns.nodes[t.nodeByUrl(A)] && ns.nodes[folder]);
  assert.ok(ps.nodes[t.privNode], "the private window sees its tab");
  assert.ok(!ps.nodes[folder], "but none of the normal folders");
  assert.ok(!ps.nodes[t.nodeByUrl(A)], "or normal tabs");
  assert.deepEqual(ps.panels.map((p) => p.id), ["p_private"], "only the private panel");
  assert.ok(ns.panels.every((p) => !p.private), "no private panel in a normal window");
  assert.ok(!ps.panels.some((p) => p.id === t.panelId));
});

test("a port that has not said who it is gets the normal state; a lie about a window changes nothing", async () => {
  const t = await twoWindows();
  const anon = t.sim.connectUi();
  await settle();
  assert.equal(anon.last().private, false);
  assert.ok(!JSON.stringify(anon.last()).includes("secret.test"));
  const bogus = t.sim.connectUi({ windowId: 9999 });
  await settle();
  assert.equal(bogus.last().private, false, "an unknown window is treated as normal");
});

test("pushes reach each window with its own state, and a new private tab shows only there", async () => {
  const t = await twoWindows();
  const normal = t.sim.connectUi({ windowId: t.winId });
  const priv = t.sim.connectUi({ windowId: t.pw.id });
  await settle();
  const second = await t.browser.tabs.create({ windowId: t.pw.id, url: "https://secret2.test/" });
  await settle();
  await new Promise((r) => setTimeout(r, 80));
  const id = t.nodeOf(second.id);
  assert.ok(priv.last().nodes[id]);
  assert.ok(!normal.last().nodes[id]);
  assert.ok(!JSON.stringify(normal.last()).includes("secret"));
  // every state the normal port ever received is clean, not just the last
  assert.ok(!JSON.stringify(normal.received).includes("secret"));
});

test("the active node of a private window is hidden from normal windows", async () => {
  const t = await twoWindows();
  const normal = t.sim.connectUi({ windowId: t.winId });
  const priv = t.sim.connectUi({ windowId: t.pw.id });
  await settle();
  assert.equal(normal.last().activeNodes[t.pw.id], undefined);
  assert.equal(normal.last().views[t.pw.id], undefined, "not even the window is listed");
  assert.equal(priv.last().activeNodes[t.pw.id], t.privNode);
});

test("a private tab cannot be moved into a normal window", async () => {
  const t = await twoWindows();
  await t.run("tab:activate", { id: t.privNode, windowId: t.winId });
  assert.equal(t.sim.tabs.get(t.privTab.id).windowId, t.pw.id, "it stays in the private window");
});

test("a normal tab still moves between normal windows", async () => {
  const t = await boot({ seed: [{ url: A, active: true }] });
  const w2 = t.sim.addWindow();
  await settle();
  const other = await t.browser.tabs.create({ windowId: w2.id, url: "https://b.test/" });
  await settle();
  await t.run("tab:activate", { id: t.nodeOf(other.id), windowId: t.winId });
  assert.equal(t.sim.tabs.get(other.id).windowId, t.winId);
});

test("diagnostics do not record what you browse privately", async () => {
  const t = await twoWindows();
  await t.run("diag:clear", {});
  await t.browser.tabs.create({ windowId: t.pw.id, url: "https://secret4.test/page" });
  await settle();
  const log = JSON.stringify(await t.run("diag:list", {}));
  assert.ok(!log.includes("secret"), "no private URL in the log");
});

test("a tab opened into a folder from a private window is private and never saved", async () => {
  const t = await twoWindows();
  const f = await t.run("folder:create", { name: "Mixed", panelId: t.panelId });
  const r = await t.run("tab:openUrls", { urls: [{ url: "https://secret3.test/" }], windowId: t.pw.id, parentId: f, panelId: t.panelId });
  assert.equal(r.opened, 1);
  await settle();
  const tab = t.sim.byUrl("https://secret3.test/")[0];
  assert.equal(tab.windowId, t.pw.id);
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).private, true);
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).parentId, f, "it sits in the folder while the window is open");
  await flush(t);
  assert.ok(!stored(t).includes("secret3.test"));
});

// ---- the private space: panels, folders and notes ----

test("a private window gets its own panel, and its tabs go in it", async () => {
  const t = await twoWindows();
  const node = t.m.tree.get(t.privNode);
  assert.equal(node.panelId, "p_private");
  assert.equal(t.m.windows.getView(t.pw.id).panelId, "p_private");
  assert.equal(t.m.windows.getView(t.winId).panelId, t.panelId, "the normal window is unchanged");
  assert.ok(t.m.panels.list().find((p) => p.id === "p_private").private);
});

test("folders and notes made in a private window are private, in memory only", async () => {
  const t = await twoWindows();
  const f = await t.run("folder:create", { name: "Hidden plans", windowId: t.pw.id });
  assert.ok(f);
  assert.equal(t.m.tree.get(f).private, true);
  assert.equal(t.m.tree.get(f).panelId, "p_private");
  const n = await t.run("note:create", { folderId: f, name: "Diary", text: "very secret text" });
  assert.equal(t.m.tree.get(n).private, true);
  assert.equal((await t.run("note:get", { id: n })).text, "very secret text");
  await t.run("note:save", { id: n, text: "edited secret text" });
  assert.equal((await t.run("note:get", { id: n })).text, "edited secret text");
  await flush(t);
  assert.ok(!stored(t).includes("secret text") && !stored(t).includes("Hidden plans") && !stored(t).includes("Diary"));
  assert.ok(!stored(t).includes("p_private"), "the private panel is not saved either");
  const normal = t.sim.connectUi({ windowId: t.winId });
  await settle();
  assert.ok(!JSON.stringify(normal.last()).includes("Hidden plans"));
  const out = await t.run("io:export", { scope: "all" });
  assert.ok(!out.text.includes("Hidden plans") && !out.text.includes("secret text") && !out.text.includes("Private"));
});

test("normal folders, notes and panels never show in a private window", async () => {
  const t = await twoWindows();
  const f = await t.run("folder:create", { name: "Work stuff", panelId: t.panelId });
  await t.run("note:create", { folderId: f, name: "Todo", text: "normal text" });
  await t.run("panel:create", { name: "Banking" });
  const priv = t.sim.connectUi({ windowId: t.pw.id });
  await settle();
  const j = JSON.stringify(priv.last());
  assert.ok(!j.includes("Work stuff") && !j.includes("Todo") && !j.includes("Banking") && !j.includes("a.test"));
});

test("panels created in a private window are private; switching stays inside the kind", async () => {
  const t = await twoWindows();
  const id = await t.run("panel:create", { name: "Research", windowId: t.pw.id });
  assert.equal(t.m.panels.find(id).private, true);
  assert.equal(await t.run("panel:switch", { windowId: t.pw.id, panelId: t.panelId }), false, "a private window cannot enter a normal panel");
  assert.equal(await t.run("panel:switch", { windowId: t.winId, panelId: id }), false, "nor the other way round");
  assert.equal(await t.run("panel:switch", { windowId: t.pw.id, panelId: id }), true);
  await t.run("panel:next", { windowId: t.pw.id });
  assert.equal(t.m.windows.getView(t.pw.id).panelId, "p_private", "next cycles through private panels only");
  await flush(t);
  assert.ok(!stored(t).includes("Research"));
  // a normal panel list is unaffected by the private ones
  assert.deepEqual(t.m.panels.listFor(false).map((p) => p.id), [t.panelId]);
});

test("the last private panel cannot be deleted; deleting one moves its tabs to another private panel", async () => {
  const t = await twoWindows();
  assert.equal(await t.run("panel:delete", { id: "p_private" }), false);
  const id = await t.run("panel:create", { name: "Second", windowId: t.pw.id });
  assert.equal(await t.run("panel:delete", { id: "p_private", moveTo: t.panelId }), true, "a normal panel is not a valid target");
  assert.equal(t.m.tree.get(t.privNode).panelId, id);
  assert.ok(t.m.panels.find(t.panelId), "normal panels untouched");
});

test("nothing can be moved between the private and the normal space", async () => {
  const t = await twoWindows();
  const f = await t.run("folder:create", { name: "N", panelId: t.panelId });
  assert.equal(await t.run("tree:move", { id: t.privNode, parentId: f }), false);
  assert.equal(await t.run("tree:move", { id: t.privNode, parentId: null, panelId: t.panelId }), false);
  assert.equal(await t.run("tree:move", { id: t.nodeByUrl(A), parentId: null, panelId: "p_private" }), false);
  assert.equal(t.m.tree.get(t.privNode).panelId, "p_private");
});

test("the private space ends with the last private window", async () => {
  const t = await twoWindows();
  const w2 = t.sim.addWindow({ incognito: true });
  await settle();
  const f = await t.run("folder:create", { name: "Temp", windowId: t.pw.id });
  const n = await t.run("note:create", { folderId: f, name: "Tmp note", text: "bye" });
  await t.sim.closeWindow(t.pw.id);
  await settle();
  assert.ok(t.m.tree.get(f), "another private window is still open: the space stays");
  assert.equal((await t.run("note:get", { id: n })).text, "bye");
  await t.sim.closeWindow(w2.id);
  await settle();
  assert.equal(t.m.tree.get(f), undefined);
  assert.equal(t.m.tree.get(n), undefined);
  assert.ok(!t.m.panels.find("p_private"), "the private panel is gone");
  assert.deepEqual(t.m.panels.list().map((p) => p.id), [t.panelId]);
  // a later private window starts fresh
  const w3 = t.sim.addWindow({ incognito: true });
  await settle();
  assert.ok(t.m.panels.find("p_private"));
  assert.equal(t.m.windows.getView(w3.id).panelId, "p_private");
});

test("importing leaves the private space alone, in merge and replace mode", async () => {
  const t = await twoWindows();
  const f = await t.run("folder:create", { name: "Keep me", windowId: t.pw.id });
  const file = await t.run("io:export", { scope: "all" });
  await t.run("io:import", { text: file.text, mode: "replace" });
  await settle();
  assert.ok(t.m.tree.get(f), "the private folder survived a replace");
  assert.ok(t.m.tree.get(t.privNode));
  assert.ok(t.m.panels.find("p_private"));
  await t.run("io:import", { text: file.text, mode: "merge" });
  assert.equal(t.m.panels.listFor(true).length, 1, "a merge did not touch or duplicate private panels");
});

test("a private window's view is not stamped on the window", async () => {
  const t = await twoWindows();
  await t.run("folder:create", { name: "F", windowId: t.pw.id });
  assert.ok(![...(t.sim.winValues?.keys() ?? [])].some((k) => k.startsWith(`${t.pw.id}:`)));
});

// ---- the first tab of a private window ----

test("the first tab of a private window is picked up, even when Firefox announces it before the window", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const { win, tab } = await t.sim.addWindowTabFirst({ incognito: true });
  await settle(50);
  const id = t.m.tabs.nodeIdOf(tab.id);
  assert.ok(id, "the tab has a node");
  const node = t.m.tree.get(id);
  assert.equal(node.private, true);
  assert.equal(t.m.windows.isPrivatePanel(node.panelId), true, "in the private space, not a normal panel");
  assert.equal(t.m.windows.isPrivate(win.id), true);
  const ui = t.sim.connectUi({ windowId: win.id });
  await settle(30);
  const s = ui.last();
  assert.equal(s.private, true);
  assert.ok(s.nodes[id], "the private sidebar is sent it");
  assert.equal(s.activeNodes[win.id], id, "and knows it is the one showing");
  const normal = t.sim.connectUi({ windowId: t.winId });
  await settle(30);
  assert.ok(!normal.last().nodes[id], "a normal sidebar never sees it");
});

test("the first tab of a private window is picked up when the window comes first, too", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const w = t.sim.addWindow({ incognito: true });
  await settle(20);
  const tab = await t.browser.tabs.create({ windowId: w.id, url: "about:privatebrowsing" });
  await settle(50);
  const node = t.m.tree.get(t.m.tabs.nodeIdOf(tab.id));
  assert.ok(node && t.m.windows.isPrivatePanel(node.panelId));
});

test("a window whose first tab was never announced adopts it once the window is known", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const { win, tab } = await t.sim.addWindowTabFirst({ incognito: true, announce: false });
  await settle(50);
  const id = t.m.tabs.nodeIdOf(tab.id);
  assert.ok(id, "adopted");
  assert.equal(t.m.windows.isPrivatePanel(t.m.tree.get(id).panelId), true);
  assert.equal(t.m.tabs.activeNode(win.id), id);
});

test("the same for a normal window opened tab first", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const { tab } = await t.sim.addWindowTabFirst({ incognito: false, url: "https://n.test/" });
  await settle(50);
  const node = t.m.tree.get(t.m.tabs.nodeIdOf(tab.id));
  assert.ok(node);
  assert.equal(!!node.private, false);
  assert.equal(t.m.windows.isPrivatePanel(node.panelId), false);
});
