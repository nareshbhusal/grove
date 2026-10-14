// Event bus: fire-and-forget notifications between modules.
// A throwing listener never breaks the emitter or other listeners.

export class EventBus {
  constructor(log = console) {
    this.log = log;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...args) => {
      off();
      return fn(...args);
    });
    return off;
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }

  // Resolves once every listener has settled. Errors are logged, not thrown.
  async emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map(async (fn) => {
        try {
          await fn(payload, event);
        } catch (err) {
          this.log.error(`[events] listener for "${event}" failed`, err);
        }
      })
    );
  }
}
