// What hovering a row shows. Pure, so the sidebar and the tests share it.
//
//   tooltip setting   "url" (default) | "title" | "both"
//   preview setting   "off" (default) | "row" (hover the tab) | "favicon" (hover its icon only)

export const TOOLTIP_MODES = ["url", "title", "both"];
export const PREVIEW_MODES = ["off", "row", "favicon"];

export const previewMode = (cfg) => (PREVIEW_MODES.includes(cfg?.preview) ? cfg.preview : "off");

// Only a real page has a picture worth showing.
export function previewable(node) {
  return node?.type === "tab" && /^(https?|ftp|file):/i.test(node.url ?? "");
}

// The lines the hover text is made of, in order: [{ kind: "title" | "url", text }].
// A folder or note shows its name; a tab shows what the setting asks for, and never the
// same text twice (a page with no title is shown by its address).
export function hoverLines(node, mode, label) {
  const title = String(label ?? "").trim();
  if (node.type !== "tab") return title ? [{ kind: "title", text: title }] : [];
  const url = String(node.url ?? "").trim();
  const m = TOOLTIP_MODES.includes(mode) ? mode : "url";
  const lines = [];
  if ((m === "title" || m === "both") && title) lines.push({ kind: "title", text: title });
  if ((m === "url" || m === "both") && url && !(lines[0] && lines[0].text === url)) lines.push({ kind: "url", text: url });
  if (!lines.length) {
    const fallback = title || url;
    if (fallback) lines.push({ kind: title ? "title" : "url", text: fallback });
  }
  return lines;
}

// The browser's own tooltip: the same lines, one per row of text.
export function tooltipText(node, mode, label, note = "") {
  return note + hoverLines(node, mode, label).map((l) => l.text).join("\n");
}
