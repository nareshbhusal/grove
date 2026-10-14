import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/lib/tree.js";
import { findRule, resolveContainer, compilePattern } from "../src/lib/rules.js";
import { sortModules } from "../src/core/kernel.js";
import { Hooks } from "../src/core/hooks.js";
import { EventBus } from "../src/core/events.js";

const quiet = { error() {}, warn() {}, debug() {}, info() {} };

function make(spec) {
  // spec: [id, parentId|null, panelId?]
  const nodes = {};
  for (const [id, parentId, panelId = "p1"] of spec) {
    T.addNode(nodes, { id, type: "tab", panelId, collapsed: false }, { parentId });
  }
  return nodes;
}
const ids = (nodes, parentId, panelId = "p1") => T.childrenOf(nodes, parentId, panelId).map((n) => n.id);

test("addNode appends and children inherit the parent's panel", () => {
  const n = make([["a", null], ["b", null], ["c", "a", "other"]]);
  assert.deepEqual(ids(n, null), ["a", "b"]);
  assert.equal(n.c.panelId, "p1");
  assert.deepEqual(ids(n, "a"), ["c"]);
});

test("moveNode reorders within the same list (index is pre-removal)", () => {
  const n = make([["a", null], ["b", null], ["c", null]]);
  T.moveNode(n, "a", { parentId: null, index: 3 }); // after c
  assert.deepEqual(ids(n, null), ["b", "c", "a"]);
  T.moveNode(n, "a", { parentId: null, index: 0 });
  assert.deepEqual(ids(n, null), ["a", "b", "c"]);
  T.moveNode(n, "a", { parentId: null, index: 1 }); // dropping just after itself is a no-op
  assert.deepEqual(ids(n, null), ["a", "b", "c"]);
});

test("moveNode nests, and refuses to move a node into its own subtree", () => {
  const n = make([["a", null], ["b", "a"], ["c", "b"]]);
  assert.equal(T.moveNode(n, "a", { parentId: "c" }), false);
  assert.equal(T.moveNode(n, "a", { parentId: "a" }), false);
  assert.equal(T.moveNode(n, "c", { parentId: "a", index: 0 }), true);
  assert.deepEqual(ids(n, "a"), ["c", "b"]);
});

test("moving to another panel carries the whole subtree", () => {
  const n = make([["a", null], ["b", "a"], ["c", "b"], ["x", null]]);
  T.moveNode(n, "a", { parentId: null, panelId: "p2" });
  assert.equal(n.a.panelId, "p2");
  assert.equal(n.b.panelId, "p2");
  assert.equal(n.c.panelId, "p2");
  assert.deepEqual(ids(n, null, "p1"), ["x"]);
  assert.deepEqual(ids(n, null, "p2"), ["a"]);
});

test("removeNode promote keeps children in place; subtree removes all", () => {
  const n = make([["a", null], ["b", "a"], ["c", "a"], ["d", null]]);
  T.removeNode(n, "a", { mode: "promote" });
  assert.deepEqual(ids(n, null), ["b", "c", "d"]);
  const m = make([["a", null], ["b", "a"], ["c", "b"], ["d", null]]);
  const gone = T.removeNode(m, "a", { mode: "subtree" });
  assert.deepEqual(gone.sort(), ["a", "b", "c"]);
  assert.deepEqual(ids(m, null), ["d"]);
});

test("flatten hides collapsed subtrees and reports depth", () => {
  const n = make([["a", null], ["b", "a"], ["c", null]]);
  assert.deepEqual(T.flatten(n, "p1").map((r) => [r.node.id, r.depth]), [["a", 0], ["b", 1], ["c", 0]]);
  n.a.collapsed = true;
  assert.deepEqual(T.flatten(n, "p1").map((r) => r.node.id), ["a", "c"]);
});

test("resolveDrop: before / after / inside, and after an expanded parent means first child", () => {
  const n = make([["a", null], ["b", "a"], ["c", null]]);
  assert.deepEqual(T.resolveDrop(n, "c", "before"), { parentId: null, index: 1, panelId: "p1" });
  assert.deepEqual(T.resolveDrop(n, "c", "after"), { parentId: null, index: 2, panelId: "p1" });
  assert.deepEqual(T.resolveDrop(n, "c", "inside"), { parentId: "c", index: 0, panelId: "p1" });
  assert.deepEqual(T.resolveDrop(n, "a", "after"), { parentId: "a", index: 0, panelId: "p1" });
  n.a.collapsed = true;
  assert.deepEqual(T.resolveDrop(n, "a", "after"), { parentId: null, index: 1, panelId: "p1" });
});

