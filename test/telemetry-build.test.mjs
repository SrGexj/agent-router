import { describe, it, expect } from "vitest";
import { buildTelemetry, TELEMETRY_KEYS } from "../src/core/telemetry.mjs";
import { runSchema } from "./fixtures/telemetry-service-schema.mjs";

const S = "SENTINELA";
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const RESET5 = Math.floor(T0 / 1000) + 3600;
const RESET7 = Math.floor(T0 / 1000) + 86400 * 3;
const u = (n) => ({ input: n, output: n + 1, cacheRead: n + 2, cacheWrite5m: n + 3, cacheWrite1h: 0 });
const quota = (a, b) => ({ fiveHour: { utilization: a, resetsAt: RESET5 }, sevenDay: { utilization: b, resetsAt: RESET7 }, profile: `${S}-perfil`, seenAt: T0 });

// Run orquestado con toda la información sensible que el router guarda en local, rodeada de SENTINELA.
const fixture = () => [
  { type: "run_start", runId: "20261020T100000Z-123-ab12", task: `${S} task`, mode: "orquestado", model: "opus", cwd: `/Users/x/${S}`, profile: "trabajo", sessionId: `${S}-sess`, quota: quota(0.1234, 0.5), t: T0 },
  { type: "main_model", model: "claude-opus-5-5[1m]", t: T0 + 10 },
  { type: "thinking", text: `${S} pensando`, t: T0 + 20 },
  { type: "tool", taskId: null, name: `${S}Tool`, t: T0 + 30 },
  { type: "task_request", toolUseId: "tu1", agent: "programador", description: `${S} description`, prompt: `${S} prompt`, attempt: 1, t: T0 + 40 },
  { type: "task_request", toolUseId: "tu2", agent: "asistente", description: `${S} description 2`, prompt: `${S} prompt`, attempt: 2, previousAgent: "programador", escalated: true, t: T0 + 41 },
  { type: "task_start", taskId: "a1", agent: "programador", description: "", prompt: "", model: null, t: T0 + 50 },
  { type: "task_start", taskId: "a2", agent: "asistente", description: "", prompt: "", model: null, t: T0 + 51 },
  { type: "tool", taskId: "a1", name: `${S}Bash`, t: T0 + 60 },
  { type: "task_usage", taskId: "a1", snapshot: true, byModel: { "claude-sonnet-5-5": u(100) }, t: T0 + 70 },
  { type: "task_end", taskId: "a1", status: "completed", model: "claude-sonnet-5-5[1m]", summary: `${S} summary`, result: `${S} result`, tokens: 999, toolUses: 4, durationMs: 12_000, t: T0 + 80 },
  { type: "task_end", taskId: "a2", status: "failed", error: `${S} error`, model: "claude-haiku-5-5", summary: `${S} summary`, result: `${S} result`, toolUses: 1, durationMs: 3000, t: T0 + 90 },
  { type: "error", kind: "api", message: `${S} error.message /Users/x/y`, t: T0 + 91 },
  { type: "error", kind: "api", message: "otra", t: T0 + 92 },
  { type: "error", kind: "permission", message: `${S} denegado`, t: T0 + 93 },
  { type: "direct_edit", name: "Edit", n: 2, t: T0 + 94 },
  { type: "route_label", label: "programador", t: T0 + 95, note: `${S} label` },
  { type: "orchestrator_usage", byModel: { "claude-opus-5-5": u(1000) }, t: T0 + 100 },
  { type: "run_end", exitCode: 0, status: "completed", quota: quota(0.2, 0.51), mainModel: "claude-opus-5-5[1m]", byModel: { "claude-opus-5-5": u(2000) }, t: T0 + 60_000 }
];

const OPTS = { profile: "trabajo", rev: 19 };
const build = (events = fixture(), opts = OPTS) => buildTelemetry(events, opts);

