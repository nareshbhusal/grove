import { connect, cmd, h, toast } from "../sidebar/ui/client.js";
import { patternKey, rulePanels } from "../lib/rules.js";

let state = null;
let containers = [];
let schema = { schemas: {}, values: {} };

// While you are in the middle of something (typing, a picker open) the page must not
// be redrawn under you. Each such thing "holds" the redraw; the redraw that was
// skipped happens a moment after the last hold is released (a moment, so that a click
// on a button is not lost by redrawing the button between mouse-down and mouse-up).
const holds = new Set();
let pending = false;
let redrawTimer = null;
const hold = (key) => holds.add(key);
const release = (key) => {
  holds.delete(key);
  if (pending) {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(render, 250);
  }
};
// Wire an input so it holds the redraw while it has focus.
const holdWhileFocused = (input, key) => {
  input.addEventListener("focus", () => hold(key));
  input.addEventListener("blur", () => release(key));
  return input;
};

// What is typed into the "new rule" and "test" rows survives any redraw.
const draft = { pattern: "", panels: [], container: "", testUrl: "", testPanel: "" };

const $ = (id) => document.getElementById(id);

// A panel picker closes when you click anywhere else, or press Escape.
document.addEventListener("mousedown", (e) => {
  for (const d of document.querySelectorAll("details.picker[open]")) if (!d.contains(e.target)) d.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const d of document.querySelectorAll("details.picker[open]")) {
    d.open = false;
    d.querySelector("summary")?.focus();
  }
});
const report = (p) => p.catch((e) => toast(e.message));

function containerSelect(value, onChange, { none = "No container" } = {}) {
  const sel = h("select", { onchange: (e) => onChange(e.target.value || null) },
    h("option", { value: "" }, none),
    ...containers.filter((c) => c.cookieStoreId !== "firefox-default").map((c) => h("option", { value: c.cookieStoreId }, c.name)));
  sel.value = value ?? "";
  return sel;
}

function renderPanels() {
  const body = $("panels-body");
  const rows = [h("div", { class: "head" }), h("div", { class: "head" }, "Name"), h("div", { class: "head" }, "New tabs open in"), h("div", { class: "head" })];
  for (const p of state.panels) {
    rows.push(
      h("input", { type: "color", value: p.color, onchange: (e) => report(cmd("panel:update", { id: p.id, color: e.target.value })) }),
      holdWhileFocused(h("input", { type: "text", value: p.name, onchange: (e) => report(cmd("panel:update", { id: p.id, name: e.target.value.trim() || p.name })) }), `panel-name:${p.id}`),
      containerSelect(p.defaultContainer, (v) => report(cmd("panel:update", { id: p.id, defaultContainer: v }))),
      state.panels.length > 1
        ? h("button", { class: "danger", onclick: () => { if (confirm(`Delete “${p.name}”? Its tabs move to another panel.`)) report(cmd("panel:delete", { id: p.id })); } }, "Delete")
        : h("span")
    );
  }
  body.replaceChildren(
    h("p", { class: "hint" }, "Panels are separate contexts. Switching panels hides the tabs of the others. A panel's container applies to tabs you open in it."),
    h("div", { class: "grid panels" }, ...rows),
    h("div", { class: "row-actions" }, h("button", { onclick: () => report(cmd("panel:create", { name: "New panel" })) }, "Add panel"))
  );
}

