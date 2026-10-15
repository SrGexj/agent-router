// Consumo del seat: convierte la salida de claude-monitor (4.x) en cifras para el panel.
// Puro: sin E/S ni reloj propio ("ahora" entra como parámetro). Tolerante a versiones y campos ausentes.
import { costOf } from "./pricing.mjs";

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v ? v : null);

function parseWindow(w) {
  if (!isObj(w)) return null;
  const usedPct = num(w.used_percentage);
  if (usedPct == null) return null; // el monitor no conoce esa ventana
  return {
    usedPct,
    resetsAt: num(w.resets_at_epoch),
    source: str(w.source?.kind) ?? "unknown",
    confidence: str(w.confidence) ?? "unknown",
    tokensUsed: num(w.tokens_used),
    tokenLimit: num(w.token_limit)
  };
}

function parseTokens(t) {
  if (!isObj(t)) return null;
  const input = num(t.input_tokens) ?? 0;
  const output = num(t.output_tokens) ?? 0;
  const cacheCreation = num(t.cache_creation_input_tokens) ?? 0;
  const cacheRead = num(t.cache_read_input_tokens) ?? 0;
  return { input, output, cacheCreation, cacheRead, total: num(t.total_tokens) ?? input + output + cacheCreation + cacheRead };
}

function parseCurrent(local) {
  if (!isObj(local)) return null;
  return {
    active: local.is_active === true,
    tokens: parseTokens(local.tokens),
    costUsd: num(local.cost_usd),
    sentMessages: num(local.sent_messages),
    byModel: (Array.isArray(local.model_distribution) ? local.model_distribution : []).filter(isObj).map((m) => ({
      family: str(m.family) ?? "other", pct: num(m.percentage), input: num(m.input_tokens) ?? 0, output: num(m.output_tokens) ?? 0, costUsd: num(m.cost_usd)
    }))
  };
}

// Salida de `claude-monitor --once --output json`. Devuelve null si no es un objeto.
export function parseMonitorSnapshot(json, { profile = null } = {}) {
  if (!isObj(json)) return null;
  const local = isObj(json.local) ? json.local : null;
  const burn = num(local?.burn_rate_tokens_per_minute) != null || num(local?.burn_rate_cost_per_hour) != null;
  const f = isObj(json.forecast) ? json.forecast : null;
  const h = isObj(json.local_history) ? json.local_history : null;
  return {
    profile,
    schemaVersion: str(json.schema_version),
    toolVersion: str(json.tool?.version),
    generatedAt: str(json.generated_at),
    window5h: parseWindow(json.limits?.five_hour),
    window7d: parseWindow(json.limits?.seven_day),
    current: parseCurrent(local),
    costUsd: num(local?.cost_usd),
    burnRate: burn ? { tokensPerMinute: num(local.burn_rate_tokens_per_minute), costPerHour: num(local.burn_rate_cost_per_hour) } : null,
    forecast: f && (num(f.predicted_tokens_exhausted_epoch) != null || num(f.minutes_remaining) != null) ? {
      exhaustedAt: num(f.predicted_tokens_exhausted_epoch), minutesRemaining: num(f.minutes_remaining),
      display: str(f.display), confidence: str(f.confidence) ?? "unknown"
    } : null,
    history: h ? { tokens: num(h.total_tokens), costUsd: num(h.total_cost_usd), confidence: str(h.confidence) ?? "unknown" } : null,
    p90: parseP90View(json),
    pace: isObj(json.pace) ? { label: str(json.pace.label), usedPct: num(json.pace.used_percentage), elapsedPct: num(json.pace.elapsed_percentage) } : null,
    provenance: {
      confidence: str(json.confidence) ?? "unknown",
      source: str(json.source?.kind) ?? "unknown",
      stale: json.stale === true,
      plan: str(json.plan),
      status: str(json.status?.label)
    }
  };
}

// Medición propia del monitor con el plan Custom (claude-monitor 4.0, ver el informe del encargo):
// - Analiza las sesiones de las últimas 192 h (monitoring/data_manager.py:20) y toma como "sesión" cada bloque de 5 h
//   ya cerrado, sin huecos, con tokens (entrada + salida, SIN caché) > 0 (core/p90_calculator.py:21-49).
// - Prefiere los bloques que rozan un tope habitual (>= 95 % de 19k, 88k, 220k u 880k); si no hay, usa todos.
// - P90 = statistics.quantiles(n=10)[8], con mínimo de 19 000. Sin bloques cae a 44 000 (core/plans.py:153,82).
// Al JSON de `--once` solo llega el P90 de tokens (limits.five_hour.token_limit). Los de mensajes y coste solo
// existen en la pantalla rica del monitor, así que aquí valen null: no se recalculan.
const P90_SAMPLE_HOURS = 192;
const P90_FALLBACK_LIMITS = [19_000, 44_000]; // mínimo del cálculo y valor sin bloques: no son un P90 real

