// Datos para ajustar Laya con las ejecuciones del usuario. Puro: sin E/S ni reloj.
// Texto = el mismo que recibe Laya en modo sombra (sanitizePrompt); etiqueta = trainingLabel (usuario o auto).
import { createHash } from "node:crypto";
import { CHOICES, buildLayaRequest, buildLayaContext } from "./classifier.mjs";
import { trainingLabel, actualRoute } from "./details.mjs";
import { SEEDS } from "./laya-seeds.mjs";

export const CSV_HEADER = "texto,etiqueta,perfil,fuente,runId";
export const DEFAULT_EVAL_RATIO = 0.2;
export const MIN_TOTAL = 60;
export const MIN_PER_CLASS = 15;

const profileOf = (run) => run?.profile || "trabajo";

const taskText = (run) => (typeof run.task === "string" ? run.task : run.task?.task ?? "");

// Sesión de un run de hook: makeRunId = <marca>-<session_id[0:8]>-<seq> (hooks.mjs). Solo los runs de modo "sesion" tienen sesión;
// los de `router` (pid-aleatorio) no se encadenan. Prefijo de 8 caracteres: colisión entre sesiones posible pero despreciable.
const SESSION_ID = /^\d{8}T\d{6}Z-([^-]+)-\d+$/;
export const sessionOf = (run) => (run?.mode === "sesion" ? SESSION_ID.exec(run.id ?? "")?.[1] ?? null : null);

// Run anterior de la misma sesión: el último que empezó antes (por tiempo; runId desempata). Solo mira hacia atrás.
function previousRuns(runs) {
  const bySession = new Map();
  for (const r of runs ?? []) {
    const k = sessionOf(r);
    if (k) bySession.set(k, [...(bySession.get(k) ?? []), r]);
  }
  const prev = new Map();
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
    list.forEach((r, i) => { if (i > 0) prev.set(r.id, list[i - 1]); });
  }
  return prev;
}

// Ruta que el anterior ya tenía decidida cuando empezó este run: actualRoute (nunca la etiqueta del usuario, que en vivo no existe).
// Si el anterior seguía abierto o cerró después del inicio de este run, no hay ruta conocida.
function knownRoute(prev, run) {
  if (prev.endedAt == null || (run.startedAt != null && prev.endedAt > run.startedAt)) return null;
  return actualRoute(prev);
}

// Una fila por ejecución con etiqueta y texto (con el contexto del turno anterior), ordenada por runId para que la salida sea estable.
export function trainingRows(runs, { profile = "todos" } = {}) {
  const prevOf = previousRuns(runs);
  const rows = [];
  for (const run of runs ?? []) {
    if (profile !== "todos" && profileOf(run) !== profile) continue;
    const t = trainingLabel(run);
    if (!t) continue;
    if (!taskText(run).trim()) continue;
    const prev = prevOf.get(run.id);
    const text = buildLayaContext({
      prompt: taskText(run),
      prevTask: prev ? taskText(prev) : undefined,
      prevRoute: prev ? knownRoute(prev, run) : undefined
    });
    if (!text) continue;
    const row = { text, label: t.label, profile: profileOf(run), source: t.source, runId: run.id };
    const session = sessionOf(run);
    if (session) row.session = session;
    rows.push(row);
  }
  return rows.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

// Una semilla sin etiqueta cuenta como opus (compatibilidad con las primeras semillas, que eran todas de opus).
const DEFAULT_SEED_LABEL = "opus";
// El texto de la semilla pasa por buildLayaContext sin anterior; no se reescribe.
const seedRow = (s) => ({ ...s, text: buildLayaContext({ prompt: s.text }), label: s.label ?? DEFAULT_SEED_LABEL, source: "semilla" });

// Semillas locales (JSONL fuera del repo, una por línea {origin,label,text}): las líneas inválidas o con etiqueta fuera de CHOICES se saltan; sin etiqueta = opus.
export function parseLocalSeeds(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.text !== "string" || !r.text.trim()) continue;
    const label = r.label ?? DEFAULT_SEED_LABEL;
    if (!CHOICES.includes(label)) continue;
    out.push({ text: r.text, label, origin: typeof r.origin === "string" ? r.origin : "historico" });
  }
  return out;
}

