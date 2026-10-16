import { describe, it, expect } from "vitest";
import { translateHook, quotaFromStatusline, sameQuota, interruptedIn, closeInterrupted, liveUsageDue, liveAgentUsageDue, LIVE_USAGE_MS } from "../src/core/hooks.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { agentTranscriptPath } from "../src/core/usage.mjs";

const base = { session_id: "abcdef12-3456", cwd: "/repo", transcript_path: "/t" };
const makeRunId = (now, short, n) => `r-${short}-${n}`;
const T = 1_792_000_000_000;

function play(payloads, session = { runId: null, seq: 0 }) {
  const all = [];
  for (const p of payloads) {
    const res = translateHook({ ...base, ...p }, session, T, makeRunId);
    session = res.session;
    all.push(...res.events.map((e) => ({ runId: res.runId, ...e })));
  }
  return { events: all, session };
}

describe("translateHook: una sesión co a eventos del dashboard", () => {
  it("cada mensaje del usuario abre una ejecución y Stop la cierra", () => {
    const { events, session } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "Arregla el login" },
      { hook_event_name: "Stop", background_tasks: [] }
    ]);
    expect(events).toEqual([
      { type: "run_start", runId: "r-abcdef12-1", task: "Arregla el login", mode: "sesion", model: "opus", cwd: "/repo", profile: "trabajo", t: T },
      { runId: "r-abcdef12-1", type: "run_end", exitCode: 0, t: T }
    ]);
    expect(session).toEqual({ runId: null, lastRunId: "r-abcdef12-1", seq: 1 });
  });

  it("un mensaje en mitad de un turno no abre otra ejecución", () => {
    const { events } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "uno" },
      { hook_event_name: "UserPromptSubmit", prompt: "y además esto" }
    ]);
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
  });

  it("traduce la llamada a Agent, el arranque y el final del subagente", () => {
    const { events } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "x" },
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tu1", tool_input: { subagent_type: "programador", description: "Validación", prompt: "p" } },
      { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "programador" },
      { hook_event_name: "PreToolUse", agent_id: "ag1", agent_type: "programador", tool_name: "Edit", tool_input: {} },
      { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "programador", last_assistant_message: "Hecho, 3 tests" },
      { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "tu1", tool_response: { status: "completed", agentId: "ag1", resolvedModel: "claude-sonnet-5-5", totalTokens: 9907, totalToolUseCount: 1, totalDurationMs: 3351 } }
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["run_start", "task_request", "task_start", "tool", "task_end", "task_stats"]);
    expect(events[1]).toMatchObject({ toolUseId: "tu1", agent: "programador", description: "Validación" });
    expect(events[2]).toMatchObject({ taskId: "ag1", agent: "programador", description: "" });
    expect(events[3]).toMatchObject({ taskId: "ag1", name: "Edit" });
    expect(events[4]).toMatchObject({ taskId: "ag1", status: "completed", summary: "Hecho, 3 tests" });
    expect(events[5]).toMatchObject({ taskId: "ag1", model: "claude-sonnet-5-5", tokens: 9907, toolUses: 1, durationMs: 3351 });
  });

  it("las herramientas del orquestador van sin encargo", () => {
    const { events } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "x" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }
    ]);
    expect(events[1]).toMatchObject({ type: "tool", taskId: null, name: "Read" });
  });

  it("Stop con tareas en segundo plano no cierra la ejecución", () => {
    const { events, session } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "x" },
      { hook_event_name: "Stop", background_tasks: [{ id: "a" }] }
    ]);
    expect(events.map((e) => e.type)).toEqual(["run_start", "thinking"]);
    expect(session.runId).toBe("r-abcdef12-1");
  });

  it("Stop con tareas en segundo plano pero ningun subagente en marcha cierra la ejecucion (sesion parada esperando al usuario)", () => {
    const s0 = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "x" }, { runId: null, seq: 0 }, T, makeRunId);
    const res = translateHook({ ...base, hook_event_name: "Stop", background_tasks: [{ id: "shell" }] }, s0.session, T, makeRunId, { runningTasks: 0 });
    expect(res.events.map((e) => e.type)).toEqual(["run_end"]);
    expect(res.session.runId).toBeNull();
    const run = reduceEvents([...s0.events, ...res.events]);
    expect(run.status).toBe("completed");
  });

  it("Stop con tareas en segundo plano y algun subagente en marcha mantiene la ejecucion abierta", () => {
    const s0 = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "x" }, { runId: null, seq: 0 }, T, makeRunId);
    const res = translateHook({ ...base, hook_event_name: "Stop", background_tasks: [{ id: "a" }] }, s0.session, T, makeRunId, { runningTasks: 1 });
    expect(res.events.map((e) => e.type)).toEqual(["thinking"]);
    expect(res.session.runId).toBe("r-abcdef12-1");
  });

  it("StopFailure por límite cierra como limitada; otros errores como fallida", () => {
    const lim = play([{ hook_event_name: "UserPromptSubmit", prompt: "x" }, { hook_event_name: "StopFailure", error: "rate_limit" }]);
    expect(lim.events.slice(1)).toEqual([
      { runId: "r-abcdef12-1", type: "error", kind: "limit", window: null, resetsAt: null, message: "Límite de uso alcanzado", t: T },
      { runId: "r-abcdef12-1", type: "run_end", exitCode: 1, t: T }
    ]);
    const bad = play([{ hook_event_name: "UserPromptSubmit", prompt: "x" }, { hook_event_name: "StopFailure", error: "overloaded", error_details: "529" }]);
    expect(bad.events[1]).toMatchObject({ type: "error", kind: "api", message: "overloaded: 529" });
  });

  it("PermissionDenied es un aviso de permisos", () => {
    const { events } = play([{ hook_event_name: "UserPromptSubmit", prompt: "x" }, { hook_event_name: "PermissionDenied", tool_name: "Bash" }]);
    expect(events[1]).toMatchObject({ type: "error", kind: "permission", message: "Bash denegado" });
  });

  it("salir de la sesión con una ejecución abierta la marca como cancelada", () => {
    const { events, session } = play([{ hook_event_name: "UserPromptSubmit", prompt: "x" }, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" }]);
    expect(events[1]).toMatchObject({ type: "run_end", status: "cancelled" });
    expect(session.runId).toBeNull();
  });

  it("sin ejecución abierta ignora el resto de hooks", () => {
    const { events } = play([{ hook_event_name: "PreToolUse", tool_name: "Read" }, { hook_event_name: "Stop" }, { hook_event_name: "SessionEnd" }]);
    expect(events).toEqual([]);
  });

  it("resume el último mensaje del subagente", () => {
    const { events } = play([
      { hook_event_name: "UserPromptSubmit", prompt: "x" },
      { hook_event_name: "SubagentStop", agent_id: "a", agent_type: "asistente", last_assistant_message: "x".repeat(500) }
    ]);
    expect(events[1].summary.length).toBeLessThanOrEqual(200);
  });
});

