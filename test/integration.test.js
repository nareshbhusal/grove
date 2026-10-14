import { test } from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../src/core/kernel.js";
import modules from "../src/modules/index.js";
import { createFakeBrowser, settle } from "./fake-browser.js";
import * as T from "../src/lib/tree.js";

const quiet = { error: (...a) => console.error("[test-log]", ...a), warn() {}, debug() {}, info() {} };

async function boot({ seed, storageData, existing } = {}) {
  const fb = existing ?? createFakeBrowser({ storageData });
  if (!existing) {
    const w = fb.sim.addWindow();
    fb.win = w;
    if (seed) for (const s of seed) fb.sim.seedTab({ windowId: w.id, ...s });
  }
  const kernel = await createKernel({ api: fb.browser, modules, log: quiet });
  await settle();
  const { ctx } = kernel;
  const m = ctx.modules;
  const winId = fb.win.id;
  const run = (name, args) => ctx.commands.run(name, args);
  const nodeOf = (tabId) => m.tabs.nodeIdOf(tabId);
  const urlOfNode = (id) => m.tree.get(id)?.url;
  const rows = (panelId) => T.flatten(m.tree.all(), panelId).map((r) => ({ id: r.node.id, url: r.node.url, name: r.node.name, depth: r.depth }));
  return { ...fb, kernel, ctx, m, winId, run, nodeOf, urlOfNode, rows, panelId: m.windows.getActive(winId) };
}

test("startup adopts existing tabs into the first panel", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  assert.deepEqual(t.rows(t.panelId).map((r) => [r.url, r.depth]), [["https://a.test/", 0], ["https://b.test/", 0]]);
  assert.equal(t.sim.hidden(t.winId).length, 0);
});

test("links opened from a tab become its children", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const parentTab = t.sim.byUrl("https://a.test/")[0].id;
  await t.sim.openFrom(parentTab, "https://child.test/");
  await settle();
  assert.deepEqual(t.rows(t.panelId).map((r) => [r.url, r.depth]), [["https://a.test/", 0], ["https://child.test/", 1]]);
});

test("switching panels hides other panels' tabs and shows its own", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const work = await t.run("panel:create", { name: "Work" });
  await t.run("panel:switch", { windowId: t.winId, panelId: work });
  await settle();

  // Main's two tabs are hidden; Work got a fresh tab because it was empty.
  assert.equal(t.sim.hidden(t.winId).length, 2);
  const visible = t.sim.visible(t.winId);
  assert.equal(visible.length, 1);
  assert.equal(t.m.tree.get(t.nodeOf(visible[0].id)).panelId, work);
  assert.ok(visible[0].active);

  // Back to Main: its tabs return, Work's tab is hidden.
  await t.run("panel:switch", { windowId: t.winId, panelId: t.panelId });
  await settle();
  assert.deepEqual(t.sim.visible(t.winId).map((x) => x.url).sort(), ["https://a.test/", "https://b.test/"]);
  assert.equal(t.sim.hidden(t.winId).length, 1);
  assert.ok(t.sim.visible(t.winId).some((x) => x.active));
});

test("a tab opened in a panel belongs to that panel", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("panel:create", { name: "Work" });
  await t.run("panel:switch", { windowId: t.winId, panelId: work });
  await settle();
  await t.run("tab:new", { windowId: t.winId, url: "https://w.test/" });
  await settle();
  const rowsWork = t.rows(work).map((r) => r.url);
  assert.ok(rowsWork.includes("https://w.test/"));
  assert.ok(!t.rows(t.panelId).some((r) => r.url === "https://w.test/"));
});

test("moving a tab to another panel hides it; the subtree goes along", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const aTab = t.sim.byUrl("https://a.test/")[0].id;
  const bTab = t.sim.byUrl("https://b.test/")[0].id;
  await t.sim.openFrom(aTab, "https://a-child.test/");
  await settle();
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("tree:move", { id: t.nodeOf(bTab), parentId: null, panelId: other });
  await settle();
  const hiddenUrls = t.sim.hidden(t.winId).map((x) => x.url);
  assert.deepEqual(hiddenUrls, ["https://b.test/"]);

  // move a (with child) too: the active tab is inside, so a new tab must appear to stay valid
  await t.run("tree:move", { id: t.nodeOf(aTab), parentId: null, panelId: other });
  await settle();
  assert.equal(t.m.tree.get(t.nodeOf(t.sim.byUrl("https://a-child.test/")[0].id)).panelId, other);
  assert.ok(t.sim.visible(t.winId).length >= 1, "something visible and active remains");
  assert.ok(t.sim.visible(t.winId).some((x) => x.active));
});

