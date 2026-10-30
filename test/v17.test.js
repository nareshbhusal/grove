import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";
import { explain, findRule, foldersAbove, migrateRules } from "../src/lib/rules.js";

// ---- folder-level container rules ----

const folder = (id, defaultContainer = null, extra = {}) => ({ id, type: "folder", name: id, defaultContainer, ...extra });

test("rule priority: folder rule, panel rule, anywhere rule; inner folder before outer", () => {
  const rules = [
    { id: "g", pattern: "x.test", panelIds: [], folderIds: [], containerId: "global" },
    { id: "p", pattern: "x.test", panelIds: ["P"], folderIds: [], containerId: "panel" },
  ];
  const outer = folder("outer");
  const inner = folder("inner");
  assert.equal(findRule(rules, "https://x.test/", "P", []).containerId, "panel");
  assert.equal(findRule(rules, "https://x.test/", "Q", []).containerId, "global");

  const onlyOuter = [...rules, { id: "o", pattern: "x.test", panelIds: [], folderIds: ["outer"], containerId: "outer" }];
  assert.equal(findRule(onlyOuter, "https://x.test/", "P", [inner, outer]).containerId, "outer", "a folder rule covers the folders inside it");
  assert.equal(findRule(onlyOuter, "https://x.test/", "P", []).containerId, "panel", "outside the folder it does not apply");
  // a rule for a folder is not a rule for everywhere
  assert.equal(findRule([onlyOuter[2]], "https://x.test/", "P", []), null);

  const both = [...onlyOuter, { id: "i", pattern: "y.test", panelIds: [], folderIds: ["inner"], containerId: "inner" }, { id: "o2", pattern: "y.test", panelIds: [], folderIds: ["outer"], containerId: "outer2" }];
  assert.equal(findRule(both, "https://y.test/", "P", [inner, outer]).containerId, "inner", "the nearest folder wins");
});

test("folder defaults: nearest folder with one, else the panel's; rules still win", () => {
  const ctx = { rules: [{ id: "r", pattern: "r.test", panelIds: [], folderIds: [], containerId: "rule" }], panels: [{ id: "P", defaultContainer: "panel" }] };
  const outer = folder("outer", "outerC");
  const inner = folder("inner", null);
  const plain = folder("plain", "firefox-default");
  assert.deepEqual(explain(ctx, "https://a.test/", "P", [inner, outer]).via, "folder");
  assert.equal(explain(ctx, "https://a.test/", "P", [inner, outer]).containerId, "outerC", "an unset folder inherits");
  assert.equal(explain(ctx, "https://a.test/", "P", [plain, outer]).containerId, "firefox-default", "“No container” is a choice, not an inherit");
  assert.equal(explain(ctx, "https://a.test/", "P", [inner]).containerId, "panel");
  assert.equal(explain(ctx, "https://r.test/", "P", [outer]).containerId, "rule");
  assert.equal(explain({ rules: [], panels: [] }, "https://a.test/", "P", []).via, "none");
});

test("foldersAbove walks through tabs to the folders around them, nearest first", () => {
  const nodes = {
    f1: { id: "f1", type: "folder", parentId: null },
    f2: { id: "f2", type: "folder", parentId: "f1" },
    t1: { id: "t1", type: "tab", parentId: "f2" },
    t2: { id: "t2", type: "tab", parentId: "t1" },
  };
  assert.deepEqual(foldersAbove(nodes, "t2").map((f) => f.id), ["f2", "f1"]);
  assert.deepEqual(foldersAbove(nodes, null), []);
  assert.deepEqual(foldersAbove(nodes, "missing"), []);
});

test("migrating keeps the folders a rule is limited to", () => {
  const { rules } = migrateRules([
    { id: "a", pattern: "a.test", panelIds: ["P"], folderIds: ["F"], containerId: "c" },
    { id: "b", pattern: "A.test", panelIds: ["Q"], folderIds: ["G"], containerId: "c" },
    { id: "c", pattern: "z.test", panelIds: [], folderIds: ["F"], containerId: "c" },
  ]);
  assert.deepEqual(rules.find((r) => r.pattern === "a.test").folderIds, ["F", "G"]);
  assert.deepEqual(rules.find((r) => r.pattern === "a.test").panelIds, ["P", "Q"]);
  assert.deepEqual(rules.find((r) => r.pattern === "z.test").folderIds, ["F"]);
});