describe("reducer con eventos de hooks", () => {
  it("empareja la descripción de task_request con el subagente que arranca y aplica task_stats", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", cwd: "/", t: 0 },
      { type: "task_request", toolUseId: "tu1", agent: "programador", description: "Validación", prompt: "p1", t: 1 },
      { type: "task_request", toolUseId: "tu2", agent: "asistente", description: "Changelog", prompt: "p2", t: 1 },
      { type: "task_start", taskId: "a2", agent: "asistente", description: "", prompt: "", t: 2 },
      { type: "task_start", taskId: "a1", agent: "programador", description: "", prompt: "", t: 2 },
      { type: "task_stats", taskId: "a1", model: "claude-sonnet-5-5", tokens: 100, toolUses: 2, durationMs: 50, t: 3 }
    ]);
    expect(run.tasks.a1).toMatchObject({ description: "Validación", prompt: "p1", node: "programador", tokens: 100, model: "claude-sonnet-5-5" });
    expect(run.tasks.a2).toMatchObject({ description: "Changelog", node: "asistente" });
    expect(run.pending).toEqual([]);
  });

  it("task_stats de un agente de otro tipo no lo mete en un nodo de rol", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", cwd: "/", t: 0 },
      { type: "task_start", taskId: "e", agent: "Explore", description: "Busca", prompt: "", t: 1 },
      { type: "task_stats", taskId: "e", model: "claude-haiku-5-5", tokens: 5, toolUses: 1, durationMs: 1, t: 2 }
    ]);
    expect(run.tasks.e.node).toBe("propio");
  });
});

