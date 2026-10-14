// Kernel: wires the core services together and loads modules.
//
// A module is a plain object:
//
//   export default {
//     name: "tree",
//     deps: ["tabs"],              // loaded after these
//     setup(ctx) { ... },          // may be async; may return a teardown function
//   };
//
// ctx exposes: api (the browser object), bus, hooks, commands, store, log,
// and ctx.modules (name -> whatever the module returned as `exports`).
// A module that fails in setup is skipped (and its dependents too) rather than
// taking the whole extension down.

import { EventBus } from "./events.js";
import { Hooks } from "./hooks.js";
import { Commands } from "./commands.js";
import { Store } from "./store.js";

function makeLog(scope = "grove") {
  const prefix = `[${scope}]`;
  return {
    debug: (...a) => console.debug(prefix, ...a),
    info: (...a) => console.info(prefix, ...a),
    warn: (...a) => console.warn(prefix, ...a),
    error: (...a) => console.error(prefix, ...a),
  };
}

export function sortModules(modules) {
  const byName = new Map();
  for (const m of modules) {
    if (byName.has(m.name)) throw new Error(`Duplicate module name: ${m.name}`);
    byName.set(m.name, m);
  }
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (m, trail) => {
    if (state.get(m.name) === "done") return;
    if (state.get(m.name) === "visiting") {
      throw new Error(`Circular module dependency: ${[...trail, m.name].join(" -> ")}`);
    }
    state.set(m.name, "visiting");
    for (const dep of m.deps ?? []) {
      const d = byName.get(dep);
      if (!d) throw new Error(`Module "${m.name}" depends on missing module "${dep}"`);
      visit(d, [...trail, m.name]);
    }
    state.set(m.name, "done");
    ordered.push(m);
  };
  modules.forEach((m) => visit(m, []));
  return ordered;
}

export async function createKernel({ api, modules, storage = api.storage.local, log = makeLog() }) {
  const bus = new EventBus(log);
  const hooks = new Hooks(log);
  const commands = new Commands(log);
  const store = new Store({ storage, bus, log });
  await store.load();

  const ctx = { api, bus, hooks, commands, store, log, modules: {}, failed: new Set() };
  const teardowns = [];

  for (const mod of sortModules(modules)) {
    const brokenDep = (mod.deps ?? []).find((d) => ctx.failed.has(d));
    if (brokenDep) {
      log.error(`Skipping "${mod.name}": dependency "${brokenDep}" failed`);
      ctx.failed.add(mod.name);
      continue;
    }
    try {
      const result = await mod.setup({ ...ctx, log: makeLog(mod.name) });
      if (result && typeof result === "object" && !Array.isArray(result)) {
        if (typeof result.teardown === "function") teardowns.push(result.teardown);
        if (result.exports) ctx.modules[mod.name] = result.exports;
      } else if (typeof result === "function") {
        teardowns.push(result);
      }
      await bus.emit("module:ready", { name: mod.name });
    } catch (err) {
      log.error(`Module "${mod.name}" failed to start`, err);
      ctx.failed.add(mod.name);
    }
  }

  await bus.emit("kernel:ready", {});

  return {
    ctx,
    async stop() {
      for (const fn of teardowns.reverse()) {
        try {
          await fn();
        } catch (err) {
          log.error("teardown failed", err);
        }
      }
      await store.flush();
    },
  };
}
