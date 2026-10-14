import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, settle, T } from "./helpers.js";

// ---- import keeps every panel's tabs in that panel ----

// panel name -> the tabs/folders under it, as a flat list of labels (depth shown by dashes)
const byPanel = (t) => {
  const out = {};
  for (const p of t.m.panels.list()) {
    const lines = [];
    const walk = (list, d) => list.forEach((n) => { lines.push(`${"-".repeat(d)}${n.type === "tab" ? n.url : n.name}`); walk(n.children, d + 1); });
    walk(T.toNested(t.m.tree.all(), p.id), 0);
    out[p.name] = lines;
  }
  return out;
};

async function threePanels({ names = ["Main", "Work", "Reading"] } = {}) {
  const t = await boot({ seed: [{ url: "https://main-1.test/", active: true }, { url: "https://main-2.test/" }] });
  t.m.panels.list()[0].name = names[0];
  const second = await t.run("panel:create", { name: names[1] });
  const third = await t.run("panel:create", { name: names[2] });
  await t.run("panel:update", { id: t.panelId, name: names[0] });
  const f = await t.run("folder:create", { name: "Docs", panelId: second });
  await t.run("tab:openUrls", { urls: ["https://work-1.test/", "https://work-2.test/"], windowId: t.winId, parentId: f, panelId: second });
  await t.run("tab:openUrls", { urls: ["https://read-1.test/"], windowId: t.winId, panelId: third });
  await settle(120);
  // saved tabs only: the point is the file, not live tabs
  return { t, ids: { first: t.panelId, second, third } };
}

test("a three-panel export imported into a fresh profile puts every tab in its own panel", async () => {
  const { t: src } = await threePanels();
  const exported = await src.run("io:export", { scope: "all", format: "json" });
  const want = byPanel(src);
  assert.equal(want.Work.length, 3, "folder plus its two tabs");
  assert.deepEqual(want.Reading, ["https://read-1.test/"]);

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  const r = await dst.run("io:import", { text: exported.text, mode: "merge" });
  assert.equal(r.panels, 3);
  assert.equal(r.panelsCreated, 2, "Main already existed here; Work and Reading are new");
  const got = byPanel(dst);
  assert.deepEqual(Object.keys(got).sort(), ["Main", "Reading", "Work"]);
  assert.deepEqual(got.Work, want.Work);
  assert.deepEqual(got.Reading, want.Reading);
  assert.deepEqual(got.Main.filter((l) => !l.includes("existing.test")), want.Main);
  assert.ok(!got.Main.some((l) => /work-|read-/.test(l)), "nothing from the other panels in the first one");
});

test("two panels that share a name stay two panels", async () => {
  const { t: src } = await threePanels({ names: ["Main", "New panel", "New panel"] });
  const exported = await src.run("io:export", { scope: "all", format: "json" });
  const file = JSON.parse(exported.text);
  assert.deepEqual(file.panels.map((p) => p.name), ["Main", "New panel", "New panel"]);

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  await dst.run("io:import", { text: exported.text, mode: "merge" });
  const panels = dst.m.panels.list();
  assert.equal(panels.length, 3, "not merged into one");
  const lists = panels.filter((p) => p.name === "New panel").map((p) => T.toNested(dst.m.tree.all(), p.id).length);
  assert.deepEqual(lists.sort(), [1, 1].sort(), "each has its own top-level item (a folder, a tab)");
  const reading = panels.filter((p) => p.name === "New panel").find((p) => JSON.stringify(T.toNested(dst.m.tree.all(), p.id)).includes("read-1"));
  assert.ok(reading && !JSON.stringify(T.toNested(dst.m.tree.all(), reading.id)).includes("work-"));
});

test("importing into the same profile twice adds to each panel and never crosses panels", async () => {
  const { t } = await threePanels();
  const exported = await t.run("io:export", { scope: "all", format: "json" });
  const before = byPanel(t);
  await t.run("io:import", { text: exported.text, mode: "merge" });
  await t.run("io:import", { text: exported.text, mode: "merge" });
  const after = byPanel(t);
  assert.equal(t.m.panels.list().length, 3, "no new panels: same ids");
  for (const name of Object.keys(before)) {
    const urls = before[name].filter((l) => l.startsWith("https"));
    assert.equal(after[name].filter((l) => l.startsWith("https")).length, urls.length * 3, name);
    for (const other of Object.keys(before)) {
      if (other === name) continue;
      for (const u of before[other].filter((l) => l.startsWith("https"))) assert.ok(!after[name].includes(u), `${u} leaked into ${name}`);
    }
  }
});

