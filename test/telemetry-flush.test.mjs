import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { flushTelemetry, telemetryStatus } from "../src/core/telemetry-flush.mjs";
import { runSchema } from "./fixtures/telemetry-service-schema.mjs";

const TOKEN = "tok-placeholder-0123456789";
const URL_OK = "http://127.0.0.1:9";
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "router-telemetry-")); });
afterEach(async () => { vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });

const cfg = (env = {}) => loadConfig({ HOME: home, ROUTER_HOME: home, ROUTER_TELEMETRY_URL: URL_OK, ROUTER_TELEMETRY_TOKEN: TOKEN, ...env }, { exists: () => false, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, warn: () => {} });
const storeOf = (config) => createStore({ runsDir: config.runsDir });

// Un run cerrado en el instante `end` (ms). El id lleva `n` para ordenarlos.
async function addRun(store, n, { end = NOW - 60_000, closed = true } = {}) {
  const runId = `20261023T10${String(n).padStart(4, "0")}Z-1-aa${n}`;
  await store.append(runId, { type: "run_start", runId, task: "SENTINELA", mode: "sesion", model: "opus", cwd: "/Users/x", profile: "trabajo", t: end - 1000 });
  if (closed) await store.append(runId, { type: "run_end", exitCode: 0, status: "completed", t: end });
  return runId;
}

const ok = () => new Response(JSON.stringify({ accepted: 1, stale: 0 }), { status: 200 });
const status = (code, body = { error: "x" }) => new Response(JSON.stringify(body), { status: code });
const bodyOf = (call) => JSON.parse(call[1].body);
const files = async () => (await readdir(home)).sort();
const readJson = async (f) => JSON.parse(await readFile(join(home, f), "utf8"));

describe("telemetría desactivada: no hace nada", () => {
  it.each([
    ["sin URL ni token", { ROUTER_TELEMETRY_URL: "", ROUTER_TELEMETRY_TOKEN: "" }],
    ["sin token", { ROUTER_TELEMETRY_TOKEN: "" }],
    ["http no local", { ROUTER_TELEMETRY_URL: "http://telemetry.example.com" }]
  ])("%s: cero fetch y cero archivos", async (_n, env) => {
    const config = cfg(env);
    const fetch = vi.fn(ok);
    const res = await flushTelemetry({ config, store: storeOf(config), fetch, now: () => NOW });
    expect(res.skipped).toBe("desactivada");
    expect(fetch).not.toHaveBeenCalled();
    expect(await files()).toEqual([]);
  });

  it("status desactivado tampoco crea archivos", async () => {
    const config = cfg({ ROUTER_TELEMETRY_URL: "" });
    const s = await telemetryStatus({ config, store: storeOf(config), now: () => NOW });
    expect(s.enabled).toBe(false);
    expect(await files()).toEqual([]);
  });
});

