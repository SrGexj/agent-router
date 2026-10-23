// Informe de cuota por ejecución: cuántos puntos porcentuales (5 h y 7 d) gasta cada run, por día, orquestador y perfil.
// Puro: recibe las listas de eventos de cada run. Lee `quota` de run_start/run_end (exacto); en runs anteriores a ese
// registro aproxima con el primer y el último evento `quota` del run y lo marca como aproximado (no entra en las sumas).
import { totalTokens } from "./pricing.mjs";

const WINDOWS = [["fiveHour", "5h"], ["sevenDay", "7d"]];

const dayOf = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const sumByModel = (byModel) => Object.values(byModel ?? {}).reduce((n, u) => n + totalTokens(u), 0);

// Modelo con más tokens: orquestador de runs anteriores al evento main_model.
const dominantModel = (byModel) => Object.entries(byModel ?? {}).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))[0]?.[0] ?? null;

// Puntos porcentuales de una ventana, o { reason } si no es comparable (falta dato o hubo reset entre medias).
function windowDelta(s, e, label) {
  if (!s || !e || s.utilization == null || e.utilization == null) return { delta: null, reason: `sin dato ${label}` };
  if ((s.resetsAt ?? null) !== (e.resetsAt ?? null) || e.utilization < s.utilization) return { delta: null, reason: `reset ${label}` };
  return { delta: Math.round((e.utilization - s.utilization) * 1000) / 10, reason: null };
}

export function analyzeRun(events) {
  const start = events.find((e) => e.type === "run_start");
  const end = events.findLast((e) => e.type === "run_end");
  const quotas = events.filter((e) => e.type === "quota");
  const legacy = start && !("quota" in start) && !(end && "quota" in end);

  let qs = start?.quota ?? null;
  let qe = end?.quota ?? null;
  let approx = false;
  if (legacy && quotas.length >= 2) { qs = quotas[0]; qe = quotas.at(-1); approx = true; }

  const reasons = [];
  const deltas = {};
  for (const [key, label] of WINDOWS) {
    const r = windowDelta(qs?.[key], qe?.[key], label);
    deltas[key] = r.delta;
    if (r.reason) reasons.push(r.reason);
  }
  let reason = null;
  if (!end) reason = "abierto";
  else if (!qs || !qe) reason = "sin cuota";
  else if (approx) reason = "aproximado";
  else if (reasons.length) reason = reasons.join(", ");

  const usage = events.findLast((e) => e.type === "orchestrator_usage");
  const tasks = new Set(events.filter((e) => e.type === "task_start").map((e) => e.taskId));
  const subLast = new Map();
  for (const e of events) if (e.type === "task_usage") subLast.set(e.taskId, sumByModel(e.byModel));

  return {
    runId: start?.runId ?? null,
    startedAt: start?.t ?? null,
    day: start ? dayOf(start.t) : null,
    profile: start?.profile ?? qs?.profile ?? "trabajo",
    orchestrator: end?.mainModel ?? events.findLast((e) => e.type === "main_model")?.model ?? dominantModel(end?.byModel ?? usage?.byModel) ?? start?.model ?? "?",
    delta5: deltas.fiveHour,
    delta7: deltas.sevenDay,
    approx,
    closed: Boolean(end),
    reliable: reason === null,
    reason,
    orchTokens: sumByModel(end?.byModel ?? usage?.byModel),
    subTokens: [...subLast.values()].reduce((a, b) => a + b, 0),
    tasks: tasks.size
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

export function buildCuotaReport(analyses, { approx = false } = {}) {
  const groups = new Map();
  for (const a of analyses) {
    if (!a.day) continue;
    const key = `${a.day}|${a.orchestrator}|${a.profile}`;
    if (!groups.has(key)) groups.set(key, { day: a.day, orchestrator: a.orchestrator, profile: a.profile, runs: 0, reliable: 0, sum5: 0, n5: 0, tasks5: 0, sum7: 0, n7: 0, tasks7: 0, tasks: 0, orchTokens: 0, subTokens: 0 });
    const g = groups.get(key);
    g.runs += 1;
    const exact = a.closed && (approx || !a.approx);
    if (exact && a.delta5 != null && a.delta7 != null) { g.reliable += 1; g.tasks += a.tasks; g.orchTokens += a.orchTokens; g.subTokens += a.subTokens; }
    if (exact && a.delta5 != null) { g.sum5 += a.delta5; g.n5 += 1; g.tasks5 += a.tasks; }
    if (exact && a.delta7 != null) { g.sum7 += a.delta7; g.n7 += 1; g.tasks7 += a.tasks; }
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      sum5: round1(g.sum5), sum7: round1(g.sum7),
      avg5: g.n5 ? round1(g.sum5 / g.n5) : null,
      avg7: g.n7 ? round1(g.sum7 / g.n7) : null,
      ppPerTask5: g.tasks5 ? round1(g.sum5 / g.tasks5) : null,
      ppPerTask7: g.tasks7 ? round1(g.sum7 / g.tasks7) : null
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.orchestrator.localeCompare(b.orchestrator) || a.profile.localeCompare(b.profile));
}

const fmt = (n) => (n == null ? "-" : n.toFixed(1));
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (i < 3 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function formatCuotaReport(analyses, { verbose = false, approx = false } = {}) {
  if (!analyses.length) return "Sin ejecuciones que analizar.";
  const rows = buildCuotaReport(analyses, { approx });
  const header = ["dia", "orquestador", "perfil", "runs", "fiables", "d5h/run", "d7d/run", "sum5h", "sum7d", "tok orq", "tok sub", "encargos", "pp5h/enc", "pp7d/enc"];
  const body = rows.map((r) => [r.day, r.orchestrator, r.profile, r.runs, r.reliable, fmt(r.avg5), fmt(r.avg7), fmt(r.sum5), fmt(r.sum7), fmtTok(r.orchTokens), fmtTok(r.subTokens), r.tasks, fmt(r.ppPerTask5), fmt(r.ppPerTask7)]);
  const out = [table(header, body), "", `pp = puntos porcentuales de cuota (fin - inicio). ${approx ? "INCLUYE runs con cuota aproximada (primer y último muestreo del run, no atado a inicio/fin)." : "Sumas y medias solo con runs cerrados y con dato exacto (--aprox añade los antiguos, aproximados)."} Tokens y encargos solo de runs con delta completo.`];

  const bad = analyses.filter((a) => !a.reliable);
  if (bad.length) {
    const byReason = new Map();
    for (const a of bad) byReason.set(a.reason, (byReason.get(a.reason) ?? 0) + 1);
    out.push(`NO FIABLES: ${bad.length} de ${analyses.length} runs (${[...byReason].map(([r, n]) => `${r}: ${n}`).join(", ")}).`);
    if (verbose) for (const a of bad) out.push(`  ! ${a.runId}  ${a.day}  ${a.orchestrator}  ${a.profile}  ${a.reason}`);
    else out.push("  (--detalle lista cada run no fiable)");
  }
  return out.join("\n");
}
