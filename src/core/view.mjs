// Vistas derivadas del estado de una ejecución. Puras: "ahora" entra como parámetro.
import { modelFamily } from "./pricing.mjs";

export const PHASES = ["recibe", "analiza", "delega", "ejecuta", "revisa", "entrega"];
export const SLOTS = 6;

const DELEGA_MS = 2_000;
const FLASH_MS = 450;
// Sin eventos durante este tiempo, una ejecución "en curso" se da por abandonada
// (terminal cerrada a mitad, sesión colgada). Si vuelven a llegar eventos, se reactiva.
export const STALE_MS = 20 * 60_000;

// Una pregunta o un permiso pueden esperar horas: no es "sin señal".
export const isWaiting = (run) => run?.waiting != null;

export function isStale(run, now) {
  return run?.status === "running" && !isWaiting(run) && now - run.updatedAt >= STALE_MS;
}

export function isActive(run, now) {
  return run?.status === "running" && !isStale(run, now);
}

export function derivePhase(run, now) {
  if (!run) return "reposo";
  if (run.limit) return "limitado";
  if (run.status === "failed" || run.status === "cancelled" || isStale(run, now)) return "fallo";
  if (run.status === "limited") return "limitado";
  if (run.status === "completed") return "entrega";
  if (isWaiting(run)) return "espera"; // fase aparte: no forma parte de PHASES

  const tasks = run.taskOrder.map((id) => run.tasks[id]);
  if (tasks.length === 0) return run.orchestratorActiveAt == null ? "recibe" : "analiza";
  if (tasks.some((t) => t.status === "running")) {
    const firstWave = tasks.every((t) => t.status === "running");
    const lastStart = Math.max(...tasks.map((t) => t.startedAt ?? 0));
    return firstWave && now - lastStart < DELEGA_MS ? "delega" : "ejecuta";
  }
  return "revisa";
}

// Una ejecución terminada conserva el estado final de sus huecos (done/failed): no hay desvanecimiento.
function slotState(task, now) {
  if (task.status === "running") {
    return task.lastToolAt != null && now - task.lastToolAt < FLASH_MS ? "flash" : "running";
  }
  if (task.status === "failed" || task.status === "killed") return "failed";
  return "done";
}

export function workerView(run, node, now) {
  const empty = { running: 0, done: 0, failed: 0, total: 0, tokens: 0, model: null, slots: Array(SLOTS).fill("idle"), last: null };
  if (!run) return empty;
  const tasks = run.taskOrder.map((id) => run.tasks[id]).filter((t) => t.node === node);
  if (tasks.length === 0) return empty;

  const slots = Array(SLOTS).fill("idle");
  tasks.slice(-SLOTS).forEach((t, i) => { slots[i] = slotState(t, now); });

  return {
    running: tasks.filter((t) => t.status === "running").length,
    done: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed" || t.status === "killed").length,
    total: tasks.length,
    tokens: tasks.reduce((acc, t) => acc + (t.tokens ?? 0), 0),
    model: tasks.findLast((t) => t.model)?.model ?? null,
    slots,
    last: tasks.at(-1)
  };
}


function toPercents(parts) {
  const total = parts.opus + parts.sonnet + parts.haiku;
  if (total <= 0) return { opus: 0, sonnet: 0, haiku: 0 };
  const sonnet = Math.round((parts.sonnet / total) * 100);
  const haiku = Math.round((parts.haiku / total) * 100);
  return { opus: Math.max(0, 100 - sonnet - haiku), sonnet, haiku };
}

export function costShare(run) {
  if (!run) return { opus: 0, sonnet: 0, haiku: 0, source: null };
  const byModel = run.usage?.byModel ?? {};
  const parts = { opus: 0, sonnet: 0, haiku: 0 };
  for (const [model, u] of Object.entries(byModel)) parts[modelFamily(model)] += u.costUsd ?? 0;
  if (parts.opus + parts.sonnet + parts.haiku > 0) return { ...toPercents(parts), source: "coste" };

  const counts = { opus: 0, sonnet: 0, haiku: 0 };
  for (const id of run.taskOrder) {
    const node = run.tasks[id].node;
    if (node === "asistente") counts.haiku += 1;
    else if (node === "consultor") counts.opus += 1;
    else if (node !== "propio") counts.sonnet += 1;
  }
  if (counts.opus + counts.sonnet + counts.haiku === 0) return { opus: 0, sonnet: 0, haiku: 0, source: null };
  return { ...toPercents(counts), source: "encargos" };
}
