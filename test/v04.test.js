import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, settle, T } from "./helpers.js";

// ---- export / import: everything survives, into a profile with different container ids ----

const outline = (t, panelId, pick = (n) => n) => {
  const lines = [];
  const walk = (list, depth) => {
    for (const n of list) {
      const label = n.type === "tab" ? n.customTitle || n.url : n.name;
      lines.push(`${"  ".repeat(depth)}${n.type}:${label}${n.collapsed ? " [collapsed]" : ""}${n.cookieStoreId && n.cookieStoreId !== "firefox-default" ? ` <${n.cookieStoreId}>` : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(T.toNested(t.m.tree.all(), panelId, pick), 0);
  return lines;
};

async function buildSource() {
  const t = await boot({ seed: [
    { url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }, { url: "https://d.test/" },
  ] });
  const main = t.panelId;
  const work = await t.run("containers:create", { name: "Work" });
  const shop = await t.run("containers:create", { name: "Shop" });

  await t.run("tree:rename", { id: t.nodeByUrl("https://a.test/"), name: "Custom A" });
  const f1 = await t.run("folder:create", { name: "Research", panelId: main, nodeIds: [t.nodeByUrl("https://b.test/"), t.nodeByUrl("https://c.test/")] });
  const plan = await t.run("note:create", { folderId: f1, name: "Plan" });
  await t.run("note:save", { id: plan, name: "Plan", text: "line one\nline two — ünïcode 🌳\n\ttabbed" });
  const f2 = await t.run("folder:create", { name: "Deep", parentId: f1, panelId: main });
  await t.run("tree:move", { id: t.nodeByUrl("https://d.test/"), parentId: f2 });
  const deepNote = await t.run("note:create", { folderId: f2, name: "Deep note" });
  await t.run("note:save", { id: deepNote, name: "Deep note", text: "inside the subfolder" });
  await t.run("tree:toggle", { id: f2, value: true });

  await t.run("tab:new", { windowId: t.winId, panelId: main, url: "https://shop.test/cart", cookieStoreId: shop });
  await settle();

  const reading = await t.run("panel:create", { name: "Reading", color: "#af51f5" });
  await t.run("panel:update", { id: reading, defaultContainer: work });
  await t.run("folder:create", { name: "Later", panelId: reading });

  await t.run("rules:add", { pattern: "shop.test", containerId: shop });
  await t.run("rules:add", { pattern: "work.test", panelId: reading, containerId: work });
  await t.run("settings:set", { module: "tabs", key: "newTabPlacement", value: "child" });
  await settle();
  return { t, main, reading, work, shop };
}

test("export then import into a different profile keeps panels, folders, notes, containers, rules, settings", async () => {
  const src = await buildSource();
  const exported = await src.t.run("io:export", { scope: "all", format: "json" });
  const file = JSON.parse(exported.text);

  // What the file itself says (so a regression in export is caught even before import).
  assert.deepEqual(file.panels.map((p) => p.name), [src.t.m.panels.find(src.main).name, "Reading"]);
  assert.deepEqual(file.containers.map((c) => c.name).sort(), ["Shop", "Work"]);
  assert.equal(file.rules.length, 2);
  assert.equal(file.settings.tabs.newTabPlacement, "child");

  // A different profile: containers exist in another order, so every id differs.
  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  await dst.browser.contextualIdentities.create({ name: "Other", color: "red", icon: "circle" });
  const tabsBefore = dst.sim.tabs.size;

  const result = await dst.run("io:import", { text: exported.text, mode: "merge" });
  assert.equal(result.containersCreated, 2, "Work and Shop recreated by name");
  assert.equal(dst.sim.tabs.size, tabsBefore, "importing opens nothing");

  const dstContainers = await dst.run("containers:list");
  const idOf = (name) => dstContainers.find((c) => c.name === name)?.cookieStoreId;
  assert.ok(idOf("Work") && idOf("Shop"));
  assert.notEqual(idOf("Work"), src.work, "ids differ between profiles, that is the point");

  // Panels
  const readingHere = dst.m.panels.list().find((p) => p.name === "Reading");
  assert.ok(readingHere, "new panel created");
  assert.equal(readingHere.color, "#af51f5");
  assert.equal(readingHere.defaultContainer, idOf("Work"), "panel default container follows the name");

  // Structure, titles, collapsed state, container of each tab. Compare per panel with the source ids translated.
  const srcMain = outline(src.t, src.main).map((l) => l.replace(src.shop, "SHOP"));
  const mainHere = dst.m.panels.list().find((p) => p.name === src.t.m.panels.find(src.main).name);
  const dstMain = outline(dst, mainHere.id).map((l) => l.replace(idOf("Shop"), "SHOP"));
  // existing.test stays; everything from the file is appended after it
  assert.deepEqual(dstMain.filter((l) => !l.includes("existing.test")), srcMain);
  assert.ok(srcMain.some((l) => l.includes("[collapsed]")) && srcMain.some((l) => l.includes("<SHOP>")) && srcMain.some((l) => l.includes("Custom A")));
  assert.deepEqual(outline(dst, readingHere.id), outline(src.t, src.reading));

  // Notes, byte for byte
  const notesHere = Object.values(dst.m.tree.all()).filter((n) => n.type === "note");
  assert.equal(notesHere.length, 2);
  const texts = Object.fromEntries(await Promise.all(notesHere.map(async (n) => [n.name, (await dst.run("note:get", { id: n.id })).text])));
  assert.equal(texts["Plan"], "line one\nline two — ünïcode 🌳\n\ttabbed");
  assert.equal(texts["Deep note"], "inside the subfolder");

  // Rules follow containers by name and panels to their new ids
  const rules = dst.ctx.store.get("rules");
  assert.equal(rules.find((r) => r.pattern === "shop.test").containerId, idOf("Shop"));
  const scoped = rules.find((r) => r.pattern === "work.test");
  assert.equal(scoped.containerId, idOf("Work"));
  assert.deepEqual(scoped.panelIds, [readingHere.id], "a rule limited to a panel is still limited to that panel");

  // Settings
  assert.equal(dst.m.settings.get("tabs", "newTabPlacement"), "child");

  // Imported tabs are inert (saved, no live tab) and can be opened later
  const shopNode = Object.values(dst.m.tree.all()).find((n) => n.url === "https://shop.test/cart");
  assert.equal(shopNode.tabId ?? null, null);
  assert.equal(shopNode.cookieStoreId, idOf("Shop"));
});

test("import replace drops old saved nodes but keeps live tabs; the file's containers are reused, not duplicated", async () => {
  const src = await buildSource();
  const exported = await src.t.run("io:export", { scope: "all", format: "json" });
  // Importing back into the same profile: containers match by name, none created.
  const again = await src.t.run("io:import", { text: exported.text, mode: "replace" });
  assert.equal(again.containersCreated, 0);
  const names = (await src.t.run("containers:list")).map((c) => c.name);
  assert.equal(names.filter((n) => n === "Work").length, 1);
  assert.equal(src.t.ctx.store.get("rules").length, 2, "replace does not double the rules");
});

test("old exports without a containers list still import", async () => {
  const dst = await boot({ seed: [{ url: "https://x.test/", active: true }] });
  const old = { grove: 1, panels: [{ id: "p_old", name: "Old", color: "#111111", tree: [{ type: "tab", url: "https://old.test/", title: "Old" }] }] };
  const r = await dst.run("io:import", { text: JSON.stringify(old), mode: "merge" });
  assert.equal(r.tabs, 1);
  assert.equal(r.containersCreated, 0);
});

// ---- multi-select: bulk commands and menu ----

const names = (t) => t.labels();

test("tree:moveMany keeps the given order, carries subtrees once and skips illegal moves", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }, { url: "https://d.test/" }] });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => t.nodeByUrl(`https://${x}.test/`));
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  // c and d into the folder, d first in the order given
  assert.equal(await t.run("tree:moveMany", { ids: [d, c], parentId: f, index: null, panelId: t.panelId }), 2);
  assert.deepEqual(names(t).filter((l) => /^-/.test(l)), ["-https://d.test/", "-https://c.test/"]);
  // Selecting a folder and its own child moves the child once, with the folder
  const g = await t.run("folder:create", { name: "G", panelId: t.panelId });
  assert.equal(await t.run("tree:moveMany", { ids: [f, c], parentId: g, index: null, panelId: t.panelId }), 1);
  assert.equal(t.m.tree.get(c).parentId, f);
  assert.equal(t.m.tree.get(f).parentId, g);
  // A note cannot go to the top level, a tab beside it can
  const n = await t.run("note:create", { folderId: f, name: "N" });
  assert.equal(await t.run("tree:moveMany", { ids: [n, b], parentId: null, index: null, panelId: t.panelId }), 1);
  assert.equal(t.m.tree.get(n).parentId, f);
  assert.equal(t.m.tree.get(b).parentId, null);
  assert.ok(a);
});

test("moving several tabs to another panel hides them together", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }] });
  const other = await t.run("panel:create", { name: "Other" });
  const [b, c] = ["b", "c"].map((x) => t.nodeByUrl(`https://${x}.test/`));
  await t.run("tree:moveMany", { ids: [b, c], parentId: null, index: null, panelId: other });
  await settle();
  assert.equal(t.m.tree.get(b).panelId, other);
  assert.equal(t.m.tree.get(c).panelId, other);
  assert.deepEqual(t.sim.hidden(t.winId).map((x) => x.url).sort(), ["https://b.test/", "https://c.test/"]);
});