test("new tabs opened in a folder start in the folder's container; a subfolder overrides, and “no container” too", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  const media = await t.run("containers:create", { name: "Media" });
  const outer = await t.run("folder:create", { name: "Outer", panelId: t.panelId });
  const inner = await t.run("folder:create", { name: "Inner", parentId: outer });
  const plain = await t.run("folder:create", { name: "Plain", parentId: outer });
  await t.run("folder:setContainer", { id: outer, defaultContainer: work });
  await t.run("panel:update", { id: t.panelId, defaultContainer: media });
  await t.run("folder:setContainer", { id: plain, defaultContainer: "firefox-default" });

  await t.run("tab:new", { windowId: t.winId, parentId: outer, url: "https://in-outer.test/" });
  await t.run("tab:new", { windowId: t.winId, parentId: inner, url: "https://in-inner.test/" });
  await t.run("tab:new", { windowId: t.winId, parentId: plain, url: "https://in-plain.test/" });
  await t.run("tab:new", { windowId: t.winId, panelId: t.panelId, relation: "end", url: "https://top.test/" });
  await settle(120);
  const of = (u) => t.sim.byUrl(u)[0].cookieStoreId;
  assert.equal(of("https://in-outer.test/"), work);
  assert.equal(of("https://in-inner.test/"), work, "a subfolder with nothing set follows the folder around it");
  assert.equal(of("https://in-plain.test/"), "firefox-default", "“No container” beats the container of the folder around it");
  assert.equal(of("https://top.test/"), media, "outside folders, the panel's container");

  await t.run("folder:setContainer", { id: inner, defaultContainer: media });
  await t.run("tab:new", { windowId: t.winId, parentId: inner, url: "https://in-inner2.test/" });
  await settle(120);
  assert.equal(of("https://in-inner2.test/"), media);

  await t.run("folder:setContainer", { id: outer, defaultContainer: null });
  assert.equal(t.m.tree.get(outer).defaultContainer, undefined, "cleared, so it follows the panel again");
});

test("a child of a tab inside a folder counts as being in the folder", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  await t.run("folder:setContainer", { id: f, defaultContainer: work });
  const parent = await t.run("tab:new", { windowId: t.winId, parentId: f, url: "https://parent.test/" });
  await settle(80);
  await t.run("tab:new", { windowId: t.winId, parentId: parent, url: "https://child.test/" });
  await settle(120);
  assert.equal(t.sim.byUrl("https://child.test/")[0].cookieStoreId, work);
});

test("a rule limited to a folder only applies inside it, and beats the folder's default", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  const media = await t.run("containers:create", { name: "Media" });
  const f = await t.run("folder:create", { name: "Videos", panelId: t.panelId });
  const sub = await t.run("folder:create", { name: "Sub", parentId: f });
  const other = await t.run("folder:create", { name: "Other", panelId: t.panelId });
  await t.run("folder:setContainer", { id: f, defaultContainer: work });
  await t.run("rules:add", { pattern: "video.test", folderIds: [f], containerId: media });

  const test_ = async (args) => (await t.run("containers:test", { url: "https://video.test/", ...args })).containerId;
  assert.equal(await test_({ folderId: f }), media);
  assert.equal(await test_({ folderId: sub }), media, "subfolders are inside it");
  assert.equal(await test_({ folderId: other }), null, "another folder: no rule, no default");
  assert.equal(await test_({ panelId: t.panelId }), null);
  const viaDefault = await t.run("containers:test", { url: "https://else.test/", folderId: sub });
  assert.deepEqual([viaDefault.containerId, viaDefault.via, viaDefault.folder], [work, "folder", "Videos"]);

  await t.run("tab:new", { windowId: t.winId, parentId: sub, url: "https://video.test/clip" });
  await settle(120);
  assert.equal(t.sim.byUrl("https://video.test/clip")[0].cookieStoreId, media, "a tab Grove opens");
});

test("a tab already in a folder is moved to the folder rule's container when it navigates", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const media = await t.run("containers:create", { name: "Media" });
  const f = await t.run("folder:create", { name: "Videos", panelId: t.panelId });
  await t.run("rules:add", { pattern: "video.test", folderIds: [f], containerId: media });
  await t.run("tab:new", { windowId: t.winId, parentId: f, url: "https://start.test/" });
  await settle(120);
  const tab = t.sim.byUrl("https://start.test/")[0];
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).parentId, f);
  assert.equal(await t.sim.navigate(tab.id, "https://video.test/x"), false, "rerouted: the tab was in the folder, so the folder's rule applies");
  await settle(150);
  const moved = t.sim.byUrl("https://video.test/x")[0];
  assert.equal(moved.cookieStoreId, media);
  assert.equal(foldersAbove(t.m.tree.all(), t.m.tree.get(t.nodeOf(moved.id)).parentId)[0]?.id, f, "still in the folder (as a child of the tab it came from)");
  // a tab elsewhere is left alone
  const free = [...t.sim.tabs.values()].find((x) => x.url === "https://a.test/");
  assert.equal(await t.sim.navigate(free.id, "https://video.test/y"), true);
});

test("rules: unknown folders are ignored, but a rule cannot silently become a rule for everywhere", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  await assert.rejects(() => t.run("rules:add", { pattern: "gone.test", folderIds: ["nope"], containerId: c }), /no longer exist/);
  const id = await t.run("rules:add", { pattern: "one.test", folderIds: [f, "nope"], containerId: c });
  assert.deepEqual(t.ctx.store.get("rules").find((r) => r.id === id).folderIds, [f]);
  await assert.rejects(() => t.run("rules:update", { id, folderIds: ["nope"] }), /no longer exist/);
  // changing only the panels keeps the folders
  await t.run("rules:update", { id, panelIds: [t.panelId] });
  const r = t.ctx.store.get("rules").find((x) => x.id === id);
  assert.deepEqual([r.panelIds, r.folderIds], [[t.panelId], [f]]);
  // emptying both widens to everywhere, on purpose
  await t.run("rules:update", { id, panelIds: [], folderIds: [] });
  assert.equal((await t.run("containers:test", { url: "https://one.test/", panelId: t.panelId })).containerId, c);
});