// Clave de comparación de textos: sin mayúsculas ni espacios sobrantes.
const textKey = (t) => String(t ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// Añade las semillas versionadas (src/core/laya-seeds.mjs) y las locales a las filas de entrenamiento, sin repetir textos
// ni meter ninguna cuyo texto esté ya en la evaluación (evalRows).
export function withSeeds(rows, local = [], evalRows = []) {
  const seen = new Set([...(rows ?? []), ...(evalRows ?? [])].map((r) => textKey(r.text)));
  const extra = [];
  for (const s of [...SEEDS, ...local]) {
    const k = textKey(seedRow(s).text);
    if (seen.has(k)) continue;
    seen.add(k);
    extra.push(seedRow(s));
  }
  return [...(rows ?? []), ...extra];
}

export const SEED_EVAL_RATIO = 0.25;

// Reparte las semillas (versionadas + locales) entre train y eval según el hash del texto normalizado (~75/25, determinista).
// Sin repetir textos de filas reales de ningún lado. Devuelve ambos conjuntos con las filas reales incluidas.
export function addSeeds(trainRows, evalRows, local = [], ratio = SEED_EVAL_RATIO) {
  const seen = new Set([...(trainRows ?? []), ...(evalRows ?? [])].map((r) => textKey(r.text)));
  const train = [...(trainRows ?? [])];
  const ev = [...(evalRows ?? [])];
  for (const s of [...SEEDS, ...local]) {
    const k = textKey(seedRow(s).text);
    if (seen.has(k)) continue;
    seen.add(k);
    (inEvalSet(k, ratio) ? ev : train).push(seedRow(s));
  }
  return { train, eval: ev };
}

export function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const lines = (rows ?? []).map((r) => [r.text, r.label, r.profile, r.source, r.runId].map(csvField).join(","));
  return `${[CSV_HEADER, ...lines].join("\n")}\n`;
}

// Pertenece al conjunto de evaluación según un hash de la clave (la sesión en splitRows; el texto normalizado en addSeeds): no cambia al llegar ejecuciones nuevas.
export function inEvalSet(key, ratio = DEFAULT_EVAL_RATIO) {
  const h = createHash("sha256").update(String(key)).digest().readUInt32BE(0) / 2 ** 32;
  return h < ratio;
}

// Reparto agrupado por sesión: con contexto, runs vecinos comparten texto y una sesión partida filtraría datos al eval.
// Clave = sesión de la fila (prefijo del runId); sin sesión, el runId (cada fila su propio grupo).
export function splitRows(rows, ratio = DEFAULT_EVAL_RATIO) {
  const train = [];
  const ev = [];
  for (const r of rows ?? []) (inEvalSet(`sesion:${r.session ?? r.runId}`, ratio) ? ev : train).push(r);
  return { train, eval: ev };
}

export function distribution(rows) {
  const out = Object.fromEntries(CHOICES.map((c) => [c, 0]));
  for (const r of rows ?? []) if (r.label in out) out[r.label] += 1;
  return out;
}