test("dragging a node after its own previous sibling lands correctly", () => {
  const n = make([["a", null], ["b", null], ["c", null]]);
  const spot = T.resolveDrop(n, "a", "after"); // drop c right after a
  T.moveNode(n, "c", spot);
  assert.deepEqual(ids(n, null), ["a", "c", "b"]);
});

test("nested round trip (export/import form)", () => {
  const n = make([["a", null], ["b", "a"], ["c", null]]);
  n.a.url = "https://a.test";
  const forest = T.toNested(n, "p1", (x) => ({ ...x }));
  assert.equal(forest[0].children[0].url, undefined);
  let k = 0;
  const rebuilt = T.fromNested(forest, "p9", () => `n${k++}`);
  const out = T.flatten(rebuilt, "p9").map((r) => [r.node.url ?? null, r.depth]);
  assert.deepEqual(out, [["https://a.test", 0], [null, 1], [null, 0]]);
});

test("rule patterns", () => {
  const m = (pat, url) => {
    const f = compilePattern(pat);
    return f(url, new URL(url).hostname);
  };
  assert.ok(m("github.com", "https://github.com/x"));
  assert.ok(m("github.com", "https://gist.github.com/x"));
  assert.ok(!m("github.com", "https://notgithub.com/"));
  assert.ok(m("=github.com", "https://github.com/"));
  assert.ok(!m("=github.com", "https://gist.github.com/"));
  assert.ok(m("*.github.com", "https://gist.github.com/"));
  assert.ok(!m("*.github.com", "https://github.com/"));
  assert.ok(m("/\\/pull\\/\\d+/", "https://github.com/a/b/pull/12"));
  assert.equal(compilePattern("/(/"), null);
});

test("panel-scoped rules beat global ones; panel default is the fallback", () => {
  const rules = [
    { id: "1", pattern: "example.com", panelId: null, containerId: "global" },
    { id: "2", pattern: "example.com", panelId: "work", containerId: "scoped" },
  ];
  assert.equal(findRule(rules, "https://example.com/", "work").containerId, "scoped");
  assert.equal(findRule(rules, "https://example.com/", "fun").containerId, "global");
  const panels = [{ id: "work", defaultContainer: "wc" }, { id: "fun", defaultContainer: null }];
  assert.equal(resolveContainer({ rules, panels }, "https://other.test/", "work"), "wc");
  assert.equal(resolveContainer({ rules, panels }, "https://other.test/", "fun"), null);
});

test("module ordering, missing deps and cycles", () => {
  const m = (name, deps) => ({ name, deps, setup() {} });
  assert.deepEqual(sortModules([m("c", ["b"]), m("b", ["a"]), m("a")]).map((x) => x.name), ["a", "b", "c"]);
  assert.throws(() => sortModules([m("a", ["zzz"])]), /missing module/);
  assert.throws(() => sortModules([m("a", ["b"]), m("b", ["a"])]), /Circular/);
});

test("hooks run in priority order and survive a throwing tap", async () => {
  const h = new Hooks(quiet);
  h.tap("x", (v) => v + "B", { priority: 20 });
  h.tap("x", (v) => v + "A", { priority: 10 });
  h.tap("x", () => { throw new Error("boom"); }, { priority: 15 });
  assert.equal(await h.run("x", ""), "AB");
});

test("a failing event listener does not stop the others", async () => {
  const bus = new EventBus(quiet);
  let hit = 0;
  bus.on("e", () => { throw new Error("x"); });
  bus.on("e", () => { hit++; });
  await bus.emit("e", {});
  assert.equal(hit, 1);
});

// ---- containment rules, views, repair -------------------------------------

function mk(spec) {
  // spec: [id, type, parentId|null, panelId?]
  const nodes = {};
  for (const [id, type, parentId, panelId = "p1"] of spec) {
    const n = T.addNode(nodes, { id, type, panelId, collapsed: false }, { parentId });
    assert.ok(n, `could not add ${id}`);
  }
  return nodes;
}

test("containment: folders hold anything, tabs only tabs, notes only live in folders", () => {
  const f = { type: "folder" }, t = { type: "tab" }, n = { type: "note" };
  assert.ok(T.canContain(null, f) && T.canContain(null, t));
  assert.ok(!T.canContain(null, n), "no notes at the panel root");
  assert.ok(T.canContain(f, f) && T.canContain(f, t) && T.canContain(f, n));
  assert.ok(T.canContain(t, t));
  assert.ok(!T.canContain(t, f), "tabs cannot hold folders");
  assert.ok(!T.canContain(t, n), "tabs cannot hold notes");
  assert.ok(!T.canContain(n, t) && !T.canContain(n, n), "notes are leaves");
});

