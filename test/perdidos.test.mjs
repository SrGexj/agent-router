import { describe, it, expect } from "vitest";
import { reduceEvents, markLostTasks, LOST_AFTER_MS } from "../src/core/reducer.mjs";
import { translateHook, endedAgentsFrom } from "../src/core/hooks.mjs";

const MIN = 60_000;
const t0 = 1_000_000;
const start = { type: "run_start", runId: "r1", task: "x", mode: "sesion", model: "opus", cwd: "/x", t: t0 };
const open = [
  start,
  { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: t0 + 1 },
  { type: "tool", taskId: "a", name: "Bash", t: t0 + 5_000 },
  { type: "task_usage", taskId: "a", snapshot: true, byModel: {}, t: t0 + 8_000 }
];

describe("encargos perdidos (sin SubagentStop)", () => {
  it("cada evento propio del encargo actualiza su última actividad", () => {
    expect(reduceEvents(open).tasks.a.lastActivityAt).toBe(t0 + 8_000);
  });

  it("un encargo en marcha sin eventos propios durante LOST_AFTER_MS se da por perdido", () => {
    const lost = markLostTasks(reduceEvents(open), t0 + 8_000 + LOST_AFTER_MS);
    expect(lost.tasks.a).toMatchObject({ status: "failed", lost: true, endedAt: t0 + 8_000 });
  });

  it("dentro del plazo sigue trabajando y no se toca la ejecución", () => {
    const run = reduceEvents(open);
    expect(markLostTasks(run, t0 + 8_000 + LOST_AFTER_MS - 1)).toBe(run);
  });

  it("la actividad del orquestador o de otros encargos no mantiene vivo a uno silencioso", () => {
    const run = reduceEvents([
      ...open,
      { type: "task_start", taskId: "b", agent: "programador", description: "", prompt: "", t: t0 + 10_000 },
      { type: "tool", taskId: "b", name: "Edit", t: t0 + 9 * MIN },
      { type: "tool", taskId: null, name: "Bash", t: t0 + 11 * MIN }
    ]);
    const lost = markLostTasks(run, t0 + 11 * MIN);
    expect(lost.tasks.a.lost).toBe(true);
    expect(lost.tasks.b.status).toBe("running");
  });

  it("si el encargo vuelve a dar señales deja de estar perdido", () => {
    const run = reduceEvents([...open, { type: "tool", taskId: "a", name: "Bash", t: t0 + 20 * MIN }]);
    expect(markLostTasks(run, t0 + 21 * MIN)).toBe(run);
  });

  it("no toca encargos terminados ni muta la entrada", () => {
    const ended = reduceEvents([...open, { type: "task_end", taskId: "a", status: "completed", t: t0 + 9_000 }]);
    expect(markLostTasks(ended, t0 + 60 * MIN).tasks.a.status).toBe("completed");
    const run = reduceEvents(open);
    markLostTasks(run, t0 + 60 * MIN);
    expect(run.tasks.a.status).toBe("running");
  });

  it("sin ejecución o con la ejecución cerrada devuelve lo mismo", () => {
    expect(markLostTasks(null, t0)).toBeNull();
    const closed = reduceEvents([...open, { type: "run_end", exitCode: 0, t: t0 + 9_000 }]);
    expect(markLostTasks(closed, t0 + 60 * MIN)).toBe(closed);
  });
});

describe("cierre por notificación del encargo", () => {
  it("cierra un encargo en marcha", () => {
    const run = reduceEvents([...open, { type: "task_end", taskId: "a", status: "completed", source: "notification", t: t0 + 9_000 }]);
    expect(run.tasks.a).toMatchObject({ status: "completed", endedAt: t0 + 9_000 });
  });

  it("no pisa el resultado de un SubagentStop ya recibido", () => {
    const run = reduceEvents([
      ...open,
      { type: "task_end", taskId: "a", status: "completed", summary: "Hecho", result: "Hecho", t: t0 + 9_000 },
      { type: "task_end", taskId: "a", status: "completed", summary: "", result: "", source: "notification", t: t0 + 9_500 }
    ]);
    expect(run.tasks.a).toMatchObject({ summary: "Hecho", endedAt: t0 + 9_000 });
  });
});

const HANDBACK = `Another Claude session sent a message:
<agent-message from="a4cf217072225d48a">
[Subagent hand-back] The text below is the final report of a subagent this session delegated to.
  Informe (USD API-equivalentes)
</agent-message>`;
const NOTIFICATION = `<task-notification>
<task-id>a4cf217072225d48a</task-id>
<tool-use-id>toolu_01L2</tool-use-id>
<status>killed</status>
<summary>Agent "x" finished</summary>
</task-notification>`;

describe("endedAgentsFrom: fin de un subagente según el mensaje que recibe el orquestador", () => {
  it("reconoce el hand-back", () => {
    expect(endedAgentsFrom(HANDBACK)).toEqual([{ taskId: "a4cf217072225d48a", status: "completed" }]);
  });

  it("reconoce la task-notification con su estado", () => {
    expect(endedAgentsFrom(NOTIFICATION)).toEqual([{ taskId: "a4cf217072225d48a", status: "killed" }]);
    expect(endedAgentsFrom(NOTIFICATION.replace("killed", "completed"))[0].status).toBe("completed");
    expect(endedAgentsFrom(NOTIFICATION.replace("killed", "failed"))[0].status).toBe("failed");
  });

  it("un mensaje normal no cierra nada", () => {
    expect(endedAgentsFrom("Arregla el login")).toEqual([]);
    expect(endedAgentsFrom(undefined)).toEqual([]);
    expect(endedAgentsFrom('<agent-message from="../../etc">hola</agent-message>')).toEqual([]);
  });
});

describe("translateHook: cierre de encargos por el mensaje de fin", () => {
  const T = 1_792_000_000_000;
  const session = { runId: "r1", seq: 1 };
  const p = (prompt) => ({ hook_event_name: "UserPromptSubmit", session_id: "abcdef12-3456", prompt });

  it("con la ejecución abierta emite task_end por notificación y no abre otra ejecución", () => {
    const res = translateHook(p(HANDBACK), session, T, () => "nueva");
    expect(res.runId).toBe("r1");
    expect(res.session).toBe(session);
    expect(res.events).toEqual([{ type: "task_end", taskId: "a4cf217072225d48a", status: "completed", source: "notification", t: T }]);
  });

  it("un mensaje normal sigue sin emitir nada", () => {
    expect(translateHook(p("y además esto"), session, T, () => "nueva").events).toEqual([]);
  });

  it("evidencia: el encargo sin SubagentStop deja de contar como trabajando", () => {
    const res = translateHook(p(HANDBACK), session, T, () => "nueva");
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a4cf217072225d48a", agent: "asistente", description: "", prompt: "", t: t0 + 1 },
      { type: "tool", taskId: "a4cf217072225d48a", name: "SubagentHandback", t: t0 + 5_000 },
      ...res.events.map((e) => ({ ...e, t: t0 + 6_000 }))
    ]);
    expect(Object.values(run.tasks).filter((t) => t.status === "running")).toHaveLength(0);
  });
});
