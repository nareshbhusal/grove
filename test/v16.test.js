import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers.js";
import { pickSuccessor } from "../src/lib/succession.js";

const U = (x) => `https://${x}.test/`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LOOK = 90; // Grove looks a moment after a change (30 ms), then the call returns

async function setup(names = ["a", "b", "c", "d"]) {
  const t = await boot({ seed: names.map((n, i) => ({ url: U(n), active: i === 0 })) });
  t.tab = (n) => t.tabByUrl(U(n));
  t.active = () => t.sim.visible(t.winId).find((x) => x.active);
  // visit: switch to these tabs one after another (as clicking through them), letting Grove look after each
  t.visit = async (...ns) => {
    for (const n of ns) {
      await t.run("tab:activate", { id: t.nodeByUrl(U(n)), windowId: t.winId });
      await wait(LOOK);
    }
  };
  t.closeActive = async () => {
    await t.browser.tabs.remove(t.active().id); // as Ctrl+W: nothing of Grove's is involved in the close itself
    await wait(LOOK);
  };
  await wait(LOOK);
  return t;
}

// ---- the choice itself ----

const tab = (id, o = {}) => ({ id, windowId: 1, index: id, hidden: false, discarded: false, lastAccessed: id, ...o });

test("pickSuccessor: the most recently shown, loaded tab; unloaded ones only when nothing else is", () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4)];
  const seen = new Map([[1, 4], [2, 2], [3, 3], [4, 5]]);
  assert.equal(pickSuccessor(tabs, 4, { seen }).id, 1, "1 was shown last before 4");
  assert.equal(pickSuccessor(tabs, 1, { seen }).id, 4);
  const asleep = tabs.map((x) => (x.id === 1 ? { ...x, discarded: true } : x));
  assert.equal(pickSuccessor(asleep, 4, { seen }).id, 3, "1 is not loaded: the one before it is");
  const allAsleep = tabs.map((x) => (x.id === 4 ? x : { ...x, discarded: true }));
  assert.equal(pickSuccessor(allAsleep, 4, { seen }).id, 1, "nothing loaded: the most recent, so something is shown");
  assert.equal(pickSuccessor([tab(1)], 1), null, "nowhere to go");
});

test("pickSuccessor: shown this session beats lastAccessed; then lastAccessed; then nearness", () => {
  const tabs = [tab(1, { lastAccessed: 900 }), tab(2, { lastAccessed: 100 }), tab(3, { lastAccessed: 500 }), tab(4, { lastAccessed: 1 })];
  assert.equal(pickSuccessor(tabs, 4, { seen: new Map([[2, 1]]) }).id, 2, "a tab shown since Grove started comes first");
  assert.equal(pickSuccessor(tabs, 4).id, 1, "otherwise Firefox's own lastAccessed");
  const same = [tab(1, { lastAccessed: 0, index: 0 }), tab(2, { lastAccessed: 0, index: 1 }), tab(3, { lastAccessed: 0, index: 9 })];
  assert.equal(pickSuccessor(same, 3).id, 2, "nothing to tell them apart: the nearest");
});

test("pickSuccessor: never a hidden tab, another window's tab, or one that is excluded", () => {
  const tabs = [tab(1, { hidden: true }), tab(2, { windowId: 2 }), tab(3), tab(4)];
  assert.equal(pickSuccessor(tabs, 4).id, 3);
  assert.equal(pickSuccessor(tabs, 4, { exclude: [3] }), null);
});

// ---- closing ----

test("closing the tab you are on goes to the one you used before it, and so on back", async () => {
  const t = await setup();
  await t.visit("c", "b", "d");
  await t.closeActive();
  assert.equal(t.active().url, U("b"), "d was reached from b");
  await t.closeActive();
  assert.equal(t.active().url, U("c"));
  await t.closeActive();
  assert.equal(t.active().url, U("a"));
});

test("tabs in that chain that are not loaded are skipped, and stay unloaded", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  await t.run("tab:unload", { id: t.nodeByUrl(U("c")) });
  await wait(LOOK);
  await t.closeActive();
  assert.equal(t.active().url, U("b"), "c is the one used before d, but it is not loaded");
  assert.equal(t.tab("c").discarded, true, "skipping it did not load it");
});

