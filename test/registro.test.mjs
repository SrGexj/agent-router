import { describe, it, expect } from "vitest";
import { translateHook } from "../src/core/hooks.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { summarizeSubagent } from "../src/core/subagent.mjs";

const base = { session_id: "abcdef12-3456", cwd: "/repo", transcript_path: "/t" };
const makeRunId = (now, short, n) => `r-${short}-${n}`;
const T = 1_792_000_000_000;
const open1 = () => ({ runId: "r-abcdef12-1", lastRunId: "r-abcdef12-1", seq: 1, transcriptOffset: 0 });

// Reproduce una secuencia de hooks pasando la sesión de uno al siguiente, como hace el proceso del hook con el disco.
function play(steps, session = open1()) {
  const events = [];
  steps.forEach((step, i) => {
    const [p, ctx] = Array.isArray(step) ? step : [step, {}];
    const res = translateHook({ ...base, ...p }, session, T + i * 1000, makeRunId, ctx);
    session = res.session;
    events.push(...res.events);
  });
  return { events, session };
}
const ofType = (events, type) => events.filter((e) => e.type === type);

describe("un task_start y un task_end por encargo", () => {
  it("SubagentStop de un agente que nunca arrancó (fork de resumen de progreso) no emite nada", () => {
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "real", agent_type: "programador" },
      { hook_event_name: "SubagentStop", agent_id: "fork1", last_assistant_message: "Analyzing hook output" },
      { hook_event_name: "SubagentStop", agent_id: "fork2", last_assistant_message: "Polling header" },
      { hook_event_name: "SubagentStop", agent_id: "real", last_assistant_message: "Hecho" }
    ]);
    expect(ofType(events, "task_start")).toHaveLength(1);
    expect(ofType(events, "task_end").map((e) => e.taskId)).toEqual(["real"]);
  });

  it("repetir SubagentStart o SubagentStop del mismo agente es idempotente", () => {
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "asistente" },
      { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "asistente" },
      { hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: "ok" },
      { hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: "ok" }
    ]);
    expect(ofType(events, "task_start")).toHaveLength(1);
    expect(ofType(events, "task_end")).toHaveLength(1);
  });

  it("un agente reanudado tras terminar vuelve a abrir su ciclo", () => {
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "asistente" },
      { hook_event_name: "SubagentStop", agent_id: "a" },
      { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "asistente" },
      { hook_event_name: "SubagentStop", agent_id: "a" }
    ]);
    expect(ofType(events, "task_start")).toHaveLength(2);
    expect(ofType(events, "task_end")).toHaveLength(2);
  });

  it("sesiones sin registro de agentes (anteriores a este cambio) siguen cerrando el encargo", () => {
    const { events } = play([{ hook_event_name: "SubagentStop", agent_id: "a" }]);
    expect(ofType(events, "task_end")).toHaveLength(1);
  });

  it("el reducer ignora task_end de un id que nunca tuvo task_start (datos antiguos)", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "task_start", taskId: "a", agent: "asistente", description: "d", prompt: "", t: 2 },
      { type: "task_end", taskId: "fork", status: "completed", summary: "Waiting on log", t: 3 },
      { type: "task_end", taskId: "a", status: "completed", t: 4 }
    ]);
    expect(run.taskOrder).toEqual(["a"]);
  });
});

const line = (o) => JSON.stringify(o);
const asst = (id, model, usage, ts, content = [{ type: "text", text: "x" }], extra = {}) =>
  line({ type: "assistant", timestamp: ts, message: { id, model, usage, content }, ...extra });
const toolUse = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
const result = (id, isError, ts = "2026-10-15T10:00:09.000Z") =>
  line({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: isError }] } });

