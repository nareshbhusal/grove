import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, settle, T } from "./helpers.js";

// ---- container rules: one rule per pattern, several panels per rule ----

test("a pattern can only have one rule, however it is written", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const c = await t.run("containers:create", { name: "Work" });
  const id = await t.run("rules:add", { pattern: "github.com", containerId: c });
  await assert.rejects(() => t.run("rules:add", { pattern: "HTTPS://GitHub.com/", containerId: c }), /already a rule for “github.com”/);
  const other = await t.run("rules:add", { pattern: "gitlab.com", containerId: c });
  await assert.rejects(() => t.run("rules:update", { id: other, pattern: "GITHUB.com" }), /already a rule/);
  await t.run("rules:update", { id, pattern: "github.com" }); // keeping its own pattern is fine
  assert.equal(t.ctx.store.get("rules").length, 2);
});

test("one rule can cover several panels; other panels are left alone", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const main = t.panelId;
  const work = await t.run("panel:create", { name: "Work" });
  const home = await t.run("panel:create", { name: "Home" });
  const c = await t.run("containers:create", { name: "Work" });
  await t.run("rules:add", { pattern: "mail.test", panelIds: [work, home], containerId: c });
  const of = async (panelId) => (await t.run("containers:test", { url: "https://mail.test/", panelId })).containerId;
  assert.equal(await of(work), c);
  assert.equal(await of(home), c);
  assert.equal(await of(main), null);
  // unknown panel ids are ignored, and an empty list means any panel
  await t.run("rules:update", { id: t.ctx.store.get("rules")[0].id, panelIds: ["nope"] });
  assert.deepEqual(t.ctx.store.get("rules")[0].panelIds, []);
  assert.equal(await of(main), c);
});

test("rules from older versions are merged into one rule per pattern; nothing is lost silently", async () => {
  const first = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const main = first.panelId;
  const work = await first.run("panel:create", { name: "Work" });
  await first.kernel.stop();
  const old = [
    { id: "r1", pattern: "a.test", panelId: null, containerId: "firefox-container-1" },
    { id: "r2", pattern: "a.test", panelId: work, containerId: "firefox-container-2" }, // conflicts with r1
    { id: "r3", pattern: "b.test", panelId: work, containerId: "firefox-container-1" },
    { id: "r4", pattern: "https://b.test/", panelId: null, containerId: "firefox-container-1" }, // same: any wins
    { id: "r5", pattern: "c.test", panelId: main, containerId: "firefox-container-1" },
    { id: "r6", pattern: "c.test", panelId: work, containerId: "firefox-container-1" },
  ];
  first.sim.storage["grove:v1"].rules = structuredClone(old);

  const second = await boot({ existing: first });
  const rules = second.ctx.store.get("rules");
  const by = (p) => rules.find((r) => r.pattern === p);
  assert.equal(rules.length, 3);
  assert.deepEqual([by("a.test").containerId, by("a.test").panelIds], ["firefox-container-2", [work]], "the rule that used to win is kept");
  assert.deepEqual(by("b.test").panelIds, [], "any panel absorbs the specific one");
  assert.deepEqual([...by("c.test").panelIds].sort(), [main, work].sort());
  assert.deepEqual(second.ctx.store.get("rulesBefore"), old, "the old list is kept");
  const log = await second.run("diag:list", { kind: "route" });
  assert.ok(log.some((e) => e.action === "migrated" && e.url === "a.test"), "the dropped rule is reported");
  await second.kernel.stop();

  // idempotent: a second start changes nothing
  const third = await boot({ existing: first });
  assert.equal(third.ctx.store.get("rules").length, 3);
  assert.deepEqual(third.ctx.store.get("rulesBefore"), old);
});

test("deleting a panel takes it out of rules; a rule only for that panel goes with it", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const main = t.panelId;
  const work = await t.run("panel:create", { name: "Work" });
  await t.run("rules:add", { pattern: "only.test", panelIds: [work], containerId: "firefox-container-1" });
  await t.run("rules:add", { pattern: "both.test", panelIds: [work, main], containerId: "firefox-container-1" });
  await t.run("panel:delete", { id: work });
  const rules = t.ctx.store.get("rules");
  assert.equal(rules.length, 1);
  assert.deepEqual([rules[0].pattern, rules[0].panelIds], ["both.test", [main]]);
});

