// Vim-style keys. A classic script (content scripts cannot be modules), used in two places:
//   - on every web page, as a content script (manifest.json), and
//   - in the sidebar, which loads it with a <script> tag and calls install() itself.
//
// Keys (no Ctrl/Alt/Meta; ignored while you are typing in a field):
//   gt         next tab           gT, gs   previous tab
//   t          new tab            x        close the tab (never the window)
//   r          reload             /        search: in the sidebar Grove's tab search, on a page a find bar
//                                          (src/content/find.js; Enter keeps the matches, then n / N step, Esc clears)
//   H, L       back, forward      << , >>  move the tab up, down among its siblings
//   f          label what can be clicked (src/content/hints.js); type a label to click it,
//              Shift on its last letter opens a link in a new child tab
//   j, k       scroll down, up a little        d, u   half a page down, up
//   gg, G      top, bottom of the page         (j k d u gg G are the "scroll keys", settable apart)
//
// Tab keys are only recognised here and sent on: what they do, and whether they are on at all,
// is decided by the background page, so pausing them in settings takes effect everywhere.
// Scroll keys act right here, on the page (or, in the sidebar, on the list).

(() => {
  "use strict";
  if (globalThis.groveVimKeys) return;

  const SEQUENCE_MS = 1200;
  const STEP = 60; // pixels for j / k
  const SEQUENCES = {
    g: { t: "next", T: "prev", s: "prev" },
    "<": { "<": "up" },
    ">": { ">": "down" },
  };
  const SINGLES = { t: "new", x: "close", r: "reload", "/": "search", H: "back", L: "forward" };
  const SCROLL_SEQUENCES = { g: { g: "top" } };
  const SCROLL_SINGLES = { j: "scrollDown", k: "scrollUp", d: "pageDown", u: "pageUp", G: "bottom" };
  const SCROLL_ACTIONS = new Set(["scrollDown", "scrollUp", "pageDown", "pageUp", "top", "bottom"]);
  const REPEATABLE = new Set(["scrollDown", "scrollUp", "pageDown", "pageUp"]); // holding the key keeps scrolling

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !/^(button|checkbox|radio|submit|reset|image|file|range|color)$/i.test(el.type);
    return el.getAttribute?.("role") === "textbox" || !!el.closest?.("[contenteditable=''],[contenteditable='true']");
  }

  // ---- scrolling ---------------------------------------------------------

  // Only the box the browser scrolls the page with is scrolled through the window. `body` is not it
  // when the page makes `html` fixed and lets `body` scroll: that one has to be scrolled itself.
  const isRootScroller = (el, win) => el === win.document.scrollingElement;

  // j / k move a little, d / u half a screen, gg / G the ends: all of them glide, so a single press is smooth.
  // A key that is held (`held`) moves at once instead: a glide started on every repeat would lag behind the finger.
  function scrollElement(el, action, win = globalThis, { held = false } = {}) {
    const root = isRootScroller(el, win);
    const view = root ? win.innerHeight : el.clientHeight;
    const target = root ? win : el;
    const calm = !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const by = (top, soft) => target.scrollBy({ top, behavior: soft && !calm ? "smooth" : "auto" });
    const to = (top) => target.scrollTo({ top, behavior: calm ? "auto" : "smooth" });
    switch (action) {
      case "scrollDown": return by(STEP, !held);
      case "scrollUp": return by(-STEP, !held);
      case "pageDown": return by(view / 2, true);
      case "pageUp": return by(-view / 2, true);
      case "top": return to(0);
      case "bottom": return to(el.scrollHeight);
    }
  }

  // Which way a scroll action goes: 1 down, -1 up.
  const DIRECTION = { scrollDown: 1, pageDown: 1, bottom: 1, scrollUp: -1, pageUp: -1, top: -1 };

  // Can a box with these measures still go that way? (A box already at its end hands over to the one around it,
  // as the browser's own scrolling does.)
  function canMove({ top, view, total }, dir) {
    if (dir > 0) return top + view < total - 1;
    if (dir < 0) return top > 0;
    return total > view + 1;
  }
  const measures = (el) => ({ top: el.scrollTop, view: el.clientHeight, total: el.scrollHeight });

  // A box the person can scroll: it overflows and its style lets it scroll.
  function scrollable(el, win) {
    return /(auto|scroll|overlay)/.test(win.getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  // The page itself: unless its style locks it (overflow: hidden on html, or on body when html leaves it to body).
  function pageScrolls(win) {
    const doc = win.document;
    const own = win.getComputedStyle(doc.documentElement).overflowY;
    const used = own === "visible" && doc.body ? win.getComputedStyle(doc.body).overflowY : own;
    return used !== "hidden" && used !== "clip";
  }

  const hostOf = (el) => el.parentElement ?? el.getRootNode?.().host ?? null; // up, out of shadow trees too

  // What is under a point, looking inside open shadow trees (component-based apps keep their content there).
  function deepAt(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    for (let depth = 0; el && depth < 12; depth++) {
      const inner = (el.openOrClosedShadowRoot ?? el.shadowRoot)?.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Every box that might be the one to scroll, best guess first: the one you are in, those under the middle
  // of the window, the page, then everything else that scrolls, largest in view first. Lazy: a good guess
  // costs nothing more.
  function* scrollCandidates(win) {
    const doc = win.document;
    const root = doc.scrollingElement || doc.documentElement;
    for (let el = doc.activeElement; el && el !== doc.body && el !== doc.documentElement; el = hostOf(el)) yield el;
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]]) {
      for (let el = deepAt(doc, win.innerWidth * fx, win.innerHeight * fy); el; el = hostOf(el)) yield el;
    }
    yield root;
    if (doc.body) yield doc.body;
    const rest = [];
    let seen = 0;
    const visit = (scope) => {
      for (const el of scope.querySelectorAll("*")) {
        if (++seen > 6000) return;
        if (scrollable(el, win)) {
          const r = el.getBoundingClientRect();
          const area = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
          if (area > 0) rest.push([area, el]);
        }
        const shadow = el.openOrClosedShadowRoot ?? el.shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    visit(doc);
    rest.sort((a, b) => b[0] - a[0]);
    for (const [, el] of rest) yield el;
  }

  // What a page scrolls, for a key that goes `dir` (1 down, -1 up, 0 either): the first box that can scroll
  // and still has room that way, or null. Many apps leave the page itself fixed and scroll a panel (often a
  // custom element, or a box inside a component's shadow tree), so the page is one candidate, not the answer.
  function findScroller(win, dir = 0) {
    const doc = win.document;
    const root = doc.scrollingElement || doc.documentElement;
    const tried = new Set();
    for (const el of scrollCandidates(win)) {
      if (!el || tried.has(el)) continue;
      tried.add(el);
      const ok = el === root ? pageScrolls(win) : scrollable(el, win);
      if (ok && canMove(measures(el), dir)) return el;
    }
    return null;
  }

  // ---- keys --------------------------------------------------------------

  // send(action): a tab key. scroll(action): a scroll key. active(): are keys on. scrolling(): are scroll keys on.
  // hints: a controller from hints.js (pages only), hinting(): is `f` on.
  // find: a controller from find.js (pages only): `/` opens it instead of being sent on.
  function install(win, { send, active, scrolling = () => false, scroll = () => {}, hints = null, hinting = () => false, find = null }) {
    let pending = "";
    let timer = null;
    const reset = () => {
      pending = "";
      clearTimeout(timer);
    };
    const sequences = () => (scrolling() ? { ...SEQUENCES, g: { ...SEQUENCES.g, ...SCROLL_SEQUENCES.g } } : SEQUENCES);
    const singles = () => ({
      ...SINGLES,
      ...(scrolling() ? SCROLL_SINGLES : {}),
      ...(hints && hinting() ? { f: "hints" } : {}),
      ...(find ? { "/": "find", ...(find.active() ? { n: "findNext", N: "findPrev" } : {}) } : {}),
    });

    // Returns true when the key press was taken (so the page must not see it).
    function onKey(e) {
      if (e.key === "Shift" || e.key === "CapsLock") return false; // a modifier on its own does not end a sequence
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return reset(), false;
      if (!active()) return reset(), false;
      const target = (e.composedPath?.()[0]) ?? e.target;
      if (isEditable(target) || win.document?.designMode === "on") return reset(), false;

      const k = e.key;
      const seqs = sequences();
      let action = null;
      if (pending && seqs[pending]) action = seqs[pending][k] ?? null;
      const wasPending = pending;
      reset();
      if (!action) {
        if (seqs[k]) {
          // First key of a sequence: hold it for a moment.
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) {
            pending = k;
            timer = setTimeout(reset, SEQUENCE_MS);
          } else pending = wasPending; // a held key does not restart the wait
          return true;
        }
        action = singles()[k] ?? null;
      }
      if (!action) return false;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && !REPEATABLE.has(action)) return true; // taken, but done once
      if (SCROLL_ACTIONS.has(action)) scroll(action, { held: !!e.repeat });
      else if (action === "hints") { if (!e.repeat) hints.start(); }
      else if (action === "find") { if (!e.repeat) find.open(); }
      else if (action === "findNext" || action === "findPrev") find.step(action === "findNext" ? 1 : -1);
      else send(action);
      return true;
    }

    // The rest of a press we took (its keypress and keyup) must not reach the page either, so a
    // page or another listener that acts on those never sees half of "gt".
    let taken = null;
    const onDown = (e) => {
      // The find bar is the page's input as far as the page is concerned: its keys go to it and to nobody else
      // (the browser still types them into the box, stopping the event does not stop that).
      if (find?.owns(e)) {
        e.stopImmediatePropagation();
        taken = null;
        if (!active()) find.close(true);
        else find.key(e);
        return;
      }
      if (find?.running() && !active()) find.close(true);
      // Esc puts the matches away (and still reaches the page).
      if (e.key === "Escape" && active() && find?.active()) find.clear();
      // While labels are showing, they own the keyboard.
      if (hints?.running()) {
        if (!active()) hints.stop();
        else { taken = hints.key(e) ? e.key : null; return; }
      }
      taken = onKey(e) ? e.key : null;
    };
    const onRest = (e) => {
      if (find?.owns(e)) { e.stopImmediatePropagation(); return; }
      if (taken === null || e.key !== taken) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keyup") taken = null;
    };
    win.addEventListener("keydown", onDown, true);
    win.addEventListener("keypress", onRest, true);
    win.addEventListener("keyup", onRest, true);
    return () => {
      win.removeEventListener("keydown", onDown, true);
      win.removeEventListener("keypress", onRest, true);
      win.removeEventListener("keyup", onRest, true);
    };
  }

  globalThis.groveVimKeys = { install, isEditable, scrollElement, findScroller, canMove, DIRECTION };

  // On a web page: ask the background whether the keys are on for this page.
  const b = globalThis.browser;
  if (b?.runtime?.sendMessage && typeof location !== "undefined" && location.protocol !== "moz-extension:") {
    let on = false;
    let scrollOn = false;
    let hintOn = false;
    let hintChars = "";
    const take = (r) => { on = !!r?.active; scrollOn = on && !!r?.scroll; hintOn = on && !!r?.hints; hintChars = r?.hintChars ?? ""; };
    const refresh = () => b.runtime.sendMessage({ type: "vim:config" }).then(take, () => {});
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    b.runtime.onMessage?.addListener((msg) => {
      if (msg?.type === "vim:active") take(msg);
    });
    const find = globalThis.groveFind?.create(window);
    const hints = globalThis.groveHints?.create(window, {
      chars: () => hintChars,
      open: (url) => { b.runtime.sendMessage({ type: "vim:hint", url }).catch(() => {}); },
    });
    install(window, {
      active: () => on,
      scrolling: () => scrollOn,
      hints,
      hinting: () => hintOn,
      find,
      scroll: (action, opts) => {
        const el = findScroller(window, DIRECTION[action] ?? 0);
        if (el) scrollElement(el, action, window, opts);
      },
      send: (action) => { b.runtime.sendMessage({ type: "vim:key", action }).catch(() => {}); },
    });
  }
})();