// PRNG determinista (mulberry32): mismo seed, misma secuencia.
function prng(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// Duplica ejemplos de las clases minoritarias hasta igualar a la mayoritaria. Los originales quedan primero y en su orden;
// los duplicados se reparten por igual dentro de la clase (barajado con semilla). Solo para el train, nunca el eval.
export function oversample(items, { seed = 0 } = {}) {
  const list = items ?? [];
  const byClass = Object.fromEntries(CHOICES.map((c) => [c, list.filter((r) => r.label === c)]));
  const max = Math.max(0, ...CHOICES.map((c) => byClass[c].length));
  const rand = prng(seed);
  const extras = [];
  for (const c of CHOICES) {
    const rows = byClass[c];
    if (rows.length === 0 || rows.length === max) continue;
    let pool = [];
    for (let n = rows.length; n < max; n++) {
      if (pool.length === 0) {
        pool = [...rows];
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      }
      extras.push(pool.pop());
    }
  }
  return [...list, ...extras];
}

// Por clase, cuántas etiquetas son corrección manual del usuario, automáticas (lo que hizo Opus) o semillas.
export function sourceBreakdown(rows) {
  const out = Object.fromEntries(CHOICES.map((c) => [c, { usuario: 0, auto: 0, semilla: 0 }]));
  for (const r of rows ?? []) if (out[r.label] && r.source in out[r.label]) out[r.label][r.source] += 1;
  return out;
}

export const classWarnings = (dist, min = MIN_PER_CLASS) => CHOICES.filter((c) => (dist[c] ?? 0) < min);

export function checkMinimum(dist, { minTotal = MIN_TOTAL, minPerClass = MIN_PER_CLASS } = {}) {
  const reasons = [];
  const total = CHOICES.reduce((a, c) => a + (dist[c] ?? 0), 0);
  if (total < minTotal) reasons.push(`hay ${total} ejemplos y hacen falta al menos ${minTotal}`);
  const scarce = classWarnings(dist, minPerClass);
  if (scarce.length) reasons.push(`clases con menos de ${minPerClass} ejemplos: ${scarce.map((c) => `${c} (${dist[c] ?? 0})`).join(", ")}`);
  return { ok: reasons.length === 0, reasons };
}

// Formato JSONL de laya-train con el mismo estado y preguntas que usa el servicio: se entrena lo que se sirve.
export function toJsonl(rows) {
  const { questions } = buildLayaRequest("");
  return (rows ?? []).map((r) => JSON.stringify({ state: { body: r.text }, questions, expected: { route: r.label } })).join("\n") + "\n";
}

// Valores por defecto de laya-entrenar (laya-train usa rlcd, 4 épocas y grad-accum 64: con 200 ejemplos son 12 actualizaciones y colapsa).
export const TRAIN_DEFAULTS = { loss: "soft-ce", gradAccum: 8, epochs: 6 };
export const LOSSES = ["soft-ce", "rlcd"];

export function layaTrainArgs({ data, out, base, dryRun = false, textColumn = null, labelColumn = null, microBatch = null, gradAccum = null, maxLen = null, loss = null, epochs = null, eval: evalPath = null, freezeEncoder = false, seed = null }) {
  const args = ["--data", data, "--out", out, "--base", base];
  if (evalPath) args.push("--eval", evalPath);
  if (loss) args.push("--loss", loss);
  if (epochs) args.push("--epochs", String(epochs));
  if (seed != null) args.push("--seed", String(seed));
  if (freezeEncoder) args.push("--freeze-encoder");
  if (microBatch) args.push("--micro-batch", String(microBatch));
  if (gradAccum) args.push("--grad-accum", String(gradAccum));
  if (maxLen) args.push("--max-len", String(maxLen));
  if (textColumn) args.push("--text-column", textColumn);
  if (labelColumn) args.push("--label-column", labelColumn);
  if (dryRun) args.push("--dry-run");
  return args;
}

export function scoreEval(gold, preds) {
  if ((gold ?? []).length !== (preds ?? []).length) throw new Error(`faltan predicciones: ${preds?.length ?? 0} para ${gold?.length ?? 0} ejemplos`);
  const byClass = Object.fromEntries(CHOICES.map((c) => [c, { n: 0, correct: 0, accuracy: null }]));
  let correct = 0;
  gold.forEach((g, i) => {
    const c = byClass[g.label];
    if (!c) return;
    c.n += 1;
    if (preds[i] === g.label) { c.correct += 1; correct += 1; }
  });
  for (const c of Object.values(byClass)) c.accuracy = c.n ? c.correct / c.n : null;
  const n = CHOICES.reduce((a, k) => a + byClass[k].n, 0);
  return { n, accuracy: n ? correct / n : null, byClass };
}

// Caída máxima por clase (puntos porcentuales) que se tolera aunque la global suba.
export const MAX_CAIDA_CLASE = 0.05;

// Clases con ejemplos en eval que empeoran más de MAX_CAIDA_CLASE o que quedan en 0 %.
function regresionesPorClase(base, nuevo) {
  const out = [];
  for (const clase of CHOICES) {
    const b = base?.byClass?.[clase];
    const n = nuevo?.byClass?.[clase];
    if (!b?.n || b.accuracy == null || n?.accuracy == null) continue;
    if (b.accuracy - n.accuracy > MAX_CAIDA_CLASE + 1e-9 || (n.accuracy === 0 && b.accuracy > 0)) out.push({ clase, base: b.accuracy, nuevo: n.accuracy });
  }
  return out;
}

export function compareScores(base, nuevo) {
  if (base?.accuracy == null || nuevo?.accuracy == null) return { winner: "empate", delta: null, regresiones: [] };
  const delta = nuevo.accuracy - base.accuracy;
  if (delta < -1e-9) return { winner: "base", delta, regresiones: [] };
  if (delta <= 1e-9) return { winner: "empate", delta, regresiones: [] };
  const regresiones = regresionesPorClase(base, nuevo);
  return { winner: regresiones.length ? "regresion" : "nuevo", delta, regresiones };
}

// Filas de un JSONL de laya-train (datos externos) en la forma que usa scoreEval: {label, text}.
export function rowsFromJsonl(text) {
  return String(text).split("\n").filter((l) => l.trim()).map((l) => {
    const r = JSON.parse(l);
    return { text: r.state?.body ?? "", label: Object.values(r.expected ?? {})[0] };
  });
}