test("container rule reroutes a navigation, keeping node, panel and tree position", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("panel:create", { name: "Work" });
  const ctr = await t.run("containers:create", { name: "Work-id" });
  await t.run("rules:add", { pattern: "github.com", panelId: work, containerId: ctr });
  await t.run("panel:switch", { windowId: t.winId, panelId: work });
  await settle();

  const tab = t.sim.visible(t.winId)[0]; // the blank tab Grove opened for Work
  const nodeId = t.nodeOf(tab.id);
  const allowed = await t.sim.navigate(tab.id, "https://github.com/x/y");
  await settle(150);
  assert.equal(allowed, false, "original navigation is cancelled before any request");

  const moved = t.sim.byUrl("https://github.com/x/y");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].cookieStoreId, ctr);
  assert.equal(t.nodeOf(moved[0].id), nodeId, "same node, new browser tab");
  assert.equal(t.m.tree.get(nodeId).panelId, work);
  assert.ok(!t.sim.tabs.has(tab.id), "blank tab replaced, not duplicated");
  assert.equal(t.rows(work).filter((r) => r.url === "https://github.com/x/y").length, 1);
});

test("the same domain in a different panel is left alone", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("panel:create", { name: "Work" });
  const ctr = await t.run("containers:create", { name: "C" });
  await t.run("rules:add", { pattern: "github.com", panelId: work, containerId: ctr });
  const tab = t.sim.byUrl("https://a.test/")[0];
  const ok = await t.sim.navigate(tab.id, "https://github.com/");
  await settle();
  assert.equal(ok, true);
  assert.equal(t.sim.byUrl("https://github.com/")[0].cookieStoreId, "firefox-default");
});

test("rules apply to tabs already in a container; a tab you reopened yourself is locked", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const mine = await t.run("containers:create", { name: "Mine" });
  const other = await t.run("containers:create", { name: "Other" });
  await t.run("rules:add", { pattern: "example.com", containerId: other });

  // A tab that merely sits in some container (e.g. inherited from a link) is still routed.
  const id1 = t.sim.seedTab({ windowId: t.winId, url: "about:newtab", cookieStoreId: mine });
  t.sim.E.tabCreated.fire({ ...t.sim.tabs.get(id1) });
  await settle();
  assert.equal(await t.sim.navigate(id1, "https://example.com/one"), false, "rule overrides a plain container tab");
  await settle(150);
  assert.equal(t.sim.byUrl("https://example.com/one")[0].cookieStoreId, other);

  // A tab you deliberately reopened in a container is left alone.
  const tab = t.sim.byUrl("https://a.test/")[0];
  await t.run("containers:reopen", { id: t.nodeOf(tab.id), cookieStoreId: mine });
  await settle();
  const reopened = t.sim.byUrl("https://a.test/")[0];
  assert.equal(reopened.cookieStoreId, mine);
  assert.equal(await t.sim.navigate(reopened.id, "https://example.com/two"), true);
  assert.equal(t.sim.byUrl("https://example.com/two")[0].cookieStoreId, mine);
});

test("rules match pasted URLs and path prefixes; the tester explains the decision", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "Work" });
  await t.run("rules:add", { pattern: "https://www.github.com/acme-corp/", containerId: c });
  assert.equal(t.ctx.store.get("rules")[0].pattern, "www.github.com/acme-corp", "scheme and slash stripped");
  const panelId = t.panelId;
  assert.equal((await t.run("containers:test", { url: "https://www.github.com/acme-corp/repo", panelId })).containerId, c);
  assert.equal((await t.run("containers:test", { url: "https://www.github.com/other/repo", panelId })).containerId, null);
  assert.equal((await t.run("containers:test", { url: "www.github.com/acme-corp", panelId })).via, "rule", "scheme optional in the tester");
});

