// diagnostics: a small in-memory log of the decisions Grove makes that are hard
// to see from outside (where a new tab was placed and why, whether a container
// rule fired). Shown on the settings page so problems can be pinned down from
// real behaviour instead of guessed at. Nothing is persisted or sent anywhere.
//
// It can be switched off (Settings → diagnostics): nothing new is recorded then,
// and what was already recorded stays until cleared.
//
//   diagnostics.log("placement", { url, signal, result })
//   commands: diag:list { kind? }  diag:clear

const MAX = 200;

export default {
  name: "diagnostics",
  deps: ["settings"],

  setup({ commands, modules }) {
    const { settings } = modules;
    settings.register("diagnostics", {
      enabled: { type: "boolean", label: "Record where tabs are placed and which container rules fire (shown under Diagnostics)", default: true },
    });
    const entries = [];

    const log = (kind, data) => {
      if (!settings.get("diagnostics", "enabled")) return;
      entries.push({ at: Date.now(), kind, ...data });
      if (entries.length > MAX) entries.shift();
    };

    commands.register("diag:list", ({ kind } = {}) =>
      entries.filter((e) => !kind || e.kind === kind).slice(-100).reverse());
    commands.register("diag:clear", () => {
      entries.length = 0;
      return true;
    });

    return { exports: { log } };
  },
};
