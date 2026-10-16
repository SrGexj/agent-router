// Enrutado por Laya en el PreToolUse de Agent/Task: "shadow" solo anota qué habría elegido; "downgrade" baja
// de programador a asistente cuando Laya lo ve claro. Nunca sube de nivel, nunca bloquea (fail-open).
// Puro respecto a E/S: clasificador y reloj entran por parámetros.
import { sanitizePrompt } from "./classifier.mjs";

export const LAYA_ROUTING_MODES = Object.freeze(["off", "shadow", "downgrade"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Mismo texto que en los datos de entrenamiento: description + "\n" + prompt, saneado y recortado.
export const layaText = (input) => sanitizePrompt(`${input?.description ?? ""}\n${input?.prompt ?? ""}`).trim();

// Decisión pura. result = { choice, confidence } o null (error/timeout).
export function decideRouting({ mode, requested, result, threshold }) {
  const applied = mode === "downgrade"
    && requested === "programador"
    && result?.choice === "asistente"
    && typeof result.confidence === "number"
    && result.confidence >= threshold;
  return { applied };
}

export function layaDecisionEvent({ payload, requested, result, latencyMs, mode, applied, t, error }) {
  return {
    type: "laya_decision",
    ...(payload?.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
    requested,
    choice: result?.choice ?? null,
    confidence: result?.confidence ?? null,
    latencyMs,
    mode,
    applied,
    ...(error ? { error } : {}),
    t
  };
}

// updatedInput parcial falla la validación de Claude Code: siempre el tool_input completo. Sin permissionDecision: se respeta el flujo normal de permisos.
export const updatedInputOutput = (updatedInput) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } });

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

// Devuelve null si no toca consultar; si no, { event, output, input }. output (o null) es lo que el hook escribe en stdout.
export async function routeAgent({ payload, mode, threshold = 0.9, classifier, timeoutMs = 300, now = Date.now }) {
  if (!mode || mode === "off" || !classifier) return null;
  if (payload?.hook_event_name !== "PreToolUse" || !AGENT_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input ?? {};
  const requested = String(input.subagent_type || "general-purpose");
  const t0 = now();
  let result = null;
  let error = null;
  try {
    result = await withTimeout(classifier.classify(layaText(input)), timeoutMs);
  } catch (e) {
    error = String(e?.message ?? "error").slice(0, 120);
  }
  const { applied } = decideRouting({ mode, requested, result, threshold });
  const t = now();
  const event = layaDecisionEvent({ payload, requested, result, latencyMs: result?.latencyMs ?? t - t0, mode, applied, t, error });
  if (!applied) return { event, output: null, input };
  const updated = { ...input, subagent_type: "asistente" };
  return { event, output: updatedInputOutput(updated), input: updated };
}
