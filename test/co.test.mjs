import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessions } from "../src/core/sessions.mjs";
import { buildCoSettings, coFunction, withZshBlock, withoutZshBlock, launchAgentPlist, layaLaunchAgentPlist, layaInstallPlan, layaServiceSpec, planStatuslineChain, serverServiceSpec, pickPython, parsePythonVersion, LAYA_VERSION, ZSH_START } from "../src/core/install.mjs";
import { systemdUnit } from "../src/core/platform/linux.mjs";
import { loadConfig } from "../src/config.mjs";
import { parseCliArgs } from "../src/core/cli.mjs";
import { parseJsonl } from "../src/core/store.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "router-co-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

// Entorno limpio: un CLAUDE_CONFIG_DIR heredado de la shell cambiaría el perfil que ven los procesos hijos.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
};

function runBin(script, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script)], { env: { ...cleanEnv(), ROUTER_HOME: home, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
  });
}

describe("sesiones", () => {
  it("guarda y recupera el estado de cada sesión, con valor por defecto", async () => {
    const s = createSessions({ dir: join(home, "sessions") });
    expect(await s.load("abc")).toEqual({ runId: null, seq: 0 });
    await s.save("abc", { runId: "r1", lastRunId: "r1", seq: 1 });
    expect(await s.load("abc")).toEqual({ runId: "r1", lastRunId: "r1", seq: 1 });
    await expect(s.load("../x")).rejects.toThrow(/sesión/);
  });

  it("la cuota se guarda aparte para no pisarse con el estado de la ejecución", async () => {
    const s = createSessions({ dir: join(home, "sessions") });
    await s.save("abc", { runId: "r1", seq: 1 });
    await s.saveQuota("abc", { fiveHour: { utilization: 0.4 } });
    expect(await s.load("abc")).toEqual({ runId: "r1", seq: 1 });
    expect(await s.loadQuota("abc")).toEqual({ fiveHour: { utilization: 0.4 } });
  });
});

