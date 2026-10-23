// Envío de la telemetría: lee los runs cerrados, construye sus documentos y los manda al servicio por lotes.
// fetch, store y reloj se inyectan. NUNCA lanza hacia fuera: todo fallo se anota en telemetry-errors.log (sin el token) y se sigue.
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";
import { buildTelemetry } from "./telemetry.mjs";

export const BATCH_SIZE = 50;
export const WINDOW_MS = 30 * 86_400_000;
export const TIMEOUT_MS = 3000;
export const LOCK_TTL_MS = 5 * 60_000;
const LOG_MAX_BYTES = 256 * 1024;

const readMap = async (file) => {
  try {
    const m = JSON.parse(await readFile(file, "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch { return {}; }
};

// Escritura atómica: archivo temporal en la misma carpeta y rename.
async function writeMap(file, map) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map), { mode: 0o600 });
  await rename(tmp, file);
}

// Línea de log sin el token, sin saltos de línea ni control, acotada.
const clean = (text, token) => {
  let s = String(text ?? "");
  if (token) s = s.split(token).join("[token]");
  s = [...s].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
};

function makeLogger(t) {
  return async (kind, detail, now) => {
    try {
      await mkdir(dirname(t.errorsFile), { recursive: true });
      const size = await stat(t.errorsFile).then((s) => s.size, () => 0);
      if (size > LOG_MAX_BYTES) await rename(t.errorsFile, `${t.errorsFile}.1`);
      await appendFile(t.errorsFile, `${new Date(now()).toISOString()} ${kind} ${clean(detail, t.token)}\n`, { mode: 0o600 });
    } catch { /* sin disco no hay nada más que hacer */ }
  };
}

// Lock con O_EXCL y caducidad por si un flush murió sin liberarlo.
// La edad se mide con el reloj real: el mtime del archivo no sale del `now` inyectado.
async function acquireLock(file) {
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => null);
      if (age != null && age <= LOCK_TTL_MS) return false;
      await rm(file, { force: true });
    }
  }
  return false;
}

// Runs cerrados en la ventana cuyo rev actual supera al enviado o rechazado. Los más antiguos primero.
async function collect({ config, store, now, sent, rejected, withDocs }) {
  const out = [];
  for (const runId of await store.listRunIds()) {
    const file = `${config.runsDir}/${runId}.jsonl`;
    const mtime = await stat(file).then((s) => s.mtimeMs, () => null);
    if (mtime == null || now() - mtime > WINDOW_MS + 86_400_000) continue; // ni lo abre: lleva más de un mes sin cambios
    const events = await store.readRun(runId);
    const end = events.findLast((e) => e.type === "run_end");
    if (!end || now() - end.t > WINDOW_MS) continue;
    const rev = events.length;
    if (rev <= Math.max(sent[runId] ?? 0, rejected[runId] ?? 0)) continue;
    const doc = withDocs ? buildTelemetry(events, { rev }) : null;
    if (withDocs && !doc) continue;
    out.push({ runId, rev, doc, endedAt: end.t });
  }
  return out.sort((a, b) => a.endedAt - b.endedAt);
}

// Una petición completa (envío y lectura del cuerpo) con tope de 3 s, aunque fetch ignore la señal.
async function post({ endpoint, token, docs, fetch }) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("tiempo agotado"), { timeout: true })), TIMEOUT_MS); });
  const request = (async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runs: docs }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = res.ok ? "" : await res.text().catch(() => "");
    return { status: res.status, ok: res.ok, text };
  })();
  request.catch(() => {});
  try { return await Promise.race([request, limit]); } finally { clearTimeout(timer); }
}

function validationMessage(text) {
  try { const j = JSON.parse(text); if (typeof j?.error === "string") return j.error; } catch { /* no era JSON */ }
  return "petición inválida";
}