function renderRules() {
  const body = $("rules-body");
  const rows = [h("div", { class: "head" }, "Domain pattern"), h("div", { class: "head" }, "In panels"), h("div", { class: "head" }, "Container"), h("div", { class: "head" })];
  // Which panels a rule applies to: none ticked = any panel.
  const panelPicker = (selected, onChange) => {
    let chosen = [...selected];
    const summary = h("summary", {});
    const label = () => {
      const names = chosen.map((id) => state.panels.find((p) => p.id === id)?.name).filter(Boolean);
      summary.textContent = names.length ? names.join(", ") : "Any panel";
    };
    const boxes = new Map();
    const sync = () => { for (const [id, box] of boxes) box.checked = id === "any" ? chosen.length === 0 : chosen.includes(id); label(); };
    const item = (id, text) => {
      const box = h("input", { type: "checkbox", onchange: () => {
        if (id === "any") chosen = [];
        else chosen = box.checked ? [...chosen, id] : chosen.filter((x) => x !== id);
        sync();
        onChange([...chosen]);
      } });
      boxes.set(id, box);
      return h("label", {}, box, text);
    };
    const el = h("details", { class: "picker" }, summary, h("div", { class: "picker-list" }, item("any", "Any panel"), ...state.panels.map((p) => item(p.id, p.name))));
    // Keep the list open while you tick several; any redraw that was held back
    // happens once it closes (and never touches what you typed elsewhere).
    el.addEventListener("toggle", () => (el.open ? hold(el) : release(el)));
    sync();
    return el;
  };

  for (const r of state.rules) {
    const input = holdWhileFocused(h("input", { type: "text", value: r.pattern, spellcheck: "false" }), `rule:${r.id}`);
    input.addEventListener("change", async () => {
      try {
        await cmd("rules:update", { id: r.id, pattern: input.value });
        input.classList.remove("bad");
      } catch (e) {
        input.classList.add("bad");
        toast(e.message);
      }
    });
    rows.push(
      input,
      panelPicker(rulePanels(r), (ids) => report(cmd("rules:update", { id: r.id, panelIds: ids }))),
      containerSelect(r.containerId, (v) => report(cmd("rules:update", { id: r.id, containerId: v ?? "firefox-default" })), { none: "No container" }),
      h("button", { class: "danger", onclick: () => report(cmd("rules:remove", { id: r.id })) }, "Remove")
    );
  }

  // The new-rule row reads from and writes to `draft`, so a redraw rebuilds it as it was.
  const pattern = holdWhileFocused(h("input", { type: "text", placeholder: "github.com", spellcheck: "false", value: draft.pattern }), "new-pattern");
  const panel = panelPicker(draft.panels, (ids) => (draft.panels = ids));
  const container = containerSelect(draft.container || null, (v) => (draft.container = v ?? ""));
  const add = h("button", { class: "primary", onclick: async () => {
    if (!pattern.value.trim()) return toast("Enter a domain pattern");
    try {
      await cmd("rules:add", { pattern: pattern.value, panelIds: draft.panels, containerId: container.value || "firefox-default" });
      draft.pattern = pattern.value = ""; // panels and container stay: the next rule is often for the same ones
      showClash();
    } catch (e) {
      toast(e.message);
    }
  } }, "Add rule");

  // One rule per pattern: say so while typing, before Add fails.
  const clash = h("p", { class: "hint warn", "aria-live": "polite" });
  function showClash() {
    const hit = pattern.value.trim() && state.rules.find((r) => patternKey(r.pattern) === patternKey(pattern.value));
    clash.textContent = hit ? `There is already a rule for “${hit.pattern}”. Edit it above and tick more panels instead.` : "";
    add.disabled = !!hit;
  }
  pattern.addEventListener("input", () => { draft.pattern = pattern.value; showClash(); });
  showClash();

  body.replaceChildren(
    h("p", { class: "hint" },
      "Patterns: ", h("code", {}, "example.com"), " matches the domain and its subdomains, ",
      h("code", {}, "=example.com"), " only that host, ", h("code", {}, "*.example.com"), " subdomains only, ",
      h("code", {}, "example.com/work"), " only that path and below, ",
      h("code", {}, "/regex/"), " tests the full URL. A pasted address works too (https:// and a trailing slash are ignored). ",
      "Each pattern has one rule; tick the panels it applies to (none ticked = every panel). A rule limited to the current panel beats an any-panel rule; otherwise the first match wins. ",
      "Rules apply to every tab, including ones already in a container, except tabs you reopened in a container yourself."),
    state.rules.length ? h("div", { class: "grid rules" }, ...rows) : h("p", { class: "hint" }, "No rules yet."),
    h("div", { class: "grid rules", style: { marginTop: "12px" } }, pattern, panel, container, add),
    clash,
    ruleTester(),
    h("div", { class: "row-actions" }, h("button", { onclick: async () => {
      const name = prompt("New container name");
      if (!name?.trim()) return;
      await report(cmd("containers:create", { name: name.trim() }));
      await loadContainers();
      render();
    } }, "Create container…"))
  );
}