describe("bin/router-hook.mjs", () => {
  it("convierte una secuencia de hooks en una ejecución completa", async () => {
    const sid = "0301590a-5672-4066-b233-de9ef7232761";
    const hooks = [
      { hook_event_name: "UserPromptSubmit", prompt: "Crea hola.txt", session_id: sid, cwd: "/p" },
      { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tu", tool_input: { subagent_type: "asistente", description: "Crear archivo", prompt: "x" }, session_id: sid },
      { hook_event_name: "SubagentStart", agent_id: "ag", agent_type: "asistente", session_id: sid },
      { hook_event_name: "SubagentStop", agent_id: "ag", agent_type: "asistente", last_assistant_message: "OK", session_id: sid },
      { hook_event_name: "Stop", background_tasks: [], session_id: sid }
    ];
    for (const h of hooks) {
      const r = await runBin("bin/router-hook.mjs", h);
      expect(r).toMatchObject({ code: 0, out: "" });
    }
    const files = await readdir(join(home, "runs"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}Z-0301590a-1\.jsonl$/);
    const run = reduceEvents(parseJsonl(await readFile(join(home, "runs", files[0]), "utf8")));
    expect(run).toMatchObject({ task: "Crea hola.txt", mode: "sesion", status: "completed" });
    expect(Object.values(run.tasks)[0]).toMatchObject({ description: "Crear archivo", node: "asistente", status: "completed" });
  });

  it("nunca bloquea a Claude: con entrada rota sale con 0 y lo anota", async () => {
    const r = await runBin("bin/router-hook.mjs", "{roto");
    expect(r.code).toBe(0);
    expect(await readFile(join(home, "hook-errors.log"), "utf8")).toMatch(/JSON/);
  });
});

describe("bin/router-statusline.mjs", () => {
  const input = (pct) => ({ session_id: "sess1234-x", rate_limits: { five_hour: { used_percentage: pct, resets_at: 1_792_003_600 } } });

  it("pasa la entrada a tu statusline original y muestra su salida", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "statusline-next"), "cat > /dev/null; printf 'mi statusline'");
    const r = await runBin("bin/router-statusline.mjs", input(10));
    expect(r).toMatchObject({ code: 0, out: "mi statusline" });
  });

  it("guarda la cuota en la ejecución de la sesión solo cuando cambia", async () => {
    const s = createSessions({ dir: join(home, "sessions") });
    await s.save("sess1234-x", { runId: "r-co-1", lastRunId: "r-co-1", seq: 1 });
    await runBin("bin/router-statusline.mjs", input(40));
    await runBin("bin/router-statusline.mjs", input(40.2));
    await runBin("bin/router-statusline.mjs", input(55));
    const events = parseJsonl(await readFile(join(home, "runs", "r-co-1.jsonl"), "utf8"));
    expect(events.map((e) => e.fiveHour.utilization)).toEqual([0.4, 0.55]);
  });

  it("guarda el contexto actual de la sesión solo cuando cambia", async () => {
    const s = createSessions({ dir: join(home, "sessions") });
    await s.save("sess1234-x", { runId: "r-co-4", lastRunId: "r-co-4", seq: 1 });
    const ctx = (cr) => ({ session_id: "sess1234-x", model: { id: "claude-opus-5-5[1m]" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 } } });
    await runBin("bin/router-statusline.mjs", ctx(100_000));
    await runBin("bin/router-statusline.mjs", ctx(100_500));
    await runBin("bin/router-statusline.mjs", ctx(300_000));
    const events = parseJsonl(await readFile(join(home, "runs", "r-co-4.jsonl"), "utf8"));
    expect(events.map((e) => [e.type, e.tokens, e.window])).toEqual([["context", 100_001, 1_000_000], ["context", 300_001, 1_000_000]]);
  });

  it("si se pulsó Esc desde que empezó la ejecución, la cierra como cancelada", async () => {
    const transcript = join(home, "t.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", text: "Arregla X" }) + "\n");
    const s = createSessions({ dir: join(home, "sessions") });
    const { size } = await import("node:fs").then((fs) => fs.statSync(transcript));
    await s.save("sess1234-x", { runId: "r-co-2", lastRunId: "r-co-2", seq: 2, transcriptOffset: size });
    // Antes del Esc: nada que cerrar.
    await runBin("bin/router-statusline.mjs", { session_id: "sess1234-x", transcript_path: transcript });
    expect((await s.load("sess1234-x")).runId).toBe("r-co-2");
    await writeFile(transcript, JSON.stringify({ type: "user", text: "Arregla X" }) + "\n" + JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    await runBin("bin/router-statusline.mjs", { session_id: "sess1234-x", transcript_path: transcript });
    expect((await s.load("sess1234-x")).runId).toBeNull();
    const events = parseJsonl(await readFile(join(home, "runs", "r-co-2.jsonl"), "utf8"));
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "cancelled" });
  });

  it("guarda la cuota con el perfil de CLAUDE_CONFIG_DIR", async () => {
    const s = createSessions({ dir: join(home, "sessions") });
    await s.save("sess1234-x", { runId: "r-co-3", lastRunId: "r-co-3", seq: 1 });
    await runBin("bin/router-statusline.mjs", input(20), { CLAUDE_CONFIG_DIR: join(home, ".claude-personal") });
    const events = parseJsonl(await readFile(join(home, "runs", "r-co-3.jsonl"), "utf8"));
    expect(events[0].profile).toBe("personal");
  });

  it("sin statusline original muestra una mínima con la cuota", async () => {
    const r = await runBin("bin/router-statusline.mjs", input(37));
    expect(r.out).toBe("co · 5 h 37 %");
  });
});

