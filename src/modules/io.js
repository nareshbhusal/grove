// io: export and import of tab data.
//
// Formats:
//   json      full-fidelity backup: panels, folders (nested), tabs, notes with their text,
//             and for scope "all" also container rules, settings and the containers
//             themselves (name, colour, icon). Containers are matched by NAME on import,
//             because Firefox container ids differ between profiles.
//   markdown  readable nested bullet list of links (export only)
//   html      Netscape bookmarks file, openable by any browser (export only)
//
// Import merges: imported tabs become "saved" ghost nodes (no live browser tab
// until you open them) so a big import does not open hundreds of tabs.
//
// Commands:
//   io:export { scope: "all" | "panel", panelId, format }  -> { filename, mime, text }
//   io:import { text, mode: "merge" | "replace", panelId? } -> { panels, tabs }

import { uid } from "../lib/util.js";
import * as T from "../lib/tree.js";
import { migrateRules, rulePanels, ruleFolders, isGlobal, patternKey } from "../lib/rules.js";

export const FORMAT_VERSION = 1;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function label(n) {
  if (n.type === "folder") return n.name || "Folder";
  if (n.type === "note") return n.name || "Untitled note";
  return n.customTitle || n.title || n.url || "Untitled";
}

export function toMarkdown(panelName, forest) {
  const lines = [`## ${panelName}`, ""];
  const walk = (list, depth) => {
    for (const n of list) {
      const pad = "  ".repeat(depth);
      if (n.type === "folder") lines.push(`${pad}- **${n.name || "Folder"}**`);
      else if (n.type === "note") {
        lines.push(`${pad}- 📝 **${label(n)}**`);
        for (const line of String(n.text ?? "").split("\n")) lines.push(`${pad}  > ${line}`);
      } else lines.push(`${pad}- [${label(n).replace(/[\[\]]/g, "")}](${n.url || ""})`);
      walk(n.children, depth + 1);
    }
  };
  walk(forest, 0);
  return lines.join("\n") + "\n";
}

export function toNetscape(panels) {
  const out = ["<!DOCTYPE NETSCAPE-Bookmark-file-1>", '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', "<TITLE>Bookmarks</TITLE>", "<H1>Bookmarks</H1>", "<DL><p>"];
  const walk = (list, depth) => {
    const pad = "    ".repeat(depth);
    for (const n of list) {
      if (n.type === "note") continue; // bookmarks have no place for free text
      if (n.type === "folder" || n.children.length) {
        out.push(`${pad}<DT><H3>${esc(label(n))}</H3>`, `${pad}<DL><p>`);
        if (n.type === "tab" && n.url) out.push(`${pad}    <DT><A HREF="${esc(n.url)}">${esc(label(n))}</A>`);
        walk(n.children, depth + 1);
        out.push(`${pad}</DL><p>`);
      } else {
        out.push(`${pad}<DT><A HREF="${esc(n.url)}">${esc(label(n))}</A>`);
      }
    }
  };
  for (const { panel, forest } of panels) {
    out.push(`    <DT><H3>${esc(panel.name)}</H3>`, "    <DL><p>");
    walk(forest, 2);
    out.push("    </DL><p>");
  }
  out.push("</DL><p>");
  return out.join("\n") + "\n";
}

const KEEP = ["type", "url", "title", "customTitle", "name", "collapsed", "cookieStoreId", "defaultContainer", "pinned", "favIconUrl"];
const pickPersistent = (n) => Object.fromEntries(KEEP.filter((k) => n[k] !== undefined && n[k] !== null).map((k) => [k, n[k]]));