test("importing rules: same pattern and container widens the panels, a different container keeps yours", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const main = t.panelId;
  const work = await t.run("panel:create", { name: "Work" });
  const c1 = await t.run("containers:create", { name: "One" });
  const c2 = await t.run("containers:create", { name: "Two" });
  await t.run("rules:add", { pattern: "same.test", panelIds: [main], containerId: c1 });
  await t.run("rules:add", { pattern: "clash.test", containerId: c1 });
  const file = {
    grove: 1,
    containers: [{ cookieStoreId: c1, name: "One" }, { cookieStoreId: c2, name: "Two" }],
    panels: [],
    rules: [
      { id: "x1", pattern: "same.test", panelId: work, containerId: c1 },
      { id: "x2", pattern: "clash.test", panelId: null, containerId: c2 },
      { id: "x3", pattern: "new.test", panelId: work, containerId: c2 },
    ],
  };
  const r = await t.run("io:import", { text: JSON.stringify(file), mode: "merge" });
  assert.equal(r.rulesSkipped, 1);
  const rules = t.ctx.store.get("rules");
  assert.deepEqual([...rules.find((x) => x.pattern === "same.test").panelIds].sort(), [main, work].sort());
  assert.equal(rules.find((x) => x.pattern === "clash.test").containerId, c1);
  assert.equal(rules.find((x) => x.pattern === "new.test").containerId, c2);
  assert.equal(rules.length, 3);
});

// ---- links dropped onto the sidebar ----

test("dropped links open as tabs at the drop spot, in order; only the first becomes active, only when you can see it", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }, { url: "https://b.test/" }] });
  const a = t.nodeByUrl("https://a.test/");
  const res = await t.run("tab:openUrls", {
    urls: [{ url: "https://one.test/", title: "One" }, "https://two.test/", { url: "javascript:alert(1)" }, { url: "file:///home/me/report.pdf" }],
    windowId: t.winId, parentId: null, index: 1, panelId: t.panelId,
  });
  await settle();
  assert.deepEqual([res.opened, res.skipped, res.error], [3, 1, null]);
  assert.deepEqual(t.labels(), ["https://a.test/", "https://one.test/", "https://two.test/", "file:///home/me/report.pdf", "https://b.test/"]);
  assert.equal(t.sim.byUrl("https://one.test/")[0].active, true, "first one opened in front of you");
  assert.equal(t.sim.byUrl("https://two.test/")[0].active, false);
  assert.ok(a);
});

test("dropping links into another panel opens them there without leaving your tab", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const other = await t.run("panel:create", { name: "Other" });
  await t.run("panel:switch", { windowId: t.winId, panelId: t.panelId });
  await settle();
  const activeBefore = t.sim.byUrl("https://a.test/")[0].id;
  await t.run("tab:openUrls", { urls: ["https://elsewhere.test/"], windowId: t.winId, parentId: null, index: null, panelId: other });
  await settle();
  const tab = t.sim.byUrl("https://elsewhere.test/")[0];
  assert.equal(t.m.tree.get(t.nodeOf(tab.id)).panelId, other);
  assert.equal(tab.hidden, true, "belongs to a panel you are not looking at");
  assert.equal(t.sim.tabs.get(activeBefore).active, true, "your tab stays active");
  assert.equal(t.view().panelId, t.panelId, "view unchanged");
});

test("dropping a link inside a folder or onto a tab nests it", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  await t.run("tab:openUrls", { urls: ["https://in-folder.test/"], windowId: t.winId, parentId: f, index: 0, panelId: t.panelId });
  const a = t.nodeByUrl("https://a.test/");
  await t.run("tab:openUrls", { urls: ["https://kid.test/"], windowId: t.winId, parentId: a, index: 0, panelId: t.panelId });
  await settle();
  assert.equal(t.m.tree.get(t.nodeByUrl("https://in-folder.test/")).parentId, f);
  assert.equal(t.m.tree.get(t.nodeByUrl("https://kid.test/")).parentId, a);
});

// ---- backups: file names, folder, automatic modes ----

import { mock } from "node:test";
import { cleanFolder, cleanFileName } from "../src/modules/backup.js";