describe("router --prompt", () => {
  it("no exige tarea", () => {
    expect(parseCliArgs(["--prompt"])).toMatchObject({ printPrompt: true, task: "" });
  });

  it("imprime el prompt del orquestador con la última cuota", async () => {
    await mkdir(join(home, "runs"), { recursive: true });
    await writeFile(join(home, "runs", "20260101T000000Z-1-a.jsonl"), JSON.stringify({ type: "quota", fiveHour: { utilization: 0.8, resetsAt: 9_999_999_999 }, sevenDay: null, t: 1 }) + "\n");
    const r = await runBin("bin/router.mjs", "");
    expect(r.code).toBe(2); // sin argumentos falta la tarea
    const p = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, "bin/router.mjs"), "--prompt"], { env: { ...cleanEnv(), ROUTER_HOME: home } });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", () => resolve(out));
    });
    expect(p).toContain("Modo orquestador");
    expect(p).toContain("5 h: 80 %");
    expect(p).toContain("subagent_type: \"programador\"");
  });
});

describe("instalador", () => {
  const paths = { node: "/usr/local/bin/node", appRoot: "/repo", home: "/home/user/.agent-router" };

  it("los hooks de co apuntan al script de hooks y la statusline al envoltorio", () => {
    const s = buildCoSettings(paths);
    const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PermissionDenied", "SessionEnd", "Notification", "PreCompact", "SessionStart"];
    expect(Object.keys(s.hooks).sort()).toEqual([...events].sort());
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("\"/usr/local/bin/node\" \"/repo/bin/router-hook.mjs\"");
    expect(s.statusLine).toEqual({ type: "command", command: "\"/usr/local/bin/node\" \"/repo/bin/router-statusline.mjs\"", padding: 0, refreshInterval: 2 });
  });

  it("compacta antes en las sesiones co y SessionStart solo corre tras compactar", () => {
    const s = buildCoSettings(paths);
    expect(s.autoCompactWindow).toBe(250000);
    expect(s.hooks.SessionStart[0].matcher).toBe("compact");
    expect(s.hooks.PreCompact[0].matcher).toBe("");
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("\"/usr/local/bin/node\" \"/repo/bin/router-hook.mjs\"");
  });

  it("deja escribir a los subagentes en sus worktrees sin preguntar (solo en sesiones co)", () => {
    const allow = buildCoSettings(paths).permissions.allow;
    expect(allow).toEqual(["Edit(**/.claude/worktrees/**)"]);
    expect(allow.some((r) => r.startsWith("Write("))).toBe(false);
    expect(allow.every((r) => r.includes(".claude/worktrees/"))).toBe(true);
  });

  it("planStatuslineChain: respeta un statusline-next existente y informa de la encadenada", () => {
    expect(planStatuslineChain({ userCmd: "node /x/mia.js", existingNext: "sh /h/statusline-chain.sh\n" }))
      .toEqual({ write: false, chained: "sh /h/statusline-chain.sh" });
    expect(planStatuslineChain({ userCmd: "node /x/mia.js", existingNext: "" })).toEqual({ write: true, chained: "node /x/mia.js" });
    expect(planStatuslineChain({ userCmd: "node /x/mia.js", existingNext: "  \n" })).toEqual({ write: true, chained: "node /x/mia.js" });
    expect(planStatuslineChain({ userCmd: "node /x/mia.js", existingNext: null })).toEqual({ write: true, chained: "node /x/mia.js" });
    expect(planStatuslineChain({ userCmd: "node /r/bin/router-statusline.mjs", existingNext: null })).toEqual({ write: false, chained: null });
    expect(planStatuslineChain({ userCmd: undefined, existingNext: null })).toEqual({ write: false, chained: null });
    expect(planStatuslineChain({ userCmd: undefined, existingNext: "sh a.sh" })).toEqual({ write: false, chained: "sh a.sh" });
  });

  it("añade el alias co a .zshrc una sola vez y lo puede quitar", () => {
    const original = "export PATH=\"$HOME/bin:$PATH\"\n";
    const once = withZshBlock(original, "co() { echo co; }");
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain(ZSH_START);
    const twice = withZshBlock(once, "co() { echo nuevo; }");
    expect(twice.split(ZSH_START)).toHaveLength(2);
    expect(twice).toContain("echo nuevo");
    expect(withoutZshBlock(twice)).toBe(original);
  });

  it("co abre el dashboard solo si no hay otra sesión co en marcha", () => {
    const f = coFunction({ ...paths, port: 4317 });
    expect(f).toContain("pgrep -qf \"agent-router/co-settings.json\" || open \"http://127.0.0.1:4317\"");
    expect(f.indexOf("pgrep")).toBeLessThan(f.indexOf("command claude"));
  });

  it("cop es co con el segundo perfil (CLAUDE_CONFIG_DIR) y sus argumentos", () => {
    const f = coFunction({ ...paths, personalDir: "/home/user/.claude-personal", personalArgs: ["--channels", "plugin:telegram@claude-plugins-official"] });
    expect(f).toContain("cop() {");
    expect(f).toContain("export CLAUDE_CONFIG_DIR=\"/home/user/.claude-personal\"");
    expect(f).toContain('( export CLAUDE_CONFIG_DIR="/home/user/.claude-personal"; co "$@" --channels plugin:telegram@claude-plugins-official )');
    expect(coFunction(paths)).not.toContain("cop()");
  });

  it("sin argumentos extra, cop no añade nada (Telegram ya no va por defecto)", () => {
    const f = coFunction({ ...paths, personalDir: "/home/user/.claude-personal" });
    expect(f).toContain('( export CLAUDE_CONFIG_DIR="/home/user/.claude-personal"; co "$@" )');
    expect(f).not.toContain("telegram");
  });

  it("el alias del segundo perfil es configurable", () => {
    expect(coFunction({ ...paths, personalDir: "/d", alias: "coc" })).toContain("coc() {");
  });

  it("el LaunchAgent arranca el servidor con el node actual y lo mantiene vivo", () => {
    const plist = launchAgentPlist({ ...paths, label: "com.agent-router.server" });
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/repo/server/index.mjs</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/home/user/.agent-router/server.log");
  });

  it("el plist del servidor puede llevar variables extra (p. ej. la ruta absoluta de claude-monitor)", () => {
    const plist = launchAgentPlist({ ...paths, label: "com.agent-router.server", env: { ROUTER_MONITOR_BIN: "/home/user/Library/Python/3.12/bin/claude-monitor" } });
    expect(plist).toContain("<key>ROUTER_MONITOR_BIN</key><string>/home/user/Library/Python/3.12/bin/claude-monitor</string>");
    expect(plist).toContain("<key>ROUTER_HOME</key>");
  });
});

