import { describe, it, expect } from "vitest";
import { reduceRun, reduceEvents, nodeFor } from "../src/core/reducer.mjs";

const start = { type: "run_start", runId: "r1", task: "Añade validación", mode: "orquestado", model: "opus", cwd: "/x", t: 0 };

describe("reducer de una ejecución", () => {
  it("crea la ejecución con run_start", () => {
    const run = reduceRun(null, start);
    expect(run).toMatchObject({ id: "r1", task: "Añade validación", mode: "orquestado", status: "running", startedAt: 0, tasks: {}, errors: [] });
  });

  it("registra encargos y su nodo según el agente", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "Validación", prompt: "p", t: 10 },
      { type: "task_start", taskId: "b", agent: "asistente", description: "Changelog", prompt: "p", t: 11 }
    ]);
    expect(run.tasks.a).toMatchObject({ node: "programador", status: "running", startedAt: 10, description: "Validación" });
    expect(run.tasks.b).toMatchObject({ node: "asistente", status: "running" });
    expect(run.taskOrder).toEqual(["a", "b"]);
  });

  it("un agente de otro tipo (Explore) es subagente propio del orquestador, sea cual sea su modelo", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "Explore", description: "Busca", prompt: "", t: 1 },
      { type: "task_model", taskId: "a", model: "claude-opus-5-5", t: 2 },
      { type: "task_start", taskId: "b", agent: "Explore", description: "Busca", prompt: "", t: 3 },
      { type: "task_model", taskId: "b", model: "claude-haiku-5-5", t: 4 }
    ]);
    expect(run.tasks.a).toMatchObject({ node: "propio", model: "claude-opus-5-5" });
    expect(run.tasks.b.node).toBe("propio");
  });

  it("no mueve de nodo a un agente conocido aunque use otro modelo", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "task_model", taskId: "a", model: "claude-haiku-5-5", t: 2 }
    ]);
    expect(run.tasks.a.node).toBe("programador");
  });

  it("cierra encargos con su resultado", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "task_end", taskId: "a", status: "failed", summary: "tests en rojo", tokens: 900, toolUses: 4, durationMs: 50, t: 60 }
    ]);
    expect(run.tasks.a).toMatchObject({ status: "failed", endedAt: 60, summary: "tests en rojo", tokens: 900, toolUses: 4 });
  });

  it("ignora un task_end sin task_start previo (en datos antiguos eran agentes internos de Claude Code)", () => {
    const run = reduceEvents([start, { type: "task_end", taskId: "zz", status: "completed", summary: "", t: 5 }]);
    expect(run.tasks.zz).toBeUndefined();
    expect(run.taskOrder).toEqual([]);
  });

  it("anota la última actividad del orquestador y de cada encargo", () => {
    const run = reduceEvents([
      start,
      { type: "thinking", taskId: null, text: "Analizo", t: 3 },
      { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 4 },
      { type: "tool", taskId: "a", name: "Edit", t: 7 },
      { type: "tool", taskId: null, name: "Read", t: 8 }
    ]);
    expect(run.orchestratorActiveAt).toBe(8);
    expect(run.tasks.a.lastToolAt).toBe(7);
    expect(run.tasks.a.tools).toBe(1);
    expect(run.lastText).toBe("Analizo");
  });

  it("guarda cuota, uso y modelo principal", () => {
    const run = reduceEvents([
      start,
      { type: "main_model", model: "claude-opus-5-5", t: 1 },
      { type: "quota", status: "allowed", fiveHour: { utilization: 0.5, resetsAt: 9 }, sevenDay: null, t: 2 },
      { type: "usage", costUsd: 0.4, byModel: { "claude-opus-5-5": { costUsd: 0.4, outputTokens: 10, inputTokens: 1 } }, t: 3 }
    ]);
    expect(run.mainModel).toBe("claude-opus-5-5");
    expect(run.quota.fiveHour.utilization).toBe(0.5);
    expect(run.usage.costUsd).toBe(0.4);
  });

  it("termina en completed, failed, cancelled o limited", () => {
    expect(reduceEvents([start, { type: "run_end", exitCode: 0, t: 9 }])).toMatchObject({ status: "completed", endedAt: 9, exitCode: 0 });
    expect(reduceEvents([start, { type: "run_end", exitCode: 1, t: 9 }]).status).toBe("failed");
    expect(reduceEvents([start, { type: "run_end", exitCode: 130, status: "cancelled", t: 9 }]).status).toBe("cancelled");
    const limited = reduceEvents([
      start,
      { type: "error", kind: "limit", resetsAt: 100, message: "Límite", t: 5 },
      { type: "run_end", exitCode: 1, t: 9 }
    ]);
    expect(limited.status).toBe("limited");
    expect(limited.limit).toEqual({ resetsAt: 100, window: null });
  });

  it("al terminar la ejecución da por cerrados los encargos huérfanos", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 1 },
      { type: "run_end", exitCode: 1, t: 9 }
    ]);
    expect(run.tasks.a).toMatchObject({ status: "failed", endedAt: 9 });
  });

  it("acumula errores", () => {
    const run = reduceEvents([start, { type: "error", kind: "permission", message: "Bash denegado", t: 2 }]);
    expect(run.errors).toEqual([{ kind: "permission", message: "Bash denegado", t: 2 }]);
  });

  it("ignora eventos antes de run_start y no muta el estado anterior", () => {
    expect(reduceRun(null, { type: "tool", taskId: null, name: "x", t: 1 })).toBeNull();
    const a = reduceRun(null, start);
    const b = reduceRun(a, { type: "task_start", taskId: "x", agent: "asistente", description: "", prompt: "", t: 1 });
    expect(a.tasks).toEqual({});
    expect(b.tasks.x).toBeDefined();
  });
});

