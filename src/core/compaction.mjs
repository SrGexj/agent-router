// Compactaciones de contexto: detección en el transcript, coste estimado y aviso antes de que haga falta compactar.
// Puro y sin dependencias de Node: lo usan los hooks, el reducer y el dashboard.
import { addUsage, costOf, emptyUsage, totalTokens } from "./pricing.mjs";

// --- Umbrales (un solo sitio) ---
export const CONTEXT_WARN = 0.8;
export const CONTEXT_CRITICAL = 0.9;
export const WINDOW_DEFAULT = 200_000;
export const WINDOW_1M = 1_000_000;
// Ventana a la que compactan solas las sesiones co/cop (autoCompactWindow de buildCoSettings): el aviso se mide contra ella.
export const CO_AUTOCOMPACT_WINDOW = 250_000;
// Contexto (tokens) a partir del cual toca relevo de conversación: ROUTER_RELEVO_TOKENS lo cambia (config.relevoTokens).
export const RELEVO_TOKENS_DEFAULT = 150_000;
// Tokens de salida que se estiman por carácter del resumen (el resumen real lleva además un bloque de análisis que se descarta).
const CHARS_PER_TOKEN = 3;

// --- Contexto actual ---

// `reported`: tamaño que informa Claude Code (statusline). Si no, el sufijo [1m] del id del modelo; y si el contexto
// ya supera 200k, la ventana es de 1M aunque el modelo no lo diga (el transcript guarda el modelo sin el sufijo).
export function contextWindowFor(model, reported = null, tokens = 0) {
  if (reported > 0) return reported;
  if (/\[1m\]/i.test(model ?? "") || tokens > WINDOW_DEFAULT) return WINDOW_1M;
  return WINDOW_DEFAULT;
}

// Contexto del último turno: entrada + caché leída + caché escrita (la salida no cuenta). Acepta la forma de la API o la normalizada.
export function contextTokens(u) {
  if (!u) return 0;
  if ("input" in u || "cacheRead" in u) return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0);
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

// `limit`: techo efectivo menor que la ventana (p. ej. autoCompactWindow de las sesiones co): el % se mide contra el menor de los dos.
export function contextState(ctx) {
  const tokens = ctx?.tokens ?? 0;
  if (!(tokens > 0)) return null;
  const window = contextWindowFor(ctx.model, ctx.window, tokens);
  const limit = ctx.limit > 0 ? Math.min(ctx.limit, window) : window;
  const ratio = tokens / limit;
  const level = ratio >= CONTEXT_CRITICAL ? "critical" : ratio >= CONTEXT_WARN ? "warn" : "ok";
  const relevo = ctx.relevoAt > 0 && tokens >= ctx.relevoAt;
  return { tokens, window, limit: ctx.limit > 0 ? limit : null, pct: Math.floor(ratio * 100), level, relevo };
}

// Estado del contexto de una ejecución (run.context lo escribe la statusline); null si aún no hay datos.
export const runContext = (run) => (run?.context ? contextState({ relevoAt: RELEVO_TOKENS_DEFAULT, ...run.context, limit: CO_AUTOCOMPACT_WINDOW }) : null);

// Sin eventos durante este tiempo y sin encargos en curso, la ejecución se considera ociosa.
export const BUSY_MS = 30_000;
export const CONTEXT_HELP = "Tarea cerrada y memoria al día → /clear. A mitad de tarea → deja que compacte.";
export const RELEVO_HELP = "Relevo: el orquestador escribe el resumen en el archivo de relevo y tú abres un co/cop nuevo en el proyecto.";

// ¿Hay trabajo en curso? Encargos running o ejecución activa (no esperando al usuario) con eventos recientes.
export function runBusy(run, now) {
  if (!run || run.status !== "running") return false;
  if (run.taskOrder?.some((id) => run.tasks?.[id]?.status === "running")) return true;
  return run.waiting == null && now - (run.updatedAt ?? 0) < BUSY_MS;
}

// Nivel y texto del aviso según el % de contexto y si hay trabajo en curso: ocioso → /clear, trabajando → compactar.
// `relevo` (se pasó el umbral de relevo): sin aviso de 80/90 % el texto es "relevo"; con él, se mantiene y se añade relevo: true.
export function contextAdvice(pct, busy, relevo = false) {
  const flag = relevo ? { relevo: true } : {};
  if (pct >= CONTEXT_CRITICAL * 100) return { level: "critical", text: busy ? "compacta ya" : "haz /clear", ...flag };
  if (pct >= CONTEXT_WARN * 100) return { level: "warn", text: busy ? "compactar pronto" : "buen momento para /clear", ...flag };
  if (relevo) return { level: "relevo", text: "relevo", ...flag };
  return { level: "ok", text: null };
}