test("a panel's default container applies to new tabs and blank ones only, and a rule still wins", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const dflt = await t.run("containers:create", { name: "Panel default" });
  const ruled = await t.run("containers:create", { name: "Ruled" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: dflt });
  await t.run("rules:add", { pattern: "special.test", containerId: ruled });

  // A page already loaded in a default-container tab is not dragged into the panel container.
  const loaded = t.sim.byUrl("https://a.test/")[0];
  assert.equal(await t.sim.navigate(loaded.id, "https://plain.test/"), true);

  // A new tab you open (Ctrl+T) is swapped for one in the panel's container straight away.
  await t.sim.userNewTab();
  await settle(150);
  const fresh = [...t.sim.tabs.values()].filter((x) => x.url === "about:newtab");
  assert.equal(fresh.length, 1, "the plain tab was replaced, not duplicated");
  assert.equal(fresh[0].cookieStoreId, dflt);
  assert.equal(fresh[0].active, true, "and it is the tab you are on");
  assert.equal(await t.sim.navigate(fresh[0].id, "https://plain.test/page"), true, "already in the right container: no reroute");
  assert.equal(t.sim.byUrl("https://plain.test/page")[0].cookieStoreId, dflt);

  // ...unless a rule matches the address, which wins.
  await t.sim.userNewTab();
  await settle(150);
  const next = [...t.sim.tabs.values()].find((x) => x.url === "about:newtab");
  await t.sim.navigate(next.id, "https://special.test/");
  await settle(150);
  assert.equal(t.sim.byUrl("https://special.test/")[0].cookieStoreId, ruled);
});

test("a request that starts before the tab is tracked still gets routed", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  await t.run("rules:add", { pattern: "fast.test", containerId: c });
  // Simulate the request firing a moment before onCreated is delivered.
  const id = t.sim.seedTab({ windowId: t.winId, url: "about:newtab" });
  const req = t.sim.E.beforeRequest.dispatch({ tabId: id, url: "https://fast.test/", type: "main_frame" });
  await settle(20);
  t.sim.E.tabCreated.fire({ ...t.sim.tabs.get(id) });
  const [res] = await req;
  assert.equal(res.cancel, true);
});

test("routing decisions are logged for the settings page", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  await t.run("rules:add", { pattern: "logged.test", containerId: c });
  const tab = t.sim.byUrl("https://a.test/")[0];
  await t.sim.navigate(tab.id, "https://nothing.test/");
  await t.sim.navigate(tab.id, "https://logged.test/");
  await settle(150);
  const log = await t.run("diag:list", { kind: "route" });
  assert.ok(log.some((e) => e.url === "https://nothing.test/" && e.action === "none"));
  assert.ok(log.some((e) => e.url === "https://logged.test/" && e.action === "reroute" && /logged\.test/.test(e.reason)));
});

test("a deleted container does not cause a redirect loop", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("rules:add", { pattern: "loop.test", containerId: "firefox-container-999" });
  const tab = t.sim.byUrl("https://a.test/")[0];
  await t.sim.navigate(tab.id, "https://loop.test/");
  await settle(200);
  await t.sim.navigate(tab.id, "https://loop.test/again");
  await settle(200);
  assert.ok(t.sim.tabs.size <= 3, `tab count stayed small, got ${t.sim.tabs.size}`);
});

test("closing a tab promotes its children; closing a subtree removes them all", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const aTab = t.sim.byUrl("https://a.test/")[0].id;
  await t.sim.openFrom(aTab, "https://b.test/");
  await settle();
  const bTab = t.sim.byUrl("https://b.test/")[0].id;
  await t.sim.openFrom(bTab, "https://c.test/");
  await settle();
  assert.deepEqual(t.rows(t.panelId).map((r) => r.depth), [0, 1, 2]);

  await t.run("tab:close", { id: t.nodeOf(bTab), mode: "self" });
  await settle();
  assert.deepEqual(t.rows(t.panelId).map((r) => [r.url, r.depth]), [["https://a.test/", 0], ["https://c.test/", 1]]);

  await t.run("tab:close", { id: t.nodeOf(aTab), mode: "subtree" });
  await settle();
  assert.equal(t.rows(t.panelId).length, 0);
});

test("folders group tabs, nest, and survive collapse", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }] });
  const [a, b, c] = ["a", "b", "c"].map((x) => t.nodeOf(t.sim.byUrl(`https://${x}.test/`)[0].id));
  const f = await t.run("folder:create", { name: "Stuff", nodeIds: [b, c] });
  await settle();
  assert.deepEqual(t.rows(t.panelId).map((r) => [r.name ?? r.url, r.depth]),
    [["https://a.test/", 0], ["Stuff", 0], ["https://b.test/", 1], ["https://c.test/", 1]]);
  await t.run("tree:toggle", { id: f });
  assert.deepEqual(t.rows(t.panelId).map((r) => r.name ?? r.url), ["https://a.test/", "Stuff"]);
  await t.run("folder:ungroup", { id: f });
  assert.deepEqual(t.rows(t.panelId).map((r) => r.depth), [0, 0, 0]);
  assert.ok(a);
});

