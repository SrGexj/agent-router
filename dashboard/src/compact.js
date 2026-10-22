// Textos compactos de los paneles Cuota y Consumo. Puro: la vista solo pinta lo que sale de aquí.
import { fmtClock, fmtCost, fmtCostFine, fmtTokens, fmtTokenTypes } from "./captions.js";
import { provenanceLabel } from "../../src/core/consumo.mjs";

export const toneOf = (pct) => (pct >= 90 ? "err" : pct >= 70 ? "warn" : "ok");

const WINDOWS = { "5h": { label: "5 h", long: "Ventana de 5 horas" }, "7d": { label: "7 d", long: "Ventana de 7 días" } };

// Una ventana en una línea: "5 h · 67 % · ↻ 15:00". expired: ya reiniciada (0 %). note: aviso de fuente para el tooltip.
// estimate: la fuente no es oficial (estimación del monitor): el % va con "~" delante.
export function windowLine(kind, usedPct, resetsAt, { expired = false, note, estimate = false } = {}) {
  const { label, long } = WINDOWS[kind];
  const pct = expired ? 0 : Math.round(usedPct ?? 0);
  const reset = expired ? "reiniciada" : resetsAt ? `↻ ${fmtClock(resetsAt)}` : "";
  const pctText = `${estimate && !expired ? "~" : ""}${pct} %`;
  const title = `${long}: ${pctText} usado${expired ? ", ya reiniciada" : resetsAt ? `, se reinicia a las ${fmtClock(resetsAt)}` : ""}${note ? ` · ${note}` : ""}`;
  return { label, pct, pctText, tone: toneOf(pct), reset, text: [label, pctText, reset].filter(Boolean).join(" · "), title };
}

// "15 %" y debajo "16,28 $ de 19,18 $ · 8 ejec."; tokens y tipos van al tooltip.
export function savingsLines(s) {
  if (!s || !s.runs) return null;
  const runs = `${s.runs} ${s.runs === 1 ? "ejecución" : "ejecuciones"}`;
  return {
    pct: s.savingsPct == null ? "—" : `${Math.round(s.savingsPct)} %`,
    detail: `${fmtCost(s.total)} de ${fmtCost(s.opusEquivalentUsd)} · ${s.runs} ejec.`,
    title: [`${fmtCost(s.total)} en vez de ${fmtCost(s.opusEquivalentUsd)}`, `${fmtTokens(s.tokens)} tok`, runs, fmtTokenTypes(s.tokenTypes)].filter(Boolean).join(" · ")
  };
}

// Clasificador en sombra: resumen de una línea y el resto para el <details>.
export function shadowLines(sh) {
  if (!sh || !sh.n) return null;
  const tr = sh.training;
  const detail = [
    `${sh.savingsUsd >= 0 ? "ahorraría" : "costaría"} ~${fmtCostFine(Math.abs(sh.savingsUsd))} · coste ${sh.name} ${fmtCostFine(sh.jevCostUsd)}${sh.errors ? ` · ${sh.errors} ${sh.errors === 1 ? "fallo" : "fallos"}` : ""} · estimación gruesa`
  ];
  if (sh.others?.length > 0) detail.push(`(no incluye ${sh.others.map((o) => `${o.n} de ${o.name}`).join(" ni ")})`);
  if (tr && tr.n > 0) detail.push(`Datos para entrenar: ${tr.n} (${tr.corrected} ${tr.corrected === 1 ? "corregida" : "corregidas"}) · asistente ${tr.byLabel.asistente} · programador ${tr.byLabel.programador} · orquestador ${tr.byLabel.opus}`);
  return { name: sh.name, pct: `${Math.round(sh.matchPct)} %`, ratio: `(${sh.matches}/${sh.n})`, title: `${sh.name} en sombra: acierta ${sh.matches} de ${sh.n}`, summary: `Detalle ${sh.name}`, detail };
}

const P90_NO_DATA = {
  "pocos-datos": "Pocos datos para calcular el P90: el monitor necesita sesiones de 5 h completas en los últimos 8 días.",
  "plan-no-custom": "El monitor no está midiendo con su plan Custom, así que no hay P90 personal.",
  "sin-limite": "El monitor no ha dado un P90 en esta lectura."
};

