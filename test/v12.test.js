import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";
import "../src/content/hints.js";
import "../src/content/keys.js";

const U = (n) => `https://${n}.test/`;
const active = (t) => [...t.sim.tabs.values()].find((x) => x.windowId === t.winId && x.active);

async function setup(urls = ["a", "b"], { enable = true } = {}) {
  const t = await boot({ seed: urls.map((n, i) => ({ url: U(n), active: i === 0 })) });
  if (enable) await t.run("settings:set", { module: "vim", key: "enabled", value: true });
  Object.assign(t.m.vim.guard, { same: 0, newAfterSequence: 0 });
  t.key = (n, action, extra = {}) => t.sim.fromPage(t.tabByUrl(U(n)).id, { type: "vim:key", action, ...extra });
  t.tab = (n) => t.tabByUrl(U(n));
  return t;
}

// ---- r ----

test("r reloads the tab it was pressed in; from the sidebar, the active one", async () => {
  const t = await setup(["a", "b"]);
  await t.key("b", "reload");
  assert.deepEqual(t.sim.reloads, [t.tab("b").id]);
  await t.run("vim:do", { action: "reload", windowId: t.winId });
  assert.deepEqual(t.sim.reloads.at(-1), t.tab("a").id);
});

// ---- x never closes the window ----

test("x on the last tab opens a new one instead of closing the window", async () => {
  const t = await setup(["a"]);
  assert.equal(await t.key("a", "close"), true);
  await settle(100);
  const left = [...t.sim.tabs.values()].filter((x) => x.windowId === t.winId);
  assert.equal(left.length, 1, "the window still has a tab");
  assert.equal(left[0].url, "about:newtab");
  assert.equal(t.sim.byUrl(U("a")).length, 0, "and the old one is gone");
  assert.ok(t.sim.wins.has(t.winId), "the window is open");
});

test("x on a tab that is already empty does nothing when it is the last", async () => {
  const t = await setup(["a"]);
  await t.key("a", "close");
  await settle(100);
  const blank = [...t.sim.tabs.values()].find((x) => x.url === "about:newtab");
  const r = await t.sim.fromPage(blank.id, { type: "vim:key", action: "close" });
  assert.equal(r, false);
  assert.equal([...t.sim.tabs.values()].length, 1);
});

test("x with other tabs open just closes the tab", async () => {
  const t = await setup(["a", "b"]);
  await t.key("b", "close");
  await settle(100);
  assert.equal([...t.sim.tabs.values()].length, 1);
  assert.equal([...t.sim.tabs.values()][0].url, U("a"));
});

test("x on the last visible tab, with others hidden in another panel, keeps a tab in this panel", async () => {
  const t = await setup(["a", "b"]);
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("tree:move", { id: t.nodeByUrl(U("b")), parentId: null, panelId: other });
  await settle();
  await t.key("a", "close");
  await settle(150);
  const shown = t.sim.visible(t.winId);
  assert.equal(shown.length, 1, "one tab is showing");
  assert.equal(shown[0].url, "about:newtab");
  assert.equal(t.m.tree.get(t.nodeOf(shown[0].id)).panelId, t.panelId, "in the panel you were in");
});

// ---- / ----

test("/ tells an open sidebar to open its search", async () => {
  const t = await setup(["a"]);
  const ui = t.sim.connectUi({ windowId: t.winId });
  await settle();
  assert.equal(await t.key("a", "search"), true);
  assert.ok(ui.received.some((m) => m.type === "search"));
  assert.equal(t.sim.sidebarOpens, 0, "no need to open it");
});

test("/ with the sidebar closed opens it, and the search opens as soon as it connects", async () => {
  const t = await setup(["a"]);
  let ui;
  t.sim.onSidebarOpen = () => setTimeout(() => { ui = t.sim.connectUi({ windowId: t.winId }); }, 5);
  assert.equal(await t.key("a", "search"), true);
  await settle(50);
  assert.equal(t.sim.sidebarOpens, 1);
  assert.ok(ui.received.some((m) => m.type === "search"), "the new sidebar was asked to search");
  const states = ui.received.findIndex((m) => m.type === "state");
  assert.ok(states >= 0 && states < ui.received.findIndex((m) => m.type === "search"), "after it has its state");
});