test("restart: structure, panels and collapsed state come back from stamped tab values", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const aTab = first.sim.byUrl("https://a.test/")[0].id;
  await first.sim.openFrom(aTab, "https://child.test/");
  await settle();
  const work = await first.run("panel:create", { name: "Work" });
  await first.run("tree:toggle", { id: first.nodeOf(aTab), value: true });
  const ids = first.rows(first.panelId).map((r) => r.id);
  await first.kernel.stop();
  first.sim.E.tabCreated.hasListener; // listeners were removed by teardown

  const second = await boot({ existing: first });
  assert.deepEqual(second.rows(second.panelId).map((r) => r.id), ids, "same node ids, same order");
  assert.equal(second.m.tree.get(ids[0]).collapsed, true);
  assert.ok(second.m.panels.find(work));
  assert.equal(Object.values(second.m.tree.all()).filter((n) => n.type === "tab").length, 2, "no duplicate nodes");
});

test("closing a window leaves ghosts; reopening rebinds them by stamp", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const tabIds = t.sim.byUrl("https://a.test/").concat(t.sim.byUrl("https://b.test/")).map((x) => x.id);
  const nodeIds = tabIds.map((i) => t.nodeOf(i));
  const w2 = t.sim.addWindow();
  await settle();
  await t.sim.closeWindow(t.winId);
  await settle();
  const ghosts = nodeIds.map((n) => t.m.tree.get(n));
  assert.ok(ghosts.every((g) => g && g.tabId == null && g.orphanedAt), "nodes kept as ghosts");

  await t.run("tab:open", { id: nodeIds[0], windowId: w2.id });
  await settle();
  assert.ok(t.m.tabs.tabIdOf(nodeIds[0]) != null, "ghost rebound to a live tab");
  assert.equal(Object.values(t.m.tree.all()).filter((n) => n.url === "https://a.test/").length, 1, "no duplicate node");
});

test("export then import into a fresh profile: ghosts, nothing opens, panels recreated", async () => {
  const a = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const aTab = a.sim.byUrl("https://a.test/")[0].id;
  await a.sim.openFrom(aTab, "https://child.test/");
  await settle();
  const work = await a.run("panel:create", { name: "Work", color: "#ff0000" });
  await a.run("tab:new", { windowId: a.winId, panelId: work, url: "https://w.test/" });
  await settle();
  await a.run("folder:create", { name: "F", panelId: work, nodeIds: [] });
  await a.run("rules:add", { pattern: "github.com", panelId: work, containerId: "firefox-container-1" });

  const exp = await a.run("io:export", { scope: "all", format: "json" });
  const parsed = JSON.parse(exp.text);
  assert.equal(parsed.grove, 1);
  assert.equal(parsed.panels.length, 2);
  assert.ok(!exp.text.includes('"tabId"'), "no live browser ids leak into exports");

  const b = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  const before = b.sim.tabs.size;
  const res = await b.run("io:import", { text: exp.text, mode: "merge" });
  await settle();
  assert.equal(res.tabs, 3);
  assert.equal(b.sim.tabs.size, before, "import opens no tabs");
  const workPanel = b.m.panels.list().find((p) => p.name === "Work");
  assert.ok(workPanel, "panel recreated");
  assert.deepEqual(b.rows(workPanel.id).map((r) => r.name ?? r.url), ["https://w.test/", "F"]);
  assert.equal(b.ctx.store.get("rules").length, 1);

  // Importing the same file twice must not duplicate rules.
  await b.run("io:import", { text: exp.text, mode: "merge" });
  assert.equal(b.ctx.store.get("rules").length, 1);

  // Click a ghost: it opens, rebinding the same node.
  const ghost = Object.values(b.m.tree.all()).find((n) => n.url === "https://child.test/");
  assert.equal(ghost.tabId ?? null, null);
  await b.run("tab:open", { id: ghost.id });
  await settle();
  assert.ok(b.m.tabs.tabIdOf(ghost.id) != null);
});

test("export formats: markdown and bookmarks html", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", title: "A <page>", active: true }] });
  const md = await t.run("io:export", { format: "markdown" });
  assert.match(md.text, /- \[A <page>\]\(https:\/\/a\.test\/\)/);
  const html = await t.run("io:export", { format: "html" });
  assert.match(html.text, /NETSCAPE-Bookmark-file-1/);
  assert.match(html.text, /A &lt;page&gt;/);
});

