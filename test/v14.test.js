import test from "node:test";
import assert from "node:assert/strict";
import "../src/content/find.js";
import "../src/content/hints.js";
import "../src/content/keys.js";

const { buildIndex, search, ends } = globalThis.groveFind;
const page = (...parts) => buildIndex(parts.map((p, i) => (typeof p === "string" ? { text: p, block: "p1" } : { text: p[0], block: p[1] })));
const found = (index, q) => search(index, q).map((m) => index.s.slice(m.from, m.to));

// ---- matching ----

test("find: case-insensitive, unless the query has a capital letter", () => {
  const ix = page("Apple apple APPLE");
  assert.equal(search(ix, "apple").length, 3);
  assert.deepEqual(found(ix, "Apple"), ["Apple"]);
  assert.deepEqual(found(ix, "APPLE"), ["APPLE"]);
});

test("find: any run of whitespace, and tag boundaries inside a block, do not get in the way", () => {
  assert.equal(search(page("one\n   two\t three"), "one two three").length, 1);
  assert.equal(search(page("fo", "o ", "bar"), "foo bar").length, 1, "across text nodes");
  assert.equal(search(page("foo", "bar"), "foobar").length, 1, "no space made up inside a block");
  assert.equal(search(page("foo", "bar"), "foo bar").length, 0);
  assert.equal(search(page("a  b"), "a   b").length, 1, "the query is cleaned the same way");
});

test("find: a block boundary reads as a space", () => {
  const ix = page(["Title", "h1"], ["Body text", "p"]);
  assert.equal(search(ix, "title body").length, 1);
  assert.equal(search(page(["Title", "h1"], ["Body", "p"]), "titlebody").length, 0);
});

test("find: matches do not overlap, an empty or blank query finds nothing, a limit holds", () => {
  assert.equal(search(page("aaaa"), "aa").length, 2);
  assert.equal(search(page("abc"), "").length, 0);
  assert.equal(search(page("abc  def"), "   ").length, 0);
  assert.equal(search(page("a ".repeat(50)), "a", 7).length, 7);
});

test("find: a match is reported as the nodes and offsets it starts and ends in", () => {
  const ix = page("hello fo", "o bar");
  const [m] = search(ix, "foo");
  assert.deepEqual(ends(ix, m), { start: [0, 6], end: [1, 1] });
  const spaced = page(["end", "h1"], ["next", "p"]);
  const [g] = search(spaced, "d n");
  assert.deepEqual(ends(spaced, g), { start: [0, 2], end: [1, 1] }, "the space between blocks is not a letter");
});

test("find: letters whose lower case is longer do not shift positions", () => {
  const ix = page("İstanbul and istanbul");
  const hits = search(ix, "istanbul");
  assert.ok(hits.length >= 1);
  for (const h of hits) assert.equal(ix.s.slice(h.from, h.to).length, "istanbul".length);
});

// ---- in the key handler ----

function keyboard({ find, active = true } = {}) {
  const win = new EventTarget();
  win.document = { designMode: "off" };
  const sent = [];
  globalThis.groveVimKeys.install(win, { active: () => active, send: (a) => sent.push(a), find });
  const press = (key, props = {}, type = "keydown") => {
    const e = Object.assign(new Event(type, { cancelable: true }), { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: key !== key.toLowerCase(), repeat: false, ...props });
    win.dispatchEvent(e);
    return e;
  };
  return { sent, press };
}

function fakeFind() {
  const f = { bar: false, marks: 0, opened: 0, steps: [], keys: [], cleared: 0, closed: [], host: {} };
  f.open = () => { f.bar = true; f.opened++; };
  f.running = () => f.bar;
  f.owns = (e) => f.bar && !!e.fromBar; // the real one compares the event's target with the bar's host
  f.key = (e) => f.keys.push(e.key);
  f.step = (d) => { f.steps.push(d); return true; };
  f.active = () => f.marks > 0;
  f.clear = () => { f.cleared++; f.marks = 0; };
  f.close = (wipe) => { f.bar = false; f.closed.push(wipe); };
  return f;
}

test("keys: on a page `/` opens the find bar and is not sent to the sidebar", () => {
  const find = fakeFind();
  const k = keyboard({ find });
  assert.equal(k.press("/").defaultPrevented, true);
  assert.equal(find.opened, 1);
  assert.deepEqual(k.sent, []);
});

test("keys: in the sidebar (no find bar) `/` is still sent on, to Grove's own search", () => {
  const k = keyboard({ find: null });
  k.press("/");
  assert.deepEqual(k.sent, ["search"]);
});

test("keys: n and N step through the matches only while there are some", () => {
  const find = fakeFind();
  const k = keyboard({ find });
  assert.equal(k.press("n").defaultPrevented, false, "nothing searched: the page keeps n");
  find.marks = 3;
  assert.equal(k.press("n").defaultPrevented, true);
  k.press("N");
  assert.deepEqual(find.steps, [1, -1]);
  assert.deepEqual(k.sent, []);
});

test("keys: Esc clears the matches and still reaches the page", () => {
  const find = fakeFind();
  find.marks = 2;
  const k = keyboard({ find });
  const e = k.press("Escape");
  assert.equal(find.cleared, 1);
  assert.equal(e.defaultPrevented, false);
  k.press("Escape");
  assert.equal(find.cleared, 1, "nothing left to clear");
});