describe("especificación de servicios", () => {
  it("el servidor: node + server/index.mjs, ROUTER_HOME primero y log en home", () => {
    expect(serverServiceSpec({ label: "l", node: "/n", appRoot: "/r", home: "/h", env: { X: "1" } })).toEqual({ label: "l", argv: ["/n", "/r/server/index.mjs"], cwd: "/r", env: { ROUTER_HOME: "/h", X: "1" }, logFile: "/h/server.log" });
  });
  it("Laya: atada a host:puerto y con su log", () => {
    const s = layaServiceSpec({ label: "l", serveBin: "/v/bin/laya-serve", home: "/h", host: "127.0.0.1", port: 4318 });
    expect(s).toMatchObject({ argv: ["/v/bin/laya-serve"], logFile: "/h/laya.log" });
    expect(s.env).toMatchObject({ LAYA_HOST: "127.0.0.1", LAYA_PORT: "4318", HF_HOME: "/h/hf" });
    expect(s.env).not.toHaveProperty("LAYA_EXTRA_MODELS");
  });
  it("Laya: LAYA_EXTRA_MODELS desde la config, en el plist (darwin) y en la unidad (linux)", () => {
    const extraModels = { encargos: "/m/modelo" };
    const o = { label: "com.x.laya", serveBin: "/v/bin/laya-serve", home: "/h", host: "127.0.0.1", port: 4318, extraModels };
    const spec = layaServiceSpec(o);
    expect(spec.env.LAYA_EXTRA_MODELS).toBe(JSON.stringify(extraModels));
    expect(spec.env.LAYA_MODELS).toBe("multilingual");
    expect(layaLaunchAgentPlist(o)).toContain("LAYA_EXTRA_MODELS");
    expect(systemdUnit(spec)).toContain("LAYA_EXTRA_MODELS=");
  });
  it("config: layaExtraModels y layaRoutingModel", () => {
    const opts = { exists: () => false, readFile: () => { throw Object.assign(new Error(), { code: "ENOENT" }); } };
    const c = loadConfig({ HOME: "/h", ROUTER_LAYA_EXTRA_MODELS: '{"encargos":"/m"}', ROUTER_LAYA_ROUTING_MODEL: "encargos" }, opts);
    expect(c.layaExtraModels).toEqual({ encargos: "/m" });
    expect(c.layaRoutingModel).toBe("encargos");
    expect(() => loadConfig({ HOME: "/h", ROUTER_LAYA_EXTRA_MODELS: "[1]" }, opts)).toThrow(/ROUTER_LAYA_EXTRA_MODELS/);
  });
});

