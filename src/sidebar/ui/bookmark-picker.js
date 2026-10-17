// "Save to which folder?": the real bookmark folders as a small tree, one of them chosen.
//
//   const r = await pickBookmarkFolder({ title, initial });   -> { id, makeDefault } | null
//
// Opens on the folder you used last (or your default), unfolded so it is in view. "New folder…" makes one
// inside the chosen folder. The checkbox sets the chosen folder as the default and stops the question
// being asked (Settings → bookmarks turns asking back on).

import { h, cmd, toast } from "./client.js";
import { icon, twistyIcon } from "./icons.js";
import { askText } from "./dialog.js";

const NAMES = { menu________: "Menu", toolbar_____: "Toolbar", unfiled_____: "Other", mobile______: "Mobile" };
// Toolbar and Other first; the Menu folder, which is rarely used, last, and only when it holds something.
const ORDER = ["toolbar_____", "unfiled_____", "mobile______", "menu________"];

export async function pickBookmarkFolder({ title = "Save to…", initial = "unfiled_____" } = {}) {
  let roots;
  try {
    ({ roots } = await cmd("bookmarks:tree"));
  } catch (err) {
    toast(err.message);
    return null;
  }
  const folders = (list) => (list ?? []).filter((n) => n.type === "folder");
  const tops = ORDER.map((id) => roots.find((r) => r.id === id)).filter((r) => r && (r.id !== "menu________" || r.children?.length || r.id === initial || folders(r.children).length));
  const parents = new Map(); // id -> parent id
  const known = new Set();
  const walk = (n, parent) => { known.add(n.id); parents.set(n.id, parent); folders(n.children).forEach((c) => walk(c, n.id)); };
  tops.forEach((r) => walk(r, null));

  let chosen = known.has(initial) ? initial : "unfiled_____";
  const open = new Set();
  for (let p = parents.get(chosen); p; p = parents.get(p)) open.add(p);
  const byId = new Map();
  const index = (n) => { byId.set(n.id, n); folders(n.children).forEach(index); };
  tops.forEach(index);

  return new Promise((resolve) => {
    const tree = h("div", { class: "picker-tree", role: "tree", tabindex: "0", "aria-label": "Bookmark folders" });
    const always = h("input", { type: "checkbox", id: "picker-default" });
    const done = (value) => { wrap.remove(); resolve(value); };

    function rows(list, depth, out) {
      for (const n of list) {
        const kids = folders(n.children);
        const isOpen = open.has(n.id);
        const row = h("div", {
          class: `row picker-row${n.id === chosen ? " chosen" : ""}`, role: "treeitem", "aria-selected": String(n.id === chosen), "aria-expanded": kids.length ? String(isOpen) : null,
          dataset: { id: n.id }, style: { paddingLeft: `${4 + depth * 14}px` },
        },
          h("span", { class: `twisty${kids.length ? " has" : ""}${isOpen ? " open" : ""}`, onclick: (e) => { if (!kids.length) return; e.stopPropagation(); isOpen ? open.delete(n.id) : open.add(n.id); draw(); } }, kids.length ? twistyIcon() : null),
          icon("folder", { cls: "folder-icon" }),
          h("span", { class: "title" }, NAMES[n.id] ?? (n.title || "Untitled folder")));
        row.addEventListener("click", () => { chosen = n.id; draw(); });
        row.addEventListener("dblclick", () => save());
        out.push(row);
        if (isOpen) rows(kids, depth + 1, out);
      }
      return out;
    }
    function draw() {
      tree.replaceChildren(...rows(tops, 0, []));
      tree.querySelector(".chosen")?.scrollIntoView({ block: "nearest" });
    }
    const save = () => done({ id: chosen, makeDefault: always.checked });

    async function newFolder() {
      const name = await askText("Folder name", "New folder");
      if (!name) return;
      try {
        const id = await cmd("bookmarks:create", { parentId: chosen, title: name });
        const fresh = { id, title: name, type: "folder", children: [] };
        const parent = byId.get(chosen);
        (parent.children ??= []).push(fresh);
        byId.set(id, fresh);
        parents.set(id, chosen);
        known.add(id);
        open.add(chosen);
        chosen = id;
        draw();
      } catch (err) {
        toast(err.message);
      }
    }

    const wrap = h("div", { class: "overlay" },
      h("div", { class: "dialog picker" },
        h("div", { class: "dialog-title" }, title),
        tree,
        h("label", { class: "picker-always", for: "picker-default" }, always, h("span", {}, "Always save here, and stop asking")),
        h("div", { class: "dialog-actions" },
          h("button", { class: "picker-new", onclick: newFolder }, "New folder…"),
          h("span", { class: "spacer" }),
          h("button", { onclick: () => done(null) }, "Cancel"),
          h("button", { class: "primary", onclick: save }, "Save"))));
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(null); });
    wrap.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input[type=text]")) return;
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      else if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const ids = [...tree.querySelectorAll(".picker-row")].map((r) => r.dataset.id);
        chosen = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(chosen) + (e.key === "ArrowDown" ? 1 : -1)))];
        draw();
      } else if (e.key === "ArrowRight" && byId.get(chosen)?.children?.some((c) => c.type === "folder")) { open.add(chosen); draw(); }
      else if (e.key === "ArrowLeft") { if (open.has(chosen)) open.delete(chosen); else if (parents.get(chosen)) chosen = parents.get(chosen); draw(); }
    });
    document.body.appendChild(wrap);
    draw();
    tree.focus();
  });
}