describe("nodeFor", () => {
  it("usa el agente si es un perfil conocido y si no el modelo", () => {
    expect(nodeFor("asistente", null)).toBe("asistente");
    expect(nodeFor("programador", "claude-haiku-5-5")).toBe("programador");
    expect(nodeFor("Explore", "claude-haiku-5-5")).toBe("propio");
    expect(nodeFor("Explore", "claude-opus-5-5")).toBe("propio");
    expect(nodeFor("general-purpose", "claude-sonnet-5-5")).toBe("propio");
    expect(nodeFor("Plan", null)).toBe("propio");
  });
  it("ejecución antigua sin tipo de agente: se decide por modelo como antes", () => {
    expect(nodeFor(undefined, "claude-haiku-5-5")).toBe("asistente");
    expect(nodeFor(undefined, "claude-sonnet-5-5")).toBe("programador");
    expect(nodeFor(undefined, null)).toBe("programador");
  });
});

describe("esperando respuesta en el reducer", () => {
  const waiting = (t, kind = "question") => ({ type: "waiting", kind, text: "¿BD?", questions: [{ question: "¿BD?" }], t });

  it("run_start inicia sin espera ni preguntas", () => {
    expect(reduceRun(null, start)).toMatchObject({ waiting: null, asked: [], orchestratorUsage: null });
  });

  it("waiting fija la espera y registra la pregunta sin respuesta", () => {
    const run = reduceEvents([start, waiting(5)]);
    expect(run.waiting).toEqual({ kind: "question", text: "¿BD?", questions: [{ question: "¿BD?" }], t: 5 });
    expect(run.asked).toEqual([{ kind: "question", text: "¿BD?", answer: null, answeredAt: null, t: 5 }]);
  });

  it("waiting_end limpia la espera y completa la última pregunta abierta", () => {
    const run = reduceEvents([start, waiting(5), { type: "waiting_end", answer: "MySQL", t: 9 }, waiting(12, "plan"), { type: "waiting_end", answer: null, t: 15 }]);
    expect(run.waiting).toBeNull();
    expect(run.asked).toEqual([
      { kind: "question", text: "¿BD?", answer: "MySQL", answeredAt: 9, t: 5 },
      { kind: "plan", text: "¿BD?", answer: null, answeredAt: 15, t: 12 }
    ]);
  });

  it.each([
    ["tool", { type: "tool", taskId: null, name: "Bash", t: 20 }],
    ["task_request", { type: "task_request", agent: "programador", description: "d", prompt: "", t: 20 }],
    ["thinking", { type: "thinking", taskId: null, text: "", t: 20 }],
    ["error de permisos", { type: "error", kind: "permission", message: "x", t: 20 }],
    ["run_end", { type: "run_end", exitCode: 0, t: 20 }]
  ])("%s limpia la espera sin tocar asked", (_n, ev) => {
    const run = reduceEvents([start, waiting(5), ev]);
    expect(run.waiting).toBeNull();
    expect(run.asked).toEqual([{ kind: "question", text: "¿BD?", answer: null, answeredAt: null, t: 5 }]);
  });

  it.each([
    ["tool de subagente", { type: "tool", taskId: "a", name: "Bash", t: 20 }],
    ["task_start", { type: "task_start", taskId: "a", agent: "programador", description: "d", prompt: "", t: 20 }],
    ["task_end", { type: "task_end", taskId: "a", status: "completed", summary: "", t: 20 }]
  ])("%s (subagente en segundo plano) no borra una pregunta abierta", (_n, ev) => {
    const run = reduceEvents([start, waiting(5), ev]);
    expect(run.waiting).not.toBeNull();
  });

  it("el tool de la propia pregunta (antes del waiting) no la borra", () => {
    const run = reduceEvents([start, { type: "tool", taskId: null, name: "AskUserQuestion", t: 5 }, waiting(5)]);
    expect(run.waiting).not.toBeNull();
  });
});

