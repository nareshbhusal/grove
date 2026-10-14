// Hooks: modules can intercept and change values flowing through the system.
// Unlike events, hooks are a pipeline: each tap receives the previous result.
//
//   hooks.tap("tab:placement", (placement, ctx) => ({ ...placement, parentId: x }), { priority: 10 })
//   const result = await hooks.run("tab:placement", initial, ctx)
//
// Lower priority numbers run first. A tap returning undefined leaves the value alone.

export class Hooks {
  constructor(log = console) {
    this.log = log;
    this.taps = new Map();
  }

  tap(name, fn, { priority = 100 } = {}) {
    if (!this.taps.has(name)) this.taps.set(name, []);
    const list = this.taps.get(name);
    const entry = { fn, priority };
    list.push(entry);
    list.sort((a, b) => a.priority - b.priority);
    return () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async run(name, value, ctx) {
    const list = this.taps.get(name);
    if (!list) return value;
    let current = value;
    for (const { fn } of [...list]) {
      try {
        const next = await fn(current, ctx);
        if (next !== undefined) current = next;
      } catch (err) {
        this.log.error(`[hooks] tap for "${name}" failed`, err);
      }
    }
    return current;
  }
}
