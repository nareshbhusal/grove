// "Containers for this folder…": everything about containers for one folder, in one place.
//
//   - the container new tabs in the folder open in (same as around it / none / one of yours);
//   - the sites that always open in a container while in this folder (domain rules limited to it).
//
// A rule that also applies somewhere else (another folder or panel) is listed too, marked as shared;
// "Remove" then only takes it out of this folder. Changing its container changes it everywhere it
// applies, which is what the mark is there to say.

import { h, run, cmd, toast } from "./client.js";
import { rulePanels, ruleFolders, patternKey } from "../../lib/rules.js";

export function createFolderContainers({ getState, getContainers }) {
  let open = null; // { id, wrap, refresh }

  function close() {
    open?.wrap.remove();
    open = null;
  }

  function show(folderId) {
    close();
    const folder = getState()?.nodes?.[folderId];
    if (!folder || folder.type !== "folder") return;

    const select = (value, onChange, { inherit = false } = {}) => {
      const sel = h("select", { onchange: (e) => onChange(e.target.value || null) },
        ...(inherit ? [h("option", { value: "" }, "Same as around it")] : []),
        ...getContainers().map((c) => h("option", { value: c.cookieStoreId }, c.name)));
      sel.value = value ?? (inherit ? "" : getContainers()[0]?.cookieStoreId ?? "");
      return sel;
    };
    const nameOf = (id) => getContainers().find((c) => c.cookieStoreId === id)?.name ?? id;

    const title = h("div", { class: "dialog-title" });
    const dflt = h("div", { class: "fc-default" });
    const list = h("div", { class: "fc-rules" });
    const pattern = h("input", { class: "dialog-input", placeholder: "github.com", spellcheck: "false" });
    let newContainer = getContainers().find((c) => c.cookieStoreId !== "firefox-default")?.cookieStoreId ?? "firefox-default";
    const newSel = select(newContainer, (v) => { newContainer = v ?? newContainer; });

    async function add() {
      const text = pattern.value.trim();
      if (!text) return pattern.focus();
      const clash = getState().rules.find((r) => patternKey(r.pattern) === patternKey(text));
      if (clash) {
        const here = ruleFolders(clash).includes(folderId);
        toast(here
          ? `“${clash.pattern}” already has a rule in this folder.`
          : `“${clash.pattern}” already has a rule (${nameOf(clash.containerId)}) for another place. Edit it in Settings → Container rules and tick this folder.`);
        return;
      }
      try {
        await cmd("rules:add", { pattern: text, folderIds: [folderId], containerId: newSel.value || newContainer });
        pattern.value = "";
        pattern.focus();
      } catch (err) {
        toast(err.message);
      }
    }
    pattern.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
      if (e.key === "Escape") close();
    });

    const here = () => getState().rules.filter((r) => ruleFolders(r).includes(folderId));

    function refresh() {
      const now = getState()?.nodes?.[folderId];
      if (!now || now.type !== "folder") return close();
      title.textContent = `Containers for “${now.name || "Folder"}”`;

      // The list is redrawn on every change (including the click that removed a row, which leaves the
      // focus on a button that is about to disappear). A select you are using keeps its focus.
      const focusedSelect = (box) => (document.activeElement?.tagName === "SELECT" ? [...box.querySelectorAll("select")].indexOf(document.activeElement) : -1);

      const dAt = focusedSelect(dflt);
      dflt.replaceChildren(
        h("label", {}, "New tabs open in"),
        select(now.defaultContainer ?? null, (v) => run("folder:setContainer", { id: folderId, defaultContainer: v }), { inherit: true }));
      if (dAt >= 0) dflt.querySelector("select").focus();

      const lAt = focusedSelect(list);
      const rules = here();
      list.replaceChildren(
        h("div", { class: "fc-head" }, "Sites that open in a container here"),
        ...(rules.length ? rules.map((r) => {
          const shared = rulePanels(r).length + ruleFolders(r).length - 1;
          return h("div", { class: "fc-rule" },
            h("span", { class: "fc-pattern", title: shared > 0 ? `${r.pattern}: also applies in ${shared} other place${shared === 1 ? "" : "s"}` : r.pattern },
              r.pattern, shared > 0 ? h("span", { class: "fc-shared" }, ` +${shared}`) : null),
            select(r.containerId, (v) => run("rules:update", { id: r.id, containerId: v ?? "firefox-default" })),
            h("button", { class: "fc-x", title: shared > 0 ? "Stop applying it in this folder" : "Remove rule", "aria-label": "Remove",
              onclick: () => (shared > 0
                ? run("rules:update", { id: r.id, folderIds: ruleFolders(r).filter((f) => f !== folderId), panelIds: rulePanels(r) })
                : run("rules:remove", { id: r.id })) }, "×"));
        }) : [h("div", { class: "fc-empty" }, "None yet.")]));
      if (lAt >= 0) list.querySelectorAll("select")[lAt]?.focus();
    }

    const wrap = h("div", { class: "overlay" },
      h("div", { class: "dialog fc" },
        title,
        dflt,
        list,
        h("div", { class: "fc-add" }, pattern, newSel, h("button", { class: "primary", onclick: add }, "Add")),
        h("div", { class: "fc-note" }, "A site rule beats the folder's container, and applies in subfolders too. Domains: example.com (and subdomains), =example.com, *.example.com, example.com/path."),
        h("div", { class: "dialog-actions" }, h("button", { class: "primary", onclick: close }, "Done"))));
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    open = { id: folderId, wrap, refresh };
    refresh();
    pattern.focus();
  }

  return { show, refresh: () => open?.refresh(), close };
}
