// Uso real de tokens por modelo a partir de un transcript JSONL de Claude Code. Puro: recibe el texto.
// Claude Code escribe varias líneas por mensaje con el mismo message.id y el mismo usage: se cuenta una vez.
import { addUsage, emptyUsage } from "./pricing.mjs";

const SYNTHETIC = "<synthetic>";

// sidechain:false descarta lo del subagente (transcript principal); true acepta todo (transcript de subagente).
export function usageFromTranscript(text, { sidechain = false } = {}) {
  const byId = new Map();
  let anon = 0;
  for (const line of (text ?? "").split("\n")) {
    const hit = usageEntry(line, sidechain);
    if (hit) byId.set(hit.id ?? `sin-id-${anon++}`, { model: hit.model, usage: hit.usage }); // gana la última
  }
  const byModel = {};
  for (const { model, usage } of byId.values()) byModel[model] = addUsage(byModel[model] ?? emptyUsage(), usage);
  return { byModel };
}

function usageEntry(line, sidechain) {
  if (!line.includes('"usage"')) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; } // vacía o cortada a mitad
  if (e?.type !== "assistant" || (!sidechain && e.isSidechain === true)) return null;
  const m = e.message;
  if (!m?.usage || !m.model || m.model === SYNTHETIC) return null;
  return { id: m.id ?? null, model: m.model, usage: m.usage };
}

// --- Lectura incremental ---
// Estado (JSON, cabe en la sesión): offset en bytes ya consumido, byModel de los mensajes ya cerrados y
// `recent`, los últimos mensajes vistos (aún pueden reaparecer con el mismo id y gana la última línea).
// Los que salen de la ventana se pliegan en byModel. Un id que reaparezca fuera de la ventana se contaría
// dos veces: Claude Code reescribe un mismo id en líneas contiguas, así que con 32 sobra.
const RECENT_MAX = 32;

export const startUsage = (offset = 0) => ({ offset, byModel: {}, recent: [] });

const fold = (byModel, { model, usage }) => ({ ...byModel, [model]: addUsage(byModel[model] ?? emptyUsage(), usage) });

function foldLines(state, lines, sidechain) {
  let byModel = state.byModel;
  const recent = state.recent.map((r) => [...r]);
  for (const line of lines) {
    const hit = usageEntry(line, sidechain);
    if (!hit) continue;
    if (hit.id == null) { byModel = fold(byModel, hit); continue; }
    const i = recent.findIndex((r) => r[0] === hit.id);
    if (i >= 0) recent.splice(i, 1);
    recent.push([hit.id, hit.model, hit.usage]);
    while (recent.length > RECENT_MAX) { const [, model, usage] = recent.shift(); byModel = fold(byModel, { model, usage }); }
  }
  return { ...state, byModel, recent };
}

const totalOf = (state) => state.recent.reduce((acc, [, model, usage]) => fold(acc, { model, usage }), state.byModel);

// `text` es lo leído desde state.offset. Solo se consumen las líneas completas; la última, si aún no
// tiene salto de línea, cuenta en `usage` pero se vuelve a leer la próxima vez. usage == usageFromTranscript de todo.
export function advanceUsage(state, text, { sidechain = false } = {}) {
  const t = text ?? "";
  const cut = t.lastIndexOf("\n") + 1;
  const done = t.slice(0, cut);
  const next = { ...foldLines(state, done.split("\n"), sidechain), offset: state.offset + Buffer.byteLength(done) };
  const withTail = cut < t.length ? foldLines(next, [t.slice(cut)], sidechain) : next;
  return { state: next, usage: { byModel: totalOf(withTail) } };
}

// Modelo del último mensaje assistant del transcript principal (sin subagentes ni sintéticos); null si no hay.
export function lastModelOf(text) {
  let model = null;
  for (const line of (text ?? "").split("\n")) {
    const hit = usageEntry(line, false);
    if (hit) model = hit.model;
  }
  return model;
}

// Ruta del transcript de un subagente: la que traiga el hook (SubagentStop) o la derivada del transcript
// principal (<proyecto>/<sesión>.jsonl → <proyecto>/<sesión>/subagents/agent-<id>.jsonl), que es la que
// usan también los hooks de PreToolUse/PostToolUse del subagente, que no traen agent_transcript_path.
export function agentTranscriptPath(p) {
  if (p?.agent_transcript_path) return p.agent_transcript_path;
  if (!p?.agent_id || !p.transcript_path || !p.transcript_path.endsWith(".jsonl")) return null;
  return `${p.transcript_path.slice(0, -".jsonl".length)}/subagents/agent-${p.agent_id}.jsonl`;
}
