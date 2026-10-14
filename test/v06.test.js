import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, settle } from "./helpers.js";
import { readLinks } from "../src/sidebar/ui/external-drop.js";

const SEARCH = (q) => `https://search.test/?q=${encodeURIComponent(q)}`;
const dt = (data, files = 0) => ({ getData: (t) => data[t] ?? "", files: { length: files }, types: Object.keys(data) });

// ---- dropped text ----

test("dropped text with no link is a search; links still win; files are not text", () => {
  assert.deepEqual(readLinks(dt({ "text/plain": "  how do   tree tabs\nwork? " })).text, "how do tree tabs work?");
  assert.deepEqual(readLinks(dt({ "text/plain": "https://a.test/x" })).links, [{ url: "https://a.test/x" }]);
  assert.equal(readLinks(dt({ "text/plain": "https://a.test/x" })).text, "", "a link is opened, not searched");
  assert.equal(readLinks(dt({ "text/plain": "see https://a.test/x for details" })).links.length, 0, "a sentence containing a link is text");
  assert.equal(readLinks(dt({ "text/plain": "see https://a.test/x for details" })).text, "see https://a.test/x for details");
  assert.equal(readLinks(dt({ "text/plain": "report.pdf" }, 1)).text, "", "a dragged file is not a search");
  assert.equal(readLinks(dt({})).text, "");
});

test("tab:search opens the search in the background at the drop place", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const before = [...t.sim.tabs.values()].find((x) => x.active).id;
  const f = await t.run("folder:create", { name: "Research", panelId: t.panelId });

  const r = await t.run("tab:search", { text: "  tree  style tabs\nfor firefox ", windowId: t.winId, parentId: f, index: null, panelId: t.panelId });
  assert.deepEqual(r, { opened: 1, error: null });
  await settle();
  const url = SEARCH("tree style tabs for firefox");
  assert.equal(t.sim.byUrl(url).length, 1, "whitespace collapsed, query encoded");
  assert.deepEqual(t.sim.searches.at(-1).query, "tree style tabs for firefox");
  assert.equal(t.m.tree.get(t.nodeByUrl(url)).parentId, f, "inside the folder it was dropped on");
  assert.equal([...t.sim.tabs.values()].find((x) => x.active).id, before, "the tab you were on is still the active one");
  assert.equal(t.sim.byUrl(url)[0].active, false);
});

test("a search dropped on another panel stays there and does not switch panels", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const other = await t.run("panel:create", { name: "Reading" });
  const here = t.view().panelId;
  await t.run("tab:search", { text: "ocean tides", windowId: t.winId, panelId: other });
  await settle();
  const node = t.m.tree.get(t.nodeByUrl(SEARCH("ocean tides")));
  assert.equal(node.panelId, other);
  assert.equal(t.view().panelId, here, "still looking at the same panel");
  assert.equal(t.sim.byUrl(SEARCH("ocean tides"))[0].active, false);
});

test("tab:search says what went wrong instead of failing silently", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  assert.deepEqual(await t.run("tab:search", { text: "   ", windowId: t.winId }), { opened: 0, error: null });
  const long = await t.run("tab:search", { text: "x".repeat(1500), windowId: t.winId });
  assert.equal(long.opened, 0);
  assert.match(long.error, /too long/);
  assert.equal(t.sim.searches.length, 0);
  t.browser.search = undefined;
  assert.match((await t.run("tab:search", { text: "hello", windowId: t.winId })).error, /does not let extensions run a search/);
});

test("a failed search does not leave an empty tab behind", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const count = t.sim.tabs.size;
  const real = t.browser.search.search;
  t.browser.search.search = async () => { throw new Error("engine missing"); };
  const r = await t.run("tab:search", { text: "hello", windowId: t.winId });
  assert.match(r.error, /engine missing/);
  await settle();
  assert.equal(t.sim.tabs.size, count);
  t.browser.search.search = real;
});

// ---- panel containers ----

test("tabs Grove opens in a panel start in the panel's container, searches included", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });

  await t.run("tab:new", { windowId: t.winId, url: "https://new.test/" });
  await t.run("tab:openUrls", { urls: ["https://one.test/", "https://two.test/"], windowId: t.winId });
  await t.run("tab:search", { text: "container test", windowId: t.winId });
  await settle(120);
  for (const url of ["https://new.test/", "https://one.test/", "https://two.test/", SEARCH("container test")]) {
    assert.equal(t.sim.byUrl(url)[0].cookieStoreId, work, url);
  }
  assert.equal(t.sim.byUrl("https://a.test/")[0].cookieStoreId, "firefox-default", "tabs that already existed are not moved");
});

