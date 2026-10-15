// Ejecuta el clasificador y deja el resultado en el JSONL de la ejecución. No decide nada:
// solo registra lo que el clasificador habría elegido. Puro respecto a E/S: clasificador, store y reloj entran por parámetros.

import { esAvisoDelSistema } from "./avisos.mjs";

export async function runShadow({ classifier, store, runId, prompt, model, now = Date.now }) {
  const t0 = now();
  // Avisos del sistema: no son encargos repartibles. No se llama al clasificador; se anota "no aplica".
  if (esAvisoDelSistema(prompt)) {
    const event = { type: "shadow_route", model, choice: null, na: true, error: null, t: now() };
    await store.append(runId, event);
    return event;
  }
  let event;
  try {
    const r = await classifier.classify(prompt);
    event = { type: "shadow_route", model, choice: r.choice, confidence: r.confidence ?? null, reason: r.reason ?? null, latencyMs: r.latencyMs ?? null, costUsd: r.costUsd ?? null, t: now() };
  } catch (e) {
    event = { type: "shadow_route", model, choice: null, error: String(e?.message ?? "error").slice(0, 120), latencyMs: now() - t0, t: now() };
  }
  await store.append(runId, event);
  return event;
}
