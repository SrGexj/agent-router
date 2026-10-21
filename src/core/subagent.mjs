// Resumen de un subagente a partir de su transcript JSONL: estado real, modelo real, tokens, herramientas y duración.
// Puro: recibe el texto. El modelo sale de los mensajes del subagente, no del subagent_type pedido (un hook puede reescribirlo).

const SYNTHETIC = "<synthetic>";
const INTERRUPT = "[Request interrupted by user";
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|rate[ _-]?limit/i;

const PERMISSION_TEXT = /permission|denied|not allowed/i;

const textOf = (content) =>
  typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((b) => (b?.type === "text" ? b.text ?? "" : "")).join(" ");

export function summarizeSubagent(text) {
  const entries = [];
  for (const l of (text ?? "").split("\n")) {
    if (!l.trim()) continue;
    try { const e = JSON.parse(l); if (e && typeof e === "object") entries.push(e); } catch { /* línea cortada o corrupta */ }
  }

  const byMessage = new Map(); // id → uso (varias líneas por mensaje: gana la última)
  const toolIds = new Set();
  let model = null;
  let first = null;
  let last = null;
  let interrupted = false;
  let lastStep = null; // último mensaje real: assistant o user (los adjuntos y metadatos no cuentan)

  for (const e of entries) {
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts)) { first = first == null ? ts : Math.min(first, ts); last = last == null ? ts : Math.max(last, ts); }
    const m = e.message;
    if (e.type === "assistant" && m) {
      lastStep = e;
      if (m.model && m.model !== SYNTHETIC) model = m.model;
      if (m.usage && m.model && m.model !== SYNTHETIC) byMessage.set(m.id ?? `sin-id-${byMessage.size}`, m.usage);
      for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "tool_use") toolIds.add(b.id ?? `sin-id-${toolIds.size}`);
    } else if (e.type === "user" && m) {
      lastStep = e;
      if (Array.isArray(m.content) ? m.content.some((b) => b?.type === "text" && String(b.text ?? "").startsWith(INTERRUPT)) : String(m.content ?? "").startsWith(INTERRUPT)) interrupted = true;
    }
  }

  let tokens = null;
  if (byMessage.size) {
    tokens = 0;
    for (const u of byMessage.values()) tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }

  let status = "completed";
  let error = null;
  const apiError = lastStep?.type === "assistant" && lastStep.isApiErrorMessage === true;
  const endsInToolError = lastStep?.type === "user" && Array.isArray(lastStep.message.content) && lastStep.message.content.some((b) => b?.type === "tool_result" && b.is_error === true);
  if (interrupted) { status = "killed"; error = "interrupted"; }
  else if (apiError) { status = "failed"; error = LIMIT_TEXT.test(textOf(lastStep.message.content)) ? "limit" : "api"; }
  else if (endsInToolError) {
    status = "failed";
    const body = lastStep.message.content.map((b) => textOf(b?.content)).join(" ");
    error = PERMISSION_TEXT.test(body) ? "permission" : "tool_error";
  }

  return {
    status, error, model, tokens,
    toolUses: entries.length ? toolIds.size : null,
    durationMs: first != null && last != null ? last - first : null
  };
}
