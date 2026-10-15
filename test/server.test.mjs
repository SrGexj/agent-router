import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/core/store.mjs";
import { createApp, createTailer, startServer } from "../server/app.mjs";

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "router-srv-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const start = (id, t = 1) => ({ type: "run_start", runId: id, task: `tarea ${id}`, mode: "orquestado", model: "opus", cwd: "/", t });

describe("tailer", () => {
  it("devuelve solo eventos nuevos y espera a que la línea esté completa", async () => {
    const f = join(dir, "r.jsonl");
    const tail = createTailer();
    await writeFile(f, JSON.stringify({ a: 1 }) + "\n");
    expect(await tail.read(f)).toEqual([{ a: 1 }]);
    await appendFile(f, JSON.stringify({ a: 2 }) + "\n" + "{\"a\":");
    expect(await tail.read(f)).toEqual([{ a: 2 }]);
    await appendFile(f, "3}\n");
    expect(await tail.read(f)).toEqual([{ a: 3 }]);
    expect(await tail.read(f)).toEqual([]);
  });

  it("aguanta caracteres multibyte partidos entre lecturas", async () => {
    const f = join(dir, "m.jsonl");
    const tail = createTailer();
    const line = Buffer.from(JSON.stringify({ t: "añadir validación ✓" }) + "\n");
    await writeFile(f, line.subarray(0, 12));
    expect(await tail.read(f)).toEqual([]);
    await appendFile(f, line.subarray(12));
    expect(await tail.read(f)).toEqual([{ t: "añadir validación ✓" }]);
  });
});

describe("API /api/profiles", () => {
  it("manda las etiquetas de los perfiles configuradas en el servidor", async () => {
    const profileLabels = { trabajo: "Principal", cliente: "Cliente" };
    const res = await request(createApp({ store: createStore({ runsDir: "/nada" }), profileLabels })).get("/api/profiles").expect(200);
    expect(res.body).toEqual({ labels: profileLabels });
  });
  it("sin configuración, objeto vacío (el dashboard enseña el id)", async () => {
    const res = await request(createApp({ store: createStore({ runsDir: "/nada" }) })).get("/api/profiles").expect(200);
    expect(res.body).toEqual({ labels: {} });
  });
});

describe("API", () => {
  it("lista ejecuciones reducidas, la más reciente primero", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("20260101T000000Z-1-a", start("20260101T000000Z-1-a"));
    await store.append("20260102T000000Z-1-a", start("20260102T000000Z-1-a"));
    await store.append("20260102T000000Z-1-a", { type: "run_end", exitCode: 0, t: 5 });
    const res = await request(createApp({ store })).get("/api/runs").expect(200);
    expect(res.body.runs.map((r) => [r.id, r.status])).toEqual([
      ["20260102T000000Z-1-a", "completed"],
      ["20260101T000000Z-1-a", "running"]
    ]);
  });

  it("limita el número de ejecuciones", async () => {
    const store = createStore({ runsDir: dir });
    for (let i = 1; i <= 5; i++) await store.append(`2026010${i}T000000Z-1-a`, start(`2026010${i}T000000Z-1-a`));
    const res = await request(createApp({ store })).get("/api/runs?limit=2").expect(200);
    expect(res.body.runs).toHaveLength(2);
  });

  it("devuelve los eventos de una ejecución y rechaza ids peligrosos", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r1", start("r1"));
    const app = createApp({ store });
    const res = await request(app).get("/api/runs/r1").expect(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.run.id).toBe("r1");
    await request(app).get("/api/runs/..%2F..%2Fetc").expect(400);
    await request(app).get("/api/runs/noexiste").expect(404);
  });

  it("expone la última cuota", async () => {
    const store = createStore({ runsDir: dir });
    const app = createApp({ store });
    expect((await request(app).get("/api/quota").expect(200)).body).toEqual({ quotas: {} });
    await store.append("r1", { type: "quota", status: "allowed", fiveHour: { utilization: 0.4, resetsAt: 1 }, sevenDay: null, t: 1 });
    await store.append("r2", { type: "quota", profile: "personal", status: "allowed", fiveHour: { utilization: 0.7, resetsAt: 1 }, sevenDay: null, t: 2 });
    const { quotas } = (await request(app).get("/api/quota").expect(200)).body;
    expect(quotas.trabajo.fiveHour.utilization).toBe(0.4);
    expect(quotas.personal.fiveHour.utilization).toBe(0.7);
  });

  it("health", async () => {
    const store = createStore({ runsDir: dir });
    expect((await request(createApp({ store })).get("/health").expect(200)).body).toEqual({ ok: true });
  });
});