test("import rejects garbage without touching state", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const before = JSON.stringify(t.ctx.store.dump());
  await assert.rejects(() => t.run("io:import", { text: "not json" }), /not valid JSON/);
  await assert.rejects(() => t.run("io:import", { text: JSON.stringify({ hello: 1 }) }), /Not a Grove export/);
  await assert.rejects(() => t.run("io:import", { text: JSON.stringify({ grove: 99, panels: [] }) }), /newer version/);
  assert.equal(JSON.stringify(t.ctx.store.dump()), before);
});

test("deleting a panel moves its tabs to another panel", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("panel:create", { name: "Work" });
  await t.run("tree:move", { id: t.nodeOf(t.sim.byUrl("https://a.test/")[0].id), parentId: null, panelId: work });
  await settle();
  await t.run("panel:delete", { id: work, moveTo: t.panelId });
  await settle();
  assert.equal(t.m.panels.list().length, 1);
  // Main was emptied when the tab left, so Grove opened one blank tab to keep a
  // visible, active tab (Firefox requires one). The moved tab is back too.
  assert.deepEqual(t.rows(t.panelId).map((r) => r.url).sort(), ["about:newtab", "https://a.test/"]);
  assert.equal(t.sim.hidden(t.winId).length, 0);
  assert.ok(t.sim.visible(t.winId).some((x) => x.active));
});

test("the UI bridge pushes state and executes commands over messages", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const ui = t.sim.connectUi();
  await settle(100);
  const s1 = ui.last();
  assert.ok(s1 && s1.panels.length === 1 && Object.keys(s1.nodes).length === 1);

  const res = await t.browser.runtime.sendMessage({ type: "cmd", name: "panel:create", args: { name: "Via UI" } });
  assert.equal(res.ok, true);
  await settle(100);
  assert.equal(ui.last().panels.length, 2);

  const bad = await t.browser.runtime.sendMessage({ type: "cmd", name: "nope" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown command/);

  const node = Object.values(s1.nodes)[0];
  const menu = await t.browser.runtime.sendMessage({ type: "cmd", name: "ui:menu", args: { id: node.id } });
  assert.ok(menu.result.some((i) => i.id === "close"));
});

test("extensibility: a third-party module adds a hook, a command and a menu item", async () => {
  const fb = createFakeBrowser();
  fb.win = fb.sim.addWindow();
  fb.sim.seedTab({ windowId: fb.win.id, url: "https://a.test/", active: true });

  const plugin = {
    name: "plugin-demo",
    deps: ["tabs", "bridge"],
    setup({ hooks, commands }) {
      // New tabs from youtube always go to the top level, never as children.
      hooks.tap("tab:placement", (p, { tab }) => (tab.url.includes("youtube") ? { ...p, parentId: null } : p));
      commands.register("demo:hello", () => "hi");
      hooks.tap("ui:menu", (items) => [...items, { id: "demo", label: "Demo", command: "demo:hello" }]);
    },
  };
  const kernel = await createKernel({ api: fb.browser, modules: [...modules, plugin], log: quiet });
  await settle();
  const { ctx } = kernel;
  const aTab = fb.sim.byUrl("https://a.test/")[0].id;
  await fb.sim.openFrom(aTab, "https://youtube.test/v");
  await settle();
  const rows = T.flatten(ctx.modules.tree.all(), ctx.modules.windows.getActive(fb.win.id));
  assert.deepEqual(rows.map((r) => r.depth), [0, 0], "hook vetoed the child placement");
  assert.equal(await ctx.commands.run("demo:hello"), "hi");
  const items = await ctx.commands.run("ui:menu", { id: rows[0].node.id });
  assert.ok(items.some((i) => i.id === "demo"));
});

test("a module that throws in setup is skipped without breaking the rest", async () => {
  const fb = createFakeBrowser();
  fb.win = fb.sim.addWindow();
  const broken = { name: "broken", setup() { throw new Error("nope"); } };
  const dependent = { name: "dependent", deps: ["broken"], setup() { throw new Error("must not run"); } };
  const logs = [];
  const log = { ...quiet, error: (...a) => logs.push(a.join(" ")) };
  const kernel = await createKernel({ api: fb.browser, modules: [...modules, broken, dependent], log });
  assert.ok(kernel.ctx.commands.has("panel:create"));
  assert.ok(kernel.ctx.failed.has("broken") && kernel.ctx.failed.has("dependent"));
});
