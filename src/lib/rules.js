// Pure container-rule matching. A rule says "URLs matching X, opened in any of
// these panels and folders (or anywhere), belong in container Z". There is one
// rule per pattern: to cover several places, list them in the one rule.
//
// Where a tab opens decides which rule wins, most specific first:
//   a rule for a folder the tab is in (the nearest folder first, then those around it)
//   a rule for the tab's panel
//   a rule for anywhere
// With no rule at all, the default container of the nearest folder that has one
// applies, else the panel's.
//
// Pattern syntax (scheme, port, query and trailing slash are ignored, so a
// pasted https://example.com/ works):
//   example.com           the domain and every subdomain
//   =example.com          exactly that host
//   *.example.com         subdomains only
//   example.com/work      only URLs whose path is /work or starts with /work/
//   /regex/i              tested against the full URL

export const DEFAULT_STORE = "firefox-default";

// Clean up what a person typed or pasted. Regex patterns are left alone.
export function normalizePattern(pattern) {
  const p = String(pattern ?? "").trim();
  if (!p || p.startsWith("/")) return p;
  const marker = p.match(/^(=|\*\.)/)?.[1] ?? "";
  let rest = p.slice(marker.length).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "");
  const slash = rest.indexOf("/");
  let host = slash < 0 ? rest : rest.slice(0, slash);
  const path = (slash < 0 ? "" : rest.slice(slash)).replace(/\/+$/, "");
  host = host.replace(/:\d+$/, "").toLowerCase();
  return host ? marker + host + path : "";
}

export function compilePattern(pattern) {
  const raw = String(pattern ?? "").trim();
  if (!raw) return null;

  const re = raw.match(/^\/(.+)\/([a-z]*)$/);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2]);
      return (url) => rx.test(url);
    } catch {
      return null;
    }
  }

  const p = normalizePattern(raw);
  if (!p) return null;
  const marker = p.match(/^(=|\*\.)/)?.[1] ?? "";
  const body = p.slice(marker.length);
  const slash = body.indexOf("/");
  const host = slash < 0 ? body : body.slice(0, slash);
  const path = slash < 0 ? "" : body.slice(slash);
  if (!host) return null;

  const hostOk =
    marker === "="
      ? (h) => h === host
      : marker === "*."
        ? (h) => h.endsWith("." + host)
        : (h) => h === host || h.endsWith("." + host);

  return (url, h) => {
    if (!hostOk(h)) return false;
    if (!path) return true;
    try {
      const pathname = new URL(url).pathname;
      return pathname === path || pathname.startsWith(path + "/");
    } catch {
      return false;
    }
  };
}

export function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// The panels a rule is limited to; empty means every panel. (Rules saved by
// older versions have a single `panelId`.)
export function rulePanels(rule) {
  if (Array.isArray(rule.panelIds)) return rule.panelIds;
  return rule.panelId ? [rule.panelId] : [];
}

// The folders a rule is limited to (the rule also covers everything inside them).
export const ruleFolders = (rule) => (Array.isArray(rule.folderIds) ? rule.folderIds : []);

// A rule with no panel and no folder applies everywhere.
export const isGlobal = (rule) => rulePanels(rule).length === 0 && ruleFolders(rule).length === 0;

// The folders a node sits in, nearest first, starting from its parent `parentId`
// (which may itself be a folder, or a tab that sits in one).
export function foldersAbove(nodes, parentId) {
  const out = [];
  const seen = new Set();
  for (let id = parentId; id && nodes[id] && !seen.has(id); id = nodes[id].parentId) {
    seen.add(id);
    if (nodes[id].type === "folder") out.push(nodes[id]);
  }
  return out;
}

// Two patterns that differ only in case, scheme, port or a trailing slash are the same pattern.
export const patternKey = (pattern) => normalizePattern(pattern).toLowerCase();

// Returns the matching rule, or null. `folders` are the folders the tab is in,
// nearest first. Within each level, list order decides.
export function findRule(rules, url, panelId, folders = []) {
  const host = hostname(url);
  const matches = (rule) => {
    const test = compilePattern(rule.pattern);
    return !!test && test(url, host);
  };
  for (const f of folders) {
    const hit = rules.find((r) => ruleFolders(r).includes(f.id) && matches(r));
    if (hit) return hit;
  }
  return (
    rules.find((r) => rulePanels(r).includes(panelId) && matches(r)) ??
    rules.find((r) => isGlobal(r) && matches(r)) ??
    null
  );
}

// Bring rules saved by older versions into the one-rule-per-pattern shape.
// Rules for the same pattern and container are merged (their panels added up,
// "any panel" winning). When the same pattern pointed at DIFFERENT containers
// the rule that used to win is kept (the one limited to a panel, else the first)
// and the others are returned in `dropped`, so nothing disappears silently.
export function migrateRules(rules) {
  const groups = new Map();
  for (const r of rules) {
    const key = patternKey(r.pattern) || r.pattern;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  const dropped = [];
  for (const list of groups.values()) {
    const winner = list.find((r) => !isGlobal(r)) ?? list[0];
    const same = list.filter((r) => r.containerId === winner.containerId);
    dropped.push(...list.filter((r) => !same.includes(r)));
    const everywhere = same.some(isGlobal);
    const panelIds = everywhere ? [] : [...new Set(same.flatMap(rulePanels))];
    const folderIds = everywhere ? [] : [...new Set(same.flatMap(ruleFolders))];
    out.push({ id: same[0].id, pattern: same[0].pattern, panelIds, folderIds, containerId: winner.containerId });
  }
  return { rules: out, dropped };
}

// Explain the decision for a URL opened in a panel (and, optionally, inside folders,
// nearest first):
//   { containerId, via: "rule" | "folder" | "panel" | "none", rule, folder }
// containerId is null when there is no opinion (leave the tab alone). A folder's
// defaultContainer of null means "same as the folder around it".
export function explain({ rules, panels }, url, panelId, folders = []) {
  const rule = findRule(rules, url, panelId, folders);
  if (rule) return { containerId: rule.containerId, via: "rule", rule, folder: null };
  const folder = folders.find((f) => f.defaultContainer);
  if (folder) return { containerId: folder.defaultContainer, via: "folder", rule: null, folder };
  const dflt = panels.find((p) => p.id === panelId)?.defaultContainer ?? null;
  if (dflt) return { containerId: dflt, via: "panel", rule: null, folder: null };
  return { containerId: null, via: "none", rule: null, folder: null };
}

// Decide which cookieStoreId a URL should open in.
// Returns null when no opinion (leave the tab alone).
export function resolveContainer(ctx, url, panelId, folders = []) {
  return explain(ctx, url, panelId, folders).containerId;
}
