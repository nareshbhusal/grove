import { createKernel } from "../src/core/kernel.js";
import modules from "../src/modules/index.js";
import { createFakeBrowser, settle } from "./fake-browser.js";
import * as T from "../src/lib/tree.js";

export const quiet = { error: (...a) => console.error("[test-log]", ...a), warn() {}, debug() {}, info() {} };
export { settle, T };

export async function boot({ seed, storageData, existing, extraModules = [] } = {}) {
  const fb = existing ?? createFakeBrowser({ storageData });
  if (!existing) {
    const w = fb.sim.addWindow();
    fb.win = w;
    if (seed) for (const s of seed) fb.sim.seedTab({ windowId: w.id, ...s });
  }
  const kernel = await createKernel({ api: fb.browser, modules: [...modules, ...extraModules], log: quiet });
  await settle();
  const { ctx } = kernel;
  const m = ctx.modules;
  const winId = fb.win.id;
  const run = (name, args) => ctx.commands.run(name, args);
  const nodeOf = (tabId) => m.tabs.nodeIdOf(tabId);
  const tabByUrl = (url) => fb.sim.byUrl(url)[0];
  const nodeByUrl = (url) => nodeOf(tabByUrl(url)?.id);
  const view = () => m.windows.getView(winId);
  // rows of the current view, as the sidebar would render them
  const rows = () => {
    const v = view();
    return T.flatten(m.tree.all(), v.panelId, v.folderId).map((r) => ({ id: r.node.id, type: r.node.type, label: r.node.name ?? r.node.url, depth: r.depth }));
  };
  const labels = () => rows().map((r) => `${"-".repeat(r.depth)}${r.label}`);
  return { ...fb, kernel, ctx, m, winId, run, nodeOf, nodeByUrl, tabByUrl, rows, labels, view, panelId: m.windows.getActive(winId) };
}