describe("cuota desde la statusline", () => {
  it("convierte rate_limits (0-100) en un evento quota", () => {
    const q = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_792_003_600 }, seven_day: { used_percentage: 91.5, resets_at: 1_792_500_000 } } }, T);
    expect(q).toEqual({
      type: "quota", status: "allowed_warning", limitType: null,
      fiveHour: { utilization: 0.42, resetsAt: 1_792_003_600 },
      sevenDay: { utilization: 0.915, resetsAt: 1_792_500_000 },
      profile: "trabajo",
      t: T
    });
  });

  it("sin rate_limits no hay cuota; al 100 % está agotada", () => {
    expect(quotaFromStatusline({}, T)).toBeNull();
    expect(quotaFromStatusline({ rate_limits: null }, T)).toBeNull();
    expect(quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 1 } } }, T).status).toBe("rejected");
  });

  it("sameQuota evita repetir eventos si no cambia el porcentaje", () => {
    const a = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1 } } }, T);
    const b = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 42.3, resets_at: 1 } } }, T + 5);
    const c = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 44, resets_at: 1 } } }, T + 5);
    expect(sameQuota(a, b)).toBe(true);
    expect(sameQuota(a, c)).toBe(false);
    expect(sameQuota(null, a)).toBe(false);
  });
});

describe("parar con Esc", () => {
  it("detecta la marca de interrupción en el transcript", () => {
    expect(interruptedIn('{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}')).toBe(true);
    expect(interruptedIn('{"type":"user","isSidechain":false,"message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}')).toBe(true);
    expect(interruptedIn('{"type":"user","message":{"content":"[Request interrupted by user]"}}')).toBe(true);
    expect(interruptedIn('{"text":"hola"}')).toBe(false);
  });

  it("no confunde la marca cuando solo aparece dentro de un resultado de herramienta o un mensaje", () => {
    const toolResult = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "const INTERRUPT = /\\[Request interrupted by user/;" }] } });
    const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const sidechain = JSON.stringify({ type: "user", isSidechain: true, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const quoted = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "mira esto: [Request interrupted by user]" }] } });
    expect(interruptedIn([toolResult, assistant, sidechain, quoted].join("\n"))).toBe(false);
  });

  it("ignora una primera línea cortada a medias", () => {
    const real = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(interruptedIn(`by user]"}]}}\n${real}\n`)).toBe(true);
  });

  it("al abrir una ejecución guarda dónde acababa el transcript y el perfil", () => {
    const res = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "x" }, { runId: null, seq: 0 }, T, makeRunId, { profile: "personal", transcriptSize: 1234 });
    expect(res.session.transcriptOffset).toBe(1234);
    expect(res.events[0].profile).toBe("personal");
  });

  it("un mensaje nuevo tras un Esc cierra la ejecución anterior como cancelada y abre otra", () => {
    const open = { runId: "r-abcdef12-1", lastRunId: "r-abcdef12-1", seq: 1, transcriptOffset: 10 };
    const res = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "otra cosa" }, open, T, makeRunId, { interrupted: true, transcriptSize: 99 });
    expect(res.before).toEqual({ runId: "r-abcdef12-1", events: [{ type: "run_end", exitCode: 130, status: "cancelled", t: T }] });
    expect(res.runId).toBe("r-abcdef12-2");
    expect(res.events[0]).toMatchObject({ type: "run_start", task: "otra cosa" });
    expect(res.session).toMatchObject({ runId: "r-abcdef12-2", seq: 2, transcriptOffset: 99 });
  });

  it("sin Esc, un mensaje a mitad de turno sigue en la misma ejecución", () => {
    const open = { runId: "r-abcdef12-1", lastRunId: "r-abcdef12-1", seq: 1 };
    const res = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "y esto" }, open, T, makeRunId, { interrupted: false });
    expect(res.events).toEqual([]);
    expect(res.before).toBeUndefined();
  });

  it("closeInterrupted cierra la ejecución abierta (lo usa la statusline)", () => {
    const open = { runId: "r1", lastRunId: "r1", seq: 3, transcriptOffset: 5 };
    expect(closeInterrupted(open, T)).toEqual({
      runId: "r1",
      events: [{ type: "run_end", exitCode: 130, status: "cancelled", t: T }],
      session: { runId: null, lastRunId: "r1", seq: 3 }
    });
    expect(closeInterrupted({ runId: null, seq: 0 }, T)).toBeNull();
  });

  it("la cuota de la statusline lleva el perfil", () => {
    const q = quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }, T, "personal");
    expect(q.profile).toBe("personal");
    expect(quotaFromStatusline({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } } }, T).profile).toBe("trabajo");
  });
});

