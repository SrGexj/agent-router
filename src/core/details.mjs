// Detalle de una ejecución: título limpio, prompt por partes, gasto por rol y ahorro. Puro:
// sin E/S y con "ahora" como parámetro. Tolera ejecuciones antiguas sin los campos nuevos.
import { isStale } from "./view.mjs";
import { esRunAvisoDelSistema } from "./avisos.mjs";
import { summarizeCompactions } from "./compaction.mjs";
import { OPUS_REFERENCE, costOf, emptyUsage, addUsage, totalTokens, modelFamily } from "./pricing.mjs";

const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/g;
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const textOf = (task) => (typeof task === "string" ? task : task?.task ?? "");

// Texto propio del usuario + bloques pegados, en orden. Un bloque sin cierre llega hasta el final.
export function promptParts(task) {
  const src = textOf(task);
  const parts = [];
  let last = 0;
  for (const m of src.matchAll(PASTED)) {
    parts.push({ kind: "text", text: src.slice(last, m.index) });
    parts.push({ kind: "pasted", text: m[1] });
    last = m.index + m[0].length;
  }
  parts.push({ kind: "text", text: src.slice(last) });
  return parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
}

export function runTitle(task) {
  const parts = promptParts(task);
  const own = oneLine(parts.filter((p) => p.kind === "text").map((p) => p.text).join(" "));
  if (own) return own;
  const pasted = parts.find((p) => p.kind === "pasted");
  const first = pasted?.text.split("\n").map((l) => l.trim()).find(Boolean);
  return first ? `[texto pegado] ${oneLine(first)}` : "Sin título";
}

export function isWaiting(run) {
  return run?.status === "running" && run?.waiting != null;
}

const ROLES = ["orchestrator", "asistente", "programador", "consultor", "propio"];
const emptyTypes = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addTypes(acc, u) {
  return {
    input: acc.input + u.input, output: acc.output + u.output, cacheRead: acc.cacheRead + u.cacheRead,
    cacheWrite: acc.cacheWrite + u.cacheWrite5m + u.cacheWrite1h
  };
}

// Coste y tokens de un { [modelo]: usage }.
function priceUsage(byModel) {
  const out = { costUsd: 0, tokens: 0, models: [], types: emptyTypes() };
  for (const [model, raw] of Object.entries(byModel ?? {})) {
    const u = addUsage(emptyUsage(), raw);
    out.costUsd += costOf(model, u) ?? 0;
    out.tokens += totalTokens(u);
    out.types = addTypes(out.types, u);
    out.models.push(model);
  }
  return out;
}

// Rol de gasto de un encargo (para el desglose por rol): asistente, consultor, propio (nodo "Otros") o programador.
const roleOf = (t) => (["asistente", "consultor", "propio"].includes(t.node) ? t.node : "programador");

const hasUsage = (byModel) => byModel != null && Object.keys(byModel).length > 0;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

