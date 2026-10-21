// Aviso de delegar: el orquestador (sesión principal, sin agent_id) editando archivos él mismo. Solo informa, nunca bloquea.
// Puro: la decisión depende solo del payload del hook.

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Carpetas que el orquestador sí escribe él: la memoria de Claude y los archivos de relevo.
const EXEMPT_DIRS = new Set(["memory", "relevo"]);

export const DIRECT_EDIT_WARNING = "Aviso: el orquestador está editando directamente. Si el contenido ya está decidido, delega a asistente (texto, config, docs) o a programador (código).";

function exempt(path) {
  if (typeof path !== "string" || !path) return false;
  const dirs = path.split(/[\\/]/).slice(0, -1);
  return dirs.some((d) => EXEMPT_DIRS.has(d));
}

export function isDirectEdit(p) {
  if (p?.hook_event_name !== "PreToolUse" || p.agent_id || !EDIT_TOOLS.has(p.tool_name)) return false;
  const input = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  return !exempt(input.file_path ?? input.notebook_path);
}

// Línea bajo el orquestador en el dashboard; null con 0 ediciones.
export const directEditsLine = (run) => (run?.directEdits > 0 ? `ediciones directas: ${run.directEdits}` : null);