test("tabs:unload and tabs:load work on a folder, a branch and a selection; the active tab is skipped", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }, { url: "https://d.test/" }] });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => t.nodeByUrl(`https://${x}.test/`));
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId, nodeIds: [a, b, c] });
  const r = await t.run("tabs:unload", { ids: [f], deep: true });
  await settle();
  assert.deepEqual(r, { unloaded: 2, skipped: 1 }, "the tab you are on is skipped");
  assert.equal(t.m.tree.get(b).discarded, true);
  assert.equal(t.m.tree.get(a).discarded, false);
  assert.equal(t.m.tree.get(d).discarded, false, "outside the folder: untouched");
  assert.equal(t.m.tree.get(b).wasLoaded, false);

  assert.deepEqual(await t.run("tabs:load", { ids: [f] }), { loaded: 2 });
  assert.equal(t.m.tree.get(b).discarded, false);
  assert.equal(t.m.tree.get(c).discarded, false);

  // a branch: a tab with children
  await t.run("tab:activate", { id: d, windowId: t.winId });
  const parent = d;
  const kid = await t.sim.openFrom(t.tabByUrl("https://d.test/").id, "https://kid.test/");
  await settle();
  const kidNode = t.nodeOf(kid.id);
  assert.equal(t.m.tree.get(kidNode).parentId, parent);
  await t.run("tab:activate", { id: b, windowId: t.winId });
  assert.deepEqual(await t.run("tabs:unload", { ids: [parent], deep: true }), { unloaded: 2, skipped: 0 });
  assert.equal(t.m.tree.get(kidNode).discarded, true);
});

