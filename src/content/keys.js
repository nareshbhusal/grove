// Vim-style keys. A classic script (content scripts cannot be modules), used in two places:
//   - on every web page, as a content script (manifest.json), and
//   - in the sidebar, which loads it with a <script> tag and calls install() itself.
//
// Keys (no Ctrl/Alt/Meta; ignored while you are typing in a field):
//   gt         next tab           gT, gs   previous tab
//   t          new tab            x        close the tab (never the window)
//   r          reload             /        search the tabs (Grove's search field)
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

  const isRootScroller = (el, win) => el === win.document.scrollingElement || el === win.document.documentElement || el === win.document.body;

  // j / k move a little (at once, so holding the key is smooth), d / u half a screen, gg / G the ends.
  function scrollElement(el, action, win = globalThis) {
    const root = isRootScroller(el, win);
    const view = root ? win.innerHeight : el.clientHeight;
    const target = root ? win : el;
    const calm = !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const by = (top, soft) => target.scrollBy({ top, behavior: soft && !calm ? "smooth" : "auto" });
    const to = (top) => target.scrollTo({ top, behavior: calm ? "auto" : "smooth" });
    switch (action) {
      case "scrollDown": return by(STEP, false);
      case "scrollUp": return by(-STEP, false);
      case "pageDown": return by(view / 2, true);
      case "pageUp": return by(-view / 2, true);
      case "top": return to(0);
      case "bottom": return to(el.scrollHeight);
    }
  }

  function scrollable(el, win) {
    return /(auto|scroll|overlay)/.test(win.getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  // What a page scrolls: the box you are in, else the page, else its biggest scrolling box
  // (many apps scroll an inner panel and leave the page itself fixed).
  function findScroller(win) {
    const doc = win.document;
    const page = doc.scrollingElement || doc.documentElement;
    for (let el = doc.activeElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
      if (scrollable(el, win)) return el;
    }
    if (page.scrollHeight > win.innerHeight + 1) return page;
    if (doc.body && scrollable(doc.body, win)) return doc.body;
    let best = null;
    let bestArea = 0;
    let seen = 0;
    for (const el of doc.querySelectorAll("div,main,section,article,aside,ul,ol,table")) {
      if (++seen > 4000) break;
      if (!scrollable(el, win)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best ?? page;
  }

  // ---- keys --------------------------------------------------------------

  // send(action): a tab key. scroll(action): a scroll key. active(): are keys on. scrolling(): are scroll keys on.
  // hints: a controller from hints.js (pages only), hinting(): is `f` on.
  function install(win, { send, active, scrolling = () => false, scroll = () => {}, hints = null, hinting = () => false }) {
    let pending = "";
    let timer = null;
    const reset = () => {
      pending = "";
      clearTimeout(timer);
    };
    const sequences = () => (scrolling() ? { ...SEQUENCES, g: { ...SEQUENCES.g, ...SCROLL_SEQUENCES.g } } : SEQUENCES);
    const singles = () => ({ ...SINGLES, ...(scrolling() ? SCROLL_SINGLES : {}), ...(hints && hinting() ? { f: "hints" } : {}) });

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
      if (SCROLL_ACTIONS.has(action)) scroll(action);
      else if (action === "hints") { if (!e.repeat) hints.start(); }
      else send(action);
      return true;
    }

    // The rest of a press we took (its keypress and keyup) must not reach the page either, so a
    // page or another listener that acts on those never sees half of "gt".
    let taken = null;
    const onDown = (e) => {
      // While labels are showing, they own the keyboard.
      if (hints?.running()) {
        if (!active()) hints.stop();
        else { taken = hints.key(e) ? e.key : null; return; }
      }
      taken = onKey(e) ? e.key : null;
    };
    const onRest = (e) => {
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

  globalThis.groveVimKeys = { install, isEditable, scrollElement, findScroller };

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
    const hints = globalThis.groveHints?.create(window, {
      chars: () => hintChars,
      open: (url) => { b.runtime.sendMessage({ type: "vim:hint", url }).catch(() => {}); },
    });
    install(window, {
      active: () => on,
      scrolling: () => scrollOn,
      hints,
      hinting: () => hintOn,
      scroll: (action) => scrollElement(findScroller(window), action, window),
      send: (action) => { b.runtime.sendMessage({ type: "vim:key", action }).catch(() => {}); },
    });
  }
})();
