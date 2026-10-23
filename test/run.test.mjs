import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/core/store.mjs";
import { runTask, makeRunId } from "../src/core/run.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";

const fixtureLines = readFileSync(new URL("./fixtures/stream-subagente.jsonl", import.meta.url), "utf8").trim().split("\n");

function fakeSpawn({ lines = fixtureLines, code = 0, stderr = "", fail = null } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdinData = "";
    child.stdin = new Writable({ write(chunk, _e, cb) { stdinData += chunk; cb(); } });
    child.kill = (sig) => { child.killedWith = sig; };
    calls.push({ bin, args, opts, child, get stdin() { return stdinData; } });
    setImmediate(() => {
      if (fail) { child.emit("error", fail); return; }
      for (const l of lines) child.stdout.write(l + "\n");
      child.stdout.end();
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      setImmediate(() => child.emit("close", code, null));
    });
    return child;
  };
  return { spawn, calls };
}

const sink = () => { let text = ""; return { write: (s) => { text += s; }, get text() { return text; } }; };
const config = { permissionMode: "auto", fallbackModel: "sonnet", maxBudgetUsd: null, effort: null, claudeBin: "claude" };
let dir;
let clock;
const now = () => clock;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "router-test-")); clock = 1_792_000_000_000; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("makeRunId", () => {
  it("ordena por fecha y no colisiona entre procesos", () => {
    expect(makeRunId(Date.UTC(2026, 9, 14, 13, 5, 9), 4242, "ab12")).toBe("20261014T130509Z-4242-ab12");
  });
});

describe("store", () => {
  it("guarda cada ejecución en su archivo y conserva el orden", async () => {
    const store = createStore({ runsDir: dir });
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append("r1", { type: "tool", i, t: i })));
    const events = await store.readRun("r1");
    expect(events.map((e) => e.i)).toEqual([...Array(50).keys()]);
  });

  it("dos ejecuciones simultáneas no se pisan", async () => {
    const a = createStore({ runsDir: dir });
    const b = createStore({ runsDir: dir });
    await Promise.all([
      ...Array.from({ length: 100 }, (_, i) => a.append("20260101T000000Z-1-a", { type: "tool", i, t: i })),
      ...Array.from({ length: 100 }, (_, i) => b.append("20260101T000000Z-2-b", { type: "tool", i, t: i }))
    ]);
    expect((await a.readRun("20260101T000000Z-1-a")).map((e) => e.i)).toEqual([...Array(100).keys()]);
    expect((await a.readRun("20260101T000000Z-2-b")).map((e) => e.i)).toEqual([...Array(100).keys()]);
    expect(await a.listRunIds()).toEqual(["20260101T000000Z-2-b", "20260101T000000Z-1-a"]);
  });

  it("ignora líneas corruptas al leer y nombres de ejecución peligrosos", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r1", { type: "tool", t: 1 });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "r1.jsonl"), "{roto\n");
    expect(await store.readRun("r1")).toHaveLength(1);
    await expect(store.append("../fuera", { t: 1 })).rejects.toThrow(/id de ejecución/);
    await expect(store.readRun("../../etc/passwd")).rejects.toThrow(/id de ejecución/);
  });

  it("la última cuota es por perfil (cuentas distintas)", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("20260101T000000Z-1-a", { type: "quota", profile: "personal", fiveHour: { utilization: 0.9 }, t: 2 });
    await store.append("20260101T000000Z-2-a", { type: "quota", fiveHour: { utilization: 0.3 }, t: 1 });
    expect((await store.latestQuota("personal")).fiveHour.utilization).toBe(0.9);
    expect((await store.latestQuota("trabajo")).fiveHour.utilization).toBe(0.3);
    expect(await store.latestQuotas()).toMatchObject({ personal: { fiveHour: { utilization: 0.9 } }, trabajo: { fiveHour: { utilization: 0.3 } } });
  });

  it("devuelve la última cuota conocida", async () => {
    const store = createStore({ runsDir: dir });
    expect(await store.latestQuota()).toBeNull();
    await store.append("20260101T000000Z-1-a", { type: "quota", fiveHour: { utilization: 0.1 }, t: 1 });
    await store.append("20260102T000000Z-1-a", { type: "quota", fiveHour: { utilization: 0.6 }, t: 2 });
    await store.append("20260102T000000Z-1-a", { type: "tool", t: 3 });
    expect((await store.latestQuota()).fiveHour.utilization).toBe(0.6);
  });
});