test("addNode and moveNode refuse illegal placements", () => {
  const nodes = mk([["F", "folder", null], ["t", "tab", null], ["note", "note", "F"]]);
  assert.equal(T.addNode(nodes, { id: "x", type: "note", panelId: "p1" }, { parentId: null }), null);
  assert.equal(T.addNode(nodes, { id: "y", type: "folder", panelId: "p1" }, { parentId: "t" }), null);
  assert.ok(!nodes.x && !nodes.y);
  assert.equal(T.moveNode(nodes, "F", { parentId: "t" }), false);
  assert.equal(T.moveNode(nodes, "note", { parentId: null }), false);
  assert.equal(T.moveNode(nodes, "t", { parentId: "F" }), true);
  assert.deepEqual(ids(nodes, "F"), ["note", "t"]);
});

test("placeAfter puts a sibling after the anchor's subtree, climbing out of tabs for folders", () => {
  const nodes = mk([["a", "tab", null], ["b", "tab", "a"], ["c", "tab", "b"], ["d", "tab", null]]);
  assert.deepEqual(T.placeAfter(nodes, "b", { type: "tab" }), { parentId: "a", index: 1, panelId: "p1" });
  // a folder cannot be a sibling of a nested tab: it steps out to after the top-level tab
  assert.deepEqual(T.placeAfter(nodes, "c", { type: "folder" }), { parentId: null, index: 1, panelId: "p1" });
  assert.equal(T.placeAfter(nodes, "c", { type: "note" }), null, "no folder anywhere above");
});

test("inView and flatten from a folder root", () => {
  const nodes = mk([["F", "folder", null], ["a", "tab", "F"], ["G", "folder", "F"], ["b", "tab", "G"], ["z", "tab", null], ["o", "tab", null, "p2"]]);
  const view = { panelId: "p1", folderId: "F" };
  assert.ok(T.inView(nodes, nodes.a, view) && T.inView(nodes, nodes.b, view));
  assert.ok(!T.inView(nodes, nodes.z, view), "outside the folder");
  assert.ok(!T.inView(nodes, nodes.o, view), "other panel");
  assert.ok(T.inView(nodes, nodes.z, { panelId: "p1", folderId: null }));
  assert.deepEqual(T.flatten(nodes, "p1", "F").map((r) => [r.node.id, r.depth]), [["a", 0], ["G", 0], ["b", 1]]);
});

test("dropAllowed rejects illegal and cyclic drops", () => {
  const nodes = mk([["F", "folder", null], ["t", "tab", null], ["u", "tab", "t"], ["n", "note", "F"]]);
  assert.ok(!T.dropAllowed(nodes, "F", { parentId: "t" }), "folder into tab");
  assert.ok(!T.dropAllowed(nodes, "n", { parentId: null }), "note to root");
  assert.ok(!T.dropAllowed(nodes, "t", { parentId: "u" }), "into own subtree");
  assert.ok(T.dropAllowed(nodes, "u", { parentId: "F" }));
  assert.ok(T.dropAllowed(nodes, "n", { parentId: "F" }));
});

test("promote refuses when it would strand notes at the root; allowed inside another folder", () => {
  const nodes = mk([["F", "folder", null], ["n", "note", "F"], ["G", "folder", null], ["H", "folder", "G"], ["m", "note", "H"]]);
  assert.deepEqual(T.removeNode(nodes, "F", { mode: "promote" }), []);
  assert.ok(nodes.F && nodes.n);
  assert.deepEqual(T.removeNode(nodes, "H", { mode: "promote" }), ["H"]);
  assert.equal(nodes.m.parentId, "G");
});

test("normalize repairs data from older versions", () => {
  // v0.1 allowed a folder inside a tab, a dangling parent, and a child in another panel
  const nodes = {
    a: { id: "a", type: "tab", panelId: "p1", parentId: null, order: 0 },
    F: { id: "F", type: "folder", panelId: "p1", parentId: "a", order: 0 },
    c: { id: "c", type: "tab", panelId: "p1", parentId: "F", order: 0 },
    lost: { id: "lost", type: "tab", panelId: "p1", parentId: "gone", order: 1 },
    x: { id: "x", type: "tab", panelId: "p9", parentId: "a", order: 1 },
  };
  assert.ok(T.normalize(nodes) > 0);
  assert.equal(nodes.F.parentId, null, "folder stepped out of the tab");
  assert.equal(nodes.c.parentId, "F", "its contents stay with it");
  assert.equal(nodes.lost.parentId, null);
  assert.equal(nodes.x.panelId, "p1", "child follows its parent's panel");
  assert.equal(T.normalize(nodes), 0, "second pass changes nothing");
});