describe("resultado y coste en el reducer", () => {
  const um = (n) => ({ input: n, output: n, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

  it("task_end guarda result (por defecto vacío)", () => {
    const run = reduceEvents([start, { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 }, { type: "task_end", taskId: "a", status: "completed", summary: "s", result: "todo el texto", t: 2 }]);
    expect(run.tasks.a.result).toBe("todo el texto");
    expect(reduceEvents([start, { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 }]).tasks.a).toMatchObject({ result: "", usage: null });
  });

  it("task_usage se guarda y se fusiona si llegan varios", () => {
    const run = reduceEvents([start, { type: "task_usage", taskId: "a", byModel: { m: um(1) }, t: 1 }, { type: "task_usage", taskId: "a", byModel: { m: um(2), n: um(5) }, t: 2 }]);
    expect(run.tasks.a.usage).toEqual({ m: um(3), n: um(5) });
  });

  it("orchestrator_usage se guarda en la ejecución", () => {
    const run = reduceEvents([start, { type: "orchestrator_usage", byModel: { m: um(4) }, t: 1 }]);
    expect(run.orchestratorUsage).toEqual({ m: um(4) });
  });

  it("cada orchestrator_usage es el acumulado desde el inicio: sustituye al anterior, no se suma", () => {
    const run = reduceEvents([start, { type: "orchestrator_usage", byModel: { m: um(4) }, t: 1 }, { type: "orchestrator_usage", byModel: { m: um(6) }, t: 2 }]);
    expect(run.orchestratorUsage).toEqual({ m: um(6) });
  });
});

describe("route_label", () => {
  it("guarda la corrección del usuario y null la quita", () => {
    let run = reduceEvents([start, { type: "run_end", exitCode: 0, t: 5 }]);
    expect(run.routeLabel ?? null).toBeNull();
    run = reduceRun(run, { type: "route_label", label: "opus", source: "usuario", t: 9 });
    expect(run.routeLabel).toEqual({ label: "opus", t: 9 });
    run = reduceRun(run, { type: "route_label", label: null, source: "usuario", t: 10 });
    expect(run.routeLabel).toBeNull();
    expect(run.status).toBe("completed");
  });
  it("ignora etiquetas desconocidas", () => {
    const run = reduceRun(reduceRun(null, start), { type: "route_label", label: "gpt", source: "usuario", t: 9 });
    expect(run.routeLabel ?? null).toBeNull();
  });
});