test("a panel that was renamed since the export is still matched by id", async () => {
  const { t, ids } = await threePanels();
  const exported = await t.run("io:export", { scope: "all", format: "json" });
  await t.run("panel:update", { id: ids.second, name: "Renamed" });
  await t.run("io:import", { text: exported.text, mode: "merge" });
  assert.equal(t.m.panels.list().length, 3, "no extra 'Work' panel");
  assert.equal(byPanel(t).Renamed.filter((l) => l.includes("work-1")).length, 2);
});

test("replace mode into another profile: panels, folders and notes land where they were", async () => {
  const { t: src, ids } = await threePanels();
  const folder = Object.values(src.m.tree.all()).find((n) => n.type === "folder");
  const note = await src.run("note:create", { folderId: folder.id, name: "N" });
  await src.run("note:save", { id: note, name: "N", text: "kept" });
  const exported = await src.run("io:export", { scope: "all", format: "json" });

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  await dst.run("panel:create", { name: "Work" }); // exists here with a different id
  const stale = await dst.run("folder:create", { name: "Old stuff", panelId: dst.panelId });
  assert.ok(stale);
  await dst.run("io:import", { text: exported.text, mode: "replace" });
  const got = byPanel(dst);
  assert.ok(!JSON.stringify(got).includes("Old stuff"), "replace cleared what was saved");
  assert.equal(dst.m.panels.list().filter((p) => p.name === "Work").length, 1, "matched by name, not duplicated");
  assert.ok(got.Work.includes("Docs") && got.Work.includes("-https://work-1.test/"));
  assert.ok(!got.Main.some((l) => /work-|read-/.test(l)));
  const n = Object.values(dst.m.tree.all()).find((x) => x.type === "note");
  assert.equal(dst.m.tree.get(n.parentId).name, "Docs");
  assert.equal((await dst.run("note:get", { id: n.id })).text, "kept");
});

test("a file with damaged parts imports the rest and changes nothing when it is unusable", async () => {
  const { t: src } = await threePanels();
  const file = JSON.parse((await src.run("io:export", { scope: "all", format: "json" })).text);

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  const damaged = { ...file, panels: [null, 42, "x", ...file.panels, { name: "No tree" }], rules: [null, ...(file.rules ?? [])] };
  const r = await dst.run("io:import", { text: JSON.stringify(damaged), mode: "merge" });
  assert.equal(r.unreadable, 3, "three entries that are not panels are skipped and counted");
  assert.deepEqual(Object.keys(byPanel(dst)).sort(), ["Main", "No tree", "Reading", "Work"]);

  // Unusable files are refused before anything is touched, including in replace mode.
  const before = JSON.stringify([dst.m.panels.list(), dst.m.tree.all()]);
  for (const bad of ["{ nope", JSON.stringify({ hello: 1 }), JSON.stringify({ grove: 1 }), JSON.stringify({ grove: 99, panels: [] })]) {
    await assert.rejects(() => dst.run("io:import", { text: bad, mode: "replace" }));
  }
  assert.equal(JSON.stringify([dst.m.panels.list(), dst.m.tree.all()]), before);
});

test("panels in the file get clean names and colours; rules follow panels to where they went", async () => {
  const { t: src, ids } = await threePanels({ names: ["Main", "Work", "Work"] });
  await src.run("rules:add", { pattern: "a.test", panelIds: [ids.second], containerId: "firefox-default" });
  await src.run("rules:add", { pattern: "b.test", panelIds: [ids.third], containerId: "firefox-default" });
  const file = JSON.parse((await src.run("io:export", { scope: "all", format: "json" })).text);
  file.panels[1].color = "javascript:alert(1)";
  file.panels[2].name = "   ";

  const dst = await boot({ seed: [{ url: "https://existing.test/", active: true }] });
  await dst.run("io:import", { text: JSON.stringify(file), mode: "merge" });
  const list = dst.m.panels.list();
  assert.equal(list.length, 3);
  assert.match(list[1].color, /^#[0-9a-f]{3,8}$/i);
  assert.equal(list[2].name, "Imported");
  const rules = dst.ctx.store.get("rules");
  const first = rules.find((r) => r.pattern === "a.test");
  const second = rules.find((r) => r.pattern === "b.test");
  assert.deepEqual(first.panelIds, [list[1].id]);
  assert.deepEqual(second.panelIds, [list[2].id], "each rule follows ITS panel even though two panels shared a name");
});