test("deleting a folder takes it out of the rules; a rule only for it goes too", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  const g = await t.run("folder:create", { name: "G", panelId: t.panelId });
  await t.run("rules:add", { pattern: "only-f.test", folderIds: [f], containerId: c });
  await t.run("rules:add", { pattern: "f-and-g.test", folderIds: [f, g], containerId: c });
  await t.run("rules:add", { pattern: "f-and-panel.test", folderIds: [f], panelIds: [t.panelId], containerId: c });
  await t.run("folder:ungroup", { id: f });
  const rules = t.ctx.store.get("rules");
  assert.deepEqual(rules.map((r) => r.pattern).sort(), ["f-and-g.test", "f-and-panel.test"]);
  assert.deepEqual(rules.find((r) => r.pattern === "f-and-g.test").folderIds, [g]);
  assert.deepEqual(rules.find((r) => r.pattern === "f-and-panel.test").folderIds, []);
});

test("export and import carry folder containers and folder rules to another profile", async () => {
  const src = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await src.run("containers:create", { name: "Work" });
  const media = await src.run("containers:create", { name: "Media" });
  const outer = await src.run("folder:create", { name: "Outer", panelId: src.panelId });
  const inner = await src.run("folder:create", { name: "Inner", parentId: outer });
  await src.run("folder:setContainer", { id: outer, defaultContainer: work });
  await src.run("rules:add", { pattern: "video.test", folderIds: [inner], containerId: media });
  await src.run("rules:add", { pattern: "both.test", folderIds: [outer], panelIds: [src.panelId], containerId: work });
  const file = await src.run("io:export", { scope: "all", format: "json" });
  const data = JSON.parse(file.text);
  assert.deepEqual(data.containers.map((c) => c.name).sort(), ["Media", "Work"]);

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  await dst.browser.contextualIdentities.create({ name: "Other", color: "red", icon: "circle" });
  const result = await dst.run("io:import", { text: file.text, mode: "merge" });
  assert.equal(result.rulesSkipped, 0);
  const have = await dst.run("containers:list");
  const idOf = (n) => have.find((c) => c.name === n).cookieStoreId;

  const nodes = Object.values(dst.m.tree.all());
  const o = nodes.find((n) => n.type === "folder" && n.name === "Outer");
  const i = nodes.find((n) => n.type === "folder" && n.name === "Inner");
  assert.equal(o.defaultContainer, idOf("Work"), "folder container follows the container's name");
  assert.equal(i.defaultContainer, undefined);
  assert.equal(o.ref, undefined, "the helper id is not left on the node");
  const rules = dst.ctx.store.get("rules");
  const video = rules.find((r) => r.pattern === "video.test");
  assert.deepEqual(video.folderIds, [i.id], "the rule follows its folder to the new id");
  assert.equal(video.containerId, idOf("Media"));
  const both = rules.find((r) => r.pattern === "both.test");
  assert.deepEqual(both.folderIds, [o.id]);
  assert.equal(both.panelIds.length, 1);
  assert.equal((await dst.run("containers:test", { url: "https://video.test/", folderId: i.id })).containerId, idOf("Media"));
  assert.equal((await dst.run("containers:test", { url: "https://video.test/", folderId: o.id })).containerId, idOf("Work"), "outside the inner folder: the outer folder's default");

  // a file whose rule names a folder that is not in the file: skipped, never widened
  const broken = JSON.parse(file.text);
  broken.rules.push({ id: "x", pattern: "ghost.test", panelIds: [], folderIds: ["not-in-file"], containerId: media });
  const again = await dst.run("io:import", { text: JSON.stringify(broken), mode: "merge" });
  assert.equal(again.rulesSkipped, 1);
  assert.ok(!dst.ctx.store.get("rules").some((r) => r.pattern === "ghost.test"));
});

test("private folders take no container settings", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  const f = await t.run("folder:create", { name: "Plain", panelId: t.panelId });
  t.m.tree.mutate((all) => { all[f].private = true; });
  assert.equal(await t.run("folder:setContainer", { id: f, defaultContainer: c }), false);
  await assert.rejects(() => t.run("rules:add", { pattern: "p.test", folderIds: [f], containerId: c }), /no longer exist/);
});

test("the folder menu offers the container dialog", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "C" });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  await t.run("folder:setContainer", { id: f, defaultContainer: c });
  const items = await t.ctx.hooks.run("ui:menu", [], { node: t.m.tree.get(f), selection: null });
  const entry = items.find((i) => i.id === "folder-containers");
  assert.equal(entry.ui, "folderContainers");
  assert.equal(entry.args.id, f);
  void c;
});
