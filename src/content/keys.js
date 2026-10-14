// Vim-style keys. A classic script (content scripts cannot be modules), used in two places:
//   - on every web page, as a content script (manifest.json), and
//   - in the sidebar, which loads it with a <script> tag and calls install() itself.
//
// Keys (no Ctrl/Alt/Meta; ignored while you are typing in a field):
//   gt         next tab           gT, gs   previous tab
//   t          new tab            H, L     back, forward
//   << , >>    move the tab up, down among its siblings (Shift+, and Shift+. twice)
//
// The script only recognises keys. What they do, and whether they are on at all,
// is decided by the background page, so pausing them in settings takes effect everywhere.

(() => {
  "use strict";
  if (globalThis.groveVimKeys) return;

  const SEQUENCE_MS = 1200;
  const AFTER = {
    g: { t: "next", T: "prev", s: "prev" },
    "<": { "<": "up" },
    ">": { ">": "down" },
  };
  const SINGLE = { t: "new", H: "back", L: "forward" };

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !/^(button|checkbox|radio|submit|reset|image|file|range|color)$/i.test(el.type);
    return el.getAttribute?.("role") === "textbox" || !!el.closest?.("[contenteditable=''],[contenteditable='true']");
  }

  // send(action) delivers a recognised key; active() says whether keys are on right now.
  function install(win, { send, active }) {
    let pending = "";
    let timer = null;
    const reset = () => {
      pending = "";
      clearTimeout(timer);
    };

    function onKey(e) {
      if (e.key === "Shift" || e.key === "CapsLock") return; // a modifier on its own does not end a sequence
      if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return reset();
      if (!active()) return reset();
      const target = (e.composedPath?.()[0]) ?? e.target;
      if (isEditable(target) || win.document?.designMode === "on") return reset();

      const k = e.key;
      let action = null;
      if (pending && AFTER[pending]) action = AFTER[pending][k] ?? null;
      const wasPending = pending;
      reset();
      if (!action && !(wasPending && AFTER[wasPending]?.[k])) {
        if (AFTER[k]) {
          // First key of a sequence: hold it for a moment.
          if (e.repeat) return;
          pending = k;
          timer = setTimeout(reset, SEQUENCE_MS);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        action = SINGLE[k] ?? null;
      }
      if (!action || e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      send(action);
    }

    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }

  globalThis.groveVimKeys = { install, isEditable };

  // On a web page: ask the background whether the keys are on for this page.
  const b = globalThis.browser;
  if (b?.runtime?.sendMessage && typeof location !== "undefined" && location.protocol !== "moz-extension:") {
    let on = false;
    const refresh = () =>
      b.runtime.sendMessage({ type: "vim:config" }).then((r) => { on = !!r?.active; }, () => {});
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    b.runtime.onMessage?.addListener((msg) => {
      if (msg?.type === "vim:active") on = !!msg.active;
    });
    install(window, {
      active: () => on,
      send: (action) => { b.runtime.sendMessage({ type: "vim:key", action }).catch(() => {}); },
    });
  }
})();