describe("summarizeSubagent: estado, modelo, tokens y duración desde el transcript", () => {
  const u = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };

  it("termina bien: completed, con modelo real, tokens, herramientas y duración", () => {
    const text = [
      asst("m1", "claude-haiku-5-5", u, "2026-10-15T10:00:00.000Z", [toolUse("t1")]),
      asst("m1", "claude-haiku-5-5", u, "2026-10-15T10:00:00.500Z", [toolUse("t1")]), // misma respuesta, otra línea
      result("t1", false, "2026-10-15T10:00:02.000Z"),
      asst("m2", "claude-haiku-5-5", u, "2026-10-15T10:00:05.000Z")
    ].join("\n");
    expect(summarizeSubagent(text)).toEqual({
      status: "completed", error: null, model: "claude-haiku-5-5", tokens: 2 * (10 + 5 + 100), toolUses: 1, durationMs: 5000
    });
  });

  it("un tool_result con error a mitad de camino no hace fallar el encargo", () => {
    const text = [
      asst("m1", "claude-sonnet-5-5", u, "2026-10-15T10:00:00.000Z", [toolUse("t1")]),
      result("t1", true),
      asst("m2", "claude-sonnet-5-5", u, "2026-10-15T10:00:10.000Z")
    ].join("\n");
    expect(summarizeSubagent(text).status).toBe("completed");
  });

  it("failed si el último paso es un tool_result con error", () => {
    const text = [asst("m1", "claude-sonnet-5-5", u, "2026-10-15T10:00:00.000Z", [toolUse("t1")]), result("t1", true)].join("\n");
    expect(summarizeSubagent(text)).toMatchObject({ status: "failed", error: "tool_error" });
  });

  it("failed por límite de uso o error de API (mensaje sintético)", () => {
    const err = (text) => line({ type: "assistant", isApiErrorMessage: true, timestamp: "2026-10-15T10:00:03.000Z", message: { id: "e", model: "<synthetic>", usage: {}, content: [{ type: "text", text }] } });
    const ok = asst("m1", "claude-sonnet-5-5", u, "2026-10-15T10:00:00.000Z");
    expect(summarizeSubagent([ok, err("You've hit your limit · resets 5pm")].join("\n"))).toMatchObject({ status: "failed", error: "limit", model: "claude-sonnet-5-5" });
    expect(summarizeSubagent([ok, err("API Error: 500")].join("\n"))).toMatchObject({ status: "failed", error: "api" });
  });

  it("killed si el usuario interrumpió", () => {
    const text = [
      asst("m1", "claude-sonnet-5-5", u, "2026-10-15T10:00:00.000Z"),
      line({ type: "user", timestamp: "2026-10-15T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    ].join("\n");
    expect(summarizeSubagent(text)).toMatchObject({ status: "killed", error: "interrupted" });
  });

  it("transcript vacío o ilegible: completed sin datos", () => {
    expect(summarizeSubagent("")).toEqual({ status: "completed", error: null, model: null, tokens: null, toolUses: null, durationMs: null });
    expect(summarizeSubagent("no json\n{")).toMatchObject({ status: "completed", model: null });
  });
});

describe("task_end con estado, modelo, tokens y duración reales", () => {
  const summary = { status: "failed", error: "limit", model: "claude-haiku-5-5", tokens: 321, toolUses: 4, durationMs: 9000 };

  it("SubagentStop usa lo leído del transcript del subagente", () => {
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "a", agent_type: "programador" },
      [{ hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: "x" }, { agentSummary: summary }]
    ]);
    expect(ofType(events, "task_end")[0]).toMatchObject({ status: "failed", error: "limit", model: "claude-haiku-5-5", tokens: 321, toolUses: 4, durationMs: 9000 });
  });

  it("sin transcript legible el estado es completed y el modelo null", () => {
    const { events } = play([{ hook_event_name: "SubagentStart", agent_id: "a" }, { hook_event_name: "SubagentStop", agent_id: "a" }]);
    expect(ofType(events, "task_end")[0]).toMatchObject({ status: "completed", model: null, tokens: null });
  });

  it("permiso denegado y agente recuperado: completed, con la marca permissionDenied", () => {
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "a" },
      { hook_event_name: "PermissionDenied", agent_id: "a", tool_name: "Bash" },
      [{ hook_event_name: "SubagentStop", agent_id: "a" }, { agentSummary: { status: "completed", error: null } }]
    ]);
    expect(ofType(events, "task_end")[0]).toMatchObject({ status: "completed", permissionDenied: true });
    const run = reduceEvents([{ type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 }, { type: "task_start", taskId: "a", agent: "x", description: "", prompt: "", t: 2 }, ofType(events, "task_end")[0]]);
    expect(run.tasks.a).toMatchObject({ status: "completed", permissionDenied: true });
  });

  it("permiso denegado y el agente termina por ese error: failed/permission", () => {
    const text = [
      JSON.stringify({ type: "assistant", timestamp: "2026-10-15T10:00:00.000Z", message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 1 }, content: [{ type: "tool_use", id: "t" }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-10-15T10:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "Permission to use Bash has been denied." }] } })
    ].join("\n");
    const summary = summarizeSubagent(text);
    expect(summary).toMatchObject({ status: "failed", error: "permission" });
    const { events } = play([
      { hook_event_name: "SubagentStart", agent_id: "a" },
      { hook_event_name: "PermissionDenied", agent_id: "a" },
      [{ hook_event_name: "SubagentStop", agent_id: "a" }, { agentSummary: summary }]
    ]);
    expect(ofType(events, "task_end")[0]).toMatchObject({ status: "failed", error: "permission", permissionDenied: true });
  });

  it("task_start lleva el modelo si ya se conoce", () => {
    const { events } = play([[{ hook_event_name: "SubagentStart", agent_id: "a", agent_type: "asistente" }, { agentModel: "claude-haiku-5-5" }]]);
    expect(ofType(events, "task_start")[0].model).toBe("claude-haiku-5-5");
  });

  it("el reducer guarda estado, error y modelo reales; el modelo real manda sobre el pedido", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "task_start", taskId: "a", agent: "programador", description: "d", prompt: "", t: 2 },
      { type: "task_end", taskId: "a", status: "failed", error: "limit", model: "claude-haiku-5-5", tokens: 5, durationMs: 7, t: 3 }
    ]);
    expect(run.tasks.a).toMatchObject({ status: "failed", error: "limit", model: "claude-haiku-5-5", tokens: 5, durationMs: 7 });
  });
});

