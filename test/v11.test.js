import test from "node:test";
import assert from "node:assert/strict";
import { boot, settle } from "./helpers.js";
import { hoverLines, tooltipText, previewable, previewMode } from "../src/lib/hover.js";

const U = (n) => `https://${n}.test/`;

// ---- what the hover text says ----

test("hover text: address by default, title, or both; never the same text twice", () => {
  const tab = { type: "tab", url: "https://a.test/page", title: "A page" };
  assert.equal(tooltipText(tab, "url", "A page"), "https://a.test/page");
  assert.equal(tooltipText(tab, "title", "A page"), "A page");
  assert.equal(tooltipText(tab, "both", "A page"), "A page\nhttps://a.test/page");
  assert.equal(tooltipText(tab, undefined, "A page"), "https://a.test/page", "unknown setting = address, as before");
  assert.equal(tooltipText({ type: "tab", url: "https://a.test/" }, "both", "https://a.test/"), "https://a.test/", "no title: the address once");
  assert.equal(tooltipText({ type: "tab", url: "" }, "url", "New tab"), "New tab", "no address: the title");
  assert.equal(tooltipText(tab, "url", "A page", "Not loaded yet.\n"), "Not loaded yet.\nhttps://a.test/page", "notes come first");
  assert.equal(tooltipText({ type: "folder", name: "Research" }, "both", "Research"), "Research");
  assert.deepEqual(hoverLines(tab, "both", "A page").map((l) => l.kind), ["title", "url"]);
});

test("only real pages have previews; the setting reads as off unless it says otherwise", () => {
  assert.equal(previewable({ type: "tab", url: "https://a.test/" }), true);
  assert.equal(previewable({ type: "tab", url: "file:///x.pdf" }), true);
  assert.equal(previewable({ type: "tab", url: "about:newtab" }), false);
  assert.equal(previewable({ type: "folder", url: "https://a.test/" }), false);
  assert.equal(previewMode({}), "off");
  assert.equal(previewMode({ preview: "bogus" }), "off");
  assert.equal(previewMode({ preview: "favicon" }), "favicon");
});

// ---- pictures ----

async function setup(preview = "row") {
  const t = await boot({ seed: [{ url: U("a"), active: true }, { url: U("b") }] });
  if (preview) await t.run("settings:set", { module: "hover", key: "preview", value: preview });
  await settle();
  t.tab = (n) => t.tabByUrl(U(n));
  t.thumb = (n, windowId = t.winId) => t.run("thumb:get", { id: t.nodeByUrl(U(n)), windowId });
  return t;
}

test("settings: tooltip shows the address, the preview is off, until changed", async () => {
  const t = await boot({ seed: [{ url: U("a"), active: true }] });
  assert.equal(t.m.settings.get("hover", "tooltip"), "url");
  assert.equal(t.m.settings.get("hover", "preview"), "off");
  assert.equal(t.m.settings.get("hover", "previewWidth"), 260);
  await t.run("settings:set", { module: "hover", key: "previewWidth", value: 5000 });
  assert.equal(t.m.settings.get("hover", "previewWidth"), 600, "clamped");
  assert.equal(await t.m.hover.capture(t.tabByUrl(U("a")).id), false, "off: nothing is captured");
  assert.equal(t.sim.captures.length, 0);
});

test("the tab in front is captured, scaled to the preview size, and served to the sidebar", async () => {
  const t = await setup();
  assert.equal(await t.m.hover.capture(t.tab("a").id), true);
  const c = t.sim.captures.at(-1);
  assert.equal(c.format, "jpeg");
  assert.equal(c.scale, 640 / 1200, "scaled down to the largest preview, not the screen's pixel density");
  const got = await t.thumb("a");
  assert.match(got.dataUrl, /^data:image\/jpeg/);
  assert.ok(Math.abs(got.ratio - 800 / 1200) < 1e-9);
  assert.equal(await t.thumb("b"), null, "a tab never visited has no picture yet");
});

