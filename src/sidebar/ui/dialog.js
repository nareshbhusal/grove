// Tiny in-page dialogs. window.prompt/confirm are unreliable inside extension
// sidebars, so use these instead.

import { h } from "./client.js";

function overlay(content) {
  const wrap = h("div", { class: "overlay" }, h("div", { class: "dialog" }, content));
  document.body.appendChild(wrap);
  return wrap;
}

export function askText(title, initial = "") {
  return new Promise((resolve) => {
    const input = h("input", { class: "dialog-input", value: initial, spellcheck: "false" });
    const done = (value) => { wrap.remove(); resolve(value); };
    const wrap = overlay([
      h("div", { class: "dialog-title" }, title),
      input,
      h("div", { class: "dialog-actions" },
        h("button", { onclick: () => done(null) }, "Cancel"),
        h("button", { class: "primary", onclick: () => done(input.value.trim() || null) }, "OK")),
    ]);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    });
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(null); });
    input.focus();
    input.select();
  });
}

export function askConfirm(message, okLabel = "OK") {
  return new Promise((resolve) => {
    const done = (value) => { wrap.remove(); resolve(value); };
    const wrap = overlay([
      h("div", { class: "dialog-title" }, message),
      h("div", { class: "dialog-actions" },
        h("button", { onclick: () => done(false) }, "Cancel"),
        h("button", { class: "primary", onclick: () => done(true) }, okLabel)),
    ]);
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(false); });
  });
}
