// Guion de demostración: eventos normalizados idénticos a los de una ejecución real.
// Pasan por el mismo reducer, así la demo y el modo en vivo se ven igual.
import { reduceEvents } from "../../src/core/reducer.mjs";
import { derivePhase } from "../../src/core/view.mjs";

const tools = (taskId, times, name = "Edit") => times.map((t) => ({ type: "tool", taskId, name, t }));

const raw = [
  { type: "run_start", runId: "demo", task: "Añade validación al formulario de registro y actualiza el changelog", mode: "orquestado", model: "opus", cwd: "~/proyecto", t: 0 },
  { type: "main_model", model: "claude-opus-5-5", t: 400 },
  { type: "thinking", taskId: null, text: "Leo el formulario y sus tests", t: 900 },
  ...tools(null, [1400, 2000, 2600], "Read"),
  { type: "thinking", taskId: null, text: "Dos encargos independientes", t: 3200 },
  { type: "task_start", taskId: "p1", agent: "programador", description: "Validación + tests", prompt: "", t: 3800 },
  { type: "task_start", taskId: "a1", agent: "asistente", description: "Entrada en CHANGELOG", prompt: "", t: 4100 },
  { type: "quota", status: "allowed", limitType: "five_hour", fiveHour: { utilization: 0.41, resetsAt: null }, sevenDay: { utilization: 0.22, resetsAt: null }, t: 4300 },
  ...tools("p1", [4700, 5300, 5900, 6500, 7100, 7700, 8300, 9000]),
  ...tools("a1", [4900, 5600]),
  { type: "task_end", taskId: "a1", status: "completed", summary: "OK", tokens: 3100, toolUses: 2, durationMs: 2100, t: 6300 },
  { type: "task_start", taskId: "p2", agent: "programador", description: "Test e2e del registro", prompt: "", t: 8200 },
  ...tools("p2", [8700, 9400, 10000], "Bash"),
  { type: "task_end", taskId: "p1", status: "completed", summary: "Validación lista, 6 tests", tokens: 21400, toolUses: 8, durationMs: 5800, t: 9600 },
  { type: "task_end", taskId: "p2", status: "failed", summary: "1 test en rojo: email con mayúsculas", tokens: 8200, toolUses: 3, durationMs: 2400, t: 10600 },
  { type: "thinking", taskId: null, text: "Reintento con más contexto", t: 11000 },
  { type: "task_start", taskId: "p3", agent: "programador", description: "Normaliza el email", prompt: "", t: 11800 },
  ...tools("p3", [12300, 12900, 13600, 14200]),
  { type: "task_end", taskId: "p3", status: "completed", summary: "e2e en verde", tokens: 6900, toolUses: 4, durationMs: 3000, t: 14800 },
  { type: "thinking", taskId: null, text: "Reviso el diff y los tests", t: 15300 },
  ...tools(null, [15800, 16400], "Bash"),
  { type: "usage", costUsd: 0.86, byModel: { "claude-opus-5-5": { costUsd: 0.31 }, "claude-sonnet-5-5": { costUsd: 0.47 }, "claude-haiku-5-5": { costUsd: 0.08 } }, t: 17000 },
  { type: "run_end", exitCode: 0, t: 17600 }
];

export const DEMO_EVENTS = raw.sort((a, b) => a.t - b.t);
export const DEMO_LENGTH = 22_000;

export function demoRunAt(ms) {
  return reduceEvents(DEMO_EVENTS.filter((e) => e.t <= ms));
}

// Tramos [inicio, fin) de cada fase, muestreando el guion. Sirve para llenar la línea de tiempo.
export function phaseSpans(events, length, step = 100) {
  const spans = [];
  let i = 0;
  let run = null;
  for (let t = 0; t <= length; t += step) {
    while (i < events.length && events[i].t <= t) run = reduceEvents([events[i++]], run);
    const phase = derivePhase(run, t);
    const last = spans.at(-1);
    if (last?.phase === phase) last.end = t + step;
    else spans.push({ phase, start: t, end: t + step });
  }
  return spans;
}
