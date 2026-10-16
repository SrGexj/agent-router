// Estado visible de una pestaña de sesión: texto y color del punto. Puro, para poder probarlo.
export const PHASE_LABEL = { recibe: "recibiendo", analiza: "analizando", delega: "delegando", ejecuta: "ejecutando", revisa: "revisando", limitado: "límite", fallo: "falló" };
const WORKING = new Set(["recibe", "analiza", "delega", "ejecuta", "revisa"]);

export function pillStatus(p) {
  if (p.waiting) return { text: "espera respuesta", dot: "wait pulse", tone: "wait" };
  if (p.alert) return { text: "aviso", dot: "err pulse", tone: "err" };
  if (p.phase === "fallo" || p.phase === "limitado") return { text: PHASE_LABEL[p.phase], dot: "err", tone: "err" };
  if (WORKING.has(p.phase)) return { text: PHASE_LABEL[p.phase], dot: "ok", tone: "ok" };
  return { text: PHASE_LABEL[p.phase] ?? "inactiva", dot: "idle", tone: "idle" };
}
