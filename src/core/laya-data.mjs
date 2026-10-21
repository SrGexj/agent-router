// Datos para ajustar Laya con las ejecuciones del usuario. Puro: sin E/S ni reloj.
// Texto = el mismo que recibe Laya en modo sombra (sanitizePrompt); etiqueta = trainingLabel (usuario o auto).
import { createHash } from "node:crypto";
import { CHOICES, buildLayaRequest, sanitizePrompt } from "./classifier.mjs";
import { trainingLabel } from "./details.mjs";

export const CSV_HEADER = "texto,etiqueta,perfil,fuente,runId";
export const DEFAULT_EVAL_RATIO = 0.2;
export const MIN_TOTAL = 60;
export const MIN_PER_CLASS = 15;

const profileOf = (run) => run?.profile || "trabajo";

// Una fila por ejecución con etiqueta y texto, ordenada por runId para que la salida sea estable.
export function trainingRows(runs, { profile = "todos" } = {}) {
  const rows = [];
  for (const run of runs ?? []) {
    if (profile !== "todos" && profileOf(run) !== profile) continue;
    const t = trainingLabel(run);
    if (!t) continue;
    const text = sanitizePrompt(typeof run.task === "string" ? run.task : run.task?.task ?? "").trim();
    if (!text) continue;
    rows.push({ text, label: t.label, profile: profileOf(run), source: t.source, runId: run.id });
  }
  return rows.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

export function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const lines = (rows ?? []).map((r) => [r.text, r.label, r.profile, r.source, r.runId].map(csvField).join(","));
  return `${[CSV_HEADER, ...lines].join("\n")}\n`;
}

// Pertenece al conjunto de evaluación según un hash del runId: no cambia al llegar ejecuciones nuevas.
export function inEvalSet(runId, ratio = DEFAULT_EVAL_RATIO) {
  const h = createHash("sha256").update(String(runId)).digest().readUInt32BE(0) / 2 ** 32;
  return h < ratio;
}

export function splitRows(rows, ratio = DEFAULT_EVAL_RATIO) {
  const train = [];
  const ev = [];
  for (const r of rows ?? []) (inEvalSet(r.runId, ratio) ? ev : train).push(r);
  return { train, eval: ev };
}

export function distribution(rows) {
  const out = Object.fromEntries(CHOICES.map((c) => [c, 0]));
  for (const r of rows ?? []) if (r.label in out) out[r.label] += 1;
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

export function layaTrainArgs({ data, out, base, dryRun = false, textColumn = null, labelColumn = null, microBatch = null, gradAccum = null, maxLen = null }) {
  const args = ["--data", data, "--out", out, "--base", base];
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

export function compareScores(base, nuevo) {
  if (base?.accuracy == null || nuevo?.accuracy == null) return { winner: "empate", delta: null };
  const delta = nuevo.accuracy - base.accuracy;
  return { winner: delta > 1e-9 ? "nuevo" : delta < -1e-9 ? "base" : "empate", delta };
}

// Filas de un JSONL de laya-train (datos externos) en la forma que usa scoreEval: {label, text}.
export function rowsFromJsonl(text) {
  return String(text).split("\n").filter((l) => l.trim()).map((l) => {
    const r = JSON.parse(l);
    return { text: r.state?.body ?? "", label: Object.values(r.expected ?? {})[0] };
  });
}