export default {
  name: "io",
  deps: ["tree", "panels", "settings", "notes", "containers", "bookmarks"],

  setup({ api, commands, store, bus, modules }) {
    const { tree, panels, notes, containers, bookmarks } = modules;

    async function collect(panelIds) {
      const nodes = T.withoutPrivate(tree.all()); // private tabs are never exported
      const noteIds = Object.values(nodes).filter((n) => n.type === "note").map((n) => n.id);
      const text = await notes.bodies(noteIds);
      // A folder carries its id as `ref`, so rules that name it can find it again on import.
      const pick = (n) =>
        n.type === "note" ? { ...pickPersistent(n), text: text[n.id] ?? "" }
        : n.type === "folder" ? { ...pickPersistent(n), ref: n.id }
        : pickPersistent(n);
      return panelIds
        .map((id) => panels.find(id))
        .filter((p) => p && !p.private)
        .map((panel) => ({ panel, forest: T.toNested(nodes, panel.id, pick) }));
    }

    // Local time, safe in a file name: 2026-10-12_14-30-05
    const timestamp = (d = new Date()) => {
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    };

    // `digest` is the same for two exports of identical data (the export time is
    // left out of it), so a periodic backup can skip writing an unchanged file.
    async function exportData({ scope = "all", panelId = null, format = "json" } = {}) {
      const ids = scope === "panel" && panelId ? [panelId] : panels.listFor(false).map((p) => p.id); // the private space is never exported
      const data = await collect(ids);
      const stamp = timestamp();

      if (format === "markdown") {
        const text = data.map((d) => toMarkdown(d.panel.name, d.forest)).join("\n");
        return { filename: `grove-${stamp}.md`, mime: "text/markdown", text, digest: text };
      }
      if (format === "html") {
        const text = toNetscape(data);
        return { filename: `grove-${stamp}.html`, mime: "text/html", text, digest: text };
      }

      const payload = {
        grove: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        panels: data.map(({ panel, forest }) => ({ ...panel, tree: forest })),
      };
      // Containers any panel, rule or tab refers to, so a fresh profile can recreate them.
      const used = new Set();
      for (const { panel, forest } of data) {
        if (panel.defaultContainer) used.add(panel.defaultContainer);
        const walk = (list) => list.forEach((n) => {
          if (n.cookieStoreId) used.add(n.cookieStoreId);
          if (n.defaultContainer) used.add(n.defaultContainer);
          walk(n.children);
        });
        walk(forest);
      }
      if (scope === "all") {
        payload.rules = store.get("rules");
        payload.settings = store.get("settings");
        for (const r of payload.rules) if (r.containerId) used.add(r.containerId);
      }
      if (scope === "all") {
        const marks = await bookmarks.snapshot(); // the browser's own bookmarks, as a copy (null when switched off)
        if (marks) payload.bookmarks = marks;
      }
      used.delete("firefox-default");
      const known = await containers.listContainers();
      payload.containers = known
        .filter((c) => used.has(c.cookieStoreId))
        .map(({ cookieStoreId, name, color, icon }) => ({ cookieStoreId, name, color, icon }));
      const digest = JSON.stringify({ ...payload, exportedAt: null });
      return { filename: `grove-${stamp}.json`, mime: "application/json", text: JSON.stringify(payload, null, 2), digest };
    }

    commands.register("io:export", async (args) => {
      const { digest, ...file } = await exportData(args);
      return file;
    });

    function validate(payload) {
      if (!payload || typeof payload !== "object" || payload.grove == null) throw new Error("Not a Grove export file");
      if (payload.grove > FORMAT_VERSION) throw new Error("This file was made by a newer version of Grove");
      if (!Array.isArray(payload.panels)) throw new Error("Export file has no panels");
    }

    // Imported nodes are always inert: no tabId, flagged saved.
    const sanitize = (forest, mapContainer) =>
      (Array.isArray(forest) ? forest : []).map((n) => {
        const type = n.type === "folder" ? "folder" : n.type === "note" ? "note" : "tab";
        const picked = pickPersistent(n);
        if (picked.cookieStoreId) picked.cookieStoreId = mapContainer(picked.cookieStoreId);
        if (type === "folder") {
          if (picked.defaultContainer) picked.defaultContainer = mapContainer(picked.defaultContainer);
          if (typeof n.ref === "string") picked.ref = n.ref; // see below: rules find their folders by it
        } else delete picked.defaultContainer;
        return {
          ...picked,
          ...(type === "note" ? { text: String(n.text ?? "") } : {}),
          type,
          saved: true,
          children: sanitize(n.children, mapContainer),
        };
      });

    // Container ids belong to a profile. Match the file's containers to this
    // profile's by name, creating the ones that are missing, and translate ids.
    async function containerMapper(list) {
      const map = new Map();
      let created = 0;
      const have = await containers.listContainers();
      for (const c of Array.isArray(list) ? list : []) {
        if (!c?.cookieStoreId || !c.name) continue;
        let match = have.find((h) => h.name === c.name);
        if (!match) {
          try {
            match = await api.contextualIdentities.create({ name: c.name, color: c.color ?? "blue", icon: c.icon ?? "fingerprint" });
            have.push(match);
            created++;
          } catch {
            continue; // cannot create it: the id stays as it was
          }
        }
        map.set(c.cookieStoreId, match.cookieStoreId);
      }
      return { map: (id) => map.get(id) ?? id, created };
    }

    // Which panel here does each panel in the file go to? Every panel in the file
    // lands in exactly one panel, and no two of them in the same one:
    //   1. a panel here with the same id (the same profile, or a restored one);
    //   2. else one with the same NAME that no other panel in the file has claimed
    //      (ids differ between profiles; two panels may even share a name);
    //   3. else a new panel, appended after the existing ones in the file's order.
    // Panels made by this import are never matched, so two new panels can not merge.
    function planPanels(incoming, existing, forcedId) {
      const claimed = new Set();
      const targets = new Array(incoming.length).fill(null);
      if (forcedId) return { targets: targets.fill(forcedId), created: [] };
      incoming.forEach((p, i) => {
        const hit = existing.find((e) => e.id === p.id && !claimed.has(e.id));
        if (hit) { targets[i] = hit.id; claimed.add(hit.id); }
      });
      incoming.forEach((p, i) => {
        if (targets[i] || typeof p.name !== "string") return;
        const hit = existing.find((e) => e.name === p.name && !claimed.has(e.id));
        if (hit) { targets[i] = hit.id; claimed.add(hit.id); }
      });
      const created = [];
      incoming.forEach((p, i) => {
        if (targets[i]) return;
        const panel = {
          id: uid("p"),
          name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Imported",
          color: /^#[0-9a-f]{3,8}$/i.test(p.color ?? "") ? p.color : "#8a8a8a",
          icon: typeof p.icon === "string" ? p.icon : null,
          defaultContainer: p.defaultContainer ?? null,
        };
        created.push(panel);
        targets[i] = panel.id;
      });
      return { targets, created };
    }

    // The file is read and checked completely BEFORE anything here is changed, so a
    // damaged file can not leave half an import (or a cleared "replace") behind.
    commands.register("io:import", async ({ text, mode = "merge", panelId = null }) => {
      let payload;
      try {
        payload = typeof text === "string" ? JSON.parse(text) : text;
      } catch {
        throw new Error("File is not valid JSON");
      }
      validate(payload);
      if (panelId && (!panels.find(panelId) || panels.find(panelId).private)) throw new Error("That panel no longer exists");
      const incoming = payload.panels.filter((p) => p && typeof p === "object" && !Array.isArray(p));
      const unreadable = payload.panels.length - incoming.length;

      const { map: mapContainer, created: containersCreated } = await containerMapper(payload.containers);
      const existing = panels.listFor(false); // incoming panels never merge into private ones
      const { targets, created } = planPanels(incoming, existing, panelId);
      for (const c of created) if (c.defaultContainer) c.defaultContainer = mapContainer(c.defaultContainer);
      const forests = incoming.map((p) => sanitize(p.tree, mapContainer));
      let tabCount = 0;
      let noteCount = 0;
      const count = (forest) => forest.forEach((n) => { if (n.type === "tab") tabCount++; if (n.type === "note") noteCount++; count(n.children); });
      forests.forEach(count);

      // Panels first, so no node ever refers to a panel that does not exist yet.
      if (created.length) {
        store.set("panels", [...panels.list(), ...created]);
        await bus.emit("panel:changed", { reason: "import" });
      }
      const allPanels = [...existing, ...created];

      if (mode === "replace") {
        // Drop every existing node that has no live tab; keep live ones in place.
        const cleared = [];
        tree.mutate((all) => {
          for (const n of Object.values(all)) {
            if (n.private) continue; // the private space is not part of what an import replaces
            if (n.type !== "tab" || n.tabId == null) {
              cleared.push(n.id);
              delete all[n.id];
            }
          }
          T.normalize(all); // live tabs that sat in a deleted folder go to the top level
        }, "import-clear");
        if (cleared.length) await bus.emit("tree:removed", { ids: cleared });
      }

      const bodies = [];
      const folderRefs = new Map(); // a folder's id in the file -> its id here
      const added = new Map(); // panel here -> how many top-level nodes this import has put in it
      tree.mutate((all) => {
        incoming.forEach((_, i) => {
          const target = targets[i];
          const start = T.childrenOf(all, null, target).length + (added.get(target) ?? 0);
          const fresh = T.fromNested(forests[i], target, () => uid("t"));
          let top = 0;
          for (const n of Object.values(fresh)) {
            if (n.parentId === null) { n.order += start; top++; }
            if (n.type === "note") {
              bodies.push([n.id, n.text]);
              delete n.text;
            }
            if (n.ref !== undefined) {
              if (n.type === "folder") folderRefs.set(n.ref, n.id);
              delete n.ref;
            }
            all[n.id] = n;
          }
          added.set(target, (added.get(target) ?? 0) + top);
        });
        T.normalize(all); // an import may come from an older version or by hand
      }, "import");

      // Rules refer to panels by id: follow each panel in the file to where it went.
      const panelIdMap = new Map();
      incoming.forEach((p, i) => { if (p.id != null) panelIdMap.set(p.id, targets[i]); });
      let rulesSkipped = 0;
      if (mode === "replace" || !panelId) {
        if (Array.isArray(payload.rules)) {
          const known = new Set(allPanels.map((p) => p.id));
          // Panels and folders follow to their ids in this profile, containers by name; old files had a single panelId.
          // A rule limited to places that did not come along would turn into a rule for everywhere: it is skipped.
          const incomingRules = [];
          for (const r of migrateRules(payload.rules.filter((x) => x && typeof x === "object")).rules) {
            const panelIds = rulePanels(r).map((id) => panelIdMap.get(id) ?? id).filter((id) => known.has(id));
            const folderIds = ruleFolders(r).map((id) => folderRefs.get(id)).filter(Boolean);
            if (!isGlobal(r) && !panelIds.length && !folderIds.length) { rulesSkipped++; continue; }
            incomingRules.push({
              ...r,
              id: r.id ?? uid("r"),
              panelIds,
              folderIds,
              containerId: r.containerId ? mapContainer(r.containerId) : r.containerId,
            });
          }
          if (mode === "replace") {
            store.set("rules", incomingRules);
          } else {
            // One rule per pattern: same container = widen where it applies, different container = keep yours.
            const next = store.get("rules").map((r) => ({ ...r }));
            for (const inc of incomingRules) {
              const mine = next.find((r) => patternKey(r.pattern) === patternKey(inc.pattern));
              if (!mine) next.push(inc);
              else if (mine.containerId === inc.containerId) {
                if (isGlobal(mine) || isGlobal(inc)) { mine.panelIds = []; mine.folderIds = []; }
                else {
                  mine.panelIds = [...new Set([...rulePanels(mine), ...rulePanels(inc)])];
                  mine.folderIds = [...new Set([...ruleFolders(mine), ...ruleFolders(inc)])];
                }
              } else rulesSkipped++;
            }
            store.set("rules", next);
          }
        }
        if (payload.settings && typeof payload.settings === "object") {
          store.update("settings", (s) => {
            for (const [mod, vals] of Object.entries(payload.settings)) if (vals && typeof vals === "object") s[mod] = { ...(s[mod] ?? {}), ...vals };
          });
        }
      }

      // Note texts go to their own storage; skip any note that normalisation had to drop.
      for (const [id, body] of bodies) if (tree.get(id)?.type === "note") await notes.setBody(id, body);

      // Bookmarks are added where they are missing, never replaced or removed.
      let marks = null;
      if ((mode === "replace" || !panelId) && payload.bookmarks) marks = await bookmarks.restore(payload.bookmarks).catch(() => null);

      await store.flush();
      return { bookmarks: marks, panels: incoming.length, panelsCreated: created.length, tabs: tabCount, notes: noteCount, containersCreated, rulesSkipped, unreadable };
    });

    return { exports: { exportData, timestamp } };
  },
};