describe("runTask", () => {
  const agents = { asistente: { description: "Haiku", prompt: "p", model: "haiku" } };

  it("lanza claude en modo orquestado, pasa la tarea por stdin y registra la ejecución completa", async () => {
    const store = createStore({ runsDir: dir });
    const { spawn, calls } = fakeSpawn();
    const out = sink();
    const res = await runTask({ task: "Haz X", mode: "orquestado", model: "opus", agents, config, store, spawn, now, out, cwd: "/proyecto", runId: "r1" });

    expect(res).toEqual({ runId: "r1", exitCode: 0, status: "completed" });
    expect(calls[0].bin).toBe("claude");
    expect(calls[0].stdin).toBe("Haz X");
    expect(calls[0].opts.cwd).toBe("/proyecto");
    expect(calls[0].args).toContain("--append-system-prompt");
    expect(calls[0].args[calls[0].args.indexOf("--agents") + 1]).toBe(JSON.stringify(agents));

    const run = reduceEvents(await store.readRun("r1"));
    expect(run).toMatchObject({ id: "r1", task: "Haz X", mode: "orquestado", status: "completed", exitCode: 0 });
    expect(run.taskOrder).toEqual(["b1c2d3e4f5a6b7c8"]);
    expect(run.tasks.b1c2d3e4f5a6b7c8).toMatchObject({ status: "completed", agent: "asistente", node: "asistente" });
    expect(out.text).toContain("→ asistente · saludo");
    expect(out.text).toContain("✓ asistente · saludo");
    expect(out.text).toContain("hecho");
  });

  it("mete la última cuota en el prompt del orquestador", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("20000101T000000Z-1-a", { type: "quota", fiveHour: { utilization: 0.8, resetsAt: 1_792_003_600 }, sevenDay: null, t: 1 });
    const { spawn, calls } = fakeSpawn();
    await runTask({ task: "x", mode: "orquestado", model: "opus", agents, config, store, spawn, now, out: sink(), runId: "r2" });
    const sys = calls[0].args[calls[0].args.indexOf("--append-system-prompt") + 1];
    expect(sys).toContain("5 h: 80 %");
  });

  it("mete el navegador del perfil en el prompt, y no en modo manual", async () => {
    const store = createStore({ runsDir: dir });
    const browser = { id: "11111111-2222-3333-4444-555555555555", label: "Trabajo" };
    const a = fakeSpawn();
    await runTask({ task: "x", mode: "orquestado", model: "opus", agents, config, store, spawn: a.spawn, now, out: sink(), runId: "r2b", browser });
    expect(a.calls[0].args[a.calls[0].args.indexOf("--append-system-prompt") + 1]).toContain(browser.id);
    const b = fakeSpawn();
    await runTask({ task: "x", mode: "orquestado", model: "opus", agents, config, store, spawn: b.spawn, now, out: sink(), runId: "r2c" });
    expect(b.calls[0].args[b.calls[0].args.indexOf("--append-system-prompt") + 1]).not.toContain("## Navegador");
  });

  it("modo manual: sin prompt de orquestador", async () => {
    const store = createStore({ runsDir: dir });
    const { spawn, calls } = fakeSpawn();
    await runTask({ task: "x", mode: "manual", model: "haiku", agents: null, config, store, spawn, now, out: sink(), runId: "r3" });
    expect(calls[0].args).not.toContain("--append-system-prompt");
    expect(calls[0].args).toEqual(expect.arrayContaining(["--model", "haiku"]));
  });

  it("si claude sale con error guarda el final de stderr", async () => {
    const store = createStore({ runsDir: dir });
    const { spawn } = fakeSpawn({ lines: [], code: 1, stderr: "Error: algo se rompió" });
    const res = await runTask({ task: "x", mode: "manual", model: "haiku", config, store, spawn, now, out: sink(), runId: "r4" });
    expect(res.status).toBe("failed");
    const run = reduceEvents(await store.readRun("r4"));
    expect(run.errors[0]).toMatchObject({ kind: "api", message: "Error: algo se rompió" });
  });

  it("detecta el límite de uso y lo marca como limitado", async () => {
    const store = createStore({ runsDir: dir });
    const lines = [JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_792_003_600, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_792_003_600 } } } })];
    const { spawn } = fakeSpawn({ lines, code: 1 });
    const out = sink();
    const res = await runTask({ task: "x", mode: "manual", model: "opus", config, store, spawn, now, out, runId: "r5" });
    expect(res.status).toBe("limited");
    expect(out.text).toMatch(/Límite de uso/);
  });

  it("si claude no existe termina con 127 y lo registra", async () => {
    const store = createStore({ runsDir: dir });
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { spawn } = fakeSpawn({ fail: err });
    const res = await runTask({ task: "x", mode: "manual", model: "opus", config, store, spawn, now, out: sink(), runId: "r6" });
    expect(res).toMatchObject({ exitCode: 127, status: "failed" });
    const raw = await readFile(join(dir, "r6.jsonl"), "utf8");
    expect(raw).toMatch(/no está en el PATH/);
  });

  it("cancelar envía SIGINT a claude y marca la ejecución como cancelada", async () => {
    const store = createStore({ runsDir: dir });
    const { spawn, calls } = fakeSpawn({ code: 130 });
    const ac = new AbortController();
    const p = runTask({ task: "x", mode: "manual", model: "opus", config, store, spawn, now, out: sink(), runId: "r7", signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(calls[0].child.killedWith).toBe("SIGINT");
    expect(res.status).toBe("cancelled");
  });
});