const usage = (model, n) => ({ byModel: { [model]: { input: n, output: n, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } });
const open1 = () => ({ runId: "r-abcdef12-1", lastRunId: "r-abcdef12-1", seq: 1, transcriptOffset: 0 });
const hook = (p, session = open1(), ctx = {}) => translateHook({ ...base, ...p }, session, T, makeRunId, ctx);

describe("esperando respuesta", () => {
  const questions = [
    { question: "¿Qué base de datos?", header: "BD", multiSelect: false, options: [{ label: "MySQL", description: "relacional" }, { label: "SQLite" }] },
    { question: "¿Extras?", multiSelect: true, options: [] }
  ];

  it("AskUserQuestion emite tool y waiting question con las preguntas normalizadas", () => {
    const { events } = hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions } });
    expect(events).toEqual([
      { type: "tool", taskId: null, name: "AskUserQuestion", t: T },
      {
        type: "waiting", kind: "question", text: "¿Qué base de datos?", t: T,
        questions: [
          { question: "¿Qué base de datos?", header: "BD", multiSelect: false, options: [{ label: "MySQL", description: "relacional" }, { label: "SQLite", description: "" }] },
          { question: "¿Extras?", header: "", multiSelect: true, options: [] }
        ]
      }
    ]);
  });

  it("AskUserQuestion sin preguntas no rompe", () => {
    const { events } = hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} });
    expect(events[1]).toEqual({ type: "waiting", kind: "question", text: "", questions: [], t: T });
  });

  it("un AskUserQuestion de un subagente no cuenta como espera del usuario", () => {
    const { events } = hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", agent_id: "a", tool_input: { questions } });
    expect(events.map((e) => e.type)).toEqual(["tool"]);
  });

  it("ExitPlanMode emite waiting plan", () => {
    const { events } = hook({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_input: { plan: "x" } });
    expect(events[1]).toEqual({ type: "waiting", kind: "plan", text: "Aprobar el plan", questions: [], t: T });
  });

  it("Notification de permisos emite waiting permission; el resto de avisos, nada", () => {
    const msg = "Claude needs your permission to use Bash";
    expect(hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: msg }).events)
      .toEqual([{ type: "waiting", kind: "permission", text: msg, questions: [], t: T }]);
    expect(hook({ hook_event_name: "Notification", message: msg }).events[0]).toMatchObject({ kind: "permission" });
    expect(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }).events).toEqual([]);
    expect(hook({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "needs permission" }).events).toEqual([]);
    expect(hook({ hook_event_name: "Notification", message: "otra cosa" }).events).toEqual([]);
  });

  it("sin ejecución abierta la Notification se ignora", () => {
    expect(hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "m" }, { runId: null, seq: 0 }).events).toEqual([]);
  });

  it("PostToolUse de AskUserQuestion/ExitPlanMode emite waiting_end con la respuesta legible", () => {
    const end = (tool_response, tool_name = "AskUserQuestion") => hook({ hook_event_name: "PostToolUse", tool_name, tool_response }).events;
    expect(end({ questions: [], answers: { "¿BD?": "MySQL", "¿Extras?": "Tests, Docs" } })).toEqual([{ type: "waiting_end", answer: "MySQL · Tests, Docs", t: T }]);
    expect(end(JSON.stringify({ answers: { a: "Sí" } }))[0].answer).toBe("Sí");
    expect(end({ answers: ["A", "B"] })[0].answer).toBe("A · B");
    expect(end({ answer: "Opción 1" })[0].answer).toBe("Opción 1");
    expect(end({ content: [{ type: "text", text: "elegido: X" }] })[0].answer).toBe("elegido: X");
    expect(end('User has answered: "¿BD?"="MySQL"')[0].answer).toBe('User has answered: "¿BD?"="MySQL"');
    expect(end({ approved: true }, "ExitPlanMode")[0].answer).toBe("Aprobado");
    expect(end({ approved: false }, "ExitPlanMode")[0].answer).toBe("Rechazado");
    expect(end({ cosa: 1 })).toEqual([{ type: "waiting_end", answer: null, t: T }]);
    expect(end(undefined)).toEqual([{ type: "waiting_end", answer: null, t: T }]);
  });

  it("PostToolUse de otras herramientas o de subagentes no emite waiting_end", () => {
    expect(hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} }).events).toEqual([]);
    expect(hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", agent_id: "a", tool_response: {} }).events).toEqual([]);
  });
});