test("keys: while the bar is open its keys go to it alone, and vim keys do nothing", () => {
  const find = fakeFind();
  const k = keyboard({ find });
  k.press("/");
  let reachedPage = 0;
  const e1 = k.press("t", { fromBar: true });
  k.press("x", { fromBar: true });
  k.press("Enter", { fromBar: true });
  assert.deepEqual(find.keys, ["t", "x", "Enter"], "the bar got them");
  assert.deepEqual(k.sent, [], "t and x did not open or close a tab");
  assert.equal(e1.defaultPrevented, false, "and the box still types them");
  void reachedPage;
});

test("keys: pausing vim closes the bar and puts the matches away", () => {
  const find = fakeFind();
  let on = true;
  const win = new EventTarget();
  win.document = { designMode: "off" };
  globalThis.groveVimKeys.install(win, { active: () => on, send() {}, find });
  const press = (props = {}) => win.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "a", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, ...props }));
  find.bar = true;
  on = false;
  press({ fromBar: true });
  assert.deepEqual(find.closed, [true]);
});

// ---- bookmarks: several at once ----

import { boot, settle } from "./helpers.js";
const OTHER = "unfiled_____";
const U = (n) => `https://${n}.test/`;
const kids = async (t, root) => (await t.run("bookmarks:tree")).roots.find((r) => r.id === root).children;
const names = (list) => list.map((n) => n.title);

async function marks(list = ["a", "b", "c", "d", "e"]) {
  const t = await boot({ seed: [{ url: U("x"), active: true }] });
  t.sim.seedBookmarks("toolbar_____", list.map((n) => ({ title: n, url: U(n) })));
  t.ids = Object.fromEntries((await kids(t, "toolbar_____")).map((n) => [n.title, n.id]));
  return t;
}

test("move several: they land together, in the order given, before the sibling at the index", async () => {
  const t = await marks();
  const r = await t.run("bookmarks:moveMany", { ids: [t.ids.d, t.ids.b], parentId: "toolbar_____", index: 4 });
  assert.deepEqual(r, { moved: 2, skipped: 0 });
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a", "c", "d", "b", "e"], "before e, d then b as asked");
  await t.run("bookmarks:moveMany", { ids: [t.ids.e, t.ids.a], parentId: "toolbar_____", index: 0 });
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["e", "a", "c", "d", "b"], "to the top");
  await t.run("bookmarks:moveMany", { ids: [t.ids.c, t.ids.e], parentId: "toolbar_____" });
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a", "d", "b", "c", "e"], "no index: the end");
});

test("move several where the target is itself being moved: the next sibling not moving is the place", async () => {
  const t = await marks();
  await t.run("bookmarks:moveMany", { ids: [t.ids.b, t.ids.c], parentId: "toolbar_____", index: 2 });
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a", "b", "c", "d", "e"], "dropped on themselves: nothing changes");
  await t.run("bookmarks:moveMany", { ids: [t.ids.a, t.ids.c], parentId: "toolbar_____", index: 2 });
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["b", "a", "c", "d", "e"], "placed before d: the first one at or after index 2 that is not moving");
});

test("move several into a folder, across folders; a folder cannot go into itself, a built-in cannot move", async () => {
  const t = await marks(["a", "b"]);
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Dir" });
  const sub = await t.run("bookmarks:create", { parentId: dir, title: "Sub" });
  const r = await t.run("bookmarks:moveMany", { ids: [t.ids.a, t.ids.b], parentId: sub });
  assert.equal(r.moved, 2);
  const bad = await t.run("bookmarks:moveMany", { ids: [dir, "toolbar_____", t.ids.a], parentId: sub });
  assert.deepEqual(bad, { moved: 1, skipped: 2 }, "Dir into its own Sub, and a built-in folder, are left; a moves");
  assert.deepEqual(await t.run("bookmarks:moveMany", { ids: [t.ids.a], parentId: "nope" }), { moved: 0, skipped: 1 });
  assert.deepEqual(await t.run("bookmarks:moveMany", { ids: [t.ids.a], parentId: t.ids.b }), { moved: 0, skipped: 1 }, "a bookmark is not a folder");
});

test("delete several, and one undo brings them all back where they were", async () => {
  const t = await marks();
  assert.equal(await t.run("bookmarks:remove", { ids: [t.ids.b, t.ids.d, "toolbar_____"] }), true);
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a", "c", "e"], "the built-in folder stays");
  assert.equal(await t.run("bookmarks:undo"), true);
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a", "b", "c", "d", "e"]);
  assert.equal(await t.run("bookmarks:undo"), false);
});

test("deleting a folder and something inside it removes it once, and undo restores the folder whole", async () => {
  const t = await marks(["a"]);
  const dir = await t.run("bookmarks:create", { parentId: "toolbar_____", title: "Dir" });
  const inner = await t.run("bookmarks:create", { parentId: dir, title: "in", url: U("in") });
  assert.equal(await t.run("bookmarks:remove", { ids: [inner, dir] }), true);
  assert.deepEqual(names(await kids(t, "toolbar_____")), ["a"]);
  await t.run("bookmarks:undo");
  const back = await kids(t, "toolbar_____");
  assert.deepEqual(names(back), ["a", "Dir"]);
  assert.deepEqual(names(back[1].children), ["in"]);
  assert.equal(await t.run("bookmarks:remove", { ids: ["toolbar_____", "nope"] }), false, "nothing deletable: false, and nothing to undo");
});
