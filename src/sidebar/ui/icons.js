// Inline SVG icons (no innerHTML). All are drawn on a 16x16 grid with
// currentColor, so they take the text colour and centre cleanly in any box.
//
//   icon("gear", { size: 18 })  -> <svg>

const NS = "http://www.w3.org/2000/svg";

// Each icon is a list of [tag, attributes]. Strokes are 1.5 wide with round caps.
const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" };

const ICONS = {
  // two stacked chevrons: up folds everything away, down opens everything
  collapseAll: { stroke: true, shapes: [["path", { d: "M4 7.5 8 4l4 3.5" }], ["path", { d: "M4 12 8 8.5l4 3.5" }]] },
  expandAll: { stroke: true, shapes: [["path", { d: "M4 4.5 8 8l4-3.5" }], ["path", { d: "M4 9l4 3.5L12 9" }]] },
  // a gear: a dashed ring makes the teeth
  gear: {
    stroke: true,
    shapes: [
      ["circle", { cx: 8, cy: 8, r: 5.6, "stroke-width": 2.2, "stroke-dasharray": "2.2 2.2", "stroke-linecap": "butt" }],
      ["circle", { cx: 8, cy: 8, r: 4.1 }],
      ["circle", { cx: 8, cy: 8, r: 1.6 }],
    ],
  },
  plus: { stroke: true, shapes: [["path", { d: "M8 3v10M3 8h10" }]] },
  search: { stroke: true, shapes: [["circle", { cx: 7, cy: 7, r: 4.3 }], ["path", { d: "M10.3 10.3 13.5 13.5" }]] },
  // a folder / a note with a plus inside: "make a new one"
  folderPlus: {
    stroke: true,
    shapes: [["path", { d: "M2 4.4A1.4 1.4 0 0 1 3.4 3h2.7l1.5 1.6h5A1.4 1.4 0 0 1 14 6v5.6a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.6z" }], ["path", { d: "M8 7v3.6M6.2 8.8h3.6" }]],
  },
  notePlus: {
    stroke: true,
    shapes: [["path", { d: "M4 2.5h5l3 3v8H4z" }], ["path", { d: "M9 2.5v3h3" }], ["path", { d: "M8 7.8v3.4M6.3 9.5h3.4" }]],
  },
  back: { stroke: true, shapes: [["path", { d: "M9.5 3.5 5 8l4.5 4.5" }]] },
  download: { stroke: true, shapes: [["path", { d: "M8 3v7M5 7.5l3 3 3-3M3.5 13h9" }]] },
  note: {
    stroke: true,
    shapes: [["path", { d: "M4 2.5h5l3 3v8H4z" }], ["path", { d: "M9 2.5v3h3" }], ["path", { d: "M6 8.5h4M6 11h4" }]],
  },
  folder: {
    fill: true,
    shapes: [["path", { d: "M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z", opacity: ".8" }]],
  },
  speaker: {
    both: true,
    shapes: [
      ["path", { d: "M2.5 6.5H5L8.5 3.5v9L5 9.5H2.5z", fill: "currentColor", stroke: "none" }],
      ["path", { d: "M10.5 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.8a6 6 0 0 1 0 8.4", ...STROKE }],
    ],
  },
  speakerMuted: {
    both: true,
    shapes: [
      ["path", { d: "M2.5 6.5H5L8.5 3.5v9L5 9.5H2.5z", fill: "currentColor", stroke: "none" }],
      ["path", { d: "M10.8 6l3.4 4M14.2 6l-3.4 4", ...STROKE }],
    ],
  },
  // stand-ins for pages that have no icon of their own
  file: { stroke: true, shapes: [["path", { d: "M4 2.5h5l3 3v8H4z" }], ["path", { d: "M9 2.5v3h3" }]] },
  page: { stroke: true, shapes: [["rect", { x: 3, y: 3, width: 10, height: 10, rx: 2 }]] },
  internal: { stroke: true, shapes: [["circle", { cx: 8, cy: 8, r: 5.2 }], ["path", { d: "M8 7.2v3.6M8 5.2v.1" }]] },
  puzzle: { stroke: true, shapes: [["path", { d: "M3 6h2.2a1.3 1.3 0 1 1 2.6 0H10v2.2a1.3 1.3 0 1 1 0 2.6V13H3z" }]] },
  split: { stroke: true, shapes: [["rect", { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.5 }], ["path", { d: "M8 3.5v9" }]] },
  close: { stroke: true, shapes: [["path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" }]] },
};

export function icon(name, { size = 16, cls = null } = {}) {
  const def = ICONS[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon-${name}${cls ? " " + cls : ""}`);
  if (!def) return svg;
  for (const [tag, attrs] of def.shapes) {
    const el = document.createElementNS(NS, tag);
    const base = def.stroke ? STROKE : def.fill ? { fill: "currentColor" } : {};
    for (const [k, v] of Object.entries({ ...base, ...attrs })) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

// Small filled triangle for tree twisties (8x8 grid).
export function twistyIcon() {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 8 8");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M2 0.5 6.5 4 2 7.5z");
  p.setAttribute("fill", "currentColor");
  svg.appendChild(p);
  return svg;
}
