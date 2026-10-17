// Link hints: press `f` and every clickable thing in view gets a short label. Type the label to
// click it. On a link, type the last letter with Shift held to open it in a new tab beside the
// current one (as its child) instead.
//
// A classic content script, loaded before keys.js (which decides when `f` starts it). Everything
// is drawn in one closed shadow root so the page's styles cannot touch it and it never touches the page.
//
//   labels(count, chars)      short labels, none the start of another (so the last letter ends it)
//   create(win, options)      { running(), start(), key(event), stop() }
//
//   options.chars()           the letters labels are made of
//   options.open(url)         called for Shift + last letter on a link

(() => {
  "use strict";
  if (globalThis.groveHints) return;

  const DEFAULT_CHARS = "asdfghjklqwertyuiop";
  const MAX_HINTS = 600;
  const MAX_SCAN = 20000;
  const OPENABLE = /^(https?|ftp|file):/i;

  // Things that are clickable because of what they are...
  const STRONG =
    "a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,label[for],video[controls],audio[controls]," +
    "[contenteditable=''],[contenteditable='true'],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox]," +
    "[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem]";
  // ...and because a page says so (often a big wrapper, so they give way to anything inside them).
  const LOOSE = "[onclick],[jsaction],[tabindex]:not([tabindex='-1'])";

  // ---- labels ------------------------------------------------------------

  // Letters only, no repeats, at least four; anything else falls back to the default.
  function alphabet(chars) {
    const seen = [];
    for (const c of String(chars ?? "").toLowerCase()) if (/[a-z]/.test(c) && !seen.includes(c)) seen.push(c);
    return seen.length >= 4 ? seen : [...DEFAULT_CHARS];
  }

  // As short as they can be, and none is the start of another, so a label is finished the moment
  // its last letter is typed. The first ones (the top of the page) get the shortest.
  function labels(count, chars) {
    const letters = alphabet(Array.isArray(chars) ? chars.join("") : chars);
    if (count <= 0) return [];
    const queue = [""];
    let at = 0;
    while (queue.length - at < count || queue.length === 1) {
      const head = queue[at++];
      for (const c of letters) queue.push(head + c);
    }
    return queue.slice(at, at + count);
  }

  // ---- what can be clicked -----------------------------------------------

  const isTextField = (el) => {
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return !/^(button|checkbox|radio|submit|reset|image|file|range|color)$/i.test(el.type);
    return !!el.isContentEditable;
  };

  function* walk(root, budget) {
    for (const el of root.querySelectorAll("*")) {
      if (budget.left-- <= 0) return;
      yield el;
      const shadow = el.openOrClosedShadowRoot ?? el.shadowRoot;
      if (shadow) yield* walk(shadow, budget);
    }
  }

  // Where an element is on screen, in the coordinates of the top window (it may be inside frames):
  // the part of it that is in view, or null.
  function locate(item, win) {
    let x = 0;
    let y = 0;
    let clip = { l: 0, t: 0, r: win.innerWidth, b: win.innerHeight };
    for (const frame of item.frames) {
      const fr = frame.getBoundingClientRect();
      x += fr.left + frame.clientLeft;
      y += fr.top + frame.clientTop;
      clip = { l: Math.max(clip.l, x), t: Math.max(clip.t, y), r: Math.min(clip.r, x + frame.clientWidth), b: Math.min(clip.b, y + frame.clientHeight) };
    }
    for (const r of item.el.getClientRects()) {
      const l = Math.max(r.left + x, clip.l);
      const t = Math.max(r.top + y, clip.t);
      const rr = Math.min(r.right + x, clip.r);
      const b = Math.min(r.bottom + y, clip.b);
      if (rr - l >= 3 && b - t >= 3) return { left: r.left + x, top: r.top + y, l, t, r: rr, b, x, y };
    }
    return null;
  }

  // Is the element what you would actually hit at that spot (not hidden under a dialog)?
  function reachable(item, spot) {
    const doc = item.el.ownerDocument;
    let top = doc.elementFromPoint((spot.l + spot.r) / 2 - spot.x, (spot.t + spot.b) / 2 - spot.y);
    for (let hops = 0; top && hops < 50; hops++) {
      if (top === item.el || item.el.contains(top) || top.contains(item.el)) return true;
      top = top.parentNode?.host ?? top.getRootNode?.()?.host ?? null; // out of a shadow tree
    }
    return false;
  }

  function linkOf(el) {
    const raw = el.matches?.("a[href],area[href]") ? el.href : null;
    const href = typeof raw === "string" ? raw : raw?.baseVal ?? null;
    if (!href) return null;
    let url;
    try {
      url = new URL(href, el.ownerDocument.baseURI);
    } catch {
      return null;
    }
    if (!OPENABLE.test(url.protocol)) return null;
    const here = el.ownerDocument.location?.href ?? "";
    if (url.hash && url.href.split("#")[0] === here.split("#")[0]) return null; // a jump within this page
    return url.href;
  }

  // Everything clickable that you can see, in page order.
  function collect(win) {
    const found = [];
    const budget = { left: MAX_SCAN };
    const scan = (doc, frames) => {
      for (const el of walk(doc, budget)) {
        if (/^i?frame$/i.test(el.tagName)) {
          try {
            if (el.contentDocument) scan(el.contentDocument, [...frames, el]);
          } catch { /* another site: its own page handles keys pressed inside it */ }
          continue;
        }
        if (found.length >= MAX_HINTS * 3) return;
        const strong = el.matches(STRONG);
        const loose = !strong && el.matches(LOOSE);
        const item = { el, frames, strong, loose, kind: "other", href: null, pointer: false };
        if (!strong && !loose) {
          // Not marked up as clickable: does the page at least show a hand over it?
          const view = el.ownerDocument.defaultView;
          if (!view || el.children.length > 20) continue;
          const spot = locate(item, win);
          if (!spot) continue;
          const parent = el.parentElement;
          if (view.getComputedStyle(el).cursor !== "pointer" || (parent && view.getComputedStyle(parent).cursor === "pointer")) continue;
          item.pointer = true;
          item.loose = true;
          item.spot = spot;
        }
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const spot = item.spot ?? locate(item, win);
        if (!spot) continue;
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        if (style && (style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none")) continue;
        if (!reachable(item, spot)) continue;
        item.spot = spot;
        item.href = linkOf(el);
        item.kind = item.href ? "link" : isTextField(el) || el.tagName === "SELECT" ? "field" : "other";
        found.push(item);
      }
    };
    scan(win.document, []);
    // A wrapper the page made clickable gives way to what is inside it, and anything inside a real link or button.
    const keep = found.filter((a) => {
      if (!a.loose) return true;
      return !found.some((b) => b !== a && (a.el.contains(b.el) || (b.strong && b.el.contains(a.el))));
    });
    return keep.slice(0, MAX_HINTS);
  }

  // ---- clicking ------------------------------------------------------------

  function click(el) {
    const w = el.ownerDocument.defaultView;
    if (isTextField(el)) {
      el.focus();
      try {
        const n = el.value?.length;
        if (typeof n === "number") el.setSelectionRange?.(n, n);
      } catch { /* types that have no caret */ }
      return;
    }
    if (el.tagName === "SELECT") {
      el.focus();
      try { el.showPicker?.(); } catch { /* needs a recent key press; focus is enough */ }
      return;
    }
    if (/^(AUDIO|VIDEO)$/.test(el.tagName)) {
      el.focus();
      return;
    }
    // What a hand would do: pages that listen for mousedown / mouseup see them too.
    for (const type of ["mouseover", "mousedown", "mouseup"]) {
      el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, view: w, button: 0 }));
    }
    el.click();
  }

  // ---- the overlay ---------------------------------------------------------

  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    .tag { position: fixed; display: flex; padding: 1px 4px; border-radius: 3px; font: 700 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .04em; text-transform: uppercase; color: #1d1700; background: #ffd84d; border: 1px solid #b38f00;
      box-shadow: 0 1px 3px rgba(0,0,0,.35); white-space: nowrap; }
    .tag.field { background: #9ed3ff; border-color: #2f7bb8; color: #06223a; }
    .tag.gone { display: none; }
    .tag .done { opacity: .38; }
    .hud { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); padding: 5px 12px; border-radius: 999px;
      font: 12px/1.4 system-ui, sans-serif; color: #fff; background: rgba(28,28,32,.86); box-shadow: 0 2px 8px rgba(0,0,0,.35); white-space: nowrap; }
    .hud b { font-weight: 700; color: #ffd84d; }
    @media (prefers-reduced-motion: no-preference) { .tag { transition: opacity .08s; } }
    @media (prefers-color-scheme: dark) { .tag { box-shadow: 0 1px 3px rgba(0,0,0,.7); } }
  `;

  function create(win, { chars = () => DEFAULT_CHARS, open = () => {} } = {}) {
    let run = null;

    function stop() {
      if (!run) return;
      const r = run;
      run = null;
      win.cancelAnimationFrame?.(r.frame);
      for (const [target, type, fn, opts] of r.listeners) target.removeEventListener(type, fn, opts);
      r.host.remove();
    }

    function draw() {
      for (const b of run.badges) {
        const spot = locate(b.item, win);
        const live = !!spot && b.label.startsWith(run.typed);
        b.node.classList.toggle("gone", !live);
        if (!spot) continue;
        // On the top-left corner, half outside it, so the first letters of a link stay readable.
        b.node.style.left = `${Math.max(0, spot.left - 7)}px`;
        b.node.style.top = `${Math.max(0, spot.top - 8)}px`;
        b.done.textContent = b.label.slice(0, run.typed.length);
        b.rest.textContent = b.label.slice(run.typed.length);
      }
    }
    const redraw = () => {
      if (!run || run.frame) return;
      run.frame = win.requestAnimationFrame(() => {
        if (run) { run.frame = 0; draw(); }
      });
    };

    function start() {
      if (run) return true;
      const items = collect(win);
      const doc = win.document;
      const host = doc.createElement("grove-hints");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = doc.createElement("style");
      style.textContent = CSS;
      shadow.append(style);
      const hud = doc.createElement("div");
      hud.className = "hud";
      shadow.append(hud);
      if (!items.length) {
        hud.textContent = "Nothing to click in view";
        (doc.documentElement ?? doc.body).append(host);
        setTimeout(() => host.remove(), 1200);
        return false;
      }
      const names = labels(items.length, alphabet(chars()));
      const badges = items.map((item, i) => {
        const node = doc.createElement("div");
        node.className = `tag ${item.kind === "field" ? "field" : ""}`;
        const done = doc.createElement("span");
        done.className = "done";
        const rest = doc.createElement("span");
        node.append(done, rest);
        shadow.append(node);
        return { item, label: names[i], node, done, rest };
      });
      hud.innerHTML = "";
      hud.append("Type a label to click ");
      const hint = doc.createElement("b");
      hint.textContent = "⇧ + last letter";
      hud.append(hint, " opens a link in a new tab · Esc cancels");
      (doc.documentElement ?? doc.body).append(host);

      const onMove = () => redraw();
      const listeners = [
        [win, "scroll", onMove, { capture: true, passive: true }],
        [win, "resize", onMove, { passive: true }],
        [win, "blur", stop, {}],
        [win, "pagehide", stop, {}],
      ];
      for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);
      run = { host, badges, typed: "", frame: 0, listeners };
      draw();
      return true;
    }

    function finish(badge, shift) {
      const { item } = badge;
      stop();
      if (shift && item.kind === "link") open(item.href);
      else click(item.el);
    }

    // A key while hints are showing. Returns true when it was taken (the page must not see it).
    function key(e) {
      if (!run) return false;
      if (e.key === "Shift" || e.key === "CapsLock") return false;
      if (e.ctrlKey || e.altKey || e.metaKey) return false; // the browser's own shortcuts keep working
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return stop(), true;
      if (e.key === "Backspace") {
        run.typed = run.typed.slice(0, -1);
        draw();
        return true;
      }
      if (e.key.length !== 1) return true;
      const next = run.typed + e.key.toLowerCase();
      const alive = run.badges.filter((b) => b.label.startsWith(next));
      if (!alive.length) return true; // matches nothing: ignored, the hints stay
      run.typed = next;
      const whole = alive.find((b) => b.label === next);
      if (whole) finish(whole, e.shiftKey);
      else draw();
      return true;
    }

    return { running: () => !!run, start, key, stop };
  }

  globalThis.groveHints = { create, labels, alphabet, collect, DEFAULT_CHARS };
})();
