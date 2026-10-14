// backup: saves exports into your Downloads folder, by hand or automatically.
//
// An extension cannot write to an arbitrary path: the downloads API only takes a
// path RELATIVE to Firefox's download folder. So "where" is a folder name inside
// Downloads (default "Grove", nested names like "Backups/Grove" work). To land
// the files somewhere else (a synced folder, another drive), point Firefox's
// download folder there, or make Downloads/Grove a link to that place.
//
// Two automatic backups, each switched on by itself (use either or both):
//   latest    one file with a name you choose (default grove-latest.json),
//             rewritten shortly after anything changes
//   periodic  a timestamped file every N minutes, only when something changed;
//             the oldest are deleted beyond "keep"
// Each skips the write when the content is identical to what it saved last.
//
// Commands:
//   backup:save   { scope, panelId, format, saveAs? } -> { filename }   (the export buttons)
//   backup:status {}  -> { latest, periodic, folder, latestName, latestAt, latestFile,
//                          periodicAt, periodicFile, lastError, pending }

const META_KEY = "grove:backup";
export const DEFAULT_LATEST = "grove-latest.json";

export function cleanFolder(input) {
  return String(input ?? "")
    .split(/[\\/]+/)
    .map((p) => p.trim().replace(/[<>:"|?*\u0000-\u001f]/g, ""))
    .filter((p) => p && p !== "." && p !== "..");
}

// A single file name: no folders, no characters Windows refuses, ".json" added
// when you typed no extension at all.
export function cleanFileName(input, fallback = DEFAULT_LATEST) {
  let name = String(input ?? "")
    .replace(/[\\/]+/g, "-")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!name) return fallback;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += ".json";
  return name;
}

export default {
  name: "backup",
  deps: ["io", "settings"],

  async setup({ api, bus, commands, log, modules, store }) {
    const { io, settings } = modules;

    // The first version had one "mode" setting (off / sync / periodic). Carry it over.
    const old = store?.get("settings")?.backup;
    const carried = old && "mode" in old && !("latest" in old) && !("periodic" in old)
      ? { latest: old.mode === "sync", periodic: old.mode === "periodic" }
      : null;

    settings.register("backup", {
      folder: { type: "text", label: "Save exports into this folder inside your Downloads folder", default: "Grove" },
      askWhere: { type: "boolean", label: "Ask where to save when I click an export button", default: false },
      latest: { type: "boolean", label: "Keep one file up to date after every change", default: false },
      latestName: { type: "text", label: "That file's name", default: DEFAULT_LATEST },
      periodic: { type: "boolean", label: "Also save a timestamped copy every so often", default: false },
      quietSeconds: { type: "number", label: "Up-to-date file: wait this long after a change before saving (seconds)", default: 30, min: 5, max: 3600 },
      everyMinutes: { type: "number", label: "Timestamped copies: save at most every (minutes)", default: 60, min: 1, max: 10080 },
      quiet: {
        type: "boolean",
        label: "Keep automatic saves out of Firefox's download list (the files stay on disk). Timestamped copies are only hidden when \"how many to keep\" is 0: Firefox can only delete a file it still lists",
        default: true,
      },
      keep: { type: "number", label: "Timestamped copies: how many to keep (0 = keep all)", default: 24, min: 0, max: 1000 },
    });
    if (carried) store.update("settings", (all) => { Object.assign(all.backup, carried); });

    const storage = api.storage.local;
    let meta = { latest: {}, periodic: {}, error: null, errorKind: null, files: [] };
    try {
      meta = { ...meta, ...((await storage.get(META_KEY))?.[META_KEY] ?? {}) };
    } catch { /* first run */ }
    meta.latest ??= {};
    meta.periodic ??= {};
    const saveMeta = () => storage.set({ [META_KEY]: meta }).catch((e) => log.warn("backup state not saved", e));
    const setError = (kind, msg) => { meta.error = msg; meta.errorKind = kind; return saveMeta(); };
    const clearError = (kind) => { if (meta.errorKind === kind) { meta.error = null; meta.errorKind = null; } };

    const get = (k) => settings.get("backup", k);
    const folderPath = () => cleanFolder(get("folder"));
    const latestName = () => cleanFileName(get("latestName"));
    const pathOf = (name) => [...folderPath(), name].join("/");
    const ours = new Map(); // download id -> { path, kind, quiet }, to report failures
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Should this automatic save be taken out of the download list once it is done?
    // The up-to-date file is overwritten in place, so its entries are only noise. A
    // timestamped copy has to stay listed while it may still be pruned (Firefox deletes a
    // file only through the entry that made it), so those are hidden only when nothing is pruned.
    const quietFor = (kind) => !!get("quiet") && (kind === "latest" || (kind === "periodic" && get("keep") === 0));

    // Hand a text to the downloads API. Resolves once the download has started.
    async function write({ filename, mime, text }, { saveAs = false, overwrite = false, kind = "manual" } = {}) {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const path = pathOf(filename);
      try {
        const id = await api.downloads.download({ url, filename: path, saveAs, conflictAction: overwrite ? "overwrite" : "uniquify" });
        ours.set(id, { path, kind, quiet: kind !== "manual" && quietFor(kind) });
        reconcile(id); // a small file can finish before anyone is listening
        const t = setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
        t.unref?.();
        return { id, path };
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
    }

    function finish(id, state, error) {
      const mine = ours.get(id);
      if (!mine || (state !== "complete" && state !== "interrupted")) return;
      ours.delete(id);
      if (state === "interrupted") setError(mine.kind, `Firefox could not save ${mine.path}${error ? ` (${error})` : ""}`);
      // Out of the list (and the toolbar's download panel); the file itself is not touched.
      if (mine.quiet) api.downloads.erase?.({ id }).catch(() => {});
    }

    const onChanged = (delta) => finish(delta.id, delta.state?.current, delta.error?.current);

    async function reconcile(id) {
      try {
        const [d] = (await api.downloads.search?.({ id })) ?? [];
        if (d) finish(id, d.state, d.error);
      } catch { /* the event will tell */ }
    }

    // Entries an earlier version (or an earlier setting) left behind for the up-to-date file.
    function sweep() {
      if (!get("quiet") || !get("latest")) return;
      const parts = [...folderPath(), latestName()].map(escapeRegex);
      api.downloads.erase?.({ filenameRegex: `[\\\\/]${parts.join("[\\\\/]")}$`, state: "complete" })?.catch?.(() => {});
    }
    api.downloads.onChanged?.addListener(onChanged);

    // ---- by hand --------------------------------------------------------

    commands.register("backup:save", async ({ scope = "all", panelId = null, format = "json", saveAs } = {}) => {
      const { digest, ...file } = await io.exportData({ scope, panelId, format });
      const { path } = await write(file, { saveAs: saveAs ?? get("askWhere") });
      return { filename: path };
    }, { title: "Save an export" });

    // ---- automatic ------------------------------------------------------

    const dirty = { latest: false, periodic: false };
    const running = { latest: false, periodic: false };
    let quietTimer = null; // the up-to-date file waits for a quiet moment
    let firstTimer = null; // the first timestamped copy does not wait an hour
    let everyTimer = null;

    async function auto(kind) {
      if (running[kind]) return;
      running[kind] = true;
      try {
        const latest = kind === "latest";
        const { digest, ...file } = await io.exportData({ scope: "all", format: "json" });
        const slot = meta[kind];
        const name = latest ? latestName() : file.filename;
        // Same content, same place: nothing to do. A new name or folder is "something changed".
        if (digest === slot.digest && (!latest || slot.file === pathOf(name))) {
          dirty[kind] = false;
          return;
        }
        const { id, path } = await write({ ...file, filename: name }, { overwrite: latest, kind });
        dirty[kind] = false;
        meta[kind] = { digest, at: Date.now(), file: path };
        clearError(kind);
        if (!latest) {
          const limit = get("keep");
          if (limit > 0) meta.files.push({ id, filename: path });
          else meta.files = []; // keeping everything: no list to maintain, nothing is ever pruned
          while (limit > 0 && meta.files.length > limit) {
            const gone = meta.files.shift();
            await api.downloads.removeFile?.(gone.id).catch(() => {}); // already moved or deleted: fine
            await api.downloads.erase?.({ id: gone.id }).catch(() => {});
          }
        }
        await saveMeta();
      } catch (err) {
        log.warn(`automatic ${kind} backup failed`, err);
        await setError(kind, String(err?.message ?? err));
      } finally {
        running[kind] = false;
      }
    }

    function stopTimers() {
      clearTimeout(quietTimer);
      clearTimeout(firstTimer);
      clearInterval(everyTimer);
      quietTimer = firstTimer = everyTimer = null;
    }

    // One write per quiet period, however many changes happen inside it.
    function scheduleLatest() {
      if (quietTimer) return;
      quietTimer = setTimeout(() => {
        quietTimer = null;
        if (get("latest")) auto("latest");
      }, Math.max(5, get("quietSeconds")) * 1000);
      quietTimer.unref?.();
    }

    function configure() {
      stopTimers();
      sweep();
      if (get("latest")) {
        dirty.latest = true; // compare with the last save shortly: unchanged data writes nothing
        scheduleLatest();
      }
      if (get("periodic")) {
        dirty.periodic = true;
        if (meta.periodic.at == null) {
          firstTimer = setTimeout(() => { firstTimer = null; if (get("periodic")) auto("periodic"); }, Math.max(5, get("quietSeconds")) * 1000);
          firstTimer.unref?.();
        }
        everyTimer = setInterval(() => dirty.periodic && get("periodic") && auto("periodic"), Math.max(1, get("everyMinutes")) * 60_000);
        everyTimer.unref?.();
      }
    }

    const onData = () => {
      if (get("latest")) {
        dirty.latest = true;
        scheduleLatest();
      }
      if (get("periodic")) dirty.periodic = true;
    };
    bus.on("store:saved", onData);
    bus.on("notes:changed", onData);
    bus.on("settings:changed", ({ module }) => module === "backup" && configure());
    configure();

    commands.register("backup:status", () => ({
      latest: !!get("latest"),
      periodic: !!get("periodic"),
      folder: folderPath().join("/"),
      latestName: latestName(),
      latestAt: meta.latest.at ?? null,
      latestFile: meta.latest.file ?? null,
      periodicAt: meta.periodic.at ?? null,
      periodicFile: meta.periodic.file ?? null,
      lastError: meta.error ?? null,
      pending: (!!get("latest") && dirty.latest) || (!!get("periodic") && dirty.periodic),
    }));

    return {
      exports: { auto, cleanFolder, cleanFileName },
      teardown() {
        stopTimers();
        api.downloads.onChanged?.removeListener(onChanged);
      },
    };
  },
};
