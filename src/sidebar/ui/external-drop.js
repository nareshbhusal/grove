// Things dragged into the sidebar from outside it: a link from a page, a
// bookmark, a downloaded file from the downloads panel, a URL from the address
// bar, or selected text that contains links.
//
// While the pointer moves, a browser only reveals the TYPES of what is being
// dragged, not its contents, so `isExternal` is a guess from the types and
// `readLinks` (used on drop) is where we find out whether there really is a link.
//
// Firefox offers a link as "text/uri-list" and/or "text/x-moz-url" (url and title
// on alternating lines), bookmarks and downloaded files the same way (a file:// url).
// A file dragged from the desktop gives the page only the file's name, never its
// location, so it cannot be opened from here.
// Text with no link in it is returned as `text`, to be searched for.

const OPENABLE = /^(https?|ftp|file):\/\//i;

export function isExternal(dt) {
  if (!dt) return false;
  const types = [...(dt.types ?? [])];
  return types.some((t) => ["text/uri-list", "text/x-moz-url", "text/plain", "Files", "application/x-moz-file"].includes(t));
}

const lines = (s) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// -> { links: [{ url, title? }], files: number, text: string }
// `text` is the dropped plain text when it holds no link at all: that is a search.
export function readLinks(dt) {
  const links = [];
  const seen = new Set();
  const add = (url, title) => {
    if (!OPENABLE.test(url) || seen.has(url)) return;
    seen.add(url);
    links.push(title ? { url, title } : { url });
  };

  // x-moz-url first: it carries titles. Lines alternate url, title.
  const moz = lines(dt.getData?.("text/x-moz-url"));
  for (let i = 0; i < moz.length; i += 2) add(moz[i], moz[i + 1]);

  for (const l of lines(dt.getData?.("text/uri-list"))) if (!l.startsWith("#")) add(l);

  const plain = dt.getData?.("text/plain") ?? "";
  for (const l of lines(plain)) add(l);

  const files = dt.files?.length ?? 0;
  return { links, files, text: links.length || files ? "" : plain.replace(/\s+/g, " ").trim() };
}
