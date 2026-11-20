// Which tab to go to when the tab you are looking at closes (or is unloaded): the one you used
// before it, and so on back along the chain of tabs you visited, skipping tabs that are not loaded
// (going to one would load it). Pure: the tabs module feeds it what Firefox reports.
//
//   pickSuccessor(tabs, fromId, { seen, exclude, empty })  -> a tab of `tabs`, or null
//
//   tabs      the window's tabs as tabs.query gives them (id, windowId, index, hidden, discarded, lastAccessed)
//   fromId    the tab being left
//   seen      Map(tabId -> number), larger = visited more recently, for tabs visited since Grove started.
//             These come before any that were not (a restart forgets who was visited when, Firefox keeps
//             only lastAccessed), and lastAccessed orders the rest.
//   exclude   tab ids that must not be chosen (the others being unloaded in the same go)
//   empty     (tab) -> true for a tab that shows nothing (a blank page, the new-tab page); default: by address
//
// Never a tab that is hidden (another panel, outside the folder you are in) or in another window.
// In order of preference: a loaded tab with a page, an unloaded one with a page (going there loads it),
// an empty tab that is loaded, an empty one that is not. Empty tabs are only ever the last resort, and
// when only unloaded ones are left the most recent of those is chosen: something has to be shown.
// Within each of those the most recently used comes first.

const BLANK = /^(about:(blank|newtab|home))?$/i;
export const isBlankUrl = (url) => BLANK.test(url ?? "");

export function pickSuccessor(tabs, fromId, { seen = new Map(), exclude = [], empty = (t) => typeof t.url === "string" && isBlankUrl(t.url) } = {}) {
  const from = tabs.find((t) => t.id === fromId);
  const skip = new Set([fromId, ...exclude]);
  const pool = tabs.filter((t) => !skip.has(t.id) && !t.hidden && (!from || t.windowId === from.windowId));
  if (!pool.length) return null;
  const at = from?.index ?? 0;
  const rank = (t) => (empty(t) ? 2 : 0) + (t.discarded ? 1 : 0);
  pool.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0) ||
      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) ||
      Math.abs(a.index - at) - Math.abs(b.index - at) ||
      a.id - b.id,
  );
  return pool[0];
}
