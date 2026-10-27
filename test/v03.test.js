import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot, settle } from "./helpers.js";
import { MANIFEST_PERMISSIONS } from "./fake-browser.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest asks for the cookies permission (Firefox refuses cookieStoreId without it)", () => {
  assert.ok(manifest.permissions.includes("cookies"));
  assert.ok(manifest.permissions.includes("contextualIdentities"));
});

test("reopen in a container works end to end and keeps the node", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const cid = await t.run("containers:create", { name: "Work" });
  const old = t.tabByUrl("https://b.test/");
  const nodeId = t.nodeOf(old.id);
  assert.equal(await t.run("containers:reopen", { id: nodeId, cookieStoreId: cid }), true);
  await settle();
  const fresh = t.sim.byUrl("https://b.test/");
  assert.equal(fresh.length, 1, "old tab replaced, not duplicated");
  assert.equal(fresh[0].cookieStoreId, cid);
  assert.equal(t.nodeOf(fresh[0].id), nodeId, "same node");
  assert.equal(t.m.tree.get(nodeId).containerLocked, true);
});

test("the fake browser really rejects cookieStoreId without the permission", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const cid = await t.run("containers:create", { name: "X" });
  await t.browser.tabs.create({ cookieStoreId: cid }); // allowed: manifest has cookies
  const i = MANIFEST_PERMISSIONS.indexOf("cookies");
  MANIFEST_PERMISSIONS.splice(i, 1);
  try {
    await assert.rejects(() => t.browser.tabs.create({ cookieStoreId: cid }), /No permission for cookieStoreId/);
    await assert.rejects(() => t.run("containers:reopen", { id: t.nodeByUrl("https://a.test/"), cookieStoreId: cid }), /No permission for cookieStoreId/);
  } finally {
    MANIFEST_PERMISSIONS.splice(i, 0, "cookies");
  }
});

const restartWith = async (t, discardedUrls) => {
  await t.kernel.stop();
  for (const url of discardedUrls) t.sim.tabs.get(t.sim.byUrl(url)[0].id).discarded = true; // Firefox restores lazily
  return boot({ existing: t });
};

test("restart: tabs that were loaded are loaded again, tabs you unloaded stay unloaded", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }, { url: "https://c.test/" }] });
  await first.run("tab:unload", { id: first.nodeByUrl("https://c.test/") });
  assert.equal(first.m.tree.get(first.nodeByUrl("https://c.test/")).wasLoaded, false);

  const second = await restartWith(first, ["https://b.test/", "https://c.test/"]);
  await settle(700);
  assert.equal(second.tabByUrl("https://b.test/").discarded, false, "b was loaded before: woken");
  assert.equal(second.tabByUrl("https://c.test/").discarded, true, "c was unloaded by you: left alone");
  assert.ok(second.sim.reloads.includes(second.tabByUrl("https://b.test/").id));
  assert.ok(!second.sim.reloads.includes(second.tabByUrl("https://c.test/").id));
});

test("restart: falls back to navigating when reload does not wake the tab", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  first.sim.reloadDoesNotWake = true;
  const second = await restartWith(first, ["https://b.test/"]);
  second.sim.reloadDoesNotWake = true;
  await settle(900);
  assert.equal(second.tabByUrl("https://b.test/").discarded, false);
});

test("restart: the setting can turn restoring off", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  await first.run("settings:set", { module: "tabs", key: "restoreLoaded", value: false });
  const second = await restartWith(first, ["https://b.test/"]);
  await settle(500);
  assert.equal(second.tabByUrl("https://b.test/").discarded, true);
  assert.equal(second.sim.reloads.length, 0);
});

test("unloaded state reaches the node; a tab alone in its window cannot be unloaded (nowhere to go)", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const a = t.nodeByUrl("https://a.test/");
  const b = t.nodeByUrl("https://b.test/");
  await t.run("tab:unload", { id: b });
  await settle();
  assert.equal(t.m.tree.get(b).discarded, true);
  await t.run("tab:load", { id: b });
  assert.equal(t.m.tree.get(b).discarded, false);
  await t.run("tab:close", { id: b });
  await settle();
  await assert.rejects(() => t.run("tab:unload", { id: a }), /no other tab/);
  assert.equal(t.m.tree.get(a).discarded, false);
});

test("a tab in a split view is flagged (read-only, Firefox 149+)", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const tab = t.tabByUrl("https://b.test/");
  t.sim.tabs.get(tab.id).splitViewId = 7;
  await t.sim.E.tabUpdated.dispatch(tab.id, { splitViewId: 7 }, { ...t.sim.tabs.get(tab.id) });
  await settle();
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).split, true);
});