describe("runTask registra la cuota al inicio y al fin", () => {
  const quotaEv = (five, profile, t) => ({ type: "quota", status: "allowed", limitType: null, fiveHour: { utilization: five, resetsAt: 5000 }, sevenDay: { utilization: 0.5, resetsAt: 9000 }, profile, t });

  it("run_start y run_end llevan la última cuota conocida del perfil (null si no hay)", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("20260101T000000Z-1-a", quotaEv(0.1, "personal", 1));
    await store.append("20260101T000000Z-1-a", quotaEv(0.9, "trabajo", 2));
    const { spawn } = fakeSpawn({ lines: [] });
    await runTask({ task: "x", mode: "manual", model: "sonnet", config, store, spawn, now, out: sink(), runId: "20260102T000000Z-2-b", profile: "personal" });
    const evs = await store.readRun("20260102T000000Z-2-b");
    expect(evs[0]).toMatchObject({ type: "run_start", quota: { profile: "personal", fiveHour: { utilization: 0.1 } } });
    expect(evs.at(-1)).toMatchObject({ type: "run_end", quota: { profile: "personal", fiveHour: { utilization: 0.1 } } });

    const empty = createStore({ runsDir: join(dir, "vacio") });
    await runTask({ task: "x", mode: "manual", model: "sonnet", config, store: empty, spawn, now, out: sink(), runId: "20260103T000000Z-3-c", profile: "personal" });
    const evs2 = await empty.readRun("20260103T000000Z-3-c");
    expect(evs2[0].quota).toBeNull();
    expect(evs2.at(-1).quota).toBeNull();
  });
});

describe("runTask registra estado y modelo real en run_end", () => {
  const opusLine = JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "hola" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const endOf = async (opts, spawnOpts) => {
    const store = createStore({ runsDir: dir });
    const { spawn } = fakeSpawn(spawnOpts);
    await runTask({ task: "x", mode: "manual", model: "opus", config, store, spawn, now, out: sink(), runId: "r-estado", ...opts });
    return (await store.readRun("r-estado")).findLast((e) => e.type === "run_end");
  };

  it("exit 0 completed, exit distinto de 0 failed", async () => {
    expect(await endOf({}, { lines: [] })).toMatchObject({ exitCode: 0, status: "completed" });
  });

  it("exit distinto de 0 es failed", async () => {
    expect(await endOf({}, { lines: [], code: 1, stderr: "boom" })).toMatchObject({ exitCode: 1, status: "failed" });
  });

  it("cancelado es cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await endOf({ signal: ac.signal }, { lines: [] })).toMatchObject({ status: "cancelled" });
  });

  it("mainModel es el modelo real que vio el parser, o el alias si no hay", async () => {
    expect((await endOf({}, { lines: [opusLine] })).mainModel).toBe("claude-opus-5-5");
    expect((await endOf({}, { lines: [] })).mainModel).toBe("opus");
  });
});
