// Pure tree algorithms over a flat node map. No browser APIs in here, so it is
// fully unit-testable.
//
// nodes: { [id]: { id, type: "tab" | "folder", panelId, parentId, order, collapsed, ... } }
// Root nodes have parentId === null and belong to node.panelId.
// A child always shares its parent's panelId (enforced by moveNode / addNode).

export function childrenOf(nodes, parentId, panelId) {
  const out = [];
  for (const n of Object.values(nodes)) {
    if (n.parentId === parentId && (parentId !== null || n.panelId === panelId)) out.push(n);
  }
  return out.sort((a, b) => a.order - b.order);
}

export function indexAmongSiblings(nodes, id) {
  const n = nodes[id];
  if (!n) return -1;
  return childrenOf(nodes, n.parentId, n.panelId).findIndex((s) => s.id === id);
}

export function isAncestor(nodes, ancestorId, id) {
  let cur = nodes[id];
  const seen = new Set();
  while (cur && cur.parentId !== null && !seen.has(cur.id)) {
    if (cur.parentId === ancestorId) return true;
    seen.add(cur.id);
    cur = nodes[cur.parentId];
  }
  return false;
}

export function depthOf(nodes, id) {
  let depth = 0;
  let cur = nodes[id];
  const seen = new Set();
  while (cur && cur.parentId !== null && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = nodes[cur.parentId];
  }
  return depth;
}

