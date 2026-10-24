import test from "node:test";
import assert from "node:assert/strict";
import "../src/content/overlay.js";
import "../src/content/hints.js";
import "../src/content/keys.js";

const { canMove, DIRECTION } = globalThis.groveVimKeys;

// ---- which box scrolls ----

test("canMove: a box that is at its end hands over, one that has room goes on", () => {
  const box = (top) => ({ top, view: 600, total: 2000 });
  assert.equal(canMove(box(0), 1), true);
  assert.equal(canMove(box(0), -1), false, "at the top, up has nowhere to go");
  assert.equal(canMove(box(700), 1), true);
  assert.equal(canMove(box(700), -1), true);
  assert.equal(canMove(box(1400), 1), false, "at the bottom, down has nowhere to go");
  assert.equal(canMove(box(1399.5), 1), false, "fractional positions at the very end count as the end");
  assert.equal(canMove(box(1400), -1), true);
});

test("canMove: a box that does not overflow cannot move either way", () => {
  const flat = { top: 0, view: 600, total: 600 };
  assert.equal(canMove(flat, 1), false);
  assert.equal(canMove(flat, -1), false);
  assert.equal(canMove(flat, 0), false);
  assert.equal(canMove({ top: 0, view: 600, total: 900 }, 0), true);
});

test("every scroll action has a direction", () => {
  assert.deepEqual(
    Object.fromEntries(["scrollDown", "pageDown", "bottom", "scrollUp", "pageUp", "top"].map((a) => [a, DIRECTION[a]])),
    { scrollDown: 1, pageDown: 1, bottom: 1, scrollUp: -1, pageUp: -1, top: -1 },
  );
});

// ---- the overlay's holder ----

function fakeDocument() {
  const made = [];
  return {
    made,
    createElement(tag) {
      const el = {
        tag,
        props: {},
        style: { setProperty: (name, value, priority) => { el.props[name] = [value, priority]; } },
        attachShadow(init) { el.shadowInit = init; return { nodes: [], append(...n) { this.nodes.push(...n); } }; },
      };
      made.push(el);
      return el;
    },
    documentElement: { children: [], append(...n) { this.children.push(...n); } },
  };
}

test("overlay: the holder is not a custom element and cannot be restyled by the page", () => {
  const doc = fakeDocument();
  const { host, shadow } = globalThis.groveOverlay.create(doc, ".x { color: red; }");
  assert.equal(host.tag, "div", "a hyphenated name would be hidden by `:not(:defined)` rules, and other unknown names cannot hold a shadow root");
  assert.equal(host.shadowInit.mode, "closed");
  assert.equal(shadow.nodes[0].textContent.includes(".x { color: red; }"), true);
  // what makes it visible and in place is set inline and !important, which outranks any page rule
  for (const [name, value] of [["visibility", "visible"], ["display", "block"], ["opacity", "1"], ["position", "fixed"], ["pointer-events", "none"]]) {
    assert.deepEqual(host.props[name], [value, "important"], name);
  }
  assert.equal(Object.values(host.props).every(([, priority]) => priority === "important"), true);
});

test("overlay: mount puts the holder in the page", () => {
  const doc = fakeDocument();
  const { host } = globalThis.groveOverlay.create(doc);
  globalThis.groveOverlay.mount(doc, host);
  assert.deepEqual(doc.documentElement.children, [host]);
});

// ---- what `f` can see: elements inside shadow trees ----

// A tiny node: parent in the same tree, or a shadow root whose host is the next hop up.
const node = (name, parent = null, root = null) => ({
  name,
  parentElement: parent,
  getRootNode: () => root ?? { host: null },
});

test("hints: within() looks through shadow boundaries, which Node.contains does not", () => {
  const { within } = globalThis.groveHints;
  const page = node("page");
  const host = node("host", page);
  const shadowRoot = { host };
  const frame = node("frame", null, shadowRoot); // top of the shadow tree
  const button = node("button", frame, shadowRoot);
  assert.equal(within(host, button), true, "a button inside a component is inside the component");
  assert.equal(within(page, button), true);
  assert.equal(within(button, host), false);
  assert.equal(within(button, button), true);
  assert.equal(within(node("other"), button), false);
});

test("hints: deepHit() asks each shadow tree in turn, since elementFromPoint stops at the first host", () => {
  const { deepHit } = globalThis.groveHints;
  const button = { name: "button" };
  const innerHost = { name: "inner", shadowRoot: { elementFromPoint: () => button } };
  const host = { name: "host", shadowRoot: { elementFromPoint: () => innerHost } };
  const doc = { elementFromPoint: () => host };
  assert.equal(deepHit(doc, 5, 5), button);
  const plain = { name: "plain" };
  assert.equal(deepHit({ elementFromPoint: () => plain }, 5, 5), plain);
  assert.equal(deepHit({ elementFromPoint: () => null }, 5, 5), null);
  const same = { name: "same", shadowRoot: { elementFromPoint: () => same } };
  assert.equal(deepHit({ elementFromPoint: () => same }, 5, 5), same, "a tree that answers with its own host ends the search");
});