test("a rule for the address beats the panel's container for tabs Grove opens", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  const media = await t.run("containers:create", { name: "Media" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.run("rules:add", { pattern: "video.test", containerId: media });
  await t.run("tab:openUrls", { urls: ["https://video.test/watch"], windowId: t.winId });
  await settle(120);
  assert.equal(t.sim.byUrl("https://video.test/watch")[0].cookieStoreId, media);
  assert.equal(t.sim.tabs.size, 2, "opened once, in the right place, not opened twice");
});

test("a search whose engine has a container rule ends up in that container", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  const searchC = await t.run("containers:create", { name: "Search" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.run("rules:add", { pattern: "search.test", containerId: searchC });
  await t.run("tab:search", { text: "rule wins", windowId: t.winId });
  await settle(200);
  const tab = t.sim.byUrl(SEARCH("rule wins"))[0];
  assert.equal(tab.cookieStoreId, searchC);
  assert.equal(tab.active, false, "still in the background after being rerouted");
});

test("a deleted panel container does not stop tabs from opening", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const gone = await t.run("containers:create", { name: "Gone" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: gone });
  await t.run("containers:remove", { cookieStoreId: gone });
  await t.run("tab:new", { windowId: t.winId, url: "https://still.test/" });
  await settle(100);
  assert.equal(t.sim.byUrl("https://still.test/")[0].cookieStoreId, "firefox-default");
});

test("Ctrl+T in a panel with no container is left alone; so is a link opened from a page", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.sim.userNewTab();
  await settle(100);
  const blank = [...t.sim.tabs.values()].find((x) => x.url === "about:newtab");
  assert.equal(blank.cookieStoreId, "firefox-default");

  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  const opener = t.sim.byUrl("https://a.test/")[0];
  const link = await t.sim.openFrom(opener.id, "https://linked.test/");
  await settle(100);
  assert.ok(t.sim.tabs.has(link.id), "a tab that is already loading something is not swapped for an empty one");
  assert.equal(t.sim.byUrl("https://linked.test/").length, 1);
});

test("with enforcement off, panel containers are not applied to new tabs", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const work = await t.run("containers:create", { name: "Work" });
  await t.run("panel:update", { id: t.panelId, defaultContainer: work });
  await t.run("settings:set", { module: "containers", key: "enforce", value: false });
  await t.run("tab:new", { windowId: t.winId, url: "https://off.test/" });
  await t.sim.userNewTab();
  await settle(100);
  assert.equal(t.sim.byUrl("https://off.test/")[0].cookieStoreId, "firefox-default");
  assert.equal([...t.sim.tabs.values()].find((x) => x.url === "about:newtab").cookieStoreId, "firefox-default");
});

// ---- diagnostics switch ----

test("diagnostics can be switched off and on", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("diag:clear");
  await t.run("tab:new", { windowId: t.winId, url: "https://one.test/" });
  await settle();
  const recorded = (await t.run("diag:list")).length;
  assert.ok(recorded > 0, "on by default");

  await t.run("settings:set", { module: "diagnostics", key: "enabled", value: false });
  await t.run("tab:new", { windowId: t.winId, url: "https://two.test/" });
  await settle();
  assert.equal((await t.run("diag:list")).length, recorded, "nothing new while off");

  await t.run("settings:set", { module: "diagnostics", key: "enabled", value: true });
  await t.run("tab:new", { windowId: t.winId, url: "https://three.test/" });
  await settle();
  assert.ok((await t.run("diag:list")).length > recorded);
});

// ---- the package ----

const python = spawnSync("python3", ["--version"]);
test("scripts/make-xpi.py builds a package Firefox can install, using nothing but Python", { skip: python.status !== 0 && "python3 not installed" }, () => {
  const out = mkdtempSync(join(tmpdir(), "grove-xpi-"));
  try {
    const run = spawnSync("python3", ["-I", new URL("../scripts/make-xpi.py", import.meta.url).pathname, "--out", out], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const check = spawnSync("python3", ["-I", "-c", `
import zipfile, json, glob, sys
(path,) = glob.glob(sys.argv[1] + "/grove-*.xpi")
z = zipfile.ZipFile(path)
names = z.namelist()
assert names[0] == "manifest.json", names[:3]
assert not [n for n in names if n.startswith(("test/", "scripts/", "node_modules/", "grove/"))], "stray files"
m = json.loads(z.read("manifest.json"))
for f in (m["background"]["page"], m["sidebar_action"]["default_panel"], m["options_ui"]["page"], *m["icons"].values()):
    assert f in names, f
print(m["version"])
`, out], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
