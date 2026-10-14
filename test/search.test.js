import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, searchView, highlight, matches, fold } from "../src/lib/search.js";

let n = 0;
const node = (type, o) => ({ id: `n${++n}`, type, order: 0, panelId: "p1", parentId: null, collapsed: false, ...o });
const tab = (title, url, o = {}) => node("tab", { title, url, ...o });
const folder = (name, o = {}) => node("folder", { name, ...o });
const index = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const order = (list) => list.forEach((x, i) => (x.order = i));

test("the query: AND, plain spaces, quotes and accents", () => {
  assert.deepEqual(parseQuery("github AND pull"), ["github", "pull"]);
  assert.deepEqual(parseQuery("github and  pull"), ["github", "pull"], "AND in any case, any spacing");
  assert.deepEqual(parseQuery('github "pull request"'), ["github", "pull request"]);
  assert.deepEqual(parseQuery('"and"'), ["and"], "quoted, it is the word");
  assert.deepEqual(parseQuery("AND"), []);
  assert.deepEqual(parseQuery("  AND   AND "), []);
  assert.deepEqual(parseQuery('"never closed'), ["never", "closed"]);
  assert.deepEqual(parseQuery("CAFÉ"), ["cafe"]);
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery(null), []);
});

test("every term must match; title and address are searched together", () => {
  const t = tab("Pull request #12 · acme/grove", "https://github.com/acme/grove/pull/12");
  assert.ok(matches(t, parseQuery("github AND pull")), "github is only in the address, pull in both");
  assert.ok(matches(t, parseQuery("GITHUB")));
  assert.ok(matches(t, parseQuery('"pull request"')));
  assert.ok(!matches(t, parseQuery('"request pull"')), "a quoted phrase keeps its order");
  assert.ok(matches(t, parseQuery("request pull")), "unquoted words match in any order");
  assert.ok(!matches(t, parseQuery("github AND gitlab")));
  assert.ok(!matches(t, []), "nothing to look for matches nothing");
  assert.ok(matches(tab("x", "https://a.test/caf%C3%A9"), parseQuery("café")), "encoded addresses are read");
  assert.ok(matches(tab("Résumé", "https://a.test/"), parseQuery("resume")), "accents ignored");
  assert.ok(matches(tab("Auto title", "https://a.test/", { customTitle: "My name for it" }), parseQuery("name AND auto")), "a title you gave it counts, and so does the page's");
});

test("a folder is searched by name, a note by name, and neither by an address it does not have", () => {
  assert.ok(matches(folder("Research"), parseQuery("research")));
  assert.ok(matches(node("note", { name: "Reading list", parentId: "x" }), parseQuery("list")));
  assert.ok(!matches(folder("Research"), parseQuery("undefined")));
});

// Main: a(github) , Research/(b, Papers/(c), d-collapsed branch with child e) ; Work panel: w
function world() {
  n = 0;
  const a = tab("grove repo", "https://github.com/acme/grove");
  const research = folder("Research");
  const b = tab("Trees", "https://en.wikipedia.org/wiki/Tree", { parentId: research.id });
  const papers = folder("Papers", { parentId: research.id });
  const c = tab("Attention is all you need", "https://arxiv.org/abs/1706.03762", { parentId: papers.id });
  const d = tab("Tree survey", "https://example.org/survey", { parentId: research.id, collapsed: true });
  const e = tab("Tree survey appendix", "https://example.org/survey/appendix", { parentId: d.id });
  const w = tab("Jira grove board", "https://jira.example.com/grove", { panelId: "p2" });
  const pinned = tab("Pinned grove", "https://grove.test/", { pinned: true });
  order([a, research, pinned]); order([b, papers, d]); order([c]); order([e]);
  return { nodes: index([a, research, b, papers, c, d, e, w, pinned]), a, research, b, papers, c, d, e, w };
}

test("searching a panel covers that panel only, in tree order, collapsed branches included, pinned tabs excluded", () => {
  const W = world();
  const r = searchView(W.nodes, { panelId: "p1", folderId: null }, "tree");
  assert.deepEqual(r.results.map((x) => x.node.id), [W.b.id, W.d.id, W.e.id], "inside the collapsed branch too");
  const g = searchView(W.nodes, { panelId: "p1", folderId: null }, "grove");
  assert.deepEqual(g.results.map((x) => x.node.id), [W.a.id], "not the other panel's tab, not the pinned one");
  assert.deepEqual(searchView(W.nodes, { panelId: "p2", folderId: null }, "grove").results.map((x) => x.node.id), [W.w.id]);
});

test("searching an open folder covers its subfolders and nothing outside it", () => {
  const W = world();
  const view = { panelId: "p1", folderId: W.research.id };
  assert.deepEqual(searchView(W.nodes, view, "attention").results.map((x) => x.node.id), [W.c.id], "two levels down");
  assert.deepEqual(searchView(W.nodes, view, "github").results, [], "the tab outside the folder is not a result");
  assert.deepEqual(searchView(W.nodes, view, "papers").results.map((x) => x.node.id), [W.papers.id], "a subfolder can be found by name");
  const sub = searchView(W.nodes, { panelId: "p1", folderId: W.papers.id }, "tree");
  assert.deepEqual(sub.results, [], "inside Papers there is no Tree");
});

test("each result says where it is: its folders inside the scope, else its site", () => {
  const W = world();
  const inPanel = searchView(W.nodes, { panelId: "p1", folderId: null }, "attention").results[0];
  assert.equal(inPanel.where, "Research › Papers");
  const inFolder = searchView(W.nodes, { panelId: "p1", folderId: W.research.id }, "attention").results[0];
  assert.equal(inFolder.where, "Papers", "relative to the folder you are in");
  const loose = searchView(W.nodes, { panelId: "p1", folderId: null }, "grove repo").results[0];
  assert.equal(loose.where, "github.com");
  const underTab = searchView(W.nodes, { panelId: "p1", folderId: null }, "appendix").results[0];
  assert.equal(underTab.where, "Research", "a tab under a tab: the folder it is in, not the parent tab");
});

test("an empty or operator-only query finds nothing and says it has no terms", () => {
  const W = world();
  for (const q of ["", "   ", "AND", null]) {
    const r = searchView(W.nodes, { panelId: "p1", folderId: null }, q);
    assert.equal(r.terms.length, 0);
    assert.equal(r.results.length, 0);
  }
});

test("highlight marks what matched, in the original text, through accents", () => {
  const parts = highlight("Pull request #12 · Café", parseQuery("pull cafe"));
  assert.deepEqual(parts, [{ text: "Pull", hit: true }, { text: " request #12 · ", hit: false }, { text: "Café", hit: true }]);
  assert.deepEqual(highlight("aaa", parseQuery("aa")).map((p) => p.text).join(""), "aaa", "the text is never lost");
  assert.deepEqual(highlight("nothing here", parseQuery("zzz")), [{ text: "nothing here", hit: false }]);
  assert.deepEqual(highlight("", parseQuery("a")), []);
  assert.deepEqual(highlight("İstanbul", parseQuery("istanbul")).map((p) => p.text).join(""), "İstanbul");
  assert.equal(fold("Straße").s.length > 0, true);
});