export function costBreakdown(run) {
  const roles = Object.fromEntries(ROLES.map((r) => [r, { costUsd: 0, tokens: 0, models: [], tokenTypes: emptyTypes() }]));
  const add = (role, p) => {
    const r = roles[role];
    r.costUsd += p.costUsd;
    r.tokens += p.tokens;
    r.tokenTypes = { ...r.tokenTypes, input: r.tokenTypes.input + p.types.input, output: r.tokenTypes.output + p.types.output, cacheRead: r.tokenTypes.cacheRead + p.types.cacheRead, cacheWrite: r.tokenTypes.cacheWrite + p.types.cacheWrite };
    for (const m of p.models) if (!r.models.includes(m)) r.models.push(m);
  };

  const orch = priceUsage(run?.orchestratorUsage);
  add("orchestrator", orch);

  let opusTasksUsd = 0;
  let workerData = false;
  let complete = true;
  const finished = run != null && run.status !== "running";
  for (const id of run?.taskOrder ?? []) {
    const t = run.tasks[id];
    if (hasUsage(t.usage)) {
      workerData = true;
      const p = priceUsage(t.usage);
      add(roleOf(t), p);
      for (const raw of Object.values(t.usage)) opusTasksUsd += costOf(OPUS_REFERENCE, addUsage(emptyUsage(), raw)) ?? 0;
    } else if (t.status !== "running") {
      complete = false;
    }
  }
  const orchData = hasUsage(run?.orchestratorUsage);
  if (finished && !orchData) complete = false;

  const sum = (f) => ROLES.reduce((a, r) => a + roles[r][f], 0);
  const tokenTypes = ROLES.reduce((a, r) => ({
    input: a.input + roles[r].tokenTypes.input, output: a.output + roles[r].tokenTypes.output,
    cacheRead: a.cacheRead + roles[r].tokenTypes.cacheRead, cacheWrite: a.cacheWrite + roles[r].tokenTypes.cacheWrite
  }), emptyTypes());

  const hasData = workerData || orchData;
  let total = sum("costUsd");
  const reported = run?.usage?.costUsd;
  if (!hasData && reported != null) total = reported;

  const opusEquivalentUsd = workerData ? opusTasksUsd + orch.costUsd : null;
  const savingsUsd = opusEquivalentUsd == null ? null : opusEquivalentUsd - total;
  return {
    ...roles, total, tokens: sum("tokens"), tokenTypes,
    hasData: hasData || reported != null,
    opusEquivalentUsd, savingsUsd, savingsPct: savingsUsd == null ? null : pct(savingsUsd, opusEquivalentUsd),
    complete,
    // Aparte del resto: la llamada del resumen no está en el transcript, así que no suma a total ni a los roles.
    compactions: summarizeCompactions(run?.compactStats, total)
  };
}

// Cifras de cabecera de una ejecución (en curso o terminada) para captions y nodos. Puro.
// costUsd/tokens son null sin datos de uso; partial si hay datos de encargos u orquestador pero faltan otros.
export function runTotals(run, now) {
  const b = costBreakdown(run);
  const detailed = ROLES.some((r) => b[r].costUsd > 0 || b[r].tokens > 0);
  return {
    tasks: run?.taskOrder?.length ?? 0,
    durationMs: run ? Math.max(0, (run.endedAt ?? now) - run.startedAt) : 0,
    hasUsage: b.hasData,
    costUsd: b.hasData ? b.total : null,
    tokens: detailed ? b.tokens : null,
    partial: detailed && !b.complete
  };
}

export function aggregateSavings(runs) {
  const acc = { runs: 0, total: 0, tokens: 0, tokenTypes: emptyTypes(), opusEquivalentUsd: 0, savingsUsd: 0, savingsPct: null };
  for (const run of runs ?? []) {
    const b = costBreakdown(run);
    if (b.savingsUsd == null) continue;
    acc.runs += 1;
    acc.total += b.total;
    acc.tokens += b.tokens;
    acc.opusEquivalentUsd += b.opusEquivalentUsd;
    acc.savingsUsd += b.savingsUsd;
    for (const k of Object.keys(acc.tokenTypes)) acc.tokenTypes[k] += b.tokenTypes[k];
  }
  acc.savingsPct = pct(acc.savingsUsd, acc.opusEquivalentUsd);
  return acc;
}

const profileOf = (run) => run?.profile || "trabajo";
const byProfileOrder = (a, b) => (a === "trabajo" ? -1 : b === "trabajo" ? 1 : a.localeCompare(b));

// Agrupa por cuenta (trabajo por defecto) y aplica el agregado; solo perfiles con datos, trabajo primero.
function byProfile(runs, aggregate, hasData) {
  const groups = {};
  for (const run of runs ?? []) (groups[profileOf(run)] ??= []).push(run);
  const out = {};
  for (const name of Object.keys(groups).sort(byProfileOrder)) {
    const agg = aggregate(groups[name]);
    if (hasData(agg)) out[name] = agg;
  }
  return out;
}

export const aggregateSavingsByProfile = (runs) => byProfile(runs, aggregateSavings, (a) => a.runs > 0);

