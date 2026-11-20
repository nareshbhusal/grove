export function uid(prefix = "n") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// The site of an address as icons and "where" labels see it: host and port, without a leading www.
// Different local apps (localhost:3000, localhost:5173) are different sites.
export function siteOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

export function isInternalUrl(url) {
  return !url || /^(about|moz-extension|chrome|resource|view-source):/i.test(url);
}
