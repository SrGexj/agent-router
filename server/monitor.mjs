// Fuente de datos del panel Consumo: ejecuta claude-monitor (4.x) y lo convierte con src/core/consumo.mjs.
// La ejecución del proceso y el reloj entran por parámetro; nada aquí tumba el servidor.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { aggregateProfiles, buildProfile } from "../src/core/consumo.mjs";
import { profileIdFromDir } from "../src/config.mjs";

const ERROR_RETRY_MS = 10_000;

// Ejecuta un proceso y devuelve { stdout, stderr, code } también cuando el código de salida no es 0
// (claude-monitor usa 10, 11, 20 y 30 como estados). Rechaza solo si no arranca o si pasa el timeout.
export function execRun(bin, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err.killed || typeof err.code !== "number")) return reject(err);
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
  });
}

// Perfiles de cuenta: ~/.claude y ~/.claude-X (id según profileIdFromDir, la misma regla que src/config.mjs), más las
// carpetas extra que se pasen (el segundo perfil configurado puede estar en cualquier sitio). Solo con carpeta projects.
export function discoverProfiles(userHome, extraDirs = []) {
  let names;
  try { names = readdirSync(userHome); } catch { return {}; }
  const dirs = names.filter((n) => n === ".claude" || n.startsWith(".claude-")).sort().map((n) => join(userHome, n));
  const out = {};
  for (const dir of [...dirs, ...extraDirs.filter(Boolean)]) {
    const projects = join(dir, "projects");
    if (existsSync(projects)) out[profileIdFromDir(dir)] ??= projects;
  }
  return out;
}

const INSTALL_HINT = "Instálalo con: pip install --user claude-monitor (hace falta la 4.0 o posterior).";

function describeError(err) {
  if (err?.code === "ENOENT") return { code: "no-instalado", message: `No encuentro claude-monitor. ${INSTALL_HINT}` };
  if (err?.killed) return { code: "timeout", message: "claude-monitor tardó demasiado en responder." };
  return { code: "fallo", message: `claude-monitor falló: ${String(err?.message ?? err).slice(0, 200)}` };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function createMonitorSource({ run, now, bin, profiles, refreshMs, seatUsdMonth, warehouseDir = null, timeoutMs = 30_000 }) {
  let cached = null; // { payload, at, ttl }
  let inflight = null;
  const warmed = new Set();

  // Un perfil: snapshot (y, si el warehouse está activado, totales por día/modelo). Nunca lanza.
  async function readProfile(name, dataPath) {
    // --plan custom explícito: el monitor recuerda el último plan usado y solo con Custom calcula su P90 (últimas 192 h).
    const base = ["--once", "--output", "json", "--plan", "custom", "--data-paths", dataPath];
    const snapshotArgs = ["--view", "realtime", ...base];
    const call = (args) => run(bin, args, { timeoutMs });
    try {
      let snapshotRun;
      let entries = null;
      if (warehouseDir) {
        const file = join(warehouseDir, `${name}.json`);
        const withWarehouse = ["--view", "realtime", ...base, "--warehouse", "--warehouse-file", file];
        const entriesArgs = ["--view", "entries", "--output", "json", "--warehouse-file", file];
        // El monitor recuerda la última vista usada: la última llamada siempre es la de realtime.
        if (!warmed.has(name)) { await call(withWarehouse); warmed.add(name); }
        const e = await call(entriesArgs);
        entries = parseJson(e.stdout);
        snapshotRun = await call(withWarehouse);
      } else {
        snapshotRun = await call(snapshotArgs);
      }
      const snapshot = parseJson(snapshotRun.stdout);
      if (!snapshot) {
        if (snapshotRun.code === 30 && !snapshotRun.stdout.trim()) return { name, noData: true };
        if (/unrecognized arguments|invalid choice|--once/.test(snapshotRun.stderr ?? "")) {
          return { name, error: { code: "version", message: `Este claude-monitor no admite --once --output json (anterior a la 4.0). ${INSTALL_HINT}` } };
        }
        return { name, error: { code: "fallo", message: "claude-monitor no devolvió un JSON válido." } };
      }
      return { name, profile: buildProfile({ profile: name, snapshot, entries, now: now(), seatUsdMonth }) };
    } catch (err) {
      return { name, error: describeError(err) };
    }
  }

  async function refresh() {
    const entries = Object.entries(profiles ?? {});
    const t = now();
    const base = { seatUsdMonth, refreshMs, warehouse: Boolean(warehouseDir), updatedAt: new Date(t).toISOString() };
    if (entries.length === 0) {
      return { ...base, profiles: {}, error: { code: "sin-perfiles", message: "No encuentro carpetas de Claude Code (~/.claude, ~/.claude-*) para medir." } };
    }
    const results = await Promise.all(entries.map(([name, path]) => readProfile(name, path)));
    const ok = Object.fromEntries(results.filter((r) => r.profile).map((r) => [r.name, r.profile]));
    const failed = results.filter((r) => r.error);
    const payload = { ...base, profiles: ok };
    if (Object.keys(ok).length > 0) {
      if (failed.length) payload.profileErrors = Object.fromEntries(failed.map((r) => [r.name, r.error]));
      const aggregate = aggregateProfiles(ok);
      if (aggregate) payload.aggregate = aggregate;
    } else if (failed.length) {
      payload.error = failed[0].error;
    }
    return payload;
  }

  async function get() {
    const t = now();
    if (cached && t - cached.at < cached.ttl) return cached.payload;
    if (inflight) return inflight;
    inflight = refresh()
      .catch((err) => ({ seatUsdMonth, profiles: {}, updatedAt: new Date(now()).toISOString(), error: describeError(err) }))
      .then((payload) => {
        cached = { payload, at: now(), ttl: payload.error ? Math.min(refreshMs, ERROR_RETRY_MS) : refreshMs };
        return payload;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { get };
}