test("a tab that is not in front, not loaded, or not a page is not captured", async () => {
  const t = await setup();
  assert.equal(await t.m.hover.capture(t.tab("b").id), false, "Firefox draws only the tab in front");
  await t.sim.discardTab(t.tab("a").id);
  assert.equal(await t.m.hover.capture(t.tab("a").id), false);
  const t2 = await setup();
  const blank = await t2.browser.tabs.create({ windowId: t2.winId, url: "about:newtab" });
  await settle();
  assert.equal(await t2.m.hover.capture(blank.id), false);
  t2.sim.captureFails = true;
  assert.equal(await t2.m.hover.capture(t2.tab("a").id), false, "a refused capture is not an error");
});

test("pictures are taken on their own: a moment after a page loads, and when you arrive on a tab", async () => {
  const t = await setup();
  const id = t.tab("a").id;
  await t.sim.E.tabUpdated.dispatch(id, { status: "complete" }, { ...t.sim.tabs.get(id), status: "complete" });
  await settle(1300);
  assert.ok(await t.thumb("a"), "after load");
  await t.browser.tabs.update(t.tab("b").id, { active: true });
  await settle(1000);
  assert.ok(await t.thumb("b"), "on arrival");
});

test("a picture of a page the tab has left is not shown", async () => {
  const t = await setup();
  const id = t.tab("a").id;
  const node = t.nodeOf(id);
  await t.m.hover.capture(id);
  assert.ok(await t.run("thumb:get", { id: node, windowId: t.winId }));
  t.sim.tabs.get(id).url = U("elsewhere");
  await t.sim.E.tabUpdated.dispatch(id, { url: U("elsewhere") }, { ...t.sim.tabs.get(id) });
  await settle();
  assert.equal(await t.run("thumb:get", { id: node, windowId: t.winId }), null);
});

test("closing a tab, or switching the preview off, lets go of its picture", async () => {
  const t = await setup();
  await t.m.hover.capture(t.tab("a").id);
  assert.equal(t.m.hover.thumbCount(), 1);
  await t.run("settings:set", { module: "hover", key: "preview", value: "off" });
  await settle();
  assert.equal(t.m.hover.thumbCount(), 0);
  assert.equal(await t.thumb("a"), null);
  await t.run("settings:set", { module: "hover", key: "preview", value: "favicon" });
  await settle(500);
  assert.ok(await t.thumb("a"), "switching it on takes the picture of the tab in front");
  await t.run("tab:close", { id: t.nodeByUrl(U("a")), mode: "self" });
  await settle();
  assert.equal(t.m.hover.thumbCount(), 0);
});

test("pictures never reach storage; a private tab's picture goes only to private windows", async () => {
  const t = await setup();
  const pw = t.sim.addWindow({ incognito: true });
  await settle();
  const p = await t.browser.tabs.create({ windowId: pw.id, url: "https://secret.test/p" });
  await settle();
  assert.equal(await t.m.hover.capture(p.id), true);
  await t.m.hover.capture(t.tab("a").id);
  await t.ctx.store.flush();
  const stored = JSON.stringify(t.sim.storage);
  assert.ok(!stored.includes("PIC-") && !stored.includes("data:image"), "nothing of a picture is saved");
  const pn = t.nodeOf(p.id);
  assert.ok(await t.run("thumb:get", { id: pn, windowId: pw.id }), "the private window sees it");
  assert.equal(await t.run("thumb:get", { id: pn, windowId: t.winId }), null, "a normal window does not");
  assert.equal(await t.run("thumb:get", { id: pn, windowId: null }), null);
  assert.equal(await t.run("thumb:get", { id: t.nodeByUrl(U("a")), windowId: pw.id }), null, "nor the other way round");
  const out = await t.run("io:export", { scope: "all" });
  assert.ok(!out.text.includes("PIC-"));
});

test("only the most recent pictures are kept", async () => {
  const t = await boot({ seed: [{ url: U("a"), active: true }] });
  await t.run("settings:set", { module: "hover", key: "preview", value: "row" });
  const ids = [];
  for (let i = 0; i < 160; i++) {
    const tab = await t.browser.tabs.create({ windowId: t.winId, url: `https://many${i}.test/` });
    ids.push(tab.id);
    await t.m.hover.capture(tab.id);
  }
  assert.equal(t.m.hover.thumbCount(), 150);
  assert.equal(await t.run("thumb:get", { id: t.nodeOf(ids[0]), windowId: t.winId }), null, "the oldest went");
  assert.ok(await t.run("thumb:get", { id: t.nodeOf(ids.at(-1)), windowId: t.winId }));
});
