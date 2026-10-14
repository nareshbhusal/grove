import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";
import "../src/content/keys.js";

const U = (n) => `https://${n}.test/`;
const active = (t) => [...t.sim.tabs.values()].find((x) => x.windowId === t.winId && x.active);

async function setup(urls = ["a", "b", "c"], { enable = true } = {}) {
  const t = await boot({ seed: urls.map((n, i) => ({ url: U(n), active: i === 0 })) });
  if (enable) await t.run("settings:set", { module: "vim", key: "enabled", value: true });
  t.key = (n, action) => t.sim.fromPage(t.tabByUrl(U(n)).id, { type: "vim:key", action });
  t.tab = (n) => t.tabByUrl(U(n));
  return t;
}

// ---- on and off ----

test("vim keys are off until switched on; a paused page is told", async () => {
  const t = await setup(["a", "b"], { enable: false });
  assert.deepEqual(await t.sim.fromPage(t.tab("a").id, { type: "vim:config" }), { active: false });
  assert.equal(await t.key("a", "next"), false);
  assert.equal(active(t).url, U("a"), "nothing happened");
  await t.run("settings:set", { module: "vim", key: "enabled", value: true });
  assert.deepEqual(await t.sim.fromPage(t.tab("a").id, { type: "vim:config" }), { active: true });
  assert.ok(t.sim.pageMessages.some(([, m]) => m.type === "vim:active" && m.active === true), "open pages are told at once");
  t.sim.pageMessages.length = 0;
  await t.run("settings:set", { module: "vim", key: "enabled", value: false });
  await settle();
  assert.equal(t.sim.pageMessages.filter(([, m]) => m.active === false).length, 2, "every open tab hears it");
  assert.equal(await t.key("a", "next"), false, "paused: keys do nothing");
});

// ---- gt / gT ----

test("next and previous tab follow the order of the sidebar, and wrap around", async () => {
  const t = await setup();
  await t.key("a", "next");
  assert.equal(active(t).url, U("b"));
  await t.key("b", "next");
  assert.equal(active(t).url, U("c"));
  await t.key("c", "next");
  assert.equal(active(t).url, U("a"), "wraps to the first");
  await t.key("a", "prev");
  assert.equal(active(t).url, U("c"), "and back to the last");
});

test("the order is the tree's, not the browser's strip", async () => {
  const t = await setup();
  // drag c in front of a in the tree; the browser strip keeps a, b, c
  await t.run("tree:move", { id: t.nodeByUrl(U("c")), parentId: null, index: 0, panelId: t.panelId });
  await t.key("a", "next");
  assert.equal(active(t).url, U("b"), "after a comes b (tree: c, a, b)");
  await t.key("b", "next");
  assert.equal(active(t).url, U("c"), "wraps to c, the first row");
});

test("tabs folded away are skipped; tabs of another panel or folder are not in the order", async () => {
  const t = await setup(["a", "b", "c"]);
  await t.run("tree:move", { id: t.nodeByUrl(U("b")), parentId: t.nodeByUrl(U("a")), index: 0 });
  await t.run("tree:toggle", { id: t.nodeByUrl(U("a")), value: true });
  await t.key("a", "next");
  assert.equal(active(t).url, U("c"), "b is folded under a");
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("tree:move", { id: t.nodeByUrl(U("c")), parentId: null, panelId: other });
  await settle();
  await t.browser.tabs.update(t.tab("a").id, { active: true });
  await t.run("tree:toggle", { id: t.nodeByUrl(U("a")), value: true }); // activating b had unfolded it
  await t.key("a", "next");
  assert.equal(active(t).url, U("a"), "a is the only tab left in this panel");
});

test("unloaded tabs are included or skipped by the setting", async () => {
  const t = await setup();
  await t.sim.discardTab(t.tab("b").id);
  await t.key("a", "next");
  assert.equal(active(t).url, U("b"), "included by default");
  await t.browser.tabs.update(t.tab("a").id, { active: true });
  await t.run("settings:set", { module: "vim", key: "includeUnloaded", value: false });
  await t.key("a", "next");
  assert.equal(active(t).url, U("c"), "skipped when asked");
});

test("from the sidebar the active tab of the window is the starting point", async () => {
  const t = await setup();
  assert.equal(await t.run("vim:do", { action: "next", windowId: t.winId }), true);
  assert.equal(active(t).url, U("b"));
  await t.run("settings:set", { module: "vim", key: "enabled", value: false });
  assert.equal(await t.run("vim:do", { action: "next", windowId: t.winId }), false);
});

// ---- t, H, L ----

test("t opens a tab in the panel's container, like the + button", async () => {
  const t = await setup(["a"]);
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.key("a", "new");
  await settle(100);
  const fresh = [...t.sim.tabs.values()].filter((x) => x.url === "about:newtab");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].cookieStoreId, work);
  assert.equal(t.m.tree.get(t.nodeOf(fresh[0].id)).panelId, t.panelId);
});

test("H goes back and L goes forward in the tab you are in", async () => {
  const t = await setup(["a", "b"]);
  await t.key("b", "back");
  await t.key("b", "forward");
  assert.deepEqual(t.sim.history, [["back", t.tab("b").id], ["forward", t.tab("b").id]]);
});

// ---- << and >> ----

test("<< and >> move a tab among its siblings and stop at the ends", async () => {
  const t = await setup(["a", "b", "c"]);
  const order = () => t.rows().map((r) => r.label);
  await t.key("b", "up");
  assert.deepEqual(order(), [U("b"), U("a"), U("c")]);
  assert.equal(await t.key("b", "up"), false, "already first");
  await t.key("b", "down");
  await t.key("b", "down");
  assert.deepEqual(order(), [U("a"), U("c"), U("b")]);
  assert.equal(await t.key("b", "down"), false, "already last");
});