describe("buildTelemetry: lista blanca", () => {
  it("no filtra texto, rutas, sessionId, label ni nombres de herramientas", () => {
    const json = JSON.stringify(build());
    expect(json).not.toContain(S);
    expect(json).not.toContain("/Users/");
    expect(json).not.toContain("Bash");
  });

  it("las claves son EXACTAMENTE la lista blanca, en cada nivel", () => {
    const d = build();
    expect(Object.keys(d).sort()).toEqual([...TELEMETRY_KEYS.run].sort());
    expect(Object.keys(d.quotaStart).sort()).toEqual([...TELEMETRY_KEYS.quota].sort());
    expect(Object.keys(d.errorKinds).sort()).toEqual([...TELEMETRY_KEYS.errorKinds].sort());
    for (const t of d.tasks) expect(Object.keys(t).sort()).toEqual([...TELEMETRY_KEYS.task].sort());
    for (const row of [...d.orchestratorUsage, ...d.tasks[0].usage]) expect(Object.keys(row).sort()).toEqual([...TELEMETRY_KEYS.usage].sort());
  });

  it("un evento con campos extra no los cuela", () => {
    const events = fixture();
    events.at(-1).extra = `${S} extra`;
    events[0].apiKey = `${S}-key`;
    expect(JSON.stringify(build(events))).not.toContain(S);
  });

  it("no hay SENTINELA aunque esté en el perfil de la cuota ni en agent o modelo con charset ajeno", () => {
    const events = fixture();
    events.find((e) => e.taskId === "a1" && e.type === "task_start").agent = `${S} raro/agent con espacios`;
    const d = build(events);
    expect(JSON.stringify(d)).not.toContain(S);
    expect(d.tasks[0].agent).toBeNull();
  });
});

describe("buildTelemetry: contenido", () => {
  it("campos del run", () => {
    const d = build();
    expect(d).toMatchObject({
      schema: 1, runId: "20261020T100000Z-123-ab12", rev: 19, profile: "trabajo", mode: "orquestado",
      orchestratorModel: "claude-opus-5-5", status: "completed", exitCode: 0,
      startedAt: T0, endedAt: T0 + 60_000, durationMs: 60_000, directEdits: 2,
      errorKinds: { limit: 0, api: 2, permission: 1 }
    });
  });

  it("el perfil sale de las opciones (la clave), no del label", () => {
    expect(build(fixture(), { profile: "otro", rev: 1 }).profile).toBe("otro");
  });

  it("cuota: porcentajes 0..100 y resets en segundos", () => {
    const d = build();
    expect(d.quotaStart).toEqual({ fiveHourPct: 12.3, fiveHourResetsAt: RESET5, sevenDayPct: 50, sevenDayResetsAt: RESET7 });
    expect(d.quotaEnd).toEqual({ fiveHourPct: 20, fiveHourResetsAt: RESET5, sevenDayPct: 51, sevenDayResetsAt: RESET7 });
  });

  it("cuota sin dato o con una sola ventana: null por campo, null si no hay ninguna", () => {
    const events = fixture();
    events[0].quota = null;
    events.at(-1).quota = { fiveHour: { utilization: 1.7, resetsAt: null }, sevenDay: null };
    const d = build(events);
    expect(d.quotaStart).toBeNull();
    expect(d.quotaEnd).toEqual({ fiveHourPct: 100, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null });
  });

  it("el modelo con sufijo [1m] sale limpio", () => {
    const d = build();
    expect(d.orchestratorModel).toBe("claude-opus-5-5");
    expect(d.tasks[0].model).toBe("claude-sonnet-5-5");
  });

  it("un alias corto del orquestador (sin id real) sale null", () => {
    const events = fixture().filter((e) => e.type !== "main_model");
    events.at(-1).mainModel = "opus";
    expect(build(events).orchestratorModel).toBeNull();
  });

  it("encargos: idx ordinal, estado, duración, herramientas, intento y uso", () => {
    const d = build();
    expect(d.tasks).toEqual([
      { idx: 1, agent: "programador", model: "claude-sonnet-5-5", status: "completed", durationMs: 12_000, toolUses: 4, attempt: 1, usage: [{ model: "claude-sonnet-5-5", ...u(100) }] },
      { idx: 2, agent: "asistente", model: "claude-haiku-5-5", status: "failed", durationMs: 3000, toolUses: 1, attempt: 2, usage: null }
    ]);
  });

  it("usage null no es 0: sin datos de uso queda null", () => {
    const events = fixture().filter((e) => e.type !== "orchestrator_usage").map((e) => (e.type === "run_end" ? { ...e, byModel: undefined } : e));
    expect(build(events).orchestratorUsage).toBeNull();
  });

  it("uso del orquestador: el del cierre manda sobre la última instantánea", () => {
    expect(build().orchestratorUsage).toEqual([{ model: "claude-opus-5-5", ...u(2000) }]);
  });

  it("errorKinds cuenta límites", () => {
    const events = fixture();
    events.splice(5, 0, { type: "error", kind: "limit", message: `${S} límite`, t: T0 });
    expect(build(events).errorKinds.limit).toBe(1);
  });

  it("run manual sale como directo; sesión como sesion", () => {
    const manual = fixture(); manual[0].mode = "manual";
    expect(build(manual).mode).toBe("directo");
    const ses = fixture(); ses[0].mode = "sesion";
    expect(build(ses).mode).toBe("sesion");
  });

  it("cancelado y limitado se reflejan en status", () => {
    const events = fixture(); events.at(-1).status = "cancelled"; events.at(-1).exitCode = 130;
    expect(build(events)).toMatchObject({ status: "cancelled", exitCode: 130 });
    const lim = fixture(); lim.splice(5, 0, { type: "error", kind: "limit", message: "x", t: T0 }); lim.at(-1).exitCode = 1;
    expect(build(lim).status).toBe("limited");
  });

  it("sin run_end no hay documento (run abierto)", () => {
    expect(build(fixture().slice(0, -1))).toBeNull();
    expect(build([])).toBeNull();
  });

  it("encargo aún en marcha al cerrar queda como failed (lo cierra el reductor)", () => {
    const events = fixture().filter((e) => !(e.type === "task_end" && e.taskId === "a2"));
    expect(build(events).tasks[1].status).toBe("failed");
  });
});

