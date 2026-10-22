import { describe, it, expect } from "vitest";
import { translateHook, closeInterrupted, quotaSnapshot } from "../src/core/hooks.mjs";
import { analyzeRun, buildCuotaReport, formatCuotaReport } from "../src/core/cuota.mjs";
import { parseCuotaArgs, isCuotaCommand } from "../src/core/cli.mjs";

const T = 1_792_000_000_000;
const makeRunId = (now, short, n) => `r-${short}-${n}`;
const base = { session_id: "abcdef12-3456", cwd: "/repo", transcript_path: "/t" };
const q = (five, seven, profile = "trabajo", t = T - 5000) => ({
  type: "quota", status: "allowed", limitType: null, profile, t,
  fiveHour: { utilization: five, resetsAt: 1_792_020_000 }, sevenDay: { utilization: seven, resetsAt: 1_792_600_000 }
});

describe("registro de cuota en run_start y run_end (hooks)", () => {
  it("quotaSnapshot reduce la cuota; sin dato es null; sin aportar es undefined", () => {
    expect(quotaSnapshot(q(0.1, 0.5))).toEqual({ fiveHour: { utilization: 0.1, resetsAt: 1_792_020_000 }, sevenDay: { utilization: 0.5, resetsAt: 1_792_600_000 }, profile: "trabajo", seenAt: T - 5000 });
    expect(quotaSnapshot(null)).toBeNull();
    expect(quotaSnapshot(undefined)).toBeUndefined();
  });

  it("run_start lleva la ultima cuota conocida de la sesion, con su perfil", () => {
    const res = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hola" }, { runId: null, seq: 0 }, T, makeRunId, { profile: "personal", quota: q(0.2, 0.6, "personal") });
    expect(res.events[0].quota).toMatchObject({ profile: "personal", fiveHour: { utilization: 0.2 }, sevenDay: { utilization: 0.6 } });
  });

  it("run_start con cuota desconocida registra null y no falla", () => {
    const res = translateHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hola" }, { runId: null, seq: 0 }, T, makeRunId, { quota: null });
    expect(res.events[0].quota).toBeNull();
  });

  it("run_end (Stop) lleva cuota, orquestador y tokens por modelo y tipo", () => {
    const usage = { byModel: { "claude-sonnet-5-5": { input: 4, output: 10, cacheRead: 100, cacheWrite5m: 7, cacheWrite1h: 0 } } };
    const res = translateHook({ ...base, hook_event_name: "Stop", background_tasks: [] }, { runId: "r1", seq: 1 }, T, makeRunId, { quota: q(0.3, 0.7), mainModel: "claude-sonnet-5-5", orchestratorUsage: usage });
    const end = res.events.find((e) => e.type === "run_end");
    expect(end).toMatchObject({ exitCode: 0, mainModel: "claude-sonnet-5-5", byModel: usage.byModel, quota: { fiveHour: { utilization: 0.3 }, sevenDay: { utilization: 0.7 }, profile: "trabajo" } });
  });

  it("run_end usa el mainModel de la sesion si el hook no lo leyo, y registra quota null sin dato", () => {
    const res = translateHook({ ...base, hook_event_name: "SessionEnd" }, { runId: "r1", seq: 1, mainModel: "claude-opus-5-5" }, T, makeRunId, { quota: null });
    expect(res.events.at(-1)).toMatchObject({ type: "run_end", mainModel: "claude-opus-5-5", quota: null });
  });

  it("cierre por Esc (closeInterrupted) tambien registra la cuota", () => {
    const res = closeInterrupted({ runId: "r1", seq: 1, mainModel: "claude-sonnet-5-5" }, T, null, q(0.4, 0.8));
    expect(res.events.at(-1)).toMatchObject({ type: "run_end", status: "cancelled", quota: { fiveHour: { utilization: 0.4 } }, mainModel: "claude-sonnet-5-5" });
  });
});

