import { describe, it, expect } from "vitest";
import { reduceEvents } from "../src/core/reducer.mjs";
import { derivePhase, workerView, costShare, isActive, isStale, isWaiting, STALE_MS, PHASES } from "../src/core/view.mjs";

const start = { type: "run_start", runId: "r1", task: "t", mode: "orquestado", model: "opus", cwd: "/", t: 0 };
const taskStart = (id, agent, t) => ({ type: "task_start", taskId: id, agent, description: id, prompt: "", t });

describe("derivePhase", () => {
  it("recorre recibe → analiza → delega → ejecuta → revisa → entrega", () => {
    expect(PHASES).toEqual(["recibe", "analiza", "delega", "ejecuta", "revisa", "entrega"]);
    let evs = [start];
    expect(derivePhase(reduceEvents(evs), 100)).toBe("recibe");
    evs = [...evs, { type: "thinking", taskId: null, text: "", t: 100 }];
    expect(derivePhase(reduceEvents(evs), 200)).toBe("analiza");
    evs = [...evs, taskStart("a", "programador", 1000)];
    expect(derivePhase(reduceEvents(evs), 1500)).toBe("delega");
    expect(derivePhase(reduceEvents(evs), 5000)).toBe("ejecuta");
    evs = [...evs, { type: "task_end", taskId: "a", status: "completed", summary: "", t: 6000 }];
    expect(derivePhase(reduceEvents(evs), 6500)).toBe("revisa");
    evs = [...evs, { type: "run_end", exitCode: 0, t: 7000 }];
    expect(derivePhase(reduceEvents(evs), 7500)).toBe("entrega");
  });

  it("solo el primer reparto es delega: un reintento posterior ya es ejecuta", () => {
    const run = reduceEvents([
      start,
      { type: "thinking", taskId: null, text: "", t: 1 },
      taskStart("a", "programador", 10),
      { type: "task_end", taskId: "a", status: "failed", summary: "", t: 50 },
      taskStart("b", "programador", 100)
    ]);
    expect(derivePhase(run, 200)).toBe("ejecuta");
  });

  it("da prioridad al límite y al fallo", () => {
    const limited = reduceEvents([start, { type: "error", kind: "limit", resetsAt: 1, message: "", t: 1 }]);
    expect(derivePhase(limited, 2)).toBe("limitado");
    const failed = reduceEvents([start, { type: "run_end", exitCode: 1, t: 1 }]);
    expect(derivePhase(failed, 2)).toBe("fallo");
    const cancelled = reduceEvents([start, { type: "run_end", exitCode: 130, status: "cancelled", t: 1 }]);
    expect(derivePhase(cancelled, 2)).toBe("fallo");
  });

  it("devuelve reposo sin ejecución", () => {
    expect(derivePhase(null, 0)).toBe("reposo");
  });
});

describe("workerView", () => {
  it("cuenta encargos por nodo y asigna cubos", () => {
    const run = reduceEvents([
      start,
      taskStart("a", "programador", 1),
      taskStart("b", "programador", 2),
      taskStart("c", "asistente", 3),
      { type: "task_end", taskId: "a", status: "failed", summary: "", tokens: 100, t: 10 },
      { type: "tool", taskId: "b", name: "Edit", t: 19_900 }
    ]);
    const v = workerView(run, "programador", 20_000);
    expect(v).toMatchObject({ running: 1, done: 0, failed: 1, total: 2, tokens: 100 });
    expect(v.slots).toHaveLength(6);
    expect(v.slots[0]).toBe("failed");
    expect(v.slots[1]).toBe("flash");
    expect(v.slots.slice(2)).toEqual(["idle", "idle", "idle", "idle"]);
    expect(workerView(run, "asistente", 20_000).slots[0]).toBe("running");
  });

  it("una ejecución terminada conserva el estado final de los huecos, sin desvanecerse", () => {
    const run = reduceEvents([
      start,
      taskStart("a", "programador", 1),
      { type: "task_end", taskId: "a", status: "failed", summary: "", t: 10 },
      { type: "run_end", exitCode: 0, t: 20 }
    ]);
    expect(workerView(run, "programador", 100).slots[0]).toBe("failed");
    expect(workerView(run, "programador", 60_000).slots[0]).toBe("failed");
    expect(workerView(run, "programador", 20 * 24 * 3600_000).slots[0]).toBe("failed");
  });

  it("con más de 6 encargos se queda con los 6 más recientes", () => {
    const evs = [start];
    for (let i = 0; i < 8; i++) evs.push(taskStart(`t${i}`, "asistente", i));
    const v = workerView(reduceEvents(evs), "asistente", 10);
    expect(v.total).toBe(8);
    expect(v.slots.filter((s) => s === "running")).toHaveLength(6);
  });

  it("sin ejecución todo está en reposo", () => {
    expect(workerView(null, "asistente", 0)).toMatchObject({ running: 0, total: 0, slots: Array(6).fill("idle") });
  });
});