describe("resultado completo del encargo", () => {
  it("SubagentStop guarda summary corto y result de hasta 8000 caracteres", () => {
    const { events } = hook({ hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: "y".repeat(9000) });
    expect(events[0].summary.length).toBeLessThanOrEqual(200);
    expect(events[0].result).toHaveLength(8000);
    expect(hook({ hook_event_name: "SubagentStop", agent_id: "a" }).events[0].result).toBe("");
  });
});

describe("coste real desde transcripts", () => {
  it("SubagentStop emite task_usage antes de task_end si hay datos", () => {
    const { events } = hook({ hook_event_name: "SubagentStop", agent_id: "a", last_assistant_message: "ok" }, open1(), { agentUsage: usage("claude-sonnet-5-5", 3) });
    expect(events.map((e) => e.type)).toEqual(["task_usage", "task_end"]);
    expect(events[0]).toEqual({ type: "task_usage", taskId: "a", snapshot: true, ...usage("claude-sonnet-5-5", 3), t: T });
    expect(hook({ hook_event_name: "SubagentStop", agent_id: "a" }, open1(), { agentUsage: { byModel: {} } }).events.map((e) => e.type)).toEqual(["task_end"]);
  });

  it("Stop, StopFailure y SessionEnd emiten orchestrator_usage antes de run_end", () => {
    const ctx = { orchestratorUsage: usage("claude-opus-5-5", 9) };
    const ev = { type: "orchestrator_usage", ...usage("claude-opus-5-5", 9), t: T };
    expect(hook({ hook_event_name: "Stop", background_tasks: [] }, open1(), ctx).events).toEqual([ev, { type: "run_end", exitCode: 0, t: T }]);
    expect(hook({ hook_event_name: "StopFailure", error: "x" }, open1(), ctx).events.map((e) => e.type)).toEqual(["error", "orchestrator_usage", "run_end"]);
    expect(hook({ hook_event_name: "SessionEnd" }, open1(), ctx).events.map((e) => e.type)).toEqual(["orchestrator_usage", "run_end"]);
  });

  it("Stop con tareas en segundo plano no cierra ni emite uso", () => {
    const { events } = hook({ hook_event_name: "Stop", background_tasks: [{ id: 1 }] }, open1(), { orchestratorUsage: usage("m", 1) });
    expect(events.map((e) => e.type)).toEqual(["thinking"]);
  });

  it("sin uso en ctx no se emite nada extra", () => {
    expect(hook({ hook_event_name: "Stop" }).events).toEqual([{ type: "run_end", exitCode: 0, t: T }]);
  });

  it("el cierre por Esc (statusline o mensaje nuevo) también lleva el uso", () => {
    const o = usage("claude-opus-5-5", 2);
    expect(closeInterrupted({ runId: "r1", seq: 1 }, T, o).events.map((e) => e.type)).toEqual(["orchestrator_usage", "run_end"]);
    const res = hook({ hook_event_name: "UserPromptSubmit", prompt: "z" }, open1(), { interrupted: true, orchestratorUsage: o });
    expect(res.before.events.map((e) => e.type)).toEqual(["orchestrator_usage", "run_end"]);
  });
});

