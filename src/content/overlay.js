// The element Grove draws over a web page: hint labels, the find bar. A classic content script,
// loaded first, shared by hints.js and find.js.
//
// It lives in a closed shadow root, so the page's style rules cannot reach what is inside. They can
// still reach the element that holds the root, and some pages do: a stylesheet that hides every custom
// element until it is defined (`:not(:defined) { visibility: hidden }`, common on component-based sites)
// hides the hint labels with it, while the keys still work, so nothing shows and clicks seem to happen
// on their own. Two things keep that from reaching us:
//   - the holder is a plain div, not a custom element (an undefined one is what such rules match);
//   - everything it needs to be seen is set as an inline !important property, which outranks any
//     rule in the page's stylesheets (set through the style object, so a strict CSP does not stop it).
//
//   groveOverlay.create(doc, css)   { host, shadow }: the holder (not yet in the page) and its shadow root,
//                                   with `css` as its style sheet. The holder covers the window and lets
//                                   clicks through; give what should take clicks `pointer-events: auto`.
//   groveOverlay.mount(doc, host)   put it in the page

(() => {
  "use strict";
  if (globalThis.groveOverlay) return;

  const PINNED = [
    ["display", "block"], ["position", "fixed"], ["top", "0"], ["left", "0"], ["right", "0"], ["bottom", "0"],
    ["width", "auto"], ["height", "auto"], ["max-width", "none"], ["max-height", "none"],
    ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "none"], ["overflow", "visible"],
    ["visibility", "visible"], ["opacity", "1"], ["transform", "none"], ["filter", "none"], ["clip-path", "none"],
    ["contain", "none"], ["z-index", "2147483647"], ["pointer-events", "none"],
  ];

  function create(doc, css = "") {
    const host = doc.createElement("div"); // a shadow root can only go on a div-like element or a custom one
    for (const [name, value] of PINNED) host.style.setProperty(name, value, "important");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = `:host { all: initial; }\n${css}`;
    shadow.append(style);
    return { host, shadow };
  }

  const mount = (doc, host) => (doc.documentElement ?? doc.body).append(host);

  globalThis.groveOverlay = { create, mount, PINNED };
})();