// "What would happen if I opened this address in this panel?"
function ruleTester() {
  const url = holdWhileFocused(h("input", { type: "text", placeholder: "Try an address, e.g. github.com/acme/repo", spellcheck: "false", value: draft.testUrl }), "test-url");
  const panel = h("select", {}, ...state.panels.map((p) => h("option", { value: p.id }, p.name)));
  if (state.panels.some((p) => p.id === draft.testPanel)) panel.value = draft.testPanel;
  const out = h("p", { class: "hint", "aria-live": "polite" });
  const test = async () => {
    if (!url.value.trim()) return (out.textContent = "");
    try {
      const r = await cmd("containers:test", { url: url.value, panelId: panel.value });
      const name = r.containerId ? containers.find((c) => c.cookieStoreId === r.containerId)?.name ?? r.containerId : null;
      out.textContent = !r.containerId
        ? "No rule matches, and the panel has no default container: it opens as usual."
        : r.via === "rule"
          ? `Opens in “${name}” (rule ${r.pattern}).`
          : `Opens in “${name}” (the panel's default container, for new blank tabs).`;
    } catch (e) {
      out.textContent = e.message;
    }
  };
  url.addEventListener("input", () => { draft.testUrl = url.value; test(); });
  panel.addEventListener("change", () => { draft.testPanel = panel.value; test(); });
  test();
  return h("div", { style: { marginTop: "16px" } },
    h("h3", { style: { margin: "0 0 6px", fontSize: "13px" } }, "Test"),
    h("div", { class: "grid rules", style: { gridTemplateColumns: "1fr 170px" } }, url, panel), out);
}

function renderSettings() {
  const body = $("settings-body");
  const out = [];
  for (const [mod, defs] of Object.entries(schema.schemas)) {
    out.push(h("h3", {}, mod));
    for (const [key, def] of Object.entries(defs)) {
      const value = schema.values?.[mod]?.[key] ?? def.default;
      const set = (v) => report(cmd("settings:set", { module: mod, key, value: v }));
      let control;
      if (def.type === "boolean") control = h("input", { type: "checkbox", checked: value ? true : null, onchange: (e) => set(e.target.checked) });
      else if (def.type === "number") control = holdWhileFocused(h("input", { type: "number", value, min: def.min, max: def.max, onchange: (e) => set(e.target.value) }), `s:${mod}.${key}`);
      else if (def.type === "lines") {
        control = holdWhileFocused(h("textarea", { rows: 4, spellcheck: "false", placeholder: "github.com\n*.example.com", onchange: (e) => set(e.target.value) }, value), `s:${mod}.${key}`);
        control.value = value;
      } else if (def.type === "select") {
        control = h("select", { onchange: (e) => set(e.target.value) }, ...def.options.map(([v, l]) => h("option", { value: v, selected: v === value ? true : null }, l)));
      } else control = holdWhileFocused(h("input", { type: "text", value, onchange: (e) => set(e.target.value) }), `s:${mod}.${key}`);
      const id = `s_${mod}_${key}`;
      control.id = id;
      out.push(h("div", { class: "setting" }, h("label", { for: id }, def.label), control));
    }
  }
  body.replaceChildren(...out);
}

