// Pendientes que podrían quedar a medias al compactar el contexto. Puro y sin LLM: la ejecución (reducida),
// la cola del transcript y el reloj entran como parámetros; la E/S la hace el hook.

const TASK_MAX = 600;
const MD_MAX = 2500;
const LABELS = { tarea: "Tarea abierta", encargo: "Encargo", pregunta: "Pregunta sin responder", todo: "Lista de tareas" };

const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const flat = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

// Los pegados largos no aportan al recordatorio: se sustituyen y se recorta.
export function sanitizeTask(text) {
  return cut(flat(String(text ?? "").replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, "[texto pegado]")), TASK_MAX);
}

// Último estado de la lista de tareas de Claude en la cola del transcript (el sidechain es de subagentes: se ignora).
// TodoWrite reemplaza la lista entera; TaskCreate/TaskUpdate la van construyendo (ids correlativos desde 1).
function todosFrom(tail) {
  let todoWrite = null;
  const tasks = new Map();
  let next = 1;
  for (const l of String(tail ?? "").split("\n")) {
    if (!l.includes("tool_use")) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (!e || e.isSidechain === true || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== "tool_use" || !b.input || typeof b.input !== "object") continue;
      if (b.name === "TodoWrite" && Array.isArray(b.input.todos)) {
        todoWrite = b.input.todos.filter((t) => t && typeof t === "object").map((t) => ({ text: flat(t.content) || flat(t.subject), status: String(t.status ?? "pending") }));
      } else if (b.name === "TaskCreate") {
        tasks.set(String(next++), { text: flat(b.input.subject) || flat(b.input.description), status: "pending" });
      } else if (b.name === "TaskUpdate" && tasks.has(String(b.input.taskId))) {
        const prev = tasks.get(String(b.input.taskId));
        tasks.set(String(b.input.taskId), { text: flat(b.input.subject) || prev.text, status: typeof b.input.status === "string" ? b.input.status : prev.status });
      }
    }
  }
  return [...(todoWrite ?? []), ...tasks.values()]
    .filter((t) => t.text && t.status !== "completed" && t.status !== "cancelled" && t.status !== "deleted")
    .map((t) => ({ type: "todo", text: t.status === "in_progress" ? `${t.text} (en curso)` : t.text }));
}

export function collectPending({ run, transcriptTail, now: _now }) {
  const out = [];
  if (run?.status === "running" && flat(run.task)) out.push({ type: "tarea", text: sanitizeTask(run.task) });
  for (const id of run?.taskOrder ?? Object.keys(run?.tasks ?? {})) {
    const t = run.tasks?.[id];
    if (!t || (t.status !== "running" && t.status !== "failed")) continue;
    const desc = `${t.agent ?? "agente"}: ${flat(t.description) || "(sin descripción)"}`;
    const summary = flat(t.summary);
    out.push({ type: "encargo", text: t.status === "running" ? `${desc} (en curso)` : `${desc} (falló${summary ? `: ${cut(summary, 200)}` : ""})` });
  }
  if (run?.waiting && flat(run.waiting.text)) out.push({ type: "pregunta", text: cut(flat(run.waiting.text), 300) });
  return [...out, ...todosFrom(transcriptTail)];
}

export function formatPending(list, { runId, t }) {
  if (!list?.length) return null;
  const head = `# Pendientes guardados antes de compactar\n\nEjecución ${runId ?? "?"} · ${new Date(t).toISOString()}\n`;
  const lines = list.map((p) => `- ${LABELS[p.type] ?? p.type}: ${p.text}`);
  let md = head;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i - 1;
    const reserve = rest > 0 ? `\n…y ${rest} más`.length : 0;
    if (md.length + 1 + lines[i].length + reserve > MD_MAX) {
      const left = lines.length - i;
      return `${md}\n…y ${left} más`;
    }
    md += `\n${lines[i]}`;
  }
  return md;
}
