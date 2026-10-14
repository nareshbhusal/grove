// Note editor: a pane docked under the tab list, so a note can be read and
// written while the tabs stay in view. Drag the divider (or use the arrow keys
// on it) to give the note more or less room. Plain text, autosaved; the title
// field renames the note; the download button saves it as a .txt file.

import { h, cmd, toast } from "./client.js";
import { icon } from "./icons.js";

const SAVE_DELAY = 400;
const MIN_NOTE = 110; // px
const MIN_LIST = 120; // px the tab list always keeps
const HEIGHT_KEY = "grove:noteHeight";

function loadHeight() {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function createNoteEditor({ root, splitter, list, onChange = () => {} }) {
  let id = null;
  let timer = null;
  let dirty = false;
  let title;
  let area;
  let height = loadHeight();

  // The list and the note share a fixed amount of room: the list keeps MIN_LIST of it.
  const maxHeight = () => Math.max(MIN_NOTE, list.offsetHeight + root.offsetHeight - MIN_LIST);
  const clamp = (n) => Math.round(Math.min(Math.max(n, MIN_NOTE), maxHeight()));

  function applyHeight() {
    const preferred = height ?? Math.round(window.innerHeight * 0.42);
    root.style.height = `${clamp(preferred)}px`;
  }

  function setHeight(n) {
    height = clamp(n);
    applyHeight();
    try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* storage unavailable: height just is not remembered */ }
  }

  async function save() {
    clearTimeout(timer);
    timer = null;
    if (id == null || !dirty) return;
    dirty = false;
    try {
      await cmd("note:save", { id, text: area.value, name: title.value });
    } catch (err) {
      dirty = true;
      toast(`Could not save the note: ${err.message}`);
    }
  }

  const touch = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY);
  };

  function download() {
    const name = (title.value.trim() || "note").replace(/[\\/:*?"<>|]+/g, "-");
    const url = URL.createObjectURL(new Blob([area.value], { type: "text/plain;charset=utf-8" }));
    const a = h("a", { href: url, download: `${name}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function open(noteId) {
    if (id === noteId) {
      area?.focus();
      return;
    }
    await save(); // switching notes: keep what was typed in the previous one
    let note;
    try {
      note = await cmd("note:get", { id: noteId });
    } catch (err) {
      toast(err.message);
      return;
    }
    id = noteId;
    dirty = false;
    title = h("input", { class: "note-title", value: note.name, spellcheck: "false", "aria-label": "Note title", oninput: touch });
    area = h("textarea", { class: "note-text", spellcheck: "true", "aria-label": "Note text", placeholder: "Write something…", oninput: touch });
    area.value = note.text;
    root.replaceChildren(
      h("div", { class: "note-head" },
        icon("note", { size: 16, cls: "note-icon" }),
        title,
        h("button", { class: "tool", title: "Download as .txt", "aria-label": "Download as .txt", onclick: download }, icon("download", { size: 18 })),
        h("button", { class: "tool", title: "Close note", "aria-label": "Close note", onclick: () => close() }, icon("close", { size: 16 }))),
      area
    );
    root.hidden = false;
    splitter.hidden = false;
    applyHeight();
    onChange(true);
    area.focus();
  }

  async function close() {
    await save();
    id = null;
    root.hidden = true;
    splitter.hidden = true;
    root.replaceChildren();
    onChange(false);
  }

  // ---- divider ----------------------------------------------------------

  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    const bottom = root.getBoundingClientRect().bottom;
    const move = (ev) => setHeight(bottom - ev.clientY);
    const up = () => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    setHeight(root.offsetHeight + (e.key === "ArrowUp" ? 24 : -24));
  });
  window.addEventListener("resize", () => id != null && applyHeight());

  window.addEventListener("blur", save);
  document.addEventListener("visibilitychange", () => document.hidden && save());

  return { open, close, isOpen: () => id != null, currentId: () => id };
}
