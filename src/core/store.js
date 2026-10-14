// Persistent key/value store backed by storage.local.
// Everything is loaded into memory at startup so reads are synchronous.
// Writes are debounced; call flush() to force a save.
//
// Modules own a top-level key (e.g. "panels", "tree", "rules", "settings")
// and register defaults with store.defaults(key, value).

const STORAGE_KEY = "grove:v1";

export class Store {
  constructor({ storage, bus, log = console, delay = 250 }) {
    this.storage = storage;
    this.bus = bus;
    this.log = log;
    this.delay = delay;
    this.data = {};
    this.defaultValues = {};
    this.filters = new Map(); // key -> (value) => what may be saved of it
    this.timer = null;
    this.dirty = false;
    this.saving = Promise.resolve();
  }

  async load() {
    const res = await this.storage.get(STORAGE_KEY);
    this.data = res?.[STORAGE_KEY] ?? {};
    return this;
  }

  defaults(key, value) {
    this.defaultValues[key] = value;
    if (!(key in this.data)) this.data[key] = structuredClone(value);
  }

  // Keep part of a key's value out of storage. `fn` gets a copy and returns what to save;
  // the in-memory data is untouched. (Used so private tabs never reach the disk.)
  persistFilter(key, fn) {
    this.filters.set(key, fn);
  }

  // A copy of the data as it would be saved.
  persistable() {
    const copy = structuredClone(this.data);
    for (const [key, fn] of this.filters) if (key in copy) copy[key] = fn(copy[key]);
    return copy;
  }

  get(key) {
    if (key in this.data) return this.data[key];
    return this.defaultValues[key];
  }

  set(key, value, { silent = false } = {}) {
    this.data[key] = value;
    this.schedule();
    if (!silent) this.bus.emit("store:changed", { key });
    return value;
  }

  // Mutate in place or return a replacement.
  update(key, fn, opts) {
    const current = this.get(key);
    const next = fn(current);
    return this.set(key, next === undefined ? current : next, opts);
  }

  schedule() {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const snapshot = this.persistable();
    this.saving = this.saving
      .then(() => this.storage.set({ [STORAGE_KEY]: snapshot }))
      .then(() => this.bus.emit("store:saved", {}))
      .catch((err) => this.log.error("[store] save failed", err));
    return this.saving;
  }

  // Raw access for export / import / reset.
  dump() {
    return this.persistable();
  }

  async replaceAll(data) {
    this.data = structuredClone(data);
    this.dirty = true;
    await this.flush();
    this.bus.emit("store:changed", { key: "*" });
  }
}