describe("gasto del orquestador en vivo", () => {
  const ctx = (n = 4) => ({ orchestratorUsage: usage("claude-opus-5-5", n), usageState: { offset: 99, byModel: {}, recent: [] } });
  const post = { hook_event_name: "PostToolUse", tool_name: "Bash" };

  it("liveUsageDue: PostToolUse del orquestador y SubagentStop, como mucho cada 20 s", () => {
    expect(LIVE_USAGE_MS).toBe(20_000);
    const s = open1();
    expect(liveUsageDue(post, s, T)).toBe(true);
    expect(liveUsageDue({ ...post, agent_id: "a" }, s, T)).toBe(false);
    expect(liveUsageDue({ hook_event_name: "SubagentStop", agent_id: "a" }, s, T)).toBe(true);
    expect(liveUsageDue({ hook_event_name: "PreToolUse" }, s, T)).toBe(false);
    expect(liveUsageDue(post, { ...s, lastUsageAt: T - 19_999 }, T)).toBe(false);
    expect(liveUsageDue(post, { ...s, lastUsageAt: T - 20_000 }, T)).toBe(true);
    expect(liveUsageDue(post, { runId: null, seq: 0 }, T)).toBe(false);
    expect(liveUsageDue(post, { ...open1(), transcriptOffset: undefined }, T)).toBe(false);
  });

  it("PostToolUse emite orchestrator_usage y guarda lastUsageAt y el estado incremental", () => {
    const res = hook(post, open1(), ctx());
    expect(res.events).toEqual([{ type: "orchestrator_usage", ...usage("claude-opus-5-5", 4), t: T }]);
    expect(res.session).toMatchObject({ runId: "r-abcdef12-1", lastUsageAt: T, usageState: { offset: 99 } });
  });

  it("estrangulado: dentro de los 20 s no emite ni toca la sesión", () => {
    const s = { ...open1(), lastUsageAt: T - 5000 };
    const res = hook(post, s, ctx());
    expect(res.events).toEqual([]);
    expect(res.session).toBe(s);
  });

  it("SubagentStop lo emite después de task_end; sin datos no emite nada", () => {
    const ev = hook({ hook_event_name: "SubagentStop", agent_id: "a" }, open1(), ctx()).events;
    expect(ev.map((e) => e.type)).toEqual(["task_end", "orchestrator_usage"]);
    expect(hook(post, open1(), { orchestratorUsage: { byModel: {} } }).events).toEqual([]);
  });

  it("PostToolUse de un subagente o de una herramienta de espera no lo emite; el de Agent sí conserva task_stats", () => {
    expect(hook({ ...post, agent_id: "a" }, open1(), ctx()).events).toEqual([]);
    expect(hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_response: "x" }, open1(), ctx()).events.map((e) => e.type)).toEqual(["waiting_end", "orchestrator_usage"]);
    const agent = { hook_event_name: "PostToolUse", tool_name: "Agent", tool_response: { agentId: "a", resolvedModel: "claude-haiku-5-5" } };
    expect(hook(agent, open1(), ctx()).events.map((e) => e.type)).toEqual(["task_stats", "orchestrator_usage"]);
  });

  it("cada instantánea sustituye a la anterior en el reducer (no se suma)", () => {
    const s0 = hook({ hook_event_name: "UserPromptSubmit", prompt: "x" }, { runId: null, seq: 0 }, { transcriptSize: 0 });
    const a = hook(post, s0.session, ctx(4));
    const b = hook(post, { ...a.session, lastUsageAt: T - 30_000 }, ctx(9));
    const run = reduceEvents([...s0.events, ...a.events, ...b.events]);
    expect(run.orchestratorUsage["claude-opus-5-5"]).toMatchObject({ input: 9, output: 9 });
  });

  it("el cierre sigue emitiendo el gasto sin importar el estrangulado", () => {
    const s = { ...open1(), lastUsageAt: T - 1000 };
    expect(hook({ hook_event_name: "Stop", background_tasks: [] }, s, ctx()).events.map((e) => e.type)).toEqual(["orchestrator_usage", "run_end"]);
  });
});

