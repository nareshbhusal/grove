// Searching the tree.
//
//   parseQuery('github AND "pull request" tabs') -> ["github", "pull request", "tabs"]
//
// Every term must match (that is what AND means; plain spaces mean the same, so
// "github pull" finds a page whose title says Pull and whose address says github).
// "Quotes" keep words together as an exact phrase, and quote "and" to look for the
// word itself. Case and accents are ignored. A term may match the title, a title
// you gave the tab, the address, or a folder's / note's name.
//
//   searchView(nodes, view, query) -> { terms, results: [{ node, where }] }
//
// The scope is the view you are in: a whole panel, or the open folder with
// everything inside it, subfolders included, whether or not branches are collapsed.
// `where` says where a result sits: the folders it is in (inside the scope), or
// for a tab that is not in a folder, its site.

import { childrenOf } from "./tree.js";

// Lowercase, accents removed. `map[i]` is the index in the original text that
// character i of the result came from, so matches can be highlighted in the original.
export function fold(text) {
  const src = String(text ?? "");
  let s = "";
  const map = [];
  let i = 0;
  for (const ch of src) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    s += f;
    i += ch.length;
  }
  map.push(src.length);
  return { s, map };
}

export function parseQuery(input) {
  let q = String(input ?? "");
  if ((q.match(/"/g) ?? []).length % 2) q = q.replace(/"([^"]*)$/, "$1"); // an unfinished quote is just text
  const terms = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined && /^and$/i.test(m[2])) continue; // the operator
    const term = fold((m[1] ?? m[2]).trim()).s;
    if (term) terms.push(term);
  }
  return terms;
}

function decoded(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

export function haystack(node) {
  if (node.type === "tab") {
    const url = node.url ?? "";
    return fold([node.customTitle, node.title, url, url !== (decoded(url)) ? decoded(url) : ""].filter(Boolean).join("\n")).s;
  }
  return fold(node.name ?? "").s;
}

export const matches = (node, terms) => {
  if (!terms.length) return false;
  const h = haystack(node);
  return terms.every((t) => h.includes(t));
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function searchView(nodes, view, query) {
  const terms = parseQuery(query);
  const results = [];
  if (!terms.length) return { terms, results };
  const walk = (parentId, folders) => {
    const panelId = parentId === null ? view.panelId : nodes[parentId]?.panelId;
    for (const n of childrenOf(nodes, parentId, panelId)) {
      if (!n.pinned && matches(n, terms)) {
        const where = folders.length ? folders.join(" › ") : n.type === "tab" ? hostOf(n.url) : "";
        results.push({ node: n, where });
      }
      walk(n.id, n.type === "folder" ? [...folders, n.name || "Folder"] : folders);
    }
  };
  walk(view.folderId ?? null, []);
  return { terms, results };
}

// Split `text` into [{ text, hit }] so the matched parts can be marked.
export function highlight(text, terms) {
  const src = String(text ?? "");
  const { s, map } = fold(src);
  const marked = new Array(src.length).fill(false);
  for (const t of terms) {
    if (!t) continue;
    for (let at = s.indexOf(t); at !== -1; at = s.indexOf(t, at + t.length)) {
      const from = map[at];
      const to = map[at + t.length - 1] + 1; // through the last original character that took part
      for (let i = from; i < Math.max(to, from + 1) && i < src.length; i++) marked[i] = true;
    }
  }
  const parts = [];
  for (let i = 0; i < src.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === marked[i]) last.text += src[i];
    else parts.push({ text: src[i], hit: marked[i] });
  }
  return parts;
}