test("moving never leaves the level: a child stays among its siblings, and takes its children along", async () => {
  const t = await setup(["p", "x", "y", "z"]);
  await t.run("tree:move", { id: t.nodeByUrl(U("x")), parentId: t.nodeByUrl(U("p")), index: 0 });
  await t.run("tree:move", { id: t.nodeByUrl(U("y")), parentId: t.nodeByUrl(U("p")), index: 1 });
  await t.run("tree:move", { id: t.nodeByUrl(U("z")), parentId: t.nodeByUrl(U("x")), index: 0 });
  assert.equal(await t.key("x", "up"), false, "first child cannot go above its parent");
  await t.key("x", "down");
  assert.deepEqual(t.rows().map((r) => `${r.depth}${r.label.slice(8, 9)}`), ["0p", "1y", "1x", "2z"], "x moved below y, z still under x");
  assert.equal(t.m.tree.get(t.nodeByUrl(U("x"))).parentId, t.nodeByUrl(U("p")));
});

// ---- exceptions ----

test("exception patterns keep the keys off on matching sites only", async () => {
  const t = await setup(["a", "b", "docs"]);
  await t.run("settings:set", { module: "vim", key: "exceptions", value: "# comment\n\n  a.test \n=docs.test\n/^https:\\/\\/never\\./" });
  const cfg = async (n) => (await t.sim.fromPage(t.tab(n).id, { type: "vim:config" })).active;
  assert.equal(await cfg("a"), false);
  assert.equal(await cfg("docs"), false);
  assert.equal(await cfg("b"), true);
  assert.equal(await t.key("a", "next"), false, "a key pressed on an excluded page does nothing");
  assert.equal(active(t).url, U("a"));
  assert.equal(await t.key("b", "next"), true);
  // the sidebar is not a site: its keys are not subject to the list
  await t.browser.tabs.update(t.tab("a").id, { active: true });
  assert.equal(await t.run("vim:do", { action: "next", windowId: t.winId }), true);
  // changing the list reaches open pages
  t.sim.pageMessages.length = 0;
  await t.run("settings:set", { module: "vim", key: "exceptions", value: "b.test" });
  await settle();
  const told = Object.fromEntries(t.sim.pageMessages.map(([id, m]) => [id, m.active]));
  assert.equal(told[t.tab("a").id], true);
  assert.equal(told[t.tab("b").id], false);
});

test("private windows work too", async () => {
  const t = await setup(["a"]);
  const pw = t.sim.addWindow({ incognito: true });
  await settle();
  const p1 = await t.browser.tabs.create({ windowId: pw.id, url: U("p1") });
  const p2 = await t.browser.tabs.create({ windowId: pw.id, url: U("p2") });
  await settle();
  await t.sim.fromPage(p2.id, { type: "vim:key", action: "prev" });
  assert.equal(t.sim.tabs.get(p1.id).active, true);
  assert.equal(active(t).url, U("a"), "the normal window is untouched");
});

// ---- the key recogniser ----

function keyboard({ active = true } = {}) {
  const win = new EventTarget();
  win.document = { designMode: "off" };
  const sent = [];
  globalThis.groveVimKeys.install(win, { active: () => active, send: (a) => sent.push(a) });
  const press = (key, props = {}) => {
    const e = Object.assign(new Event("keydown", { cancelable: true }), { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: key !== key.toLowerCase(), repeat: false, ...props });
    win.dispatchEvent(e);
    return e;
  };
  return { sent, press, win };
}
const typeInto = (press, key, el) => press(key, { composedPath: () => [el] });

test("keys: sequences, single keys and what is swallowed", () => {
  const { sent, press } = keyboard();
  press("g"); press("t");
  press("g"); press("T");
  press("g"); press("s");
  press("t"); press("H"); press("L");
  press("<"); press("<");
  press(">"); press(">");
  assert.deepEqual(sent, ["next", "prev", "prev", "new", "back", "forward", "up", "down"]);
  assert.equal(press("g").defaultPrevented, true, "the first key of a sequence is held back from the page");
  assert.equal(press("x").defaultPrevented, false, "a key that means nothing goes through");
  assert.equal(press("t").defaultPrevented, true);
});

test("keys: a half sequence is dropped by another key, and Shift alone does not break one", () => {
  const { sent, press } = keyboard();
  press("g"); press("x"); press("t");
  assert.deepEqual(sent, ["new"], "gx is nothing; the t after it is a plain t");
  sent.length = 0;
  press("g"); press("Shift"); press("T");
  assert.deepEqual(sent, ["prev"]);
  sent.length = 0;
  press("g"); press("g"); press("t");
  assert.deepEqual(sent, ["next"], "a second g starts over");
});

test("keys: ignored with Ctrl/Alt/Meta, while typing, when paused, and for held keys", () => {
  const k = keyboard();
  k.press("t", { ctrlKey: true });
  k.press("t", { altKey: true });
  k.press("t", { metaKey: true });
  k.press("t", { repeat: true });
  typeInto(k.press, "t", { nodeType: 1, tagName: "INPUT", type: "text" });
  typeInto(k.press, "t", { nodeType: 1, tagName: "TEXTAREA" });
  typeInto(k.press, "t", { nodeType: 1, tagName: "DIV", isContentEditable: true });
  assert.deepEqual(k.sent, []);
  typeInto(k.press, "t", { nodeType: 1, tagName: "INPUT", type: "checkbox", getAttribute: () => null, closest: () => null });
  assert.deepEqual(k.sent, ["new"], "a checkbox is not a place you type");
  const paused = keyboard({ active: false });
  assert.equal(paused.press("t").defaultPrevented, false);
  assert.deepEqual(paused.sent, []);
});
