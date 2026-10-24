// Find on the page: `/` on a web page opens a small search bar at the bottom of it. Matches are
// painted as you type (the CSS Custom Highlight API, so the page is never touched), the first one at or
// below the top of the screen is the current one, and Enter keeps it and gives the page back, after which
// `n` / `N` step to the next / previous match until Esc clears them. (In the sidebar `/` is Grove's own tab
// search; that is decided in keys.js.)
//
// A classic content script, loaded before keys.js. The bar lives in one closed shadow root.
//
//   buildIndex(items)       items [{ text, block }] -> one searchable string and where each letter came from
//   search(index, query)    -> [{ from, to }] (non-overlapping; a query with a capital is case-sensitive)
//   create(win)             { open(), close(), running(), owns(event), key(event), active(), step(dir), clear() }
//
// Matching ignores how the page breaks lines (any whitespace is one space) and crosses tags, so
// "foo bar" finds <b>foo</b> bar; it does not cross block boundaries unless the query has a space there.

(() => {
  "use strict";
  if (globalThis.groveFind) return;

  const MAX_MATCHES = 5000;
  const MAX_CHARS = 3_000_000;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "OPTION", "SELECT", "TITLE"]);
  const BLOCK = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "BUTTON", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV",
    "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ]);
  const WS = /\s/;

  // ---- searching text -----------------------------------------------------

  // The text of the page as one string with every run of whitespace turned into one space, a space
  // between blocks, and for every letter of it the item and offset it came from.
  function buildIndex(items) {
    const out = [];
    const owner = [];
    const off = [];
    let prevSpace = true; // nothing yet: leading whitespace is skipped
    let lastBlock;
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const { text, block } = items[i];
      if (i > 0 && block !== lastBlock && !prevSpace) {
        out.push(" ");
        owner.push(-1);
        off.push(0);
        prevSpace = true;
      }
      lastBlock = block;
      for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if (WS.test(c)) {
          if (prevSpace) continue;
          out.push(" ");
          prevSpace = true;
        } else {
          out.push(c);
          prevSpace = false;
        }
        owner.push(i);
        off.push(k);
      }
      total += text.length;
      if (total > MAX_CHARS) break;
    }
    return { s: out.join(""), owner, off };
  }

  // Lower case that never changes the length (a few letters would), so positions stay true.
  function fold(s) {
    const l = s.toLowerCase();
    if (l.length === s.length) return l;
    let r = "";
    for (const c of s) { const x = c.toLowerCase(); r += x.length === c.length ? x : c; }
    return r;
  }

  function search(index, query, max = MAX_MATCHES) {
    const q = String(query ?? "").replace(/\s+/g, " ");
    if (!q.trim()) return [];
    const exact = q !== q.toLowerCase(); // smart case: a capital letter makes it case-sensitive
    const hay = exact ? index.s : fold(index.s);
    const needle = exact ? q : fold(q);
    const found = [];
    for (let at = hay.indexOf(needle); at >= 0 && found.length < max; at = hay.indexOf(needle, at + needle.length)) {
      found.push({ from: at, to: at + needle.length });
    }
    return found;
  }

  // A match as the text nodes and offsets it starts and ends at (spaces made up between blocks are not letters).
  function ends(index, m) {
    let a = m.from;
    let b = m.to - 1;
    while (a <= b && index.owner[a] < 0) a++;
    while (b >= a && index.owner[b] < 0) b--;
    if (a > b) return null;
    return { start: [index.owner[a], index.off[a]], end: [index.owner[b], index.off[b] + 1] };
  }

  // ---- the page ----------------------------------------------------------

  function collect(doc, ignore) {
    const items = [];
    const blocks = new Map();
    const blockOf = (el) => {
      const path = [];
      let found = null;
      for (let e = el; e; e = e.parentElement) {
        if (blocks.has(e)) { found = blocks.get(e); break; }
        path.push(e);
        if (BLOCK.has(e.tagName) || e === doc.body) { found = e; break; }
      }
      for (const e of path) blocks.set(e, found);
      return found;
    };
    const root = doc.body ?? doc.documentElement;
    if (!root) return items;
    const walker = doc.createTreeWalker(root, 4);
    let chars = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || (ignore && ignore.contains(p))) continue;
      if (!n.nodeValue) continue;
      items.push({ text: n.nodeValue, block: blockOf(p), node: n });
      chars += n.nodeValue.length;
      if (chars > MAX_CHARS) break;
    }
    return items;
  }

  function create(win) {
    const doc = win.document;
    let host = null;
    let input = null;
    let status = null;
    let ranges = [];
    let cur = -1;
    let query = "";
    let usedSelection = false;

    // ---- marks ----
    const reg = () => { try { return win.CSS?.highlights && (win.Highlight ?? globalThis.Highlight) ? win.CSS.highlights : null; } catch { return null; } };

    function paint() {
      try {
        const r = reg();
        if (r) {
          const H = win.Highlight ?? globalThis.Highlight;
          if (ranges.length) {
            r.set("grove-find", new H(...ranges));
            const now = new H(ranges[cur]);
            now.priority = 1;
            r.set("grove-find-current", now);
          } else {
            r.delete("grove-find");
            r.delete("grove-find-current");
          }
          return;
        }
      } catch { /* fall through to the selection */ }
      // No highlight support: the current match is the selection.
      const sel = win.getSelection?.();
      if (!sel) return;
      sel.removeAllRanges();
      if (ranges[cur]) sel.addRange(ranges[cur]);
      usedSelection = true;
    }

    function reveal() {
      const range = ranges[cur];
      if (!range) return;
      const rect = range.getBoundingClientRect();
      const inView = rect.top >= 40 && rect.bottom <= win.innerHeight - 70 && rect.left >= 0 && rect.right <= win.innerWidth;
      if (!inView) range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
    }

    function run(text, { keepPlace = false } = {}) {
      query = text;
      const before = ranges[cur];
      ranges = [];
      cur = -1;
      if (text.trim()) {
        const items = collect(doc, host);
        const index = buildIndex(items);
        for (const m of search(index, text)) {
          const e = ends(index, m);
          if (!e) continue;
          try {
            const r = doc.createRange();
            r.setStart(items[e.start[0]].node, e.start[1]);
            r.setEnd(items[e.end[0]].node, e.end[1]);
            if (r.getClientRects().length) ranges.push(r); // only what can be seen
          } catch { /* the page changed under us */ }
        }
        if (ranges.length) {
          // The first one at or below the top of the screen, else the first; or the one we were on.
          let at = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= 0);
          if (keepPlace && before) {
            const same = ranges.findIndex((r) => r.compareBoundaryPoints(0, before) === 0);
            if (same >= 0) at = same;
          }
          cur = at < 0 ? 0 : at;
        }
      }
      paint();
      reveal();
      show();
    }

    function step(dir) {
      // The page may have changed since: look again, staying where we were if we can.
      if (ranges.length && ranges.some((r) => !r.startContainer.isConnected)) run(query, { keepPlace: true });
      if (!ranges.length) return false;
      cur = (cur + dir + ranges.length) % ranges.length;
      paint();
      reveal();
      show();
      return true;
    }

    function clear() {
      ranges = [];
      cur = -1;
      query = "";
      try { reg()?.delete("grove-find"); reg()?.delete("grove-find-current"); } catch { /* ok */ }
      if (usedSelection) { win.getSelection?.()?.removeAllRanges(); usedSelection = false; }
    }

    // ---- the bar ----
    const CSS = `
      .bar { pointer-events: auto; position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); box-sizing: border-box; width: min(460px, calc(100vw - 24px));
        display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 12px; background: #151a2b; color: #e8ecf8;
        border: 1px solid #5eead4; box-shadow: 0 6px 24px #0007; font: 14px/1.3 system-ui, sans-serif; }
      .slash { color: #5eead4; font: 700 15px ui-monospace, monospace; }
      input { all: unset; flex: 1; min-width: 0; color: inherit; font: inherit; caret-color: #5eead4; }
      input::placeholder { color: #8a93b2; }
      .count { color: #a78bfa; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .count.none { color: #f9a8b4; }
      .hint { color: #8a93b2; font-size: 12px; white-space: nowrap; }
      @media (max-width: 420px) { .hint { display: none; } }
    `;

    function show() {
      if (!status) return;
      status.className = "count";
      if (!query.trim()) status.textContent = "";
      else if (!ranges.length) { status.textContent = "No match"; status.className = "count none"; }
      else status.textContent = `${cur + 1} / ${ranges.length}${ranges.length >= MAX_MATCHES ? "+" : ""}`;
    }

    function open() {
      if (host) { input.focus(); input.select(); return true; }
      const overlay = globalThis.groveOverlay;
      const made = overlay.create(doc, CSS);
      host = made.host;
      const shadow = made.shadow;
      const bar = doc.createElement("div");
      bar.className = "bar";
      const slash = doc.createElement("span");
      slash.className = "slash";
      slash.textContent = "/";
      input = doc.createElement("input");
      input.type = "text";
      input.placeholder = "Find on this page";
      input.spellcheck = false;
      input.autocomplete = "off";
      status = doc.createElement("span");
      status.className = "count";
      const hint = doc.createElement("span");
      hint.className = "hint";
      hint.textContent = "Enter keeps · Esc clears";
      bar.append(slash, input, status, hint);
      shadow.append(bar);
      input.value = query;
      input.addEventListener("input", () => run(input.value));
      input.addEventListener("blur", () => close());
      overlay.mount(doc, host);
      input.focus();
      input.select();
      if (query) run(query, { keepPlace: true });
      return true;
    }

    // Close the bar. The marks stay (n / N and Esc work on them) unless `wipe`.
    function close(wipe = false) {
      if (wipe) clear();
      if (host) {
        const h = host;
        host = null;
        input = null;
        status = null;
        h.remove();
      }
    }

    // A key press that happened inside the bar (the page's own listeners never see it: keys.js stops it).
    function key(e) {
      if (!host || e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (e.key === "Enter") { e.preventDefault(); const keep = ranges.length > 0; close(!keep); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); step(e.key === "ArrowDown" ? 1 : -1); }
      else if (e.key === "Backspace" && !input.value) { e.preventDefault(); close(true); }
    }

    return {
      open,
      close,
      key,
      step,
      clear,
      running: () => !!host,
      owns: (e) => !!host && e.target === host,
      // There are marks to step through.
      active: () => ranges.length > 0,
      matches: () => ranges.length,
      current: () => cur,
    };
  }

  globalThis.groveFind = { buildIndex, search, ends, create };
})();
