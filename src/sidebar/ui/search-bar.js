// The search field. Collapsed until you ask for it (the search button, Ctrl+F, or "/"),
// and aimed at where you are: the panel, or the open folder with its subfolders.
//
// It only owns the field. The list under it filters itself from `query()`, and tells
// this bar how many results there are so it can say so.
//
//   Up / Down  move through the results      Enter  open the highlighted one
//   Esc        close and clear the search

import { h } from "./client.js";
import { icon } from "./icons.js";

export function createSearchBar({ root, onChange, onMove, onEnter, onToggle = () => {} }) {
  let open = false;
  let scope = "";

  const input = h("input", {
    type: "text",
    class: "search-input",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Search",
    title: 'Every word must match the title or address. Use AND between terms, "quotes" for an exact phrase.',
  });
  const status = h("span", { class: "search-status", "aria-live": "polite" });
  const close = h("button", { class: "tool small", title: "Close search (Esc)", "aria-label": "Close search", onclick: () => api.close() }, icon("close", { size: 12 }));
  const tip = h("div", { class: "search-tip" }, "Every word must match the title or address. ", h("b", {}, "AND"), " is optional; ", h("b", {}, "“quotes”"), " keep words together.");
  const box = h("div", { class: "search-box" }, icon("search", { size: 14, cls: "search-glass" }), input, status, close);
  root.replaceChildren(box, tip);

  function changed() {
    tip.hidden = !!input.value;
    onChange();
  }
  input.addEventListener("input", changed);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); onMove(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); onMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); onEnter(); }
  });

  // Ctrl/Cmd+F anywhere in the sidebar, or "/" when you are not typing somewhere.
  document.addEventListener("keydown", (e) => {
    const typing = /^(input|textarea|select)$/i.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
    if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); api.show(); }
    else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); api.show(); }
  });

  const api = {
    isOpen: () => open,
    query: () => (open ? input.value : ""),
    show() {
      if (!open) {
        open = true;
        root.hidden = false;
        onToggle(true);
      }
      changed();
      input.focus();
      input.select();
    },
    close() {
      if (!open) return;
      open = false;
      input.value = "";
      root.hidden = true;
      status.textContent = "";
      changed();
      onToggle(false);
    },
    toggle() { open ? api.close() : api.show(); },
    // Where the search is aimed, e.g. “Main” or “Research” and subfolders.
    setScope(text) {
      scope = text;
      input.placeholder = `Search ${scope}`;
    },
    // Called by the list after it has filtered.
    setCount(n, searching) {
      status.textContent = !searching ? "" : n === 0 ? "No matches" : n === 1 ? "1 match" : `${n} matches`;
      status.classList.toggle("none", searching && n === 0);
    },
  };
  return api;
}
