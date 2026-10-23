// Lógica pura de las barras de la tarjeta de gasto/uso/contexto bajo el orquestador.
import { fmtTokens } from "./captions.js";

const FAMILIES = [
  { key: "opus", name: "Opus" },
  { key: "sonnet", name: "Sonnet" },
  { key: "haiku", name: "Haiku" }
];

// Segmentos de una barra repartida por modelo; las familias al 0 % no ocupan sitio.
export function barSegments(share) {
  return FAMILIES.map(({ key }) => ({ key, pct: share?.[key] ?? 0 })).filter((s) => s.pct > 0);
}

// Leyenda de una sola línea: solo los modelos con algo. Vacía = la vista pinta «—».
export function legendItems(share) {
  return FAMILIES.map(({ key, name }) => ({ key, name, pct: share?.[key] ?? 0 })).filter((s) => s.pct > 0);
}

// Umbrales de color de la barra de contexto (% de uso).
export const CTX_AMBER = 60;
export const CTX_RED = 80;
export const contextTone = (pct) => (pct >= CTX_RED ? "critical" : pct >= CTX_AMBER ? "warn" : "ok");

// «28 % · 189,3 k / 1 M»: porcentaje, tokens y techo con el que se mide.
export const contextValue = (ctx) => `${ctx.pct} % · ${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.limit ?? ctx.window)}`;