// Previsión frente al P90 fusionada con el reinicio, en una sola línea.
export function p90ForecastLine(p90) {
  if (!p90?.active) return null;
  const reset = p90.resetAt ? fmtClock(p90.resetAt) : null;
  const f = p90.forecast;
  if ((p90.pct?.tokens ?? 0) >= 100) return `Ya has superado tu P90 de tokens en esta sesión${reset ? ` · la sesión se reinicia a las ${reset}` : ""}`;
  if (f) {
    if (f.beforeReset === false) return `A este ritmo no llegas a tu P90 antes del reinicio${reset ? ` de las ${reset}` : ""}`;
    return `A este ritmo llegarías a tu P90 a las ${fmtClock(f.hitAt)}${reset ? ` · la sesión se reinicia a las ${reset}` : ""}`;
  }
  return reset ? `La sesión de 5 h del monitor se reinicia a las ${reset}` : null;
}

// Bloque P90: título corto (con subtítulo en el tooltip), barra de tokens y una línea de mensajes · coste · ritmo.
export function p90Lines(p90) {
  if (!p90) return null;
  const days = Math.round((p90.sampleHours ?? 192) / 24);
  const title = "Tu sesión vs tu P90";
  if (!p90.available) return { title, hint: `Referencia personal del monitor, no es el límite de tu plan · últimos ${days} días`, unavailable: P90_NO_DATA[p90.reason] ?? P90_NO_DATA["pocos-datos"] };
  const { used, limits, pct } = p90;
  const shown = pct?.tokens != null ? Math.round(pct.tokens) : null;
  const rate = p90.burnRate;
  const parts = [];
  if (used.messages != null) parts.push(`${used.messages} ${used.messages === 1 ? "mensaje" : "mensajes"}`);
  if (used.costUsd != null) parts.push(`≈ ${fmtCost(used.costUsd)}`);
  if (rate?.tokensPerMinute != null) parts.push(`${fmtTokens(Math.round(rate.tokensPerMinute))} tok/min`);
  return {
    title,
    hint: `Referencia personal del monitor, no es el límite de tu plan · ${provenanceLabel(p90.provenance?.confidence)} · últimos ${days} días`,
    tokens: used.tokens != null ? `${fmtTokens(used.tokens)} / ${fmtTokens(limits.tokens)} tok${shown != null ? ` · ${shown} %` : ""}` : `P90 ${fmtTokens(limits.tokens)} tok`,
    pct: shown,
    detail: p90.active && parts.length ? parts.join(" · ") : null,
    detailTitle: rate?.costPerHour != null ? `Ritmo en coste: ≈ ${fmtCost(rate.costPerHour)}/h en API` : undefined
  };
}

// Letra pequeña de fuentes de una cuenta, para la nota plegable. win: salida de pickWindows.
export function sourcesLines(p, win) {
  const tk = p.tokens;
  const lines = [`Tokens: claude-monitor ${p.toolVersion ?? ""} (${provenanceLabel(p.provenance?.confidence)})`.replace("  ", " ")];
  let price = `Coste equivalente en API: ${tk ? "precios del router (tabla de pricing.mjs)" : "precios del monitor"}`;
  if (tk && Math.abs(tk.month.costUsd.monitor - tk.month.costUsd.router) > 0.05 * tk.month.costUsd.router) price += ` (el monitor, con sus propios precios, cifra el mes en ≈ ${fmtCost(tk.month.costUsd.monitor)})`;
  lines.push(price);
  const conf = [...new Set([win?.window5h, win?.window7d].filter(Boolean).map((w) => (w.confidence === "local_estimate" ? "estimación local (puede no reflejar tu plan)" : provenanceLabel(w.confidence))))];
  if (conf.length) lines.push(`Ventanas: ${conf.join(" / ")}`);
  if (p.p90?.available) lines.push(`P90: ${provenanceLabel(p.p90.provenance?.confidence)}`);
  if (!tk) lines.push("Totales por día y mes: warehouse del monitor apagado");
  return lines;
}

const STATUS = {
  allowed: { dot: "ok", text: "Disponible" },
  allowed_warning: { dot: "warn", text: "Aviso" },
  rejected: { dot: "err", text: "Agotada" }
};

// Estado de la cuota de una cuenta para su badge; sin cuota, sin badge.
export const quotaBadge = (q) => (q ? STATUS[q.status] ?? { dot: "idle", text: "Sin datos" } : null);
