// Contexto del orquestador turno a turno, leído de su transcript. Puro y sin dependencias de Node.
// Un turno es un mensaje assistant del orquestador; Claude Code escribe varias líneas por mensaje con el mismo id.
import { contextTokens } from "./compaction.mjs";

const SYNTHETIC = "<synthetic>";
// Los ids recientes cubren las líneas repetidas de un mismo mensaje (siempre contiguas) aunque se lea en trozos.
const RECENT_MAX = 32;

export const startContext = (offset = 0) => ({ offset, turn: 0, recent: [] });

function entryOf(line) {
  if (!line.includes('"usage"')) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  const m = e?.message;
  if (e?.type !== "assistant" || e.isSidechain === true || !m?.usage || !m.model || m.model === SYNTHETIC) return null;
  const tokens = contextTokens(m.usage);
  if (!(tokens > 0)) return null;
  const ts = Date.parse(e.timestamp);
  return { id: m.id ?? null, model: m.model, tokens, ts: Number.isFinite(ts) ? ts : null };
}

// `text` es lo leído desde state.offset; solo se consumen líneas completas. Devuelve los eventos nuevos y el estado siguiente.
export function advanceContext(state, text, now) {
  const t = text ?? "";
  const cut = t.lastIndexOf("\n") + 1;
  let { turn } = state;
  const recent = [...state.recent];
  const events = [];
  for (const line of t.slice(0, cut).split("\n")) {
    const hit = entryOf(line);
    if (!hit) continue;
    if (hit.id != null) {
      if (recent.includes(hit.id)) continue;
      recent.push(hit.id);
      if (recent.length > RECENT_MAX) recent.shift();
    }
    turn += 1;
    events.push({ type: "context", turn, tokens: hit.tokens, model: hit.model, ts: hit.ts, t: now });
  }
  return { events, state: { offset: state.offset + Buffer.byteLength(t.slice(0, cut)), turn, recent } };
}
