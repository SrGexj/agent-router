// Qué se mueve por las aristas cuando llega cada evento. Puro.

export function truncate(text, max) {
  const s = (text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const DOT_MS = 1300;
const LABEL_MS = 2200;

export function packetsFor(ev, run, born, nextSeq) {
  const mk = (edge, dir, kind, label, dur) => ({ id: `${born}-${nextSeq()}`, edge, dir, kind, label, born, dur });
  const nodeOf = (taskId) => run?.tasks?.[taskId]?.node ?? "programador";

  switch (ev.type) {
    case "run_start":
      return [mk("in", 1, "label", truncate(ev.task, 22), LABEL_MS)];
    case "task_start":
      return [mk(nodeOf(ev.taskId), 1, "label", truncate(ev.description, 24), LABEL_MS)];
    case "tool":
      return ev.taskId ? [mk(nodeOf(ev.taskId), 1, "dot", null, DOT_MS)] : [mk("in", 1, "dot", null, DOT_MS)];
    case "task_end":
      return ev.status === "completed"
        ? [mk(nodeOf(ev.taskId), -1, "ok", "OK", LABEL_MS)]
        : [mk(nodeOf(ev.taskId), -1, "error", "fallo", LABEL_MS)];
    case "error":
      if (ev.kind === "limit") return [mk("in", -1, "error", "429 límite", LABEL_MS)];
      if (ev.kind === "permission") return [mk("in", -1, "error", "permiso", LABEL_MS)];
      return [mk("in", -1, "error", "error", LABEL_MS)];
    case "run_end":
      return ev.exitCode === 0 ? [mk("in", -1, "ok", "hecho", LABEL_MS)] : [mk("in", -1, "error", "error", LABEL_MS)];
    default:
      return [];
  }
}