export async function flushTelemetry({ config, store, fetch = globalThis.fetch, now = Date.now }) {
  const t = config.telemetry;
  if (!t?.enabled) return { skipped: "desactivada", sent: 0, rejected: 0 };
  const log = makeLogger(t);
  const result = { sent: 0, rejected: 0 };
  let locked = false;
  try {
    locked = await acquireLock(t.lockFile);
    if (!locked) return { ...result, skipped: "en curso" };
    const sent = await readMap(t.sentFile);
    const rejected = await readMap(t.rejectedFile);
    const pending = await collect({ config, store, now, sent, rejected, withDocs: true });
    const save = async () => { await writeMap(t.sentFile, sent); await writeMap(t.rejectedFile, rejected); };

    // Envía una lista; devuelve true si hay que parar (401, 5xx, sin red).
    const send = async (list) => {
      while (list.length) {
        let res;
        try {
          res = await post({ endpoint: t.endpoint, token: t.token, docs: list.map((i) => i.doc), fetch });
        } catch (e) {
          await log("red", e?.timeout ? "tiempo agotado" : `${e?.name ?? "Error"}: ${e?.message ?? ""}`, now);
          result.stopped = "red";
          return true;
        }
        if (res.ok) {
          for (const i of list) { sent[i.runId] = i.rev; result.sent += 1; }
          await save();
          return false;
        }
        if (res.status === 401) {
          await log("401", "token rechazado por el servicio: revisa ROUTER_TELEMETRY_TOKEN", now);
          result.stopped = "401";
          return true;
        }
        if (res.status !== 400) {
          await log(String(res.status), `el servicio respondió ${res.status}; se reintentará`, now);
          result.stopped = String(res.status);
          return true;
        }
        const message = validationMessage(res.text);
        const bad = Number(/^runs\[(\d+)\]/.exec(message)?.[1]);
        const reject = async (item) => {
          rejected[item.runId] = item.rev;
          result.rejected += 1;
          await log("400", `rechazado ${item.runId}: ${message}`, now);
        };
        if (Number.isInteger(bad) && bad < list.length) {
          await reject(list[bad]);
          list = list.filter((_, i) => i !== bad);
          await save();
          continue;
        }
        if (list.length === 1) { await reject(list[0]); await save(); return false; }
        // El servicio no dice cuál falla: de uno en uno.
        for (const item of list) if (await send([item])) return true;
        return false;
      }
      return false;
    };

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      if (await send(pending.slice(i, i + BATCH_SIZE))) break;
    }
    // Olvida lo que ya no existe en disco (los JSONL se borran).
    const alive = new Set(await store.listRunIds());
    for (const map of [sent, rejected]) for (const id of Object.keys(map)) if (!alive.has(id)) delete map[id];
    await save();
  } catch (e) {
    await log("error", `${e?.name ?? "Error"}: ${e?.message ?? ""}`, now);
    result.stopped ??= "error";
  } finally {
    if (locked) await rm(t.lockFile, { force: true }).catch(() => {});
  }
  return result;
}

// Estado para `router telemetry status`: solo lectura y sin token. Desactivada, no toca el disco.
export async function telemetryStatus({ config, store, now = Date.now }) {
  const t = config.telemetry;
  if (!t?.enabled) return { enabled: false, url: null, pending: 0, sent: 0, rejected: 0, lastErrors: [] };
  const sent = await readMap(t.sentFile);
  const rejected = await readMap(t.rejectedFile);
  const pending = await collect({ config, store, now, sent, rejected, withDocs: false }).catch(() => []);
  const lastErrors = (await readFile(t.errorsFile, "utf8").catch(() => "")).split("\n").filter(Boolean).slice(-5);
  return { enabled: true, url: t.url, pending: pending.length, sent: Object.keys(sent).length, rejected: Object.keys(rejected).length, lastErrors };
}

// Lanza `router telemetry flush` desacoplado (patrón de launchShadow): no espera, no hace fetch y no falla.
// Con la telemetría desactivada no lanza nada. spawn inyectable para probarlo.
export function launchTelemetryFlush({ config, script, spawn = nodeSpawn, execPath = process.execPath }) {
  try {
    if (!config.telemetry?.enabled) return false;
    const child = spawn(execPath, [script, "telemetry", "flush"], { detached: true, stdio: "ignore" });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch { return false; /* la telemetría nunca rompe a co/cop */ }
}