test("/ when Firefox will not open the sidebar says no, and a later sidebar is not surprised by it", async () => {
  const t = await setup(["a"]);
  t.sim.sidebarRefuses = true;
  assert.equal(await t.key("a", "search"), false);
  t.sim.sidebarRefuses = false;
  const ui = t.sim.connectUi({ windowId: t.winId });
  await settle();
  assert.ok(!ui.received.some((m) => m.type === "search"));
});

test("/ in one window does not open the search in another window's sidebar", async () => {
  const t = await setup(["a"]);
  const other = t.sim.addWindow();
  const mine = t.sim.connectUi({ windowId: t.winId });
  const theirs = t.sim.connectUi({ windowId: other.id });
  await settle();
  await t.key("a", "search");
  assert.ok(mine.received.some((m) => m.type === "search"));
  assert.ok(!theirs.received.some((m) => m.type === "search"));
});

// ---- f: opening a hinted link ----

test("Shift + a link's label opens it as a child, behind, in the same container", async () => {
  const t = await setup(["a", "b"]);
  const work = await t.run("containers:create", { name: "Work" });
  await t.browser.tabs.remove(t.tab("b").id);
  const tab = await t.browser.tabs.create({ windowId: t.winId, url: U("w"), cookieStoreId: work, active: true });
  await settle();
  const r = await t.sim.fromPage(tab.id, { type: "vim:hint", url: "https://link.test/page" });
  assert.equal(r, true);
  await settle(100);
  const kid = [...t.sim.tabs.values()].find((x) => x.url === "https://link.test/page");
  assert.ok(kid);
  assert.equal(kid.cookieStoreId, work, "stays in the container of the page");
  assert.equal(kid.active, false, "opens behind");
  assert.equal(t.m.tree.get(t.nodeOf(kid.id)).parentId, t.nodeOf(tab.id), "as a child of the page's tab");
});

test("a hinted link comes to the front when the setting says so", async () => {
  const t = await setup(["a"]);
  await t.run("settings:set", { module: "vim", key: "hintForeground", value: true });
  await t.sim.fromPage(t.tab("a").id, { type: "vim:hint", url: "https://link.test/x" });
  await settle(100);
  assert.equal(active(t).url, "https://link.test/x");
});

test("hinted links must be web addresses, and the feature can be switched off", async () => {
  const t = await setup(["a"]);
  const before = t.sim.tabs.size;
  for (const url of ["javascript:alert(1)", "about:config", "data:text/html,hi", "", null]) {
    assert.equal(await t.sim.fromPage(t.tab("a").id, { type: "vim:hint", url }), false, String(url));
  }
  await t.run("settings:set", { module: "vim", key: "hints", value: false });
  assert.equal(await t.sim.fromPage(t.tab("a").id, { type: "vim:hint", url: "https://link.test/" }), false);
  assert.equal(await t.sim.fromPage(t.tab("a").id, { type: "vim:config" }).then((c) => c.hints), false, "pages are told");
  await settle(50);
  assert.equal(t.sim.tabs.size, before);
});

test("a paused vim, or an excepted site, opens nothing", async () => {
  const t = await setup(["a"]);
  await t.run("settings:set", { module: "vim", key: "exceptions", value: "a.test" });
  assert.equal(await t.sim.fromPage(t.tab("a").id, { type: "vim:hint", url: "https://link.test/" }), false);
});

// ---- the labels ----