describe("envío", () => {
  it("2xx: envía con Bearer al endpoint, valida contra el esquema y marca enviado", async () => {
    const config = cfg();
    const store = storeOf(config);
    const id = await addRun(store, 1);
    const fetch = vi.fn(async () => ok());
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(res).toMatchObject({ sent: 1, rejected: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${URL_OK}/v1/runs`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("error");
    const { runs } = bodyOf(fetch.mock.calls[0]);
    expect(runs).toHaveLength(1);
    expect(runSchema.safeParse(runs[0]).success).toBe(true);
    expect(JSON.stringify(runs)).not.toMatch(/SENTINELA|\/Users\//);
    expect(await readJson("telemetry-sent.json")).toEqual({ [id]: 2 });
  });

  it("no reenvía el mismo rev; con un rev mayor sí", async () => {
    const config = cfg();
    const store = storeOf(config);
    const id = await addRun(store, 1);
    const fetch = vi.fn(async () => ok());
    await flushTelemetry({ config, store, fetch, now: () => NOW });
    const again = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(again.sent).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await store.append(id, { type: "context", tokens: 5, t: NOW });
    await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch.mock.calls[1]).runs[0].rev).toBe(3);
    expect(await readJson("telemetry-sent.json")).toEqual({ [id]: 3 });
  });

  it("solo runs cerrados de los últimos 30 días", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1, { closed: false });
    await addRun(store, 2, { end: NOW - 31 * 86_400_000 });
    const young = await addRun(store, 3, { end: NOW - 29 * 86_400_000 });
    const fetch = vi.fn(async () => ok());
    await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(bodyOf(fetch.mock.calls[0]).runs.map((r) => r.runId)).toEqual([young]);
  });

  it("un lote de más de 50 se parte", async () => {
    const config = cfg();
    const store = storeOf(config);
    for (let i = 1; i <= 120; i++) await addRun(store, i, { end: NOW - 1000 * (200 - i) });
    const fetch = vi.fn(async () => ok());
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(fetch.mock.calls.map((c) => bodyOf(c).runs.length)).toEqual([50, 50, 20]);
    expect(res.sent).toBe(120);
    expect(Object.keys(await readJson("telemetry-sent.json"))).toHaveLength(120);
  });

  it("401: para (un solo intento), deja pendiente y lo anota", async () => {
    const config = cfg();
    const store = storeOf(config);
    for (let i = 1; i <= 60; i++) await addRun(store, i);
    const fetch = vi.fn(async () => status(401, { error: "no autorizado" }));
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ sent: 0, stopped: "401" });
    expect(await readFile(join(home, "telemetry-errors.log"), "utf8")).toMatch(/401/);
    const s = await telemetryStatus({ config, store, now: () => NOW });
    expect(s.pending).toBe(60);
  });

  it("400: marca rechazado el run culpable (sin cuerpo), manda el resto y no reintenta", async () => {
    const config = cfg();
    const store = storeOf(config);
    const a = await addRun(store, 1, { end: NOW - 3000 });
    const b = await addRun(store, 2, { end: NOW - 2000 });
    const c = await addRun(store, 3, { end: NOW - 1000 });
    const fetch = vi.fn(async (_u, init) => {
      const runs = JSON.parse(init.body).runs;
      const i = runs.findIndex((r) => r.runId === b);
      return i >= 0 ? status(400, { error: `runs[${i}].tasks.0.agent: Invalid string` }) : ok();
    });
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(res).toMatchObject({ sent: 2, rejected: 1 });
    expect(await readJson("telemetry-sent.json")).toEqual({ [a]: 2, [c]: 2 });
    expect(await readJson("telemetry-rejected.json")).toEqual({ [b]: 2 });
    const log = await readFile(join(home, "telemetry-errors.log"), "utf8");
    expect(log).toContain(b);
    expect(log).toContain("tasks.0.agent: Invalid string");
    expect(log).not.toMatch(/SENTINELA|\/Users\//);
    const calls = fetch.mock.calls.length;
    await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("400 sin índice en el mensaje: prueba de uno en uno", async () => {
    const config = cfg();
    const store = storeOf(config);
    const a = await addRun(store, 1, { end: NOW - 2000 });
    const b = await addRun(store, 2, { end: NOW - 1000 });
    const fetch = vi.fn(async (_u, init) => {
      const runs = JSON.parse(init.body).runs;
      return runs.some((r) => r.runId === b) ? status(400, { error: "petición inválida" }) : ok();
    });
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(res).toMatchObject({ sent: 1, rejected: 1 });
    expect(await readJson("telemetry-sent.json")).toEqual({ [a]: 2 });
    expect(Object.keys(await readJson("telemetry-rejected.json"))).toEqual([b]);
  });

  it("un run rechazado se reenvía si su rev crece", async () => {
    const config = cfg();
    const store = storeOf(config);
    const id = await addRun(store, 1);
    let reply = () => status(400, { error: "runs[0].runId: mal" });
    const fetch = vi.fn(async () => reply());
    await flushTelemetry({ config, store, fetch, now: () => NOW });
    reply = ok;
    await store.append(id, { type: "context", tokens: 1, t: NOW });
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(res.sent).toBe(1);
  });

  it("5xx y sin red: quedan pendientes y no lanza", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    await expect(flushTelemetry({ config, store, fetch: vi.fn(async () => status(503)), now: () => NOW })).resolves.toMatchObject({ sent: 0, stopped: "503" });
    await expect(flushTelemetry({ config, store, fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }), now: () => NOW })).resolves.toMatchObject({ sent: 0, stopped: "red" });
    expect((await telemetryStatus({ config, store, now: () => NOW })).pending).toBe(1);
  });

  it("fetch que nunca responde: termina en menos de 3,5 s y no lanza", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    const fetch = vi.fn(() => new Promise(() => {}));
    const p = flushTelemetry({ config, store, fetch, now: () => Date.now() });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const t1 = Date.now();
    await vi.advanceTimersByTimeAsync(3000); // el límite es 3 s desde la llamada
    await expect(p).resolves.toMatchObject({ sent: 0, stopped: "red" });
    expect(Date.now() - t1).toBeLessThan(3500);
    expect((await telemetryStatus({ config, store, now: () => NOW })).pending).toBe(1);
  });

  it("el log de errores no contiene el token aunque el error lo traiga", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    await flushTelemetry({ config, store, fetch: vi.fn(async () => { throw new Error(`boom Bearer ${TOKEN} en la URL`); }), now: () => NOW });
    await flushTelemetry({ config, store, fetch: vi.fn(async () => status(401, { error: `token ${TOKEN} malo` })), now: () => NOW });
    const log = await readFile(join(home, "telemetry-errors.log"), "utf8");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(TOKEN);
  });

  it("ningún archivo de telemetría contiene el token", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    await flushTelemetry({ config, store, fetch: vi.fn(async () => ok()), now: () => NOW });
    for (const f of await files()) if (f.startsWith("telemetry")) expect(await readFile(join(home, f), "utf8")).not.toContain(TOKEN);
  });
});

describe("lock", () => {
  it("con un lock reciente no envía; con uno caducado sí; lo libera al acabar", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    await writeFile(join(home, "telemetry.lock"), "1");
    const fetch = vi.fn(async () => ok());
    const busy = await flushTelemetry({ config, store, fetch, now: () => Date.now() });
    expect(busy.skipped).toBe("en curso");
    expect(fetch).not.toHaveBeenCalled();
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(join(home, "telemetry.lock"), old, old);
    const res = await flushTelemetry({ config, store, fetch, now: () => NOW });
    expect(res.sent).toBe(1);
    await expect(stat(join(home, "telemetry.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dos flush a la vez: solo uno envía", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1);
    const fetch = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return ok(); });
    const [a, b] = await Promise.all([
      flushTelemetry({ config, store, fetch, now: () => NOW }),
      flushTelemetry({ config, store, fetch, now: () => NOW })
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([a.sent, b.sent].sort()).toEqual([0, 1]);
  });
});

describe("status", () => {
  it("cuenta pendientes, enviados y rechazados y no revela el token", async () => {
    const config = cfg();
    const store = storeOf(config);
    await addRun(store, 1, { end: NOW - 2000 });
    await addRun(store, 2, { end: NOW - 1000 });
    await flushTelemetry({ config, store, fetch: vi.fn(async () => ok()), now: () => NOW });
    await addRun(store, 3);
    const s = await telemetryStatus({ config, store, now: () => NOW });
    expect(s).toMatchObject({ enabled: true, url: URL_OK, pending: 1, sent: 2, rejected: 0 });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });
});
