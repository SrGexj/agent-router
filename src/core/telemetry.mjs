// Documento de telemetría de un run (schema 1 del servicio agent-router-telemetry). Puro: sin E/S ni reloj.
// SOLO métricas. Cada campo se copia a mano desde una lista blanca: nunca se hace spread ni JSON.stringify de eventos,
// así que texto de tareas, prompts, rutas, mensajes de error, nombres de herramientas, sessionId o label no pueden colarse.
import { reduceEvents } from "./reducer.mjs";
import { addUsage, emptyUsage } from "./pricing.mjs";

// Claves exactas de cada nivel del documento (el servicio rechaza cualquier otra).
export const TELEMETRY_KEYS = Object.freeze({
  run: ["schema", "runId", "rev", "profile", "mode", "orchestratorModel", "status", "exitCode", "startedAt", "endedAt", "durationMs", "quotaStart", "quotaEnd", "orchestratorUsage", "directEdits", "errorKinds", "tasks", "laya"],
  quota: ["fiveHourPct", "fiveHourResetsAt", "sevenDayPct", "sevenDayResetsAt"],
  errorKinds: ["limit", "api", "permission"],
  task: ["idx", "agent", "model", "status", "durationMs", "toolUses", "attempt", "usage"],
  laya: ["model", "decisions", "errors", "errorsByKind", "applied", "latencyP50Ms", "latencyP90Ms"],
  layaErrorKinds: ["timeout", "connection", "http", "parse", "unknown"],
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

const MAX_COUNT = 100000;
const MAX_LATENCY_MS = 60000;
const LAYA_ERROR_KINDS = new Set(["timeout", "connection", "http", "parse"]);

// Percentil por rango más cercano sobre una lista ya ordenada.
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];

// Resumen por run de los laya_decision: solo contadores y latencias; undefined si no hubo ninguno.
function layaSummary(events) {
  const ds = events.filter((e) => e.type === "laya_decision");
  if (!ds.length) return undefined;
  const byKind = { timeout: 0, connection: 0, http: 0, parse: 0, unknown: 0 };
  const models = new Map();
  const latencies = [];
  let errors = 0;
  let applied = 0;
  for (const e of ds) {
    if (e.error) {
      errors += 1;
      byKind[LAYA_ERROR_KINDS.has(e.errorKind) ? e.errorKind : "unknown"] += 1;
    }
    if (e.applied === true) applied += 1;
    const m = cleanModel(e.layaModel);
    if (m) models.set(m, (models.get(m) ?? 0) + 1);
    if (typeof e.latencyMs === "number" && Number.isFinite(e.latencyMs)) latencies.push(Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(e.latencyMs))));
  }
  latencies.sort((a, b) => a - b);
  const cap = (n) => Math.min(MAX_COUNT, n);
  const top = [...models].sort((a, b) => b[1] - a[1])[0];
  return {
    model: top ? top[0] : null,
    decisions: cap(ds.length),
    errors: cap(errors),
    errorsByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, cap(v)])),
    applied: cap(applied),
    latencyP50Ms: latencies.length ? percentile(latencies, 0.5) : null,
    latencyP90Ms: latencies.length ? percentile(latencies, 0.9) : null
  };
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

// "Tareas sin inicio registrado": el reducer descarta task_usage de un taskId sin task_start en este run (p. ej. un subagente
// arrancado en un run anterior de la misma sesión y reanudado en este), pero ese gasto es real. Aquí se recoge aparte, con la
// misma regla del reducer (snapshot sustituye, sin snapshot suma), y sale como tarea con agent/status null. No toca el estado del dashboard.
function orphanUsage(events, known) {
  const byTask = new Map();
  for (const e of events) {
    if (e.type !== "task_usage" || !e.taskId || known.has(e.taskId) || !e.byModel || typeof e.byModel !== "object") continue;
    const prev = byTask.get(e.taskId);
    if (e.snapshot || !prev) { byTask.set(e.taskId, { ...e.byModel }); continue; }
    const sum = { ...prev };
    for (const [model, u] of Object.entries(e.byModel)) sum[model] = addUsage(sum[model] ?? emptyUsage(), u);
    byTask.set(e.taskId, sum);
  }
  return [...byTask.values()];
}

// Modelo de la fila huérfana: el de mayor volumen de tokens de su uso.
function dominantModel(byModel) {
  let best = null;
  let bestTotal = -1;
  for (const [model, u] of Object.entries(byModel)) {
    const total = (nat(u?.input) ?? 0) + (nat(u?.output) ?? 0) + (nat(u?.cacheRead) ?? 0) + (nat(u?.cacheWrite5m) ?? 0) + (nat(u?.cacheWrite1h) ?? 0);
    if (total > bestTotal) { best = model; bestTotal = total; }
  }
  return best;
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
    tasks: [
      ...run.taskOrder.map((id) => run.tasks[id]),
      ...orphanUsage(events, new Set(Object.keys(run.tasks))).map((byModel) => ({ agent: null, model: dominantModel(byModel), status: null, usage: byModel }))
    ].slice(0, MAX_TASKS).map((t, i) => taskDoc(t, i + 1))
  };
  const laya = layaSummary(events);
  if (laya) doc.laya = laya;
  return doc;
}
