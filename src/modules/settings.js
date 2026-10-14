// settings: a registry that lets any module declare its settings.
// The options page renders a form straight from these schemas, so a new module
// gets a settings UI without writing any UI code.
//
//   settings.register("tabs", {
//     openerChild: { type: "boolean", label: "Open links as child tabs", default: true },
//     size:        { type: "number", label: "Size", default: 3, min: 1, max: 10 },
//     mode:        { type: "select", label: "Mode", default: "a", options: [["a", "Alpha"], ["b", "Beta"]] },
//   });
//
// Read with settings.get("tabs", "openerChild"). Changes emit "settings:changed".

export default {
  name: "settings",

  setup({ bus, commands, store }) {
    const schemas = {};
    store.defaults("settings", {});

    function register(moduleName, schema) {
      schemas[moduleName] = schema;
      store.update(
        "settings",
        (all) => {
          const current = all[moduleName] ?? {};
          const merged = {};
          for (const [key, def] of Object.entries(schema)) {
            merged[key] = key in current ? current[key] : def.default;
          }
          all[moduleName] = merged;
        },
        { silent: true }
      );
    }

    const get = (moduleName, key) =>
      store.get("settings")?.[moduleName]?.[key] ?? schemas[moduleName]?.[key]?.default;

    function coerce(def, value) {
      if (def.type === "boolean") return !!value;
      if (def.type === "number") {
        let n = Number(value);
        if (!Number.isFinite(n)) n = def.default;
        if (def.min !== undefined) n = Math.max(def.min, n);
        if (def.max !== undefined) n = Math.min(def.max, n);
        return n;
      }
      return String(value ?? "");
    }

    commands.register("settings:schema", () => ({
      schemas,
      values: store.get("settings"),
    }));

    commands.register("settings:set", ({ module, key, value }) => {
      const def = schemas[module]?.[key];
      if (!def) throw new Error(`Unknown setting ${module}.${key}`);
      const next = coerce(def, value);
      store.update("settings", (all) => {
        all[module] = { ...(all[module] ?? {}), [key]: next };
      });
      bus.emit("settings:changed", { module, key, value: next });
      return next;
    });

    return { exports: { register, get } };
  },
};