test("what is loaded changes while you are on a tab: the choice follows, without moving you", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  assert.equal(t.tab("d").successorTabId, t.tab("c").id);
  await t.sim.discardTab(t.tab("c").id);
  await wait(LOOK);
  assert.equal(t.tab("d").successorTabId, t.tab("b").id, "c fell asleep");
  assert.equal(t.active().url, U("d"));
  await t.browser.tabs.update(t.tab("c").id, { discarded: false }).catch(() => {});
  await t.browser.tabs.reload(t.tab("c").id);
  await wait(LOOK);
  assert.equal(t.tab("d").successorTabId, t.tab("c").id, "c is awake again");
});

test("when nothing else is loaded the most recent tab is shown anyway", async () => {
  const t = await setup(["a", "b", "c"]);
  await t.visit("b", "c");
  await t.sim.discardTab(t.tab("a").id);
  await t.sim.discardTab(t.tab("b").id);
  await wait(LOOK);
  await t.closeActive();
  assert.equal(t.active().url, U("b"), "the most recent of the unloaded ones");
});

test("a tab that was closed is dropped from the chain", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  await t.browser.tabs.remove(t.tab("c").id);
  await wait(LOOK);
  await t.closeActive();
  assert.equal(t.active().url, U("b"));
});

test("a tab of another panel is not in the chain", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("tree:move", { id: t.nodeByUrl(U("c")), parentId: null, panelId: other });
  await wait(LOOK);
  assert.equal(t.tab("c").hidden, true);
  await t.closeActive();
  assert.equal(t.active().url, U("b"), "c is hidden, so not it");
});

test("the setting turns it off, and Grove takes back what it set", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  assert.notEqual(t.tab("d").successorTabId, -1);
  await t.run("settings:set", { module: "tabs", key: "closeToRecent", value: false });
  await t.visit("a", "d");
  assert.equal(t.tab("d").successorTabId, -1, "Firefox decides again");
  assert.equal(t.tab("a").successorTabId, -1);
});

// ---- unloading the tab you are on ----

test("unloading the tab you are on shows the one you used before it first", async () => {
  const t = await setup();
  await t.visit("b", "c");
  await t.run("tab:unload", { id: t.nodeByUrl(U("c")) });
  await wait(LOOK);
  assert.equal(t.active().url, U("b"));
  assert.equal(t.tab("c").discarded, true);
  assert.equal(t.m.tree.get(t.nodeByUrl(U("c"))).discarded, true);
});

test("unloading the tab you are on skips tabs that are not loaded, like closing does", async () => {
  const t = await setup();
  await t.visit("b", "c", "d");
  await t.sim.discardTab(t.tab("c").id);
  await t.run("tab:unload", { id: t.nodeByUrl(U("d")) });
  assert.equal(t.active().url, U("b"));
  assert.equal(t.tab("c").discarded, true, "still unloaded");
});

test("a tab with no other tab to go to cannot be unloaded", async () => {
  const t = await setup(["a"]);
  await assert.rejects(() => t.run("tab:unload", { id: t.nodeByUrl(U("a")) }), /no other tab/);
  assert.equal(t.tab("a").discarded, false);
});

test("tabs:unload with the tab you are on among them: it goes somewhere that is not being unloaded", async () => {
  const t = await setup();
  await t.visit("b", "c");
  const ids = ["a", "b", "c"].map((n) => t.nodeByUrl(U(n)));
  const r = await t.run("tabs:unload", { ids });
  assert.deepEqual(r, { unloaded: 3, skipped: 0 });
  assert.equal(t.active().url, U("d"), "d is the only one left that is loaded");
  assert.deepEqual(["a", "b", "c"].map((n) => t.tab(n).discarded), [true, true, true]);
});

test("tabs:unload of every tab leaves the one you are on (nowhere to go)", async () => {
  const t = await setup(["a", "b"]);
  const r = await t.run("tabs:unload", { ids: ["a", "b"].map((n) => t.nodeByUrl(U(n))) });
  assert.deepEqual(r, { unloaded: 1, skipped: 1 });
  assert.equal(t.active().url, U("a"));
  assert.equal(t.tab("a").discarded, false);
});
