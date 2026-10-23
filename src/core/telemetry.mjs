// Documento de telemetría de un run (schema 1 del servicio agent-router-telemetry). Puro: sin E/S ni reloj.
// SOLO métricas. Cada campo se copia a mano desde una lista blanca: nunca se hace spread ni JSON.stringify de eventos,
// así que texto de tareas, prompts, rutas, mensajes de error, nombres de herramientas, sessionId o label no pueden colarse.
import { reduceEvents } from "./reducer.mjs";
import { addUsage, emptyUsage } from "./pricing.mjs";

// Claves exactas de cada nivel del documento (el servicio rechaza cualquier otra).
export const TELEMETRY_KEYS = Object.freeze({
  run: ["schema", "runId", "rev", "profile", "mode", "orchestratorModel", "status", "exitCode", "startedAt", "endedAt", "durationMs", "quotaStart", "quotaEnd", "orchestratorUsage", "directEdits", "errorKinds", "tasks"],
  quota: ["fiveHourPct", "fiveHourResetsAt", "sevenDayPct", "sevenDayResetsAt"],
  errorKinds: ["limit", "api", "permission"],
  task: ["idx", "agent", "model", "status", "durationMs", "toolUses", "attempt", "usage"],
  usage: ["model", "input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"]
});

const LABEL = /^[A-Za-z0-9._:@/-]{1,64}$/;
const SHORT_ALIAS = /^(opus|sonnet|haiku|fable)$/i;
const MODES = { sesion: "sesion", orquestado: "orquestado", manual: "directo" };
const TASK_STATUS = new Set(["completed", "failed", "limited", "cancelled", "running"]);
const STATUS = new Set(["completed", "failed", "limited", "cancelled"]);
const MAX_TASKS = 500;
const MAX_USAGE_ROWS = 20;

const nat = (n) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : null);
const natOrNull = (n) => (typeof n === "number" ? nat(n) : null);

// Id de modelo apto para el servidor: sin sufijos tipo "[1m]" y con su charset; si no encaja, null.
function cleanModel(model) {
  if (typeof model !== "string") return null;
  const m = model.replace(/\[[^\]]*\]/g, "").trim();
  return LABEL.test(m) ? m : null;
}

const cleanLabel = (v) => (typeof v === "string" && LABEL.test(v) ? v : null);

function cleanProfile(p) {
  const s = String(p ?? "").replace(/[^A-Za-z0-9._:@/-]/g, "_").slice(0, 64);
  return s || "default";
}

// { [modelo]: uso } → lista del esquema; null si no hay datos (null no es 0). Modelos que colapsan al limpiarlos se suman.
function usageList(byModel) {
  if (!byModel || typeof byModel !== "object") return null;
  const merged = new Map();
  for (const [model, u] of Object.entries(byModel)) {
    if (!u || typeof u !== "object") continue;
    const name = cleanModel(model) ?? "other";
    merged.set(name, addUsage(merged.get(name) ?? emptyUsage(), { input: nat(u.input) ?? 0, output: nat(u.output) ?? 0, cacheRead: nat(u.cacheRead) ?? 0, cacheWrite5m: nat(u.cacheWrite5m) ?? 0, cacheWrite1h: nat(u.cacheWrite1h) ?? 0 }));
  }
  if (!merged.size) return null;
  return [...merged].slice(0, MAX_USAGE_ROWS).map(([model, u]) => ({ model, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h }));
}

// El router guarda la utilización en 0..1; el servicio la espera en 0..100.
const pct = (w) => (w && typeof w.utilization === "number" && Number.isFinite(w.utilization) ? Math.min(100, Math.max(0, Math.round(w.utilization * 1000) / 10)) : null);
// Reset de cuota: epoch en segundos (si llegara en ms se pasa a segundos).
function resetSeconds(w) {
  const v = w?.resetsAt;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.round(v > 1e11 ? v / 1000 : v);
}

function quotaDoc(q) {
  if (!q || (!q.fiveHour && !q.sevenDay)) return null;
  return { fiveHourPct: pct(q.fiveHour), fiveHourResetsAt: resetSeconds(q.fiveHour), sevenDayPct: pct(q.sevenDay), sevenDayResetsAt: resetSeconds(q.sevenDay) };
}

// Orquestador real: el id del evento main_model o del cierre; el alias de la CLI ("opus") no cuenta como id real.
function orchestratorModel(run, end) {
  for (const candidate of [run.mainModel, end?.mainModel]) {
    const m = cleanModel(candidate);
    if (m && !SHORT_ALIAS.test(m)) return m;
  }
  return null;
}

function taskDoc(t, idx) {
  const status = TASK_STATUS.has(t.status) ? t.status : null;
  const measured = t.endedAt != null && t.startedAt != null ? t.endedAt - t.startedAt : null;
  return {
    idx,
    agent: cleanLabel(t.agent),
    model: cleanModel(t.model),
    status,
    durationMs: natOrNull(t.durationMs ?? measured),
    toolUses: natOrNull(t.toolUses),
    attempt: natOrNull(t.attempt),
    usage: usageList(t.usage)
  };
}

// events: JSONL completo de un run. opts: { profile (clave del perfil), rev (nº de eventos al enviar) }.
// Devuelve null si el run no está cerrado (sin run_end) o no hay run_start.
export function buildTelemetry(events, { profile, rev } = {}) {
  const end = events.findLast((e) => e.type === "run_end");
  const run = reduceEvents(events);
  if (!run || !end) return null;
  const kinds = { limit: 0, api: 0, permission: 0 };
  for (const e of run.errors) if (e.kind in kinds) kinds[e.kind] += 1;
  const doc = {
    schema: 1,
    runId: run.id,
    rev: nat(rev ?? events.length),
    profile: cleanProfile(profile ?? run.profile),
    mode: MODES[run.mode] ?? "directo",
    orchestratorModel: orchestratorModel(run, end),
    status: STATUS.has(run.status) ? run.status : null,
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    durationMs: run.endedAt != null ? nat(run.endedAt - run.startedAt) : null,
    quotaStart: quotaDoc(events.find((e) => e.type === "run_start")?.quota),
    quotaEnd: quotaDoc(end.quota),
    orchestratorUsage: usageList(end.byModel ?? run.orchestratorUsage),
    directEdits: nat(run.directEdits) ?? 0,
    errorKinds: kinds,
    tasks: run.taskOrder.slice(0, MAX_TASKS).map((id, i) => taskDoc(run.tasks[id], i + 1))
  };
  return doc;
}