describe("python de Laya", () => {
  const probeWith = (table) => (cmd) => table[cmd] ?? null;
  it("lee la versión de `python --version`", () => {
    expect(parsePythonVersion("Python 3.12.4\n")).toEqual([3, 12]);
    expect(parsePythonVersion("")).toBeNull();
    expect(parsePythonVersion(null)).toBeNull();
  });
  it("prefiere python3.12 del PATH", () => {
    expect(pickPython({ probe: probeWith({ "python3.12": "Python 3.12.1", python3: "Python 3.13.0" }) })).toBe("python3.12");
  });
  it("si no hay python3.12, usa python3 solo si es ≥3.12", () => {
    expect(pickPython({ probe: probeWith({ python3: "Python 3.13.0" }) })).toBe("python3");
    expect(pickPython({ probe: probeWith({ python3: "Python 3.11.9" }) })).toBeNull();
    expect(pickPython({ probe: probeWith({}) })).toBeNull();
  });
  it("ROUTER_LAYA_PYTHON manda y no cae a otros si no vale", () => {
    expect(pickPython({ override: "/x/py", probe: probeWith({ "/x/py": "Python 3.14.0", python3: "Python 3.12.0" }) })).toBe("/x/py");
    expect(pickPython({ override: "/x/py", probe: probeWith({ "/x/py": "Python 3.10.0", python3: "Python 3.12.0" }) })).toBeNull();
  });
});

describe("instalador de Laya (piezas puras)", () => {
  const o = { label: "com.agent-router.laya", serveBin: "/home/user/.agent-router/laya-venv/bin/laya-serve", home: "/home/user/.agent-router", host: "127.0.0.1", port: 4318 };
  it("el plist arranca laya-serve atado a 127.0.0.1:4318 con el entorno fijado y lo mantiene vivo", () => {
    const plist = layaLaunchAgentPlist(o);
    expect(plist).toContain("<string>com.agent-router.laya</string>");
    expect(plist).toContain("<string>/home/user/.agent-router/laya-venv/bin/laya-serve</string>");
    for (const [k, v] of [["LAYA_HOST", "127.0.0.1"], ["LAYA_PORT", "4318"], ["LAYA_MODELS", "multilingual"], ["LAYA_DEFAULT_MODEL", "multilingual"], ["USE_TF", "0"], ["HF_HOME", "/home/user/.agent-router/hf"]]) {
      expect(plist).toContain(`<key>${k}</key><string>${v}</string>`);
    }
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("/home/user/.agent-router/laya.log");
    expect(plist).not.toContain("0.0.0.0");
  });
  it("el plan crea el venv con python3.12 si falta e instala la versión fijada", () => {
    const plan = layaInstallPlan({ python: "/opt/homebrew/bin/python3.12", venv: "/h/laya-venv", venvExists: false });
    expect(plan).toEqual([
      { cmd: "/opt/homebrew/bin/python3.12", args: ["-m", "venv", "/h/laya-venv"] },
      { cmd: "/h/laya-venv/bin/pip", args: ["install", "--quiet", `laya[serve]==${LAYA_VERSION}`] }
    ]);
    expect(LAYA_VERSION).toBe("0.4.7");
    expect(layaInstallPlan({ python: "p", venv: "/h/v", venvExists: true })).toHaveLength(1);
  });
});