describe("gasto de subagentes en vivo", () => {
  const sub = { hook_event_name: "PostToolUse", agent_id: "a1", tool_name: "Read" };
  const agentLive = { usage: usage("claude-sonnet-5-5", 5), state: { offset: 7, byModel: {}, recent: [] } };

  it("agentTranscriptPath: el que traiga el hook o el derivado del transcript principal", () => {
    expect(agentTranscriptPath({ agent_transcript_path: "/x/agent-a1.jsonl" })).toBe("/x/agent-a1.jsonl");
    expect(agentTranscriptPath({ agent_id: "a1", transcript_path: "/p/proy/sess-1.jsonl" })).toBe("/p/proy/sess-1/subagents/agent-a1.jsonl");
    expect(agentTranscriptPath({ agent_id: "a1" })).toBeNull();
    expect(agentTranscriptPath({ transcript_path: "/p/s.jsonl" })).toBeNull();
  });

  it("liveAgentUsageDue: tool del subagente, ejecución abierta y como mucho cada 20 s por subagente", () => {
    const s = open1();
    expect(liveAgentUsageDue(sub, s, T)).toBe(true);
    expect(liveAgentUsageDue({ ...sub, hook_event_name: "PreToolUse" }, s, T)).toBe(true);
    expect(liveAgentUsageDue({ ...sub, agent_id: undefined }, s, T)).toBe(false);
    expect(liveAgentUsageDue({ hook_event_name: "Notification", agent_id: "a1" }, s, T)).toBe(false);
    expect(liveAgentUsageDue(sub, { runId: null, seq: 0 }, T)).toBe(false);
    expect(liveAgentUsageDue(sub, { ...s, agentUsage: { a1: { at: T - 19_999 } } }, T)).toBe(false);
    expect(liveAgentUsageDue(sub, { ...s, agentUsage: { a1: { at: T - 20_000 } } }, T)).toBe(true);
    expect(liveAgentUsageDue(sub, { ...s, agentUsage: { otro: { at: T } } }, T)).toBe(true);
  });

  it("un tool del subagente con lectura emite task_usage snapshot y recuerda el estado", () => {
    const res = hook(sub, open1(), { agentLive });
    expect(res.events.map((e) => e.type)).toEqual(["task_usage"]);
    expect(res.events[0]).toEqual({ type: "task_usage", taskId: "a1", snapshot: true, ...usage("claude-sonnet-5-5", 5), t: T });
    expect(res.session.agentUsage.a1).toEqual({ at: T, state: agentLive.state });
  });

  it("sin estrangulado cumplido no emite, y SubagentStop olvida el estado del subagente", () => {
    const s = { ...open1(), agentUsage: { a1: { at: T - 1000, state: {} } } };
    expect(hook(sub, s, { agentLive }).events).toEqual([]);
    const stop = hook({ hook_event_name: "SubagentStop", agent_id: "a1" }, s, {});
    expect(stop.session.agentUsage?.a1).toBeUndefined();
  });

  it("en el reducer, instantáneas sucesivas más la final no duplican el gasto", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "t", mode: "sesion", model: "opus", t: 1 },
      { type: "task_start", taskId: "a1", agent: "programador", description: "d", prompt: "p", t: 2 },
      { type: "task_usage", taskId: "a1", snapshot: true, ...usage("claude-sonnet-5-5", 5), t: 3 },
      { type: "task_usage", taskId: "a1", snapshot: true, ...usage("claude-sonnet-5-5", 9), t: 4 }
    ]);
    expect(run.tasks.a1.usage["claude-sonnet-5-5"].input).toBe(9);
  });
});