function download({ filename, mime, text }) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderData() {
  const body = $("data-body");
  const scope = h("select", {},
    h("option", { value: "all" }, "Everything (all panels, rules, settings)"),
    ...state.panels.map((p) => h("option", { value: p.id }, `Panel: ${p.name}`)));
  // Saved through Firefox's downloads, into the folder set under Settings → backup.
  // If that is refused, fall back to a plain browser download.
  const exportAs = async (format) => {
    const args = scope.value === "all" ? { scope: "all", format } : { scope: "panel", panelId: scope.value, format };
    try {
      const r = await cmd("backup:save", args);
      toast(`Saved ${r.filename} (in your Downloads folder)`);
    } catch (err) {
      try { download(await cmd("io:export", args)); } catch (err2) { toast(err2.message); }
    }
    refreshBackupStatus();
  };

  const file = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
  const mode = h("select", {},
    h("option", { value: "merge" }, "Merge into existing tabs"),
    h("option", { value: "replace" }, "Replace saved tabs and rules"));
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const r = await cmd("io:import", { text: await f.text(), mode: mode.value });
      toast(`Imported ${r.tabs} tabs${r.notes ? ` and ${r.notes} notes` : ""} into ${r.panels} panel(s)${r.panelsCreated ? ` (${r.panelsCreated} new)` : ""}${r.containersCreated ? `, and created ${r.containersCreated} container(s)` : ""}.${r.unreadable ? ` ${r.unreadable} damaged entr${r.unreadable === 1 ? "y was" : "ies were"} skipped.` : ""} Open them from the sidebar.`);
    } catch (e) {
      toast(e.message);
    }
    file.value = "";
  });

  const status = h("p", { class: "hint", id: "backup-status", "aria-live": "polite" });
  body.replaceChildren(
    h("p", { class: "hint" }, "Imported tabs appear greyed out in the tree; click one to open it. Nothing opens automatically."),
    h("div", { class: "grid", style: { gridTemplateColumns: "1fr" } }, scope),
    h("div", { class: "row-actions" },
      h("button", { class: "primary", onclick: () => exportAs("json") }, "Export JSON (backup)"),
      h("button", { onclick: () => exportAs("markdown") }, "Markdown"),
      h("button", { onclick: () => exportAs("html") }, "Bookmarks HTML")),
    h("div", { class: "grid", style: { gridTemplateColumns: "1fr", marginTop: "18px" } }, mode),
    h("div", { class: "row-actions" }, h("button", { onclick: () => file.click() }, "Import JSON…"), file),
    h("h3", {}, "Saving and automatic backups"),
    h("p", { class: "hint" },
      "Exports are saved with the date and time in their name, into a folder inside your Firefox Downloads folder (set the folder, an automatic backup and how many copies to keep under Settings → backup). ",
      "Firefox only lets extensions save inside Downloads; to keep the files somewhere else, point Firefox's download folder there."),
    status,
    h("div", { class: "row-actions" }, h("button", { onclick: async () => {
      try { const r = await cmd("backup:save", { scope: "all", format: "json" }); toast(`Saved ${r.filename}`); } catch (e) { toast(e.message); }
      refreshBackupStatus();
    } }, "Back up everything now"))
  );
  refreshBackupStatus();
}

async function refreshBackupStatus() {
  const el = $("backup-status");
  if (!el) return;
  try {
    const s = await cmd("backup:status");
    const at = (ms) => new Date(ms).toLocaleString();
    const parts = [];
    if (!s.latest && !s.periodic) parts.push("Automatic backup is off.");
    if (s.latest) parts.push(s.latestAt ? `Up-to-date file: ${s.latestFile}, saved ${at(s.latestAt)}.` : `Up-to-date file: ${s.folder ? `${s.folder}/` : ""}${s.latestName}, nothing saved yet.`);
    if (s.periodic) parts.push(s.periodicAt ? `Latest timestamped copy: ${s.periodicFile}, saved ${at(s.periodicAt)}.` : "Timestamped copies: nothing saved yet.");
    if (s.pending) parts.push("Changes are waiting to be saved.");
    if (s.lastError) parts.push(`Problem: ${s.lastError}`);
    el.textContent = parts.join(" ");
    el.classList.toggle("warn", !!s.lastError);
  } catch (e) {
    el.textContent = e.message;
  }
}

const STRIP_CSS = "#TabsToolbar { visibility: collapse !important; }";