test("labels are as short as they can be and none starts another", () => {
  const { labels, DEFAULT_CHARS } = globalThis.groveHints;
  for (const n of [0, 1, 5, 19, 20, 100, 361, 362, 600]) {
    const set = labels(n, [...DEFAULT_CHARS]);
    assert.equal(set.length, n);
    assert.equal(new Set(set).size, n, `${n} labels are all different`);
    for (const a of set) for (const b of set) if (a !== b) assert.ok(!b.startsWith(a), `${a} starts ${b}`);
    assert.ok(Math.max(0, ...set.map((l) => l.length)) <= (n <= 19 ? 1 : n <= 361 ? 2 : 3));
  }
  assert.equal(labels(3, [..."asdf"]).join(), "a,s,d");
});

test("the letters for labels are cleaned up: letters only, no repeats, at least four", () => {
  const { alphabet, DEFAULT_CHARS } = globalThis.groveHints;
  assert.deepEqual(alphabet("ASDF aa 12"), ["a", "s", "d", "f"]);
  assert.deepEqual(alphabet("ab"), [...DEFAULT_CHARS], "too few: the default");
  assert.deepEqual(alphabet(""), [...DEFAULT_CHARS]);
});

// ---- f, in the key handler ----

function keyboard({ active = true, hinting = true, hints = null } = {}) {
  const win = new EventTarget();
  win.document = { designMode: "off" };
  const sent = [];
  globalThis.groveVimKeys.install(win, { active: () => active, send: (a) => sent.push(a), hints, hinting: () => hinting });
  const press = (key, props = {}, type = "keydown") => {
    const e = Object.assign(new Event(type, { cancelable: true }), { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: key !== key.toLowerCase(), repeat: false, ...props });
    win.dispatchEvent(e);
    return e;
  };
  return { sent, press };
}

function fakeHints() {
  const h = { on: false, started: 0, keys: [], stopped: 0 };
  h.running = () => h.on;
  h.start = () => { h.on = true; h.started++; };
  h.stop = () => { h.on = false; h.stopped++; };
  h.key = (e) => { e.preventDefault(); h.keys.push(e.key); if (e.key === "Escape") h.on = false; return true; };
  return h;
}

test("keys: r and / are sent, f starts the hints and sends nothing", () => {
  const hints = fakeHints();
  const k = keyboard({ hints });
  assert.equal(k.press("r").defaultPrevented, true);
  assert.equal(k.press("/").defaultPrevented, true);
  assert.equal(k.press("f").defaultPrevented, true);
  assert.deepEqual(k.sent, ["reload", "search"]);
  assert.equal(hints.started, 1);
});

test("keys: while hints are showing they get every key, and the page and the other keys get none", () => {
  const hints = fakeHints();
  const k = keyboard({ hints });
  k.press("f");
  const a = k.press("t");
  k.press("g");
  k.press("t");
  assert.equal(a.defaultPrevented, true);
  assert.deepEqual(hints.keys, ["t", "g", "t"], "all went to the hints");
  assert.deepEqual(k.sent, [], "t did not open a tab, gt did not switch");
  assert.equal(k.press("t", {}, "keypress").defaultPrevented, true, "the rest of a taken press is swallowed");
  k.press("Escape");
  k.press("t", {}, "keyup");
  k.press("t");
  assert.deepEqual(k.sent, ["new"], "keys are the vim keys again once the hints are gone");
});

test("keys: f does nothing when hints are off, paused, or there is no hint controller (the sidebar)", () => {
  const hints = fakeHints();
  assert.equal(keyboard({ hints, hinting: false }).press("f").defaultPrevented, false);
  assert.equal(keyboard({ hints, active: false }).press("f").defaultPrevented, false);
  assert.equal(keyboard({ hints: null }).press("f").defaultPrevented, false);
  assert.equal(hints.started, 0);
});

test("keys: pausing while hints are showing puts them away", () => {
  const hints = fakeHints();
  let active = true;
  const win = new EventTarget();
  win.document = { designMode: "off" };
  globalThis.groveVimKeys.install(win, { active: () => active, send() {}, hints, hinting: () => true });
  const press = (key) => win.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false }));
  press("f");
  active = false;
  press("a");
  assert.equal(hints.stopped, 1);
});