// Gasto en dólares por FAMILIA DE MODELO REAL (el del uso registrado), sin mirar el rol: un Explore en Opus suma a
// Opus y un programador que usó otro modelo suma al suyo. Incluye orquestador y todos los encargos.
export function spendByFamily(run) {
  const out = { opus: 0, sonnet: 0, haiku: 0 };
  const byModels = [run?.orchestratorUsage, ...(run?.taskOrder ?? []).map((id) => run.tasks[id].usage)];
  for (const byModel of byModels) {
    for (const [model, raw] of Object.entries(byModel ?? {})) out[modelFamily(model)] += costOf(model, addUsage(emptyUsage(), raw)) ?? 0;
  }
  return out;
}

// Reparto del gasto real (orquestador incluido) para la barra de la escena. null sin datos de uso.
export function spendShare(run) {
  const b = costBreakdown(run);
  const parts = spendByFamily(run);
  const sum = parts.opus + parts.sonnet + parts.haiku;
  if (!b.hasData || sum <= 0) return null;
  const sonnet = Math.round((parts.sonnet / sum) * 100);
  const haiku = Math.round((parts.haiku / sum) * 100);
  return { opus: Math.max(0, 100 - sonnet - haiku), sonnet, haiku };
}

// Tokens por FAMILIA DE MODELO REAL (orquestador + encargos). total = input + output + cacheRead + cacheWrite (5m+1h);
// fresh = lo mismo sin cacheRead, porque la lectura de caché domina el volumen.
export function tokensByFamily(run) {
  const out = { opus: { total: 0, fresh: 0 }, sonnet: { total: 0, fresh: 0 }, haiku: { total: 0, fresh: 0 } };
  const byModels = [run?.orchestratorUsage, ...(run?.taskOrder ?? []).map((id) => run.tasks[id].usage)];
  for (const byModel of byModels) {
    for (const [model, raw] of Object.entries(byModel ?? {})) {
      const u = addUsage(emptyUsage(), raw);
      const fam = out[modelFamily(model)];
      if (!fam) continue; // familia desconocida: no entra en el reparto
      fam.total += totalTokens(u);
      fam.fresh += u.input + u.output + u.cacheWrite5m + u.cacheWrite1h;
    }
  }
  return out;
}

// Reparto del uso en tokens para la barra de la escena (% + absolutos). null sin tokens.
export function tokenShare(run) {
  const f = tokensByFamily(run);
  const sum = f.opus.total + f.sonnet.total + f.haiku.total;
  if (sum <= 0) return null;
  const sonnet = Math.round((f.sonnet.total / sum) * 100);
  const haiku = Math.round((f.haiku.total / sum) * 100);
  return {
    opus: Math.max(0, 100 - sonnet - haiku), sonnet, haiku,
    tokens: { opus: f.opus.total, sonnet: f.sonnet.total, haiku: f.haiku.total },
    fresh: { opus: f.opus.fresh, sonnet: f.sonnet.fresh, haiku: f.haiku.fresh }
  };
}

// Qué barras tienen algún encargo sin uso conocido (en curso o terminado sin datos): su parte del gasto es
// desconocida, no cero. Sirve para no pintar "0 %" donde en realidad aún no se sabe. Sin uso, la familia es la del
// modelo del encargo si se conoce y si no la esperada por su nodo (asistente Haiku, programador Sonnet, consultor y propio Opus).
export function spendUnknown(run) {
  const out = { opus: false, sonnet: false, haiku: false };
  const expected = { asistente: "haiku", programador: "sonnet", consultor: "opus", propio: "opus" };
  for (const id of run?.taskOrder ?? []) {
    const t = run.tasks[id];
    if (!hasUsage(t.usage)) out[t.model ? modelFamily(t.model) : expected[t.node] ?? "sonnet"] = true;
  }
  return out;
}

export function taskRows(run, now) {
  return (run?.taskOrder ?? []).map((id) => {
    const t = run.tasks[id];
    const p = priceUsage(t.usage);
    const has = hasUsage(t.usage);
    return {
      id, agent: t.agent, node: t.node, description: t.description, status: t.status,
      durationMs: t.startedAt == null ? null : (t.endedAt ?? now) - t.startedAt,
      model: t.model, costUsd: has ? p.costUsd : null, tokens: has ? p.tokens : t.tokens ?? null,
      tokenTypes: has ? p.types : null, prompt: t.prompt ?? "", result: t.result ?? t.summary ?? ""
    };
  });
}