describe("WebSocket en vivo", () => {
  it("envía hello al conectar y retransmite eventos nuevos de cualquier ejecución", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r0", start("r0"));
    const srv = await startServer({ store, host: "127.0.0.1", port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      const messages = [];
      ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on("open", r));
      await waitFor(() => messages.some((m) => m.kind === "hello"));
      expect(messages[0].runs.map((r) => r.id)).toEqual(["r0"]);

      await store.append("r1", start("r1"));
      await store.append("r1", { type: "task_start", taskId: "t", agent: "asistente", description: "d", prompt: "", t: 2 });
      await waitFor(() => messages.filter((m) => m.kind === "event" && m.runId === "r1").length === 2);
      const evs = messages.filter((m) => m.kind === "event" && m.runId === "r1").map((m) => m.event.type);
      expect(evs).toEqual(["run_start", "task_start"]);
      ws.close();
    } finally {
      await srv.close();
    }
  });
});

describe("rachas de escrituras", () => {
  it("no pierde el último evento de una racha (chokidar descarta los change a menos de 50 ms del anterior)", async () => {
    const store = createStore({ runsDir: dir });
    const srv = await startServer({ store, host: "127.0.0.1", port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      const messages = [];
      ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on("open", r));
      await waitFor(() => messages.some((m) => m.kind === "hello"));
      const types = (id) => messages.filter((m) => m.kind === "event" && m.runId === id).map((m) => m.event.type);

      await store.append("rafaga", start("rafaga"));
      await waitFor(() => types("rafaga").length === 1);
      // Las rondas repiten la carrera: cada una escribe dos eventos muy seguidos y el último debe llegar.
      for (let i = 0; i < 8; i++) {
        const before = types("rafaga").length;
        await store.append("rafaga", { type: "thinking", taskId: null, text: "", t: 10 + i });
        await new Promise((r) => setTimeout(r, 8));
        await store.append("rafaga", { type: "run_end", status: "done", exitCode: 0, t: 20 + i });
        await waitFor(() => types("rafaga").length === before + 2, 2000);
        await new Promise((r) => setTimeout(r, 60));
      }
      ws.close();
    } finally {
      await srv.close();
    }
  });
});

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("POST /api/runs/:id/label", () => {
  const post = (app, id, body, headers = {}) => request(app).post(`/api/runs/${id}/label`).set(headers).send(body);

  it("añade el evento route_label al JSONL y se refleja en la ejecución", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r1", start("r1"));
    await store.append("r1", { type: "run_end", exitCode: 0, t: 5 });
    const app = createApp({ store, now: () => 123 });
    await post(app, "r1", { label: "opus" }).expect(200);
    const events = await store.readRun("r1");
    expect(events.at(-1)).toEqual({ type: "route_label", label: "opus", source: "usuario", t: 123 });
    expect((await request(app).get("/api/runs/r1").expect(200)).body.run.routeLabel).toEqual({ label: "opus", t: 123 });
    await post(app, "r1", { label: null }).expect(200);
    expect((await request(app).get("/api/runs/r1")).body.run.routeLabel).toBeNull();
  });

  it("valida el id, la etiqueta y que la ejecución exista", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r1", start("r1"));
    const app = createApp({ store });
    await post(app, "..%2F..%2Fetc", { label: "opus" }).expect(400);
    await post(app, "noexiste", { label: "opus" }).expect(404);
    await post(app, "r1", { label: "gpt" }).expect(400);
    await post(app, "r1", {}).expect(400);
    await post(app, "r1", { label: 3 }).expect(400);
    await request(app).post("/api/runs/r1/label").set("Content-Type", "text/plain").send("opus").expect(400);
    expect(await store.readRun("r1")).toHaveLength(1);
  });

  it("rechaza peticiones de otro origen o con Host ajeno (CSRF y DNS rebinding)", async () => {
    const store = createStore({ runsDir: dir });
    await store.append("r1", start("r1"));
    const app = createApp({ store });
    await post(app, "r1", { label: "opus" }, { Origin: "https://malo.example" }).expect(403);
    await post(app, "r1", { label: "opus" }, { Origin: "http://127.0.0.1:1", Host: "127.0.0.1:2" }).expect(403);
    await post(app, "r1", { label: "opus" }, { Host: "malo.example:4317" }).expect(403);
    await post(app, "r1", { label: "opus" }, { Origin: "null" }).expect(403);
    expect(await store.readRun("r1")).toHaveLength(1);
    await post(app, "r1", { label: "opus" }, { Host: "127.0.0.1:4317", Origin: "http://127.0.0.1:4317" }).expect(200);
    await post(app, "r1", { label: "asistente" }, { Host: "localhost:4317", Origin: "http://localhost:4317" }).expect(200);
    await post(app, "r1", { label: "asistente" }, { Host: "localhost:4317" }).expect(200); // sin Origin (curl)
  });
});

describe("API /api/settings", () => {
  it("manda el umbral de aviso del contexto configurado", async () => {
    const res = await request(createApp({ store: createStore({ runsDir: "/nada" }), settings: { contextWarnTokens: 90_000 } })).get("/api/settings").expect(200);
    expect(res.body).toEqual({ contextWarnTokens: 90_000 });
  });
  it("sin configuración, 120000", async () => {
    const res = await request(createApp({ store: createStore({ runsDir: "/nada" }) })).get("/api/settings").expect(200);
    expect(res.body).toEqual({ contextWarnTokens: 120_000 });
  });
});