export function parseP90View(json) {
  if (!isObj(json)) return null;
  const plan = str(json.plan);
  const five = isObj(json.limits?.five_hour) ? json.limits.five_hour : {};
  const local = isObj(json.local) ? json.local : {};
  const tokenLimit = num(five.token_limit);
  const empty = { tokens: null, messages: null, costUsd: null };
  const base = { plan, windowHours: 5, sampleHours: null, available: false, reason: null, active: local.is_active === true, limits: empty, used: empty, pct: empty, burnRate: null, forecast: null, resetAt: null };
  const provenance = { confidence: str(json.confidence) ?? "unknown", source: str(json.source?.kind) ?? "unknown", stale: json.stale === true, plan };
  if (plan != null && plan !== "custom") return { ...base, reason: "plan-no-custom", provenance };
  if (tokenLimit == null || tokenLimit <= 0) return { ...base, reason: "sin-limite", provenance };
  if (P90_FALLBACK_LIMITS.includes(tokenLimit)) return { ...base, sampleHours: P90_SAMPLE_HOURS, reason: "pocos-datos", provenance };

  const active = base.active;
  const usedTokens = active ? num(five.tokens_used) : null;
  const pctTokens = active ? (num(five.used_percentage) ?? (usedTokens != null ? (usedTokens / tokenLimit) * 100 : null)) : null;
  const resetAt = active ? num(five.resets_at_epoch) : null;
  const elapsedMin = (Date.parse(json.generated_at) - Date.parse(local.session_start)) / 60_000;
  const tokensPerMinute = usedTokens != null && elapsedMin > 0 ? usedTokens / elapsedMin : null;
  const costPerHour = active ? num(local.burn_rate_cost_per_hour) : null;
  const hitAt = active ? num(json.forecast?.predicted_tokens_exhausted_epoch) : null;
  return {
    ...base,
    sampleHours: P90_SAMPLE_HOURS,
    available: true,
    limits: { tokens: tokenLimit, messages: null, costUsd: null },
    used: { tokens: usedTokens, messages: active ? num(local.sent_messages) : null, costUsd: active ? num(local.cost_usd) : null },
    pct: { tokens: pctTokens, messages: null, costUsd: null },
    burnRate: tokensPerMinute != null || costPerHour != null ? { tokensPerMinute, costPerHour } : null,
    forecast: hitAt != null ? { hitAt, metric: "tokens", beforeReset: resetAt != null ? hitAt <= resetAt : null } : null,
    resetAt,
    provenance
  };
}

const emptyTokens = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 });
const emptyBucket = () => ({ tokens: emptyTokens(), costUsd: { router: 0, monitor: 0, mixed: false }, byModel: [] });

function addTo(bucket, model, tk, costRouter, costMonitor, priced) {
  for (const k of Object.keys(bucket.tokens)) bucket.tokens[k] += tk[k];
  bucket.costUsd.router += costRouter;
  bucket.costUsd.monitor += costMonitor;
  if (!priced) bucket.costUsd.mixed = true;
  let m = bucket.byModel.find((x) => x.model === model);
  if (!m) bucket.byModel.push(m = { model, tokens: emptyTokens(), costUsd: { router: 0, monitor: 0, mixed: false } });
  for (const k of Object.keys(m.tokens)) m.tokens[k] += tk[k];
  m.costUsd.router += costRouter;
  m.costUsd.monitor += costMonitor;
  if (!priced) m.costUsd.mixed = true;
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Informe `claude-monitor --view entries --output json` (warehouse) → hoy / últimos 7 días / mes natural.
// El coste se recalcula con la tabla de pricing.mjs; si un modelo no tiene precio se usa el del monitor.
export function summarizeEntries(report, { now }) {
  if (!isObj(report) || !Array.isArray(report.entries)) return null;
  const today = new Date(now);
  const todayKey = dayKey(today);
  const monthPrefix = todayKey.slice(0, 7);
  const weekStart = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));
  const out = { today: emptyBucket(), week: emptyBucket(), month: emptyBucket() };

  for (const e of report.entries) {
    if (!isObj(e) || typeof e.day !== "string") continue;
    const inMonth = e.day.startsWith(monthPrefix) && e.day <= todayKey;
    const inWeek = e.day >= weekStart && e.day <= todayKey;
    const isToday = e.day === todayKey;
    if (!inMonth && !inWeek && !isToday) continue;
    const model = str(e.model) ?? "unknown";
    const tk = {
      input: num(e.input_tokens) ?? 0, output: num(e.output_tokens) ?? 0,
      cacheCreation: num(e.cache_creation_tokens) ?? 0, cacheRead: num(e.cache_read_tokens) ?? 0, total: 0
    };
    tk.total = num(e.total_tokens) ?? tk.input + tk.output + tk.cacheCreation + tk.cacheRead;
    const monitorCost = num(e.cost_usd) ?? 0;
    const ours = costOf(model, { input: tk.input, output: tk.output, cacheRead: tk.cacheRead, cacheWrite5m: tk.cacheCreation, cacheWrite1h: 0 });
    const priced = ours != null;
    const routerCost = priced ? ours : monitorCost;
    if (isToday) addTo(out.today, model, tk, routerCost, monitorCost, priced);
    if (inWeek) addTo(out.week, model, tk, routerCost, monitorCost, priced);
    if (inMonth) addTo(out.month, model, tk, routerCost, monitorCost, priced);
  }
  for (const b of Object.values(out)) b.byModel.sort((a, b2) => b2.tokens.total - a.tokens.total);
  return out;
}

