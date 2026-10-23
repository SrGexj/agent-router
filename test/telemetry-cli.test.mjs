import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir, readFile, writeFile, chmod, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTelemetryArgs, isTelemetryCommand, USAGE } from "../src/core/cli.mjs";
import { launchTelemetryFlush } from "../src/core/telemetry-flush.mjs";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { createSessions } from "../src/core/sessions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "tok-placeholder-0123456789";
let home;
let server;
let received;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "router-tele-cli-"));
  received = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { received.push({ auth: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"accepted":1,"stale":0}'); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
// El hijo `telemetry flush` va desacoplado (detached, sin handle): sigue escribiendo (sent.json, lock) tras responder el servidor.
// Su lock existe mientras trabaja, así que se espera a que desaparezca antes de borrar el directorio temporal.
const waitFlushIdle = async () => {
  const lock = join(home, ".agent-router", "telemetry.lock");
  for (let i = 0; i < 200; i++) {
    if (!(await stat(lock).then(() => true, () => false))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
afterEach(async () => {
  await new Promise((r) => server.close(r));
  await waitFlushIdle();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const baseEnv = (extra = {}) => {
  const env = { ...process.env, HOME: home, ROUTER_HOME: join(home, ".agent-router"), ...extra };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ROUTER_TELEMETRY_URL;
  delete env.ROUTER_TELEMETRY_TOKEN;
  return { ...env, ...extra };
};
const on = () => ({ ROUTER_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}`, ROUTER_TELEMETRY_TOKEN: TOKEN });

function run(script, args, { env = {}, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { env: baseEnv(env) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(stdin ?? "");
  });
}

describe("parseo", () => {
  it("reconoce el subcomando y sus acciones", () => {
    expect(isTelemetryCommand("telemetry")).toBe(true);
    expect(isTelemetryCommand("cuota")).toBe(false);
    expect(parseTelemetryArgs(["telemetry", "flush"])).toEqual({ action: "flush" });
    expect(parseTelemetryArgs(["telemetry", "status"])).toEqual({ action: "status" });
  });
  it("rechaza acciones o argumentos desconocidos", () => {
    expect(() => parseTelemetryArgs(["telemetry"])).toThrow(/flush|status/);
    expect(() => parseTelemetryArgs(["telemetry", "enviar"])).toThrow(/enviar/);
    expect(() => parseTelemetryArgs(["telemetry", "flush", "--x"])).toThrow(/--x/);
  });
  it("--help documenta los dos comandos", () => {
    expect(USAGE).toContain("router telemetry flush");
    expect(USAGE).toContain("router telemetry status");
  });
});

describe("router telemetry (proceso real)", () => {
  it("status desactivado lo dice, sale 0 y no crea archivos", async () => {
    const r = await run("bin/router.mjs", ["telemetry", "status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/desactivada/i);
    await expect(readdir(join(home, ".agent-router"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("flush desactivado sale 0 sin red ni archivos", async () => {
    const r = await run("bin/router.mjs", ["telemetry", "flush"]);
    expect(r.code).toBe(0);
    await expect(readdir(join(home, ".agent-router"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("flush y status activados: envía, informa y nunca imprime el token", async () => {
    const config = loadConfig({ HOME: home, ROUTER_HOME: join(home, ".agent-router") }, { exists: () => false, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, warn: () => {} });
    const store = createStore({ runsDir: config.runsDir });
    const now = Date.now();
    await store.append("r1", { type: "run_start", runId: "r1", task: "SENTINELA", mode: "sesion", model: "opus", cwd: "/Users/x", profile: "trabajo", t: now - 2000 });
    await store.append("r1", { type: "run_end", exitCode: 0, status: "completed", t: now - 1000 });
    const before = await run("bin/router.mjs", ["telemetry", "status"], { env: on() });
    expect(before.out).toMatch(/pendientes: 1/);
    const f = await run("bin/router.mjs", ["telemetry", "flush"], { env: on() });
    expect(f.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(received[0].body.runs[0].runId).toBe("r1");
    const after = await run("bin/router.mjs", ["telemetry", "status"], { env: on() });
    expect(after.out).toMatch(/pendientes: 0/);
    for (const r of [before, f, after]) { expect(r.out).not.toContain(TOKEN); expect(r.err).not.toContain(TOKEN); }
  });
});

describe("lanzamiento desacoplado", () => {
  const cfg = (extra) => loadConfig({ HOME: home, ROUTER_HOME: home, ...extra }, { exists: () => false, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, warn: () => {} });

  it("activada: spawn detached con unref ejecutando telemetry flush", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    const ok = launchTelemetryFlush({ config: cfg(on()), script: "/x/router.mjs", spawn, execPath: "/node" });
    expect(ok).toBe(true);
    expect(spawn).toHaveBeenCalledWith("/node", ["/x/router.mjs", "telemetry", "flush"], { detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("desactivada: no lanza nada", () => {
    const spawn = vi.fn();
    expect(launchTelemetryFlush({ config: cfg(), script: "/x", spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("si spawn lanza, se traga el error", () => {
    const spawn = vi.fn(() => { throw new Error("EAGAIN"); });
    expect(() => launchTelemetryFlush({ config: cfg(on()), script: "/x", spawn })).not.toThrow();
  });
});

describe.each([["trabajo", ".claude"], ["personal", ".claude-personal"]])("el hook de %s dispara el flush al cerrar", (id, dir) => {
  const env = () => ({ CLAUDE_CONFIG_DIR: join(home, dir), ROUTER_PROFILE2_DIR: join(home, ".claude-personal") });
  const send = (p, extra = {}) => run("bin/router-hook.mjs", [], { env: { ...env(), ...extra }, stdin: JSON.stringify({ session_id: "sess1234-tele", cwd: "/p", ...p }) });
  const waitReceived = async () => { for (let i = 0; i < 100 && !received.length; i++) await new Promise((r) => setTimeout(r, 50)); };

  it("tras un run_end el hijo envía el run con el perfil del hook; antes de cerrar no envía", async () => {
    await send({ hook_event_name: "UserPromptSubmit", prompt: "SENTINELA tarea" }, on());
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
    const r = await send({ hook_event_name: "SessionEnd" }, on());
    expect(r.code).toBe(0);
    await waitReceived();
    expect(received).toHaveLength(1);
    expect(received[0].body.runs[0].profile).toBe(id);
    expect(JSON.stringify(received)).not.toMatch(/SENTINELA|\/p\b/);
  }, 15_000);

  it("sin telemetría configurada no lanza ni escribe nada de telemetría", async () => {
    await send({ hook_event_name: "UserPromptSubmit", prompt: "hola" });
    await send({ hook_event_name: "SessionEnd" });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
    expect((await readdir(join(home, ".agent-router"))).filter((f) => f.startsWith("telemetry"))).toEqual([]);
  });

  it("con el servicio caído el hook sale 0 igualmente", async () => {
    await send({ hook_event_name: "UserPromptSubmit", prompt: "x" }, { ROUTER_TELEMETRY_URL: "http://127.0.0.1:1", ROUTER_TELEMETRY_TOKEN: TOKEN });
    const r = await send({ hook_event_name: "SessionEnd" }, { ROUTER_TELEMETRY_URL: "http://127.0.0.1:1", ROUTER_TELEMETRY_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});

describe.each([["trabajo", ".claude"], ["personal", ".claude-personal"]])("otros cierres de %s también disparan el flush", (id, dir) => {
  const env = () => ({ CLAUDE_CONFIG_DIR: join(home, dir), ROUTER_PROFILE2_DIR: join(home, ".claude-personal") });
  const waitReceived = async () => { for (let i = 0; i < 100 && !received.length; i++) await new Promise((r) => setTimeout(r, 50)); };

  it("cierre por Esc de la statusline", async () => {
    const transcript = join(home, "t.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", text: "SENTINELA" }) + "\n");
    const ar = join(home, ".agent-router");
    const store = createStore({ runsDir: join(ar, "runs") });
    await store.append("r-esc", { type: "run_start", runId: "r-esc", task: "SENTINELA", mode: "sesion", model: "opus", cwd: "/p", profile: id, t: Date.now() - 1000 });
    const { size } = await import("node:fs").then((fs) => fs.statSync(transcript));
    await createSessions({ dir: join(ar, "sessions") }).save("sess1234-esc", { runId: "r-esc", lastRunId: "r-esc", seq: 1, transcriptOffset: size });
    await writeFile(transcript, JSON.stringify({ type: "user", text: "SENTINELA" }) + "\n" + JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    await run("bin/router-statusline.mjs", [], { env: { ...env(), ...on() }, stdin: JSON.stringify({ session_id: "sess1234-esc", transcript_path: transcript }) });
    await waitReceived();
    expect(received).toHaveLength(1);
    expect(received[0].body.runs[0]).toMatchObject({ runId: "r-esc", profile: id, status: "cancelled" });
  }, 15_000);

  it("run headless de bin/router.mjs", async () => {
    const bin = join(home, "claude-falso.sh");
    await writeFile(bin, "#!/bin/sh\ncat > /dev/null\nexit 0\n");
    await chmod(bin, 0o755);
    await mkdir(join(home, dir), { recursive: true });
    const r = await run("bin/router.mjs", ["--model", "haiku", "SENTINELA tarea"], { env: { ...env(), ...on(), CLAUDE_BIN: bin } });
    expect(r.code).toBe(0);
    await waitReceived();
    expect(received).toHaveLength(1);
    expect(received[0].body.runs[0]).toMatchObject({ profile: id, mode: "directo", status: "completed", exitCode: 0 });
    expect(JSON.stringify(received)).not.toContain("SENTINELA");
  }, 15_000);
});

describe("el hook no hace fetch de telemetría", () => {
  it("bin/router-hook.mjs solo importa el lanzador, no el envío", async () => {
    const src = await readFile(join(ROOT, "bin/router-hook.mjs"), "utf8");
    expect(src).toContain("launchTelemetryFlush");
    expect(src).not.toContain("flushTelemetry");
  });
});