// Entrada de la statusline → evento de contexto (null sin uso del último turno).
export function contextFromStatusline(input, now, relevoAt = null) {
  const cw = input?.context_window;
  const tokens = contextTokens(cw?.current_usage);
  if (!(tokens > 0)) return null;
  return { type: "context", tokens, model: input?.model?.id ?? null, window: cw.context_window_size > 0 ? cw.context_window_size : null, ...(relevoAt > 0 && { relevoAt }), t: now };
}

// Para no escribir un evento por cada token: mismo modelo y ventana, y menos de un 1 % de la ventana de diferencia.
export function sameContext(a, b) {
  if (!a || !b) return false;
  if (a.model !== b.model || (a.window ?? null) !== (b.window ?? null)) return false;
  return Math.abs(a.tokens - b.tokens) < contextWindowFor(b.model, b.window, b.tokens) * 0.01;
}

// --- Detección en el transcript ---

// Entrada { type: "system", subtype: "compact_boundary", compactMetadata: { trigger, preTokens, postTokens, durationMs } }.
export function parseCompactBoundary(e) {
  if (e?.type !== "system" || e.subtype !== "compact_boundary" || e.isSidechain === true) return null;
  const m = e.compactMetadata;
  if (!m || typeof m !== "object") return null;
  const t = Date.parse(e.timestamp);
  return {
    id: e.uuid ?? null, trigger: m.trigger ?? null, preTokens: m.preTokens ?? 0, postTokens: m.postTokens ?? 0,
    durationMs: m.durationMs ?? null, t: Number.isNaN(t) ? null : t
  };
}

// Longitud del mensaje resumen (`isCompactSummary`); null si la entrada no lo es.
export function compactSummaryChars(e) {
  if (e?.isCompactSummary !== true) return null;
  const c = e.message?.content;
  if (typeof c === "string") return c.length;
  return Array.isArray(c) ? c.reduce((n, b) => n + (typeof b?.text === "string" ? b.text.length : 0), 0) : null;
}

// Todas las compactaciones de un trozo de transcript, con el modelo del último turno anterior y el tamaño del resumen.
export function compactionsFromTranscript(text) {
  const out = [];
  let model = null;
  for (const l of (text ?? "").split("\n")) {
    if (!l.includes('"compact_boundary"') && !l.includes('"isCompactSummary"') && !l.includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const b = parseCompactBoundary(e);
    if (b) { out.push({ ...b, summaryChars: null, model }); continue; }
    const chars = compactSummaryChars(e);
    if (chars != null && out.length) { const last = out[out.length - 1]; if (last.summaryChars == null) last.summaryChars = chars; continue; }
    const m = e?.type === "assistant" && e.isSidechain !== true ? e.message?.model : null;
    if (m && m !== "<synthetic>") model = m;
  }
  return out;
}

// --- Coste ---

// La llamada que genera el resumen no queda en el transcript (verificado: no hay mensaje assistant entre el último turno
// y el límite). Se estima: entrada = contexto previo leído de caché (preTokens) y salida según el tamaño del resumen.
export function compactionUsage(rec) {
  const output = rec.summaryChars != null ? Math.ceil(rec.summaryChars / CHARS_PER_TOKEN) : rec.postTokens ?? 0;
  return addUsage(emptyUsage(), { input: 0, output, cacheRead: rec.preTokens ?? 0 });
}

export const compactionCost = (rec) => costOf(rec.model, compactionUsage(rec));

// `restUsd`: gasto de la sesión sin las compactaciones. El % se mide sobre restUsd + coste de las compactaciones.
export function summarizeCompactions(records, restUsd = 0) {
  if (!records?.length) return null;
  const items = records.map((r) => ({ ...r, tokens: totalTokens(compactionUsage(r)), costUsd: compactionCost(r) }));
  const known = items.filter((i) => i.costUsd != null);
  const costUsd = known.reduce((a, i) => a + i.costUsd, 0);
  const whole = restUsd + costUsd;
  return {
    count: items.length, auto: items.filter((i) => i.trigger === "auto").length, manual: items.filter((i) => i.trigger === "manual").length,
    tokens: items.reduce((a, i) => a + i.tokens, 0), costUsd, partial: known.length < items.length,
    pct: known.length === 0 ? null : whole > 0 ? (costUsd / whole) * 100 : 100, items
  };
}