const tick = async (until, tries = 80) => { for (let i = 0; i < tries && !until(); i++) await new Promise((r) => setImmediate(r)); };

test("export names carry date and time, and go into the chosen folder inside Downloads", async () => {
  assert.deepEqual(cleanFolder(" Backups \\ Grove/.. /Tabs? "), ["Backups", "Grove", "Tabs"]);
  assert.deepEqual(cleanFolder("/"), []);

  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const r = await t.run("backup:save", { scope: "all", format: "json" });
  assert.match(r.filename, /^Grove\/grove-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
  const d = t.sim.liveDownloads()[0];
  assert.equal(d.saveAs, false);
  assert.equal(JSON.parse(d.text).grove, 1);

  await t.run("settings:set", { module: "backup", key: "folder", value: "Backups/Grove" });
  assert.match((await t.run("backup:save", { format: "markdown" })).filename, /^Backups\/Grove\/grove-.*\.md$/);
  await t.run("settings:set", { module: "backup", key: "folder", value: "" });
  assert.match((await t.run("backup:save", { format: "html" })).filename, /^grove-[^/]*\.html$/, "empty folder = Downloads itself");

  await t.run("settings:set", { module: "backup", key: "askWhere", value: true });
  await t.run("backup:save", {});
  assert.equal(t.sim.liveDownloads().at(-1).saveAs, true);
  await t.run("backup:save", { saveAs: false });
  assert.equal(t.sim.liveDownloads().at(-1).saveAs, false);
  const names = (await t.run("io:export", { format: "json" })).filename;
  assert.match(names, /_\d{2}-\d{2}-\d{2}\.json$/);
});

test("the up-to-date file keeps ONE file up to date and writes nothing when nothing changed", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await t.m.backup.auto("latest");
  assert.equal(t.sim.liveDownloads().length, 1);
  assert.equal(t.sim.liveDownloads()[0].filename, "Grove/grove-latest.json");
  assert.equal(t.sim.liveDownloads()[0].conflictAction, "overwrite");

  await t.m.backup.auto("latest");
  assert.equal(t.sim.downloads.size, 1, "identical data: no second write");

  await t.run("tab:new", { windowId: t.winId, url: "https://new.test/" });
  await settle();
  await t.m.backup.auto("latest");
  assert.equal(t.sim.downloads.size, 2);
  assert.equal(t.sim.liveDownloads().length, 1, "the file was overwritten, not duplicated");
  assert.ok(t.sim.liveDownloads()[0].text.includes("https://new.test/"));
  const st = await t.run("backup:status");
  assert.equal(st.latestFile, "Grove/grove-latest.json");
  assert.equal(st.lastError, null);
});

test("timestamped copies are saved and timestamped copies and deletes the oldest beyond 'keep'", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("settings:set", { module: "backup", key: "periodic", value: true });
  await t.run("settings:set", { module: "backup", key: "keep", value: 2 });
  for (const url of ["https://one.test/", "https://two.test/", "https://three.test/"]) {
    await t.run("tab:new", { windowId: t.winId, url });
    await settle(30);
    await t.m.backup.auto("periodic");
  }
  const live = t.sim.liveDownloads();
  assert.equal(live.length, 2, "only the last two remain");
  assert.ok(live.at(-1).text.includes("three.test") && !live[0].text.includes("three.test"));
  assert.ok([...t.sim.downloads.values()][0].removed, "the oldest was deleted");
  await t.run("settings:set", { module: "backup", key: "keep", value: 0 });
});

