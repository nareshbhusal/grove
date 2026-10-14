// Thin client for the background bridge. Shared by the sidebar and options page.

// `windowId` lets the background tell a private window's sidebar from the others.
export function connect(onState, { windowId = null } = {}) {
  let port = null;
  let state = null;
  let closed = false;

  function open() {
    port = browser.runtime.connect({ name: "grove-ui" });
    if (windowId != null) port.postMessage({ type: "hello", windowId });
    port.onMessage.addListener((msg) => {
      if (msg?.type === "state") {
        state = msg.state;
        onState(state);
      }
    });
    port.onDisconnect.addListener(() => {
      // Background restarted (extension update / crash): reconnect.
      port = null;
      if (!closed) setTimeout(open, 500);
    });
  }
  open();

  return {
    get state() {
      return state;
    },
    close() {
      closed = true;
      port?.disconnect();
    },
  };
}

export async function cmd(name, args = {}) {
  const res = await browser.runtime.sendMessage({ type: "cmd", name, args });
  if (!res) throw new Error("No response from Grove background");
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

// Fire a command and surface failures as a toast instead of an unhandled rejection.
export function run(name, args) {
  return cmd(name, args).catch((err) => toast(err.message));
}

export function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 3500);
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") {
      // Custom properties (--x) are ignored by `el.style[name] = ...`; they need setProperty.
      for (const [name, value] of Object.entries(v)) {
        if (value === undefined || value === null) continue;
        if (name.startsWith("--")) el.style.setProperty(name, value);
        else el.style[name] = value;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