// Minúsculas y sin tildes, para buscar sin distinguir.
export const normalizeText = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const byStartDesc = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0);

// En curso (las que esperan respuesta primero) y terminadas; las "sin señal" van a terminadas.
export function groupRuns(runs, now) {
  const running = [];
  const finished = [];
  for (const r of runs ?? []) (r.status === "running" && !isStale(r, now) ? running : finished).push(r);
  const waitingFirst = (a, b) => (b.waiting != null) - (a.waiting != null) || byStartDesc(a, b);
  return { running: running.sort(waitingFirst), finished: finished.sort(byStartDesc) };
}

const RUN_STATUS = { completed: ["completed"], failed: ["failed", "limited"], cancelled: ["cancelled"] };

// status: all | completed | failed (incluye limited) | cancelled. profile: all | nombre (por defecto "trabajo").
export function filterRuns(runs, { text = "", status = "all", profile = "all" } = {}) {
  const q = normalizeText(text.trim());
  return (runs ?? []).filter((r) => {
    if (status !== "all" && !(RUN_STATUS[status] ?? [status]).includes(r.status)) return false;
    if (profile !== "all" && (r.profile || "trabajo") !== profile) return false;
    return !q || normalizeText(`${runTitle(r.task)} ${textOf(r.task)}`).includes(q);
  });
}

const TASK_STATUS = { failed: ["failed", "killed"] };

// Sobre la salida de taskRows. status: all | running | completed | failed (incluye killed). agent: all | node.
export function filterTasks(rows, { text = "", status = "all", agent = "all" } = {}) {
  const q = normalizeText(text.trim());
  return (rows ?? []).filter((t) => {
    if (status !== "all" && !(TASK_STATUS[status] ?? [status]).includes(t.status)) return false;
    if (agent !== "all" && t.node !== agent) return false;
    return !q || normalizeText(`${t.description ?? ""} ${t.prompt ?? ""} ${t.result ?? ""}`).includes(q);
  });
}

// --- Modo sombra: qué habría elegido el clasificador barato frente a lo que hizo Opus. ---

// Nombre visible del clasificador según su modelo (Laya, Jev o genérico). Puro.
export function classifierName(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("laya")) return "Laya";
  if (m.includes("jev")) return "Jev";
  return "Clasificador";
}

const SHADOW_MODEL = { asistente: "claude-haiku-5-5", programador: "claude-sonnet-5-5", opus: OPUS_REFERENCE };

// Lo que Opus hizo de verdad: sin encargos lo llevó él solo; con encargos, programador si hay alguno.
// null si sigue en curso o no hay ejecución.
export function actualRoute(run) {
  if (!run || run.status === "running") return null;
  const nodes = (run.taskOrder ?? []).map((id) => run.tasks?.[id]?.node).filter((n) => n !== "propio" && n !== "consultor"); // los propios y el consultor los lleva Opus
  if (nodes.length === 0) return "opus";
  return nodes.some((n) => n !== "asistente") ? "programador" : "asistente";
}

// Etiqueta para entrenar: la corrección del usuario manda; si no, lo que hizo Opus (solo si terminó bien).
export function trainingLabel(run) {
  if (!run || esRunAvisoDelSistema(run)) return null;
  const fixed = run.routeLabel?.label;
  if (fixed) return { label: fixed, source: "usuario" };
  if (run.status !== "completed") return null;
  const label = actualRoute(run);
  return label ? { label, source: "auto" } : null;
}

// Cuántos ejemplos etiquetados hay, cuántos corregidos a mano y el reparto por clase.
export function trainingSummary(runs) {
  const acc = { n: 0, corrected: 0, byLabel: { asistente: 0, programador: 0, opus: 0 } };
  for (const run of runs ?? []) {
    const t = trainingLabel(run);
    if (!t) continue;
    acc.n += 1;
    if (t.source === "usuario") acc.corrected += 1;
    acc.byLabel[t.label] = (acc.byLabel[t.label] ?? 0) + 1;
  }
  return acc;
}