test("tab:closeMany closes only the selected tabs and promotes their children", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const a = t.nodeByUrl("https://a.test/");
  const kid = await t.sim.openFrom(t.tabByUrl("https://a.test/").id, "https://kid.test/");
  await settle();
  const b = t.nodeByUrl("https://b.test/");
  assert.equal(await t.run("tab:closeMany", { ids: [a, b] }), 2);
  await settle();
  assert.equal(t.sim.byUrl("https://a.test/").length, 0);
  assert.equal(t.sim.byUrl("https://b.test/").length, 0);
  assert.equal(t.sim.byUrl("https://kid.test/").length, 1);
  assert.equal(t.m.tree.get(t.nodeOf(kid.id)).parentId, null, "child promoted");
});

test("context menus: selection, folder and branch items", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }] });
  const [a, b, c] = ["a", "b", "c"].map((x) => t.nodeByUrl(`https://${x}.test/`));
  await t.run("panel:create", { name: "Other" });
  const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label ?? i.heading);

  const bulk = await t.run("ui:menu", { ids: [b, c] });
  assert.deepEqual(labels(bulk), ["2 items selected", "Unload 2 tabs", "Move into new folder…", "Move to “Other”", "Bookmark 2 items…", "Close 2 tabs"]);
  assert.deepEqual(bulk.find((i) => i.id === "sel-folder").args.nodeIds, [b, c]);

  await t.run("tabs:unload", { ids: [b], deep: false });
  const mixed = await t.run("ui:menu", { ids: [b, c] });
  assert.ok(labels(mixed).includes("Unload 1 tab") && labels(mixed).includes("Load 1 tab"));

  const f = await t.run("folder:create", { name: "F", panelId: t.panelId, nodeIds: [b, c] });
  const folderMenu = await t.run("ui:menu", { id: f });
  assert.ok(labels(folderMenu).includes("Unload all tabs inside (1)"));
  assert.ok(labels(folderMenu).includes("Load all tabs inside (1)"));

  const kid = await t.sim.openFrom(t.tabByUrl("https://a.test/").id, "https://kid.test/");
  await settle();
  const branchMenu = await t.run("ui:menu", { id: a });
  assert.ok(labels(branchMenu).includes("Unload tab and children (2)"), labels(branchMenu).join(" | "));
  assert.ok(kid);
});

// ---- restart while offline ----

test("restart offline: nothing is reloaded until the browser reports it is online", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  await first.kernel.stop();
  first.sim.tabs.get(first.tabByUrl("https://b.test/").id).discarded = true;

  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const handlers = new Set();
  globalThis.addEventListener = (type, fn) => type === "online" && handlers.add(fn);
  globalThis.removeEventListener = (type, fn) => handlers.delete(fn);
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    const second = await boot({ existing: first });
    await settle(500);
    assert.equal(second.sim.reloads.length, 0, "offline: left unloaded");
    assert.equal(second.tabByUrl("https://b.test/").discarded, true);
    assert.ok(second.m.diagnostics, "diagnostics present");

    globalThis.navigator.onLine = true;
    handlers.forEach((fn) => fn());
    await settle(500);
    assert.equal(second.tabByUrl("https://b.test/").discarded, false, "online again: loaded");
    await second.kernel.stop();
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete globalThis.navigator;
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
  }
});