const day = (s) => new Date(s).getTime();
const snap = (five, seven, o = {}) => ({
  fiveHour: five == null ? null : { utilization: five, resetsAt: o.r5 ?? 1000 },
  sevenDay: seven == null ? null : { utilization: seven, resetsAt: o.r7 ?? 9000 },
  profile: o.profile ?? "trabajo", seenAt: 1
});
const usage = (n) => ({ "claude-sonnet-5-5": { input: n, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
function run({ id = "r", t = day("2026-10-20T10:00:00Z"), start, end, model = "claude-sonnet-5-5", tasks = 0, tokens = 100, profile = "trabajo", noEnd = false }) {
  const ev = [{ type: "run_start", runId: id, task: "x", mode: "sesion", model: "opus", profile, ...(start !== undefined && { quota: start }), t }];
  ev.push({ type: "main_model", model, t });
  for (let i = 0; i < tasks; i++) ev.push({ type: "task_start", taskId: `${id}-${i}`, agent: "programador", t });
  ev.push({ type: "orchestrator_usage", byModel: usage(tokens / 2), t }, { type: "orchestrator_usage", byModel: usage(tokens), t });
  if (!noEnd) ev.push({ type: "run_end", exitCode: 0, ...(end !== undefined && { quota: end }), t: t + 60_000 });
  return ev;
}

describe("analyzeRun", () => {
  it("delta en puntos porcentuales fin - inicio, orquestador y tokens (ultima instantanea)", () => {
    const r = analyzeRun(run({ start: snap(0.1, 0.5), end: snap(0.13, 0.51), tasks: 2, tokens: 1000 }));
    expect(r.delta5).toBeCloseTo(3);
    expect(r.delta7).toBeCloseTo(1);
    expect(r.orchestrator).toBe("claude-sonnet-5-5");
    expect(r.orchTokens).toBe(1000);
    expect(r.tasks).toBe(2);
    expect(r.reliable).toBe(true);
    expect(r.profile).toBe("trabajo");
  });

  it("falta dato de inicio o fin: delta null y motivo", () => {
    expect(analyzeRun(run({ start: null, end: snap(0.1, 0.5) }))).toMatchObject({ delta5: null, delta7: null, reliable: false, reason: "sin cuota" });
    expect(analyzeRun(run({ start: snap(0.1, 0.5) }))).toMatchObject({ reliable: false, reason: "sin cuota" });
  });

  it("cruza un reset (resetsAt distinto o baja la utilizacion): esa ventana se ignora", () => {
    const a = analyzeRun(run({ start: snap(0.9, 0.5), end: snap(0.02, 0.51, { r5: 2000 }) }));
    expect(a.delta5).toBeNull();
    expect(a.delta7).toBeCloseTo(1);
    expect(a.reliable).toBe(false);
    expect(a.reason).toBe("reset 5h");
    const b = analyzeRun(run({ start: snap(0.9, 0.5), end: snap(0.02, 0.51) }));
    expect(b.delta5).toBeNull();
  });

  it("run sin run_end es abierto y no fiable", () => {
    expect(analyzeRun(run({ start: snap(0.1, 0.5), noEnd: true }))).toMatchObject({ reliable: false, reason: "abierto" });
  });

  it("run antiguo sin snapshot: aproxima con primer y ultimo evento quota y lo marca aproximado", () => {
    const ev = run({});
    ev.splice(1, 0, { ...q(0.1, 0.5), t: 1 }, { ...q(0.12, 0.5), t: 2 });
    const r = analyzeRun(ev);
    expect(r.approx).toBe(true);
    expect(r.reliable).toBe(false);
    expect(r.delta5).toBeCloseTo(2);
  });
});

describe("buildCuotaReport / formatCuotaReport", () => {
  const runs = [
    run({ id: "a", start: snap(0.1, 0.5), end: snap(0.14, 0.52), tasks: 2, tokens: 1000 }),
    run({ id: "b", start: snap(0.14, 0.52), end: snap(0.16, 0.52), tasks: 0, tokens: 500 }),
    run({ id: "c", start: null, end: null, tasks: 1 }),
    run({ id: "d", model: "claude-opus-5-5", start: snap(0.2, 0.6, { profile: "personal" }), end: snap(0.3, 0.62, { profile: "personal" }), tasks: 1, tokens: 2000, profile: "personal" })
  ];

  it("agrupa por dia, orquestador y perfil y suma solo runs con delta valido", () => {
    const rows = buildCuotaReport(runs.map(analyzeRun));
    const sonnet = rows.find((r) => r.orchestrator === "claude-sonnet-5-5");
    expect(sonnet).toMatchObject({ profile: "trabajo", runs: 3, reliable: 2 });
    expect(sonnet.sum5).toBeCloseTo(6);
    expect(sonnet.avg5).toBeCloseTo(3);
    expect(sonnet.tasks).toBe(2);
    expect(sonnet.ppPerTask5).toBeCloseTo(3);
    const opus = rows.find((r) => r.orchestrator === "claude-opus-5-5");
    expect(opus).toMatchObject({ profile: "personal", runs: 1, reliable: 1 });
    expect(opus.sum5).toBeCloseTo(10);
  });

  it("con approx incluye en las sumas los runs antiguos aproximados", () => {
    const old = run({ id: "o", tasks: 1, tokens: 200 });
    old.splice(1, 0, { ...q(0.1, 0.5), t: 1 }, { ...q(0.15, 0.51), t: 2 });
    const a = analyzeRun(old);
    expect(buildCuotaReport([a])[0]).toMatchObject({ reliable: 0, sum5: 0 });
    expect(buildCuotaReport([a], { approx: true })[0]).toMatchObject({ reliable: 1, sum5: 5, tasks: 1 });
  });

  it("orquestador de runs sin main_model: modelo dominante de orchestrator_usage", () => {
    const ev = run({ start: snap(0.1, 0.5), end: snap(0.2, 0.5) }).filter((e) => e.type !== "main_model");
    expect(analyzeRun(ev).orchestrator).toBe("claude-sonnet-5-5");
  });

  it("formatea tabla de texto marcando no fiables", () => {
    const text = formatCuotaReport(runs.map(analyzeRun));
    expect(text).toContain("claude-sonnet-5-5");
    expect(text).toContain("claude-opus-5-5");
    expect(text).toMatch(/no fiables?/i);
    expect(text).toContain("sin cuota");
  });

  it("sin runs, mensaje claro", () => {
    expect(formatCuotaReport([])).toMatch(/sin ejecuciones/i);
  });
});

describe("cli cuota", () => {
  it("reconoce el comando y sus opciones", () => {
    expect(isCuotaCommand("cuota")).toBe(true);
    expect(isCuotaCommand("laya-datos")).toBe(false);
    expect(parseCuotaArgs(["cuota"])).toMatchObject({ days: null, profile: "todos", verbose: false, approx: false });
    expect(parseCuotaArgs(["cuota", "--dias", "3", "--perfil", "personal", "--detalle"])).toMatchObject({ days: 3, profile: "personal", verbose: true, approx: true });
    expect(() => parseCuotaArgs(["cuota", "--dias", "x"])).toThrow();
    expect(() => parseCuotaArgs(["cuota", "--foo"])).toThrow();
  });
});