// All descendants, depth-first, in display order.
export function descendantsOf(nodes, id) {
  const out = [];
  const walk = (parentId) => {
    const panelId = nodes[parentId]?.panelId;
    for (const c of childrenOf(nodes, parentId, panelId)) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

// What is inside a node, at any depth: { tabs, notes, folders, total } where
// total counts tabs and notes (the things you would look for).
export function countInside(nodes, id) {
  const out = { tabs: 0, notes: 0, folders: 0, total: 0 };
  for (const d of descendantsOf(nodes, id)) {
    const type = nodes[d]?.type;
    if (type === "tab") out.tabs++;
    else if (type === "note") out.notes++;
    else if (type === "folder") out.folders++;
  }
  out.total = out.tabs + out.notes;
  return out;
}

function renumber(list) {
  list.forEach((n, i) => (n.order = i));
}

// ----- containment rules ----------------------------------------------------
//
//   folder  holds folders, tabs and notes (and may sit at the panel root)
//   tab     holds only tabs (children = "opened from this")
//   note    holds nothing, and only lives inside a folder
//
// `parent` is a node, or null for the panel root.
export function canContain(parent, child) {
  if (child.type === "note") return !!parent && parent.type === "folder";
  if (child.type === "folder") return !parent || parent.type === "folder";
  return !parent || parent.type === "folder" || parent.type === "tab";
}

// Find the nearest legal place for `child` at/after (parentId, index): if the
// parent cannot hold it, step out to just after that parent and try again.
// Returns { parent, index } or null when there is no legal place (a note
// with no folder above it).
export function validSpot(nodes, parentId, index, child) {
  let p = parentId === null ? null : nodes[parentId] ?? null;
  let at = index;
  while (p && !canContain(p, child)) {
    const list = childrenOf(nodes, p.parentId, p.panelId);
    at = list.findIndex((s) => s.id === p.id) + 1;
    p = p.parentId === null ? null : nodes[p.parentId] ?? null;
  }
  if (!canContain(p, child)) return null;
  return { parent: p, index: at };
}

// Where a new/moved `child` goes to sit right after `anchorId` (and its whole
// subtree) as a sibling. Climbs out if the anchor's parent cannot hold it.
export function placeAfter(nodes, anchorId, child) {
  const anchor = nodes[anchorId];
  if (!anchor) return null;
  const at = childrenOf(nodes, anchor.parentId, anchor.panelId).findIndex((s) => s.id === anchor.id) + 1;
  const spot = validSpot(nodes, anchor.parentId, at, child);
  if (!spot) return null;
  return { parentId: spot.parent ? spot.parent.id : null, index: spot.index, panelId: spot.parent ? spot.parent.panelId : anchor.panelId };
}

export function isWithin(nodes, id, rootId) {
  return id === rootId || isAncestor(nodes, rootId, id);
}

// A view is { panelId, folderId|null }. A node is in it when it belongs to the
// panel and, if a folder is open, sits somewhere beneath that folder.
export function inView(nodes, node, view) {
  if (!node || node.panelId !== view.panelId) return false;
  return view.folderId == null || isWithin(nodes, node.id, view.folderId);
}

// Can the drop target `spot` ({ parentId }) legally take node `dragId`?
export function dropAllowed(nodes, dragId, spot) {
  const drag = nodes[dragId];
  if (!drag || !spot) return false;
  if (spot.parentId === dragId) return false;
  if (spot.parentId !== null && isAncestor(nodes, dragId, spot.parentId)) return false;
  const parent = spot.parentId === null ? null : nodes[spot.parentId];
  if (spot.parentId !== null && !parent) return false;
  return canContain(parent, drag);
}

// Repair data saved by older versions or damaged by a crash: dangling parents,
// children that disagree with their parent's panel, and anything that breaks
// the containment rules is moved to the nearest legal place. Returns the number
// of nodes touched.
export function normalize(nodes) {
  let fixed = 0;
  for (const n of Object.values(nodes)) {
    if (n.parentId !== null && !nodes[n.parentId]) {
      n.parentId = null;
      fixed++;
    }
  }
  // Parents before children so a fix never depends on a not-yet-fixed ancestor.
  const byDepth = Object.values(nodes).sort((a, b) => depthOf(nodes, a.id) - depthOf(nodes, b.id));
  for (const n of byDepth) {
    if (!nodes[n.id]) continue;
    const parent = n.parentId === null ? null : nodes[n.parentId];
    if (parent && parent.panelId !== n.panelId) {
      n.panelId = parent.panelId;
      fixed++;
    }
    if (canContain(parent, n)) continue;
    const spot = validSpot(nodes, n.parentId, null, n);
    if (!spot) {
      // A note outside any folder cannot be placed; keep the data reachable by
      // refusing to guess. It is dropped from the tree (its body is garbage-collected).
      delete nodes[n.id];
      fixed++;
      continue;
    }
    moveNode(nodes, n.id, { parentId: spot.parent ? spot.parent.id : null, index: spot.index, panelId: n.panelId });
    fixed++;
  }
  return fixed;
}

// Insert a new node. `index` defaults to the end of the sibling list.
// Returns null (and inserts nothing) if the containment rules forbid it.
export function addNode(nodes, node, { parentId = null, index = null } = {}) {
  const parent = parentId === null ? null : nodes[parentId];
  if (parentId !== null && !parent) parentId = null;
  if (!canContain(parent ?? null, node)) return null;
  node.parentId = parent ? parent.id : null;
  if (parent) node.panelId = parent.panelId;
  nodes[node.id] = node;
  const siblings = childrenOf(nodes, node.parentId, node.panelId).filter((s) => s.id !== node.id);
  const at = index === null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  siblings.splice(at, 0, node);
  renumber(siblings);
  return node;
}

// Move a node (with its subtree). `index` is the insertion point in the target
// sibling list as currently displayed (the moving node may still be in it).
// Returns false if the move is invalid (e.g. into its own subtree).
export function moveNode(nodes, id, { parentId = null, index = null, panelId = null } = {}) {
  const node = nodes[id];
  if (!node) return false;
  if (parentId === id || (parentId !== null && isAncestor(nodes, id, parentId))) return false;
  const parent = parentId === null ? null : nodes[parentId];
  if (parentId !== null && !parent) return false;
  if (!canContain(parent, node)) return false;

  const targetPanel = parent ? parent.panelId : (panelId ?? node.panelId);
  const oldParentId = node.parentId;
  const oldPanel = node.panelId;
  const oldList = childrenOf(nodes, oldParentId, oldPanel);
  const oldIndex = oldList.findIndex((s) => s.id === id);

  // Detach.
  oldList.splice(oldIndex, 1);
  renumber(oldList);

  node.parentId = parent ? parent.id : null;
  if (node.panelId !== targetPanel) {
    node.panelId = targetPanel;
    for (const d of descendantsOf(nodes, id)) nodes[d].panelId = targetPanel;
  }

  const siblings = childrenOf(nodes, node.parentId, node.panelId).filter((s) => s.id !== id);
  let at = index === null ? siblings.length : index;
  const sameList = oldParentId === node.parentId && oldPanel === node.panelId;
  if (sameList && oldIndex < at) at -= 1;
  at = Math.max(0, Math.min(at, siblings.length));
  siblings.splice(at, 0, node);
  renumber(siblings);
  return true;
}

// mode "promote": children move up to take the removed node's place.
// mode "subtree": the whole subtree is removed.
// Returns the ids that were removed.
export function removeNode(nodes, id, { mode = "promote" } = {}) {
  const node = nodes[id];
  if (!node) return [];
  const removed = [];
  if (mode === "subtree") {
    removed.push(id, ...descendantsOf(nodes, id));
  } else {
    // Promoting must not break the containment rules (e.g. a root-level folder
    // whose notes would end up outside any folder). Refuse and remove nothing.
    const newParent = node.parentId === null ? null : nodes[node.parentId];
    const kidsToMove = childrenOf(nodes, id, node.panelId);
    if (kidsToMove.some((k) => !canContain(newParent, k))) return [];
    removed.push(id);
    const kids = kidsToMove;
    const list = childrenOf(nodes, node.parentId, node.panelId);
    const at = list.findIndex((s) => s.id === id);
    list.splice(at, 1, ...kids);
    kids.forEach((k) => (k.parentId = node.parentId));
    renumber(list);
  }
  const parentId = node.parentId;
  const panelId = node.panelId;
  for (const r of removed) delete nodes[r];
  if (mode === "subtree") renumber(childrenOf(nodes, parentId, panelId));
  return removed;
}

// Flat list of rows for rendering. Collapsed nodes hide their descendants.
// With `rootId` (a folder) the rows are that folder's contents, depth from 0.
export function flatten(nodes, panelId, rootId = null) {
  const rows = [];
  const walk = (parentId, depth) => {
    for (const n of childrenOf(nodes, parentId, panelId)) {
      const kids = childrenOf(nodes, n.id, n.panelId);
      rows.push({ node: n, depth, hasChildren: kids.length > 0, collapsed: !!n.collapsed });
      if (!n.collapsed) walk(n.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return rows;
}

// Translate a drop gesture into a { parentId, index } insertion point.
// zone: "before" | "after" | "inside"
export function resolveDrop(nodes, targetId, zone) {
  const target = nodes[targetId];
  if (!target) return null;
  const kids = childrenOf(nodes, target.id, target.panelId);
  if (zone === "inside") {
    return { parentId: target.id, index: kids.length, panelId: target.panelId };
  }
  const idx = indexAmongSiblings(nodes, target.id);
  if (zone === "before") {
    return { parentId: target.parentId, index: idx, panelId: target.panelId };
  }
  // "after": below an expanded parent means "as its first child".
  if (kids.length > 0 && !target.collapsed) {
    return { parentId: target.id, index: 0, panelId: target.panelId };
  }
  return { parentId: target.parentId, index: idx + 1, panelId: target.panelId };
}

export function setCollapsed(nodes, id, value) {
  const n = nodes[id];
  if (!n) return false;
  n.collapsed = value === undefined ? !n.collapsed : !!value;
  return true;
}

// Collapse or expand everything in a panel that has children.
export function setAllCollapsed(nodes, panelId, value) {
  for (const n of Object.values(nodes)) {
    if (n.panelId !== panelId) continue;
    if (childrenOf(nodes, n.id, n.panelId).length > 0) n.collapsed = value;
  }
}

// ----- nested form (used by export/import) ---------------------------------

export function toNested(nodes, panelId, pick = (n) => ({ ...n })) {
  const build = (parentId) =>
    childrenOf(nodes, parentId, panelId).map((n) => {
      const { id, parentId: _p, panelId: _pa, order: _o, ...rest } = pick(n);
      return { ...rest, children: build(n.id) };
    });
  return build(null);
}

// Rebuild flat nodes from a nested forest. Returns the new nodes (not merged).
export function fromNested(forest, panelId, makeId, { parentId = null } = {}) {
  const out = {};
  const walk = (list, parent) => {
    list.forEach((item, i) => {
      const { children = [], ...rest } = item;
      const id = makeId();
      out[id] = { ...rest, id, panelId, parentId: parent, order: i };
      walk(children, id);
    });
  };
  walk(forest, parentId);
  return out;
}

// ----- private browsing ---------------------------------------------------------
//
// A tab opened in a private window lives in the tree like any other (so the sidebar
// works there) but is flagged `private`, and is never written anywhere: not to
// storage, not to an export. Folders and notes are the user's own organisation, not
// browsing, so they are saved as usual (with their private tabs left out).

// The nodes that may be saved or exported: everything except private tabs. The
// returned nodes are the same objects; the caller must not change them.
export function withoutPrivate(nodes) {
  const keep = {};
  for (const n of Object.values(nodes)) if (!n.private) keep[n.id] = n;
  return keep;
}

// What a window of the given kind may see. Private windows have a space of their own:
// private panels, folders, notes and tabs, all in memory. Normal windows see none of it,
// and a private window sees nothing of the normal space.
export function visibleTo(nodes, privateWindow) {
  const out = {};
  for (const n of Object.values(nodes)) {
    if (!!n.private === !!privateWindow) out[n.id] = n;
  }
  return out;
}