// Cuánto vale el uso frente a lo que cuesta el seat.
export function seatValue({ apiEquivalentUsdMonth, seatUsdMonth }) {
  const api = num(apiEquivalentUsdMonth);
  const seat = num(seatUsdMonth);
  if (api == null || seat == null || seat <= 0) return { ratio: null, savedUsd: null };
  return { ratio: api / seat, savedUsd: api - seat };
}

// Un perfil listo para el panel. null si el monitor no dio un snapshot utilizable.
export function buildProfile({ profile, snapshot, entries, now, seatUsdMonth }) {
  const parsed = parseMonitorSnapshot(snapshot, { profile });
  if (!parsed) return null;
  const tokens = summarizeEntries(entries, { now });
  // Con totales del mes (warehouse) se usa el mes natural y los precios del router; sin ellos, el histórico
  // local del monitor (lo que Claude conserva en disco, ~30 días) con los precios del propio monitor.
  let seat = null;
  if (tokens) seat = { ...seatValue({ apiEquivalentUsdMonth: tokens.month.costUsd.router, seatUsdMonth }), basis: "router" };
  else if (parsed.history?.costUsd != null) seat = { ...seatValue({ apiEquivalentUsdMonth: parsed.history.costUsd, seatUsdMonth }), basis: "history" };
  return { ...parsed, tokens, seat };
}

// Suma los perfiles que tienen totales por periodo.
export function aggregateProfiles(profiles) {
  const withTotals = Object.values(profiles ?? {}).filter((p) => p?.tokens);
  if (withTotals.length === 0) return null;
  const sum = { today: emptyBucket(), week: emptyBucket(), month: emptyBucket() };
  for (const p of withTotals) {
    for (const period of Object.keys(sum)) {
      for (const m of p.tokens[period].byModel) {
        const t = m.tokens;
        addTo(sum[period], m.model, t, m.costUsd.router, m.costUsd.monitor, !m.costUsd.mixed);
      }
    }
  }
  for (const b of Object.values(sum)) b.byModel.sort((a, c) => c.tokens.total - a.tokens.total);
  return { ...sum, apiEquivalentUsdMonth: sum.month.costUsd.router };
}

const PROVENANCE = { official: "oficial", local_estimate: "estimación local", experimental: "API experimental", unknown: "sin confirmar" };

// Etiqueta en español de la procedencia (confidence) que declara el monitor.
export const provenanceLabel = (confidence) => PROVENANCE[confidence] ?? (typeof confidence === "string" && confidence ? confidence : PROVENANCE.unknown);

// ¿Se agota la ventana a este ritmo antes de que se reinicie? at: epoch en segundos.
export function forecastVerdict(forecast, window5h) {
  const at = num(forecast?.exhaustedAt);
  if (at == null) return null;
  const resets = num(window5h?.resetsAt);
  return { kind: resets != null && at > resets ? "no-agota" : "agota", at };
}

// Ventana oficial (cuota de la statusline: utilization 0..1) en el formato del monitor. Reiniciada → 0 %.
function officialWindow(w, nowSec) {
  const u = num(w?.utilization);
  if (u == null) return null;
  const resets = num(w.resetsAt);
  if (resets != null && resets <= nowSec) return { usedPct: 0, resetsAt: null, confidence: "official" };
  return { usedPct: u * 100, resetsAt: resets, confidence: "official" };
}

// Qué ventanas enseña el panel Consumo de un perfil. Si hay cuota oficial, manda ella (el monitor no conoce los
// límites del plan, p. ej. Enterprise) y no se mezcla con su estimación. La previsión "a este ritmo" del monitor
// se basa en ese tope inventado, y con el % oficial no hay forma honesta de convertir su ritmo: solo con estimación local.
export function pickWindows(snapshot, quota, nowSec) {
  const five = officialWindow(quota?.fiveHour, nowSec);
  const seven = officialWindow(quota?.sevenDay, nowSec);
  if (!five && !seven) return { window5h: snapshot?.window5h ?? null, window7d: snapshot?.window7d ?? null, official: false, showForecast: true };
  return { window5h: five, window7d: seven, official: true, showForecast: false };
}