describe("buildTelemetry: tareas sin inicio registrado (task_usage huérfano)", () => {
  const withOrphans = (extra) => {
    const events = fixture();
    events.splice(events.length - 1, 0, ...extra);
    return events;
  };
  const sumOf = (rows) => (rows ?? []).reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h, 0);
  const total = (d) => sumOf(d.orchestratorUsage) + d.tasks.reduce((a, t) => a + (t.usage ? sumOf(t.usage) : 0), 0);

  it("un task_usage sin task_start crea una fila con agent null, status null y el modelo del uso", () => {
    const base = build();
    const d = build(withOrphans([
      { type: "task_usage", taskId: "zz", snapshot: true, byModel: { "claude-sonnet-5-5": u(5000) }, t: T0 + 96 },
      { type: "task_end", taskId: "zz", status: "completed", t: T0 + 97 }
    ]));
    expect(d.tasks).toHaveLength(base.tasks.length + 1);
    expect(d.tasks.at(-1)).toEqual({ idx: 3, agent: null, model: "claude-sonnet-5-5", status: null, durationMs: null, toolUses: null, attempt: null, usage: [{ model: "claude-sonnet-5-5", ...u(5000) }] });
    expect(total(d)).toBe(total(base) + sumOf([{ model: "m", ...u(5000) }]));
  });

  it("varias instantáneas del mismo huérfano: manda la última; sin snapshot suman", () => {
    const snap = build(withOrphans([
      { type: "task_usage", taskId: "zz", snapshot: true, byModel: { "claude-sonnet-5-5": u(10) }, t: T0 + 96 },
      { type: "task_usage", taskId: "zz", snapshot: true, byModel: { "claude-sonnet-5-5": u(30) }, t: T0 + 97 }
    ]));
    expect(snap.tasks.at(-1).usage).toEqual([{ model: "claude-sonnet-5-5", ...u(30) }]);
    const add = build(withOrphans([
      { type: "task_usage", taskId: "zz", byModel: { "claude-sonnet-5-5": u(10) }, t: T0 + 96 },
      { type: "task_usage", taskId: "zz", byModel: { "claude-sonnet-5-5": u(30) }, t: T0 + 97 }
    ]));
    expect(add.tasks.at(-1).usage).toEqual([{ model: "claude-sonnet-5-5", input: 40, output: 42, cacheRead: 44, cacheWrite5m: 46, cacheWrite1h: 0 }]);
  });

  it("un huérfano no duplica una tarea que sí tiene task_start", () => {
    const d = build(withOrphans([{ type: "task_usage", taskId: "a1", snapshot: true, byModel: { "claude-sonnet-5-5": u(100) }, t: T0 + 96 }]));
    expect(d.tasks).toHaveLength(2);
  });

  it("run del ejemplo en miniatura: 5 starts, 2 huérfanos, todo el gasto cuenta", () => {
    const events = [{ type: "run_start", runId: "r-ej", task: "x", mode: "orquestado", model: "opus", profile: "trabajo", t: T0 }];
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) events.push({ type: "task_start", taskId: id, agent: "programador", t: T0 + 1 }, { type: "task_usage", taskId: id, snapshot: true, byModel: { "claude-sonnet-5-5": u(10) }, t: T0 + 2 });
    events.push({ type: "tool", taskId: "o1", name: "Bash", t: T0 + 3 }, { type: "task_usage", taskId: "o1", byModel: { "claude-opus-5-5": u(1000) }, t: T0 + 4 }, { type: "task_end", taskId: "o1", status: "completed", t: T0 + 5 });
    events.push({ type: "task_usage", taskId: "o2", snapshot: true, byModel: { "claude-sonnet-5-5": u(2000), "claude-haiku-5-5": u(1) }, t: T0 + 6 });
    events.push({ type: "run_end", exitCode: 0, status: "completed", t: T0 + 10 });
    const d = build(events);
    expect(d.tasks).toHaveLength(7);
    expect(d.tasks.map((t) => t.idx)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(d.tasks.slice(5).map((t) => t.agent)).toEqual([null, null]);
    expect(d.tasks[5].model).toBe("claude-opus-5-5");
    expect(d.tasks[6].usage).toHaveLength(2);
    expect(total(d)).toBe(5 * sumOf([u(10)]) + sumOf([u(1000)]) + sumOf([u(2000), u(1)]));
    expect(runSchema.safeParse(d).success).toBe(true);
  });

  it("task_end o tool huérfanos sin task_usage no crean fila", () => {
    const d = build(withOrphans([{ type: "tool", taskId: "zz", name: "Bash", t: T0 + 96 }, { type: "task_end", taskId: "zz", status: "completed", t: T0 + 97 }]));
    expect(d.tasks).toHaveLength(2);
  });

  it("límites: máximo 500 tareas con idx únicos y 20 filas de uso por tarea", () => {
    const events = [{ type: "run_start", runId: "r-lim", task: "x", mode: "orquestado", model: "opus", profile: "trabajo", t: T0 }];
    for (let i = 0; i < 30; i++) events.push({ type: "task_start", taskId: `s${i}`, agent: "programador", t: T0 + 1 });
    for (let i = 0; i < 600; i++) events.push({ type: "task_usage", taskId: `o${i}`, snapshot: true, byModel: { "claude-sonnet-5-5": u(i) }, t: T0 + 2 });
    const many = {};
    for (let i = 0; i < 25; i++) many[`modelo-${i}`] = u(i);
    events.push({ type: "task_usage", taskId: "muchos", snapshot: true, byModel: many, t: T0 + 3 }, { type: "run_end", exitCode: 0, status: "completed", t: T0 + 10 });
    const d = build(events);
    expect(d.tasks).toHaveLength(500);
    expect(new Set(d.tasks.map((t) => t.idx)).size).toBe(500);
    expect(d.tasks.slice(0, 30).every((t) => t.agent === "programador")).toBe(true);
    expect(runSchema.safeParse(d).success).toBe(true);
    const e2 = events.filter((e) => !e.taskId?.startsWith("o"));
    const d2 = build(e2);
    expect(d2.tasks.at(-1).usage).toHaveLength(20);
    expect(runSchema.safeParse(d2).success).toBe(true);
  });

  it("no filtra texto del evento huérfano", () => {
    const d = build(withOrphans([{ type: "task_usage", taskId: `${S}-id`, snapshot: true, byModel: { "claude-sonnet-5-5": u(1) }, note: `${S} nota`, t: T0 + 96 }]));
    expect(JSON.stringify(d)).not.toContain(S);
  });
});

describe("buildTelemetry: contrato del servicio", () => {
  it("el documento valida contra el esquema zod estricto", () => {
    const r = runSchema.safeParse(build());
    expect(r.error?.issues).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("valida también un run mínimo con todo a null", () => {
    const events = [
      { type: "run_start", runId: "r1", task: "x", mode: "sesion", model: "opus", cwd: null, profile: "trabajo", t: T0 },
      { type: "run_end", exitCode: 0, status: "completed", t: T0 + 5 }
    ];
    const d = build(events);
    expect(d).toMatchObject({ orchestratorModel: null, quotaStart: null, quotaEnd: null, orchestratorUsage: null, tasks: [], directEdits: 0 });
    expect(runSchema.safeParse(d).success).toBe(true);
  });

  it("el esquema rechaza un campo desconocido (el contrato es estricto de verdad)", () => {
    expect(runSchema.safeParse({ ...build(), task: "x" }).success).toBe(false);
  });
});