describe("reintentos y escaladas en task_request", () => {
  const req = (description, agent) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: `tu-${Math.random()}`, tool_input: { subagent_type: agent, description, prompt: "p" } });
  const requests = (steps) => ofType(play(steps).events, "task_request");

  it("primer encargo: attempt 1 y sin previousAgent", () => {
    const [r] = requests([req("Arreglar login", "asistente")]);
    expect(r.attempt).toBe(1);
    expect(r).not.toHaveProperty("previousAgent");
    expect(r).not.toHaveProperty("escalated");
  });

  it("misma descripción normalizada: attempt 2 con previousAgent; sin escalar si el agente es el mismo", () => {
    const [, r2] = requests([req("Arreglar login", "asistente"), req("  arreglar LOGIN ", "asistente")]);
    expect(r2).toMatchObject({ attempt: 2, previousAgent: "asistente" });
    expect(r2.escalated).toBeUndefined();
  });

  it("si cambia el agente es una escalada", () => {
    const rs = requests([req("Tarea", "asistente"), req("tarea", "programador"), req("TAREA", "programador")]);
    expect(rs[1]).toMatchObject({ attempt: 2, previousAgent: "asistente", escalated: true });
    expect(rs[2]).toMatchObject({ attempt: 3, previousAgent: "programador" });
    expect(rs[2].escalated).toBeUndefined();
  });

  it("descripciones distintas o vacías no son reintentos", () => {
    const rs = requests([req("A", "asistente"), req("B", "asistente"), req("", "asistente"), req("", "asistente")]);
    expect(rs.map((r) => r.attempt)).toEqual([1, 1, 1, 1]);
  });

  it("una ejecución nueva empieza de cero", () => {
    const first = play([req("Tarea", "asistente"), { hook_event_name: "Stop", background_tasks: [] }]);
    const second = play([{ hook_event_name: "UserPromptSubmit", prompt: "otra" }, req("Tarea", "asistente")], first.session);
    expect(ofType(second.events, "task_request")[0].attempt).toBe(1);
  });

  it("el reducer propaga attempt, previousAgent y escalated al encargo cuando arranca", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "task_request", agent: "programador", description: "Tarea", prompt: "p", attempt: 2, previousAgent: "asistente", escalated: true, t: 2 },
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 3 }
    ]);
    expect(run.tasks.a).toMatchObject({ attempt: 2, previousAgent: "asistente", escalated: true, description: "Tarea" });
  });

  it("task_start sin coincidencia de agente (hook que reescribe subagent_type) toma la petición pendiente más antigua", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "task_request", agent: "programador", description: "Tarea", prompt: "p", t: 2 },
      { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 3 }
    ]);
    expect(run.tasks.a).toMatchObject({ description: "Tarea", requestedAgent: "programador" });
    expect(run.pending).toEqual([]);
  });
});

describe("parser stream-json: idempotente y con el modelo real", () => {
  const started = { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", subagent_type: "programador", description: "d" };
  const notified = { type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "ok" };
  const sub = { type: "assistant", parent_tool_use_id: "tu1", message: { model: "claude-haiku-5-5", content: [] } };

  it("repetir task_started o task_notification no duplica eventos", async () => {
    const { createParser } = await import("../src/core/parser.mjs");
    const p = createParser();
    const out = [started, started, notified, notified].flatMap((m) => p.push(m, 1));
    expect(ofType(out, "task_start")).toHaveLength(1);
    expect(ofType(out, "task_end")).toHaveLength(1);
  });

  it("task_end lleva el modelo visto en los mensajes del subagente", async () => {
    const { createParser } = await import("../src/core/parser.mjs");
    const p = createParser();
    const out = [started, sub, notified].flatMap((m) => p.push(m, 1));
    expect(ofType(out, "task_end")[0].model).toBe("claude-haiku-5-5");
  });
});

describe("compatibilidad con ejecuciones antiguas", () => {
  it("una ejecución sin attempt, error, model ni context sigue reduciéndose y las vistas no fallan", async () => {
    const { runContext } = await import("../src/core/compaction.mjs");
    const { taskRows, costBreakdown } = await import("../src/core/details.mjs");
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "task_request", agent: "asistente", description: "d", prompt: "p", t: 2 },
      { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 3 },
      { type: "task_end", taskId: "a", status: "completed", summary: "ok", tokens: null, toolUses: null, durationMs: null, t: 4 },
      { type: "run_end", exitCode: 0, t: 5 }
    ]);
    expect(run.tasks.a).toMatchObject({ status: "completed", description: "d", error: null });
    expect(run.tasks.a.attempt).toBeUndefined();
    expect(runContext(run)).toBeNull();
    expect(() => taskRows(run)).not.toThrow();
    expect(() => costBreakdown(run)).not.toThrow();
  });
});