// Todos los tokens de la ejecución (orquestador y encargos) sumados en un solo usage.
function allUsage(run) {
  let acc = emptyUsage();
  const byModels = [run?.orchestratorUsage, ...(run?.taskOrder ?? []).map((id) => run.tasks[id].usage)];
  for (const byModel of byModels) for (const raw of Object.values(byModel ?? {})) acc = addUsage(acc, raw);
  return acc;
}

// Estimación gruesa: supone los mismos tokens con el modelo elegido (uno pequeño podría gastar otros o fallar).
export function shadowVerdict(run) {
  const sh = run?.shadow ?? null;
  const choice = sh?.choice ?? null;
  const actual = actualRoute(run);
  const b = costBreakdown(run);
  const usage = allUsage(run);
  const hasTokens = totalTokens(usage) > 0;
  const actualUsd = b.hasData ? b.total : null;
  let hypotheticalUsd = null;
  if (choice && SHADOW_MODEL[choice] && hasTokens) {
    const base = costOf(SHADOW_MODEL[choice], usage);
    if (base != null) hypotheticalUsd = base + (sh.costUsd ?? 0);
  }
  const savingsUsd = hypotheticalUsd != null && actualUsd != null ? actualUsd - hypotheticalUsd : null;
  // El acierto se mide contra la etiqueta buena: la corrección del usuario si la hay, si no lo que hizo Opus.
  const fixed = run?.routeLabel?.label ?? null;
  const target = fixed ?? actual;
  return {
    na: Boolean(sh?.na), choice, actual, target, targetSource: fixed ? "usuario" : actual ? "auto" : null,
    match: choice && target ? choice === target : null,
    confidence: sh?.confidence ?? null, reason: sh?.reason ?? null, error: sh?.error ?? null,
    pending: run?.status === "running" && sh == null && !esRunAvisoDelSistema(run),
    hypotheticalUsd, actualUsd, savingsUsd
  };
}

// Sobre ejecuciones terminadas con elección del clasificador y ruta real conocida.
// name: el clasificador de la ejecución más reciente que entra en el agregado. Solo se cuentan (aciertos, matriz,
// ahorro, coste y fallos) las ejecuciones de ese clasificador; las de otros van a others para no mezclarlos.
export function aggregateShadow(runs) {
  const acc = { n: 0, matches: 0, matchPct: null, byPair: {}, savingsUsd: 0, jevCostUsd: 0, errors: 0, training: trainingSummary(runs), name: "Clasificador", others: [] };
  const rows = [];
  let latest = null;
  for (const run of runs ?? []) {
    if (run?.shadow?.na) continue; // "no aplica": ni cuenta ni falla
    const v = shadowVerdict(run);
    const counted = Boolean(v.choice && v.target);
    if (!counted && !run?.shadow?.error) continue;
    rows.push({ run, v, counted });
    if (counted && (!latest || (run.startedAt ?? 0) > (latest.startedAt ?? 0))) latest = run;
  }
  acc.name = latest ? classifierName(latest.shadow?.model) : "Clasificador";
  const others = new Map();
  for (const { run, v, counted } of rows) {
    const who = classifierName(run.shadow?.model);
    if (who !== acc.name) { others.set(who, (others.get(who) ?? 0) + 1); continue; }
    if (run.shadow?.error) acc.errors += 1;
    if (!counted) continue;
    acc.n += 1;
    if (v.match) acc.matches += 1;
    acc.byPair[v.choice] ??= {};
    acc.byPair[v.choice][v.target] = (acc.byPair[v.choice][v.target] ?? 0) + 1;
    acc.jevCostUsd += run.shadow.costUsd ?? 0;
    if (v.savingsUsd != null) acc.savingsUsd += v.savingsUsd;
  }
  acc.others = [...others].map(([name, n]) => ({ name, n }));
  acc.matchPct = pct(acc.matches, acc.n);
  return acc;
}

export const aggregateShadowByProfile = (runs) => byProfile(runs, aggregateShadow, (a) => a.n > 0);