describe("bin/router-hook.mjs: preguntas y coste", () => {
  const sid = "0301590a-5672-4066-b233-de9ef7232761";
  const asst = (id, model, input, output, extra = {}) => JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: output } }, ...extra }) + "\n";
  const events = async () => {
    const [f] = await readdir(join(home, "runs"));
    return parseJsonl(await readFile(join(home, "runs", f), "utf8"));
  };

  it("AskUserQuestion deja waiting y PostToolUse waiting_end en el JSONL", async () => {
    const q = { question: "¿BD?", header: "BD", multiSelect: false, options: [{ label: "MySQL", description: "d" }] };
    await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid });
    await runBin("bin/router-hook.mjs", { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [q] }, session_id: sid });
    let run = reduceEvents(await events());
    expect(run.waiting).toMatchObject({ kind: "question", text: "¿BD?" });
    await runBin("bin/router-hook.mjs", { hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_response: { answers: { "¿BD?": "MySQL" } }, session_id: sid });
    run = reduceEvents(await events());
    expect(run.waiting).toBeNull();
    expect(run.asked[0]).toMatchObject({ answer: "MySQL" });
  });

  it("SubagentStop lee el transcript del subagente y el cierre el del orquestador desde su offset", async () => {
    const dir = join(home, "tr");
    await mkdir(dir, { recursive: true });
    const main = join(dir, "main.jsonl");
    const agent = join(dir, "agent-a1.jsonl");
    await writeFile(main, asst("viejo", "claude-opus-5-5", 999, 999));
    await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid, transcript_path: main });
    await writeFile(main, asst("viejo", "claude-opus-5-5", 999, 999) + asst("m1", "claude-opus-5-5", 10, 5) + asst("m1", "claude-opus-5-5", 10, 6) + asst("s1", "claude-sonnet-5-5", 1, 1, { isSidechain: true }));
    await writeFile(agent, asst("a1", "claude-sonnet-5-5", 7, 3, { isSidechain: true }) + "{roto");
    await runBin("bin/router-hook.mjs", { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "programador", session_id: sid, transcript_path: main });
    await runBin("bin/router-hook.mjs", { hook_event_name: "SubagentStop", agent_id: "a1", agent_transcript_path: agent, last_assistant_message: "hecho", session_id: sid, transcript_path: main });
    await runBin("bin/router-hook.mjs", { hook_event_name: "Stop", background_tasks: [], session_id: sid, transcript_path: main });
    const run = reduceEvents(await events());
    expect(run.tasks.a1.usage["claude-sonnet-5-5"]).toMatchObject({ input: 7, output: 3 });
    expect(run.tasks.a1.result).toBe("hecho");
    expect(run.orchestratorUsage).toEqual({ "claude-opus-5-5": { input: 10, output: 6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    expect(run.status).toBe("completed");
  });

  it("gasto de subagente en vivo: un tool del subagente lee su transcript derivado y SubagentStop no duplica", async () => {
    const dir = join(home, "tr3");
    const sub = join(dir, "main", "subagents");
    await mkdir(sub, { recursive: true });
    const main = join(dir, "main.jsonl");
    await writeFile(main, asst("viejo", "claude-opus-5-5", 999, 999));
    await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid, transcript_path: main });
    await runBin("bin/router-hook.mjs", { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "programador", session_id: sid, transcript_path: main });
    const agent = join(sub, "agent-a1.jsonl");
    await writeFile(agent, asst("a1", "claude-sonnet-5-5", 7, 3, { isSidechain: true }));
    await runBin("bin/router-hook.mjs", { hook_event_name: "PostToolUse", agent_id: "a1", tool_name: "Read", session_id: sid, transcript_path: main });
    let run = reduceEvents(await events());
    expect(run.status).toBe("running");
    expect(run.tasks.a1.status).toBe("running");
    expect(run.tasks.a1.usage["claude-sonnet-5-5"]).toMatchObject({ input: 7, output: 3 });
    await appendFile(agent, asst("a2", "claude-sonnet-5-5", 2, 1, { isSidechain: true }));
    await runBin("bin/router-hook.mjs", { hook_event_name: "SubagentStop", agent_id: "a1", agent_transcript_path: agent, last_assistant_message: "ok", session_id: sid, transcript_path: main });
    run = reduceEvents(await events());
    expect(run.tasks.a1.usage["claude-sonnet-5-5"]).toMatchObject({ input: 9, output: 4 });
  });

  it("gasto en vivo: PostToolUse emite la instantánea acumulada, estrangulada a 20 s y leyendo solo lo nuevo", async () => {
    const dir = join(home, "tr2");
    await mkdir(dir, { recursive: true });
    const main = join(dir, "main.jsonl");
    const sessions = createSessions({ dir: join(home, "sessions") });
    await writeFile(main, asst("viejo", "claude-opus-5-5", 999, 999));
    await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid, transcript_path: main });
    const post = { hook_event_name: "PostToolUse", tool_name: "Bash", session_id: sid, transcript_path: main };
    const snaps = async () => reduceEvents(await events()).orchestratorUsage;
    expect(await snaps()).toBeNull();

    await appendFile(main, asst("m1", "claude-opus-5-5", 10, 1));
    await runBin("bin/router-hook.mjs", post);
    expect((await snaps())["claude-opus-5-5"]).toMatchObject({ input: 10, output: 1 });
    const st = await sessions.load(sid);
    expect(st.lastUsageAt).toBeGreaterThan(0);
    expect(st.usageState.offset).toBe(Buffer.byteLength(asst("viejo", "claude-opus-5-5", 999, 999) + asst("m1", "claude-opus-5-5", 10, 1)));

    // Dentro de los 20 s no hay evento nuevo aunque haya más transcript.
    await appendFile(main, asst("m1", "claude-opus-5-5", 10, 7));
    await runBin("bin/router-hook.mjs", post);
    expect((await snaps())["claude-opus-5-5"]).toMatchObject({ output: 1 });

    // Pasado el estrangulado, el mismo message.id partido entre dos lecturas: gana la última línea; no se suma dos veces.
    await sessions.save(sid, { ...(await sessions.load(sid)), lastUsageAt: Date.now() - 30_000 });
    await appendFile(main, asst("m2", "claude-haiku-5-5", 2, 2));
    await runBin("bin/router-hook.mjs", post);
    expect(await snaps()).toEqual({
      "claude-opus-5-5": { input: 10, output: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      "claude-haiku-5-5": { input: 2, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    });

    await runBin("bin/router-hook.mjs", { hook_event_name: "Stop", background_tasks: [], session_id: sid, transcript_path: main });
    const run = reduceEvents(await events());
    expect(run.status).toBe("completed");
    expect(run.orchestratorUsage["claude-opus-5-5"]).toMatchObject({ input: 10, output: 7 });
  });

  it("un transcript ilegible no hace fallar el hook ni quita el task_end", async () => {
    await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid });
    const r = await runBin("bin/router-hook.mjs", { hook_event_name: "SubagentStop", agent_id: "a1", agent_transcript_path: join(home, "no-existe.jsonl"), session_id: sid });
    expect(r.code).toBe(0);
    expect((await events()).map((e) => e.type)).toEqual(["run_start", "task_end"]);
  });
});