describe("costShare", () => {
  it("reparte el coste por familia de modelo", () => {
    const run = reduceEvents([start, {
      type: "usage", costUsd: 1, byModel: {
        "claude-opus-5-5": { costUsd: 0.25 },
        "claude-sonnet-5-5": { costUsd: 0.5 },
        "claude-haiku-5-5": { costUsd: 0.25 }
      }, t: 1
    }]);
    expect(costShare(run)).toEqual({ opus: 25, sonnet: 50, haiku: 25, source: "coste" });
  });

  it("sin datos de coste usa los encargos como aproximación", () => {
    const run = reduceEvents([start, taskStart("a", "asistente", 1), taskStart("b", "programador", 2), taskStart("c", "programador", 3)]);
    expect(costShare(run)).toEqual({ opus: 0, sonnet: 67, haiku: 33, source: "encargos" });
  });

  it("sin nada devuelve todo a cero", () => {
    expect(costShare(null)).toEqual({ opus: 0, sonnet: 0, haiku: 0, source: null });
  });
});

describe("ejecuciones sin señal", () => {
  it("una ejecución en curso sin eventos durante 20 min deja de contar como activa", () => {
    const run = reduceEvents([start, { type: "thinking", taskId: null, text: "", t: 1000 }]);
    expect(STALE_MS).toBe(20 * 60_000);
    expect(isActive(run, 1000 + STALE_MS - 1)).toBe(true);
    expect(isActive(run, 1000 + STALE_MS)).toBe(false);
    expect(derivePhase(run, 1000 + STALE_MS)).toBe("fallo");
  });

  it("si vuelven a llegar eventos se reactiva sola", () => {
    const run = reduceEvents([start, { type: "tool", taskId: null, name: "Bash", t: STALE_MS * 2 }]);
    expect(isActive(run, STALE_MS * 2 + 10)).toBe(true);
  });

  it("una ejecución terminada nunca es activa", () => {
    expect(isActive(reduceEvents([start, { type: "run_end", exitCode: 0, t: 5 }]), 6)).toBe(false);
    expect(isActive(null, 0)).toBe(false);
  });
});

describe("esperando respuesta en la vista", () => {
  const ask = { type: "waiting", kind: "question", text: "¿?", questions: [], t: 1000 };

  it("una pregunta pendiente nunca es 'sin señal', por mucho que tarde", () => {
    const run = reduceEvents([start, ask]);
    expect(isWaiting(run)).toBe(true);
    expect(isStale(run, 1000 + STALE_MS * 10)).toBe(false);
    expect(isActive(run, 1000 + STALE_MS * 10)).toBe(true);
  });

  it("la fase es 'espera' (fuera de PHASES) mientras corre y vuelve a la normal al responder", () => {
    const run = reduceEvents([start, ask]);
    expect(derivePhase(run, 2000)).toBe("espera");
    expect(PHASES).not.toContain("espera");
    const after = reduceEvents([start, ask, { type: "waiting_end", answer: "x", t: 3000 }]);
    expect(isWaiting(after)).toBe(false);
    expect(derivePhase(after, 3500)).toBe("recibe");
    expect(derivePhase(reduceEvents([start, ask, { type: "run_end", exitCode: 1, t: 4000 }]), 4500)).toBe("fallo");
  });

  it("sin ejecución no espera", () => {
    expect(isWaiting(null)).toBe(false);
  });
});