test("note edits count as changes, failures are reported, interrupted downloads too", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const f = await t.run("folder:create", { name: "F", panelId: t.panelId });
  const n = await t.run("note:create", { folderId: f, name: "N" });
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await t.m.backup.auto("latest");
  assert.equal((await t.run("backup:status")).pending, false);
  await t.run("note:save", { id: n, text: "changed text" });
  assert.equal((await t.run("backup:status")).pending, true, "a note edit marks the backup stale");
  await t.m.backup.auto("latest");
  assert.ok(t.sim.liveDownloads()[0].text.includes("changed text"));

  t.sim.downloadFails = "disk full";
  await t.run("note:save", { id: n, text: "again" });
  await t.m.backup.auto("latest");
  assert.match((await t.run("backup:status")).lastError, /disk full/);
  await assert.rejects(() => t.run("backup:save", {}), /disk full/);
  t.sim.downloadFails = null;

  await t.m.backup.auto("latest");
  assert.equal((await t.run("backup:status")).lastError, null, "recovers on the next success");
  const id = [...t.sim.downloads.keys()].at(-1);
  await t.sim.E.dlChanged.dispatch({ id, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
  assert.match((await t.run("backup:status")).lastError, /USER_CANCELED/);
});

test("the up-to-date file waits out the quiet period after a change, then writes once", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    await t.run("settings:set", { module: "backup", key: "quietSeconds", value: 5 });
    await t.run("settings:set", { module: "backup", key: "latest", value: true });
    mock.timers.tick(4000);
    await tick(() => false, 10);
    assert.equal(t.sim.downloads.size, 0, "still waiting");
    mock.timers.tick(1500);
    await tick(() => t.sim.downloads.size > 0);
    assert.equal(t.sim.downloads.size, 1);
  } finally {
    mock.timers.reset();
  }
});

test("latest file and timestamped copies work together; the latest file's name is yours to choose", async () => {
  assert.equal(cleanFileName("my backup"), "my backup.json");
  assert.equal(cleanFileName("tabs.txt"), "tabs.txt");
  assert.equal(cleanFileName("../evil/x:y?.json"), "-evil-xy.json");
  assert.ok(!/[\\/]/.test(cleanFileName("a/b\\c")), "never a path");
  assert.equal(cleanFileName("   "), "grove-latest.json", "empty falls back to the default");

  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await t.run("settings:set", { module: "backup", key: "periodic", value: true });
  await t.run("settings:set", { module: "backup", key: "latestName", value: "my-tabs" });
  await t.m.backup.auto("latest");
  await t.m.backup.auto("periodic");
  const names = [...t.sim.downloads.values()].map((d) => d.filename);
  assert.ok(names.includes("Grove/my-tabs.json"), "the chosen name, with .json added");
  assert.ok(names.some((n) => /^Grove\/grove-\d{4}-.*\.json$/.test(n)), "and a timestamped copy next to it");
  assert.equal(t.sim.downloads.size, 2);

  // a change goes to both; the latest file is overwritten, the copies accumulate
  await t.run("tab:new", { windowId: t.winId, url: "https://more.test/" });
  await settle();
  await t.m.backup.auto("latest");
  await t.m.backup.auto("periodic");
  assert.equal(t.sim.downloads.size, 4);
  const live = t.sim.liveDownloads();
  assert.equal(live.filter((d) => d.filename === "Grove/my-tabs.json").length, 1, "one up-to-date file");
  assert.equal(live.filter((d) => /grove-\d{4}/.test(d.filename)).length, 2, "two timestamped copies");

  // renaming the file counts as a change: it is written again under the new name
  await t.run("settings:set", { module: "backup", key: "latestName", value: "renamed.json" });
  await t.m.backup.auto("latest");
  assert.ok(t.sim.liveDownloads().some((d) => d.filename === "Grove/renamed.json"));
  const st = await t.run("backup:status");
  assert.equal(st.latest && st.periodic, true);
  assert.equal(st.latestFile, "Grove/renamed.json");
  assert.match(st.periodicFile, /grove-\d{4}/);
});

test("one backup failing does not hide or clear the other's problem", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("settings:set", { module: "backup", key: "latest", value: true });
  await t.run("settings:set", { module: "backup", key: "periodic", value: true });
  t.sim.downloadFails = "disk full";
  await t.m.backup.auto("latest");
  t.sim.downloadFails = null;
  await t.m.backup.auto("periodic"); // succeeds, but must not wipe the latest file's error
  assert.match((await t.run("backup:status")).lastError, /disk full/);
  await t.m.backup.auto("latest");
  assert.equal((await t.run("backup:status")).lastError, null);
});

test("the old single 'mode' setting is carried over", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }], storageData: { "grove:v1": { settings: { backup: { mode: "sync", folder: "Old" } } } } });
  const st = await t.run("backup:status");
  assert.equal(st.latest, true);
  assert.equal(st.periodic, false);
  assert.equal(st.folder, "Old");
});