// Firefox does not let any extension change its own toolbars, so this cannot be
// a switch. It is a three-step recipe with the one line to paste.
function renderStrip() {
  $("strip-body").replaceChildren(
    h("p", { class: "hint" },
      "Firefox does not let extensions hide or restyle its own tab strip, so Grove cannot offer a switch for it. ",
      "A one-time change in your profile does it:"),
    h("ol", { class: "steps" },
      h("li", {}, "Open ", h("code", {}, "about:config"), ", and set ", h("code", {}, "toolkit.legacyUserProfileCustomizations.stylesheets"), " to ", h("code", {}, "true"), "."),
      h("li", {}, "Open ", h("code", {}, "about:support"), ", click “Open Folder” next to Profile Folder, and create a folder named ", h("code", {}, "chrome"), " in it."),
      h("li", {}, "In that folder create ", h("code", {}, "userChrome.css"), " containing the line below, then restart Firefox.")),
    h("pre", { class: "snippet" }, STRIP_CSS),
    h("div", { class: "row-actions" }, h("button", { onclick: async () => {
      try { await navigator.clipboard.writeText(STRIP_CSS); toast("Copied"); } catch { toast("Could not copy; select the line and copy it"); }
    } }, "Copy the line")),
    h("p", { class: "hint" }, "To undo it, delete the line. Pinned tabs live only in Firefox's own strip for now (Grove lists the others), so with the strip hidden they are reachable from the tab list in the address bar menu."));
}

function when(ms) {
  return new Date(ms).toLocaleTimeString();
}

async function renderDiagnostics() {
  const body = $("diagnostics-body");
  const on = schema.values?.diagnostics?.enabled ?? true;
  const toggle = h("button", { onclick: async () => { await report(cmd("settings:set", { module: "diagnostics", key: "enabled", value: !on })); } }, on ? "Turn off" : "Turn on");
  let placement = [];
  let route = [];
  try {
    [placement, route] = await Promise.all([cmd("diag:list", { kind: "placement" }), cmd("diag:list", { kind: "route" })]);
  } catch (e) {
    body.textContent = e.message;
    return;
  }
  const name = (id) => containers.find((c) => c.cookieStoreId === id)?.name ?? (id || "-");
  const table = (head, rows) =>
    rows.length
      ? h("table", { class: "diag" }, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", {}, x)))), h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((c) => h("td", {}, c))))))
      : h("p", { class: "hint" }, "Nothing recorded yet.");
  body.replaceChildren(
    h("p", { class: "hint" }, on
      ? "The last decisions Grove made, kept in memory only. If a tab ends up in the wrong place or a container rule does not fire, look here first. Turn this off if you do not want it recording."
      : "Diagnostics are off: nothing new is being recorded. Turn it on, reproduce the problem, and come back here."),
    h("div", { class: "row-actions" }, toggle),
    h("h3", {}, "Where new tabs were placed"),
    h("p", { class: "hint" }, "“signal” is how Grove knew a tab came from a link: opener or navigation. “none” means it treated the tab as opened by you."),
    table(["Time", "Address", "Signal", "Result"], placement.slice(0, 25).map((e) => [when(e.at), e.url ?? "", e.signal, e.result])),
    h("h3", {}, "Container routing"),
    table(["Time", "Address", "Panel", "Tab in", "Wanted", "Action", "Why"],
      route.slice(0, 25).map((e) => [when(e.at), e.url ?? "", e.panel ?? "", name(e.tabContainer), e.wanted ? name(e.wanted) : "-", e.action, e.reason ?? ""])),
    h("div", { class: "row-actions" },
      h("button", { onclick: renderDiagnostics }, "Refresh"),
      h("button", { onclick: async () => { await cmd("diag:clear"); renderDiagnostics(); } }, "Clear"))
  );
}

async function loadContainers() {
  try { containers = await cmd("containers:list"); } catch { containers = []; }
}

function render() {
  if (!state) return;
  if (holds.size) { pending = true; return; }
  pending = false;
  renderPanels();
  renderRules();
  renderSettings();
  renderData();
  renderDiagnostics();
}

async function main() {
  renderStrip();
  await loadContainers();
  connect(async (next) => {
    state = next;
    try { schema = await cmd("settings:schema"); } catch { /* keep old */ }
    render();
  });
}
main();
