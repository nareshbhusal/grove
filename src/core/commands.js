// Command registry: the public API of the extension.
// The sidebar, options page, keyboard shortcuts and other modules all drive
// behaviour by running named commands, e.g. commands.run("tree:toggle", { id }).

export class Commands {
  constructor(log = console) {
    this.log = log;
    this.handlers = new Map();
    this.meta = new Map();
  }

  register(name, handler, meta = {}) {
    if (this.handlers.has(name)) {
      this.log.warn(`[commands] "${name}" is being overridden`);
    }
    this.handlers.set(name, handler);
    this.meta.set(name, meta);
    return () => {
      if (this.handlers.get(name) === handler) {
        this.handlers.delete(name);
        this.meta.delete(name);
      }
    };
  }

  has(name) {
    return this.handlers.has(name);
  }

  list() {
    return [...this.handlers.keys()].sort().map((name) => ({ name, ...this.meta.get(name) }));
  }

  async run(name, args = {}) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    return handler(args);
  }
}
