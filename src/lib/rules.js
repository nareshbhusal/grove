// Pure container-rule matching. A rule says "URLs matching X, opened in any of
// these panels (or in any panel), belong in container Z". There is one rule per
// pattern: to cover several panels, list them in the one rule.
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

// Two patterns that differ only in case, scheme, port or a trailing slash are the same pattern.
export const patternKey = (pattern) => normalizePattern(pattern).toLowerCase();

// Returns the matching rule, or null. Rules limited to the current panel win over
// rules that apply to any panel; within each group, list order decides.
export function findRule(rules, url, panelId) {
  const host = hostname(url);
  const matches = (rule) => {
    const test = compilePattern(rule.pattern);
    return !!test && test(url, host);
  };
  const scoped = rules.filter((r) => rulePanels(r).includes(panelId));
  const global = rules.filter((r) => rulePanels(r).length === 0);
  return scoped.find(matches) ?? global.find(matches) ?? null;
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
    const winner = list.find((r) => rulePanels(r).length) ?? list[0];
    const same = list.filter((r) => r.containerId === winner.containerId);
    dropped.push(...list.filter((r) => !same.includes(r)));
    const anyPanel = same.some((r) => rulePanels(r).length === 0);
    const panelIds = anyPanel ? [] : [...new Set(same.flatMap(rulePanels))];
    out.push({ id: same[0].id, pattern: same[0].pattern, panelIds, containerId: winner.containerId });
  }
  return { rules: out, dropped };
}

// Explain the decision for a URL opened in a panel:
//   { containerId, via: "rule" | "panel" | "none", rule }
// containerId is null when there is no opinion (leave the tab alone).
export function explain({ rules, panels }, url, panelId) {
  const rule = findRule(rules, url, panelId);
  if (rule) return { containerId: rule.containerId, via: "rule", rule };
  const dflt = panels.find((p) => p.id === panelId)?.defaultContainer ?? null;
  if (dflt) return { containerId: dflt, via: "panel", rule: null };
  return { containerId: null, via: "none", rule: null };
}

// Decide which cookieStoreId a URL should open in.
// Returns null when no opinion (leave the tab alone).
export function resolveContainer(ctx, url, panelId) {
  return explain(ctx, url, panelId).containerId;
}
