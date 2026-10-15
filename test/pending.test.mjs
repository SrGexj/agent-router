import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPending, formatPending, sanitizeTask } from "../src/core/pending.mjs";
import { reduceEvents, reduceRun } from "../src/core/reducer.mjs";
import { parseJsonl } from "../src/core/store.mjs";
import { createSessions } from "../src/core/sessions.mjs";
import { loadConfig } from "../src/config.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T = 1_792_000_000_000;

const run = (over = {}) => ({ id: "r1", task: "Haz X", status: "running", tasks: {}, taskOrder: [], waiting: null, ...over });
const line = (content, extra = {}) => JSON.stringify({ type: "assistant", message: { role: "assistant", content }, ...extra });
const tool = (name, input) => [{ type: "tool_use", id: "tu", name, input }];

describe("sanitizeTask", () => {
  it("sustituye los bloques pegados y recorta", () => {
    const t = sanitizeTask('mira esto <pasted_content id="1">\nmucho\ntexto</pasted_content> y arréglalo');
    expect(t).toBe("mira esto [texto pegado] y arréglalo");
    const largo = sanitizeTask("a".repeat(2000));
    expect(largo.length).toBeLessThanOrEqual(600);
    expect(largo.endsWith("…")).toBe(true);
  });
});

describe("collectPending", () => {
  it("la tarea de la ejecución abierta, solo si sigue en curso", () => {
    expect(collectPending({ run: run(), transcriptTail: "", now: T })).toEqual([{ type: "tarea", text: "Haz X" }]);
    expect(collectPending({ run: run({ status: "completed" }), transcriptTail: "", now: T })).toEqual([]);
  });

  it("encargos en curso o fallidos; los completados no", () => {
    const tasks = {
      a: { agent: "programador", description: "Login", status: "running" },
      b: { agent: "asistente", description: "Tests", status: "failed", summary: "no compila" },
      c: { agent: "asistente", description: "Hecho", status: "completed" }
    };
    const l = collectPending({ run: run({ status: "completed", tasks, taskOrder: ["a", "b", "c"] }), transcriptTail: "", now: T });
    expect(l).toEqual([
      { type: "encargo", text: "programador: Login (en curso)" },
      { type: "encargo", text: "asistente: Tests (falló: no compila)" }
    ]);
  });

  it("pregunta abierta", () => {
    const l = collectPending({ run: run({ status: "completed", waiting: { kind: "question", text: "¿BD?" } }), transcriptTail: "", now: T });
    expect(l).toEqual([{ type: "pregunta", text: "¿BD?" }]);
  });

  it("último TodoWrite del transcript, sin completados", () => {
    const tail = [
      line(tool("TodoWrite", { todos: [{ content: "viejo", status: "pending" }] })),
      line(tool("TodoWrite", { todos: [{ content: "uno", status: "completed" }, { content: "dos", status: "in_progress", activeForm: "Haciendo dos" }, { content: "tres", status: "pending" }] }))
    ].join("\n");
    const l = collectPending({ run: null, transcriptTail: tail, now: T });
    expect(l).toEqual([{ type: "todo", text: "dos (en curso)" }, { type: "todo", text: "tres" }]);
  });

  it("TaskCreate/TaskUpdate: ítems no completados", () => {
    const tail = [
      line(tool("TaskCreate", { subject: "A" })), line(tool("TaskCreate", { subject: "B" })),
      line(tool("TaskUpdate", { taskId: "1", status: "completed" }))
    ].join("\n");
    expect(collectPending({ run: null, transcriptTail: tail, now: T })).toEqual([{ type: "todo", text: "B" }]);
  });

  it("tolera formas desconocidas, líneas rotas y cortadas", () => {
    const tail = [
      'cortada a medias {"type":',
      line(tool("TodoWrite", { todos: "raro" })),
      line(tool("TodoWrite", { todos: [null, 3, { status: "pending" }, { content: "ok" }, { content: "x", status: "cancelled" }] })),
      line("texto suelto"), line(null), "{}", "[]"
    ].join("\n");
    expect(collectPending({ run: null, transcriptTail: tail, now: T })).toEqual([{ type: "todo", text: "ok" }]);
  });

  it("sin nada: lista vacía; sin run ni transcript también", () => {
    expect(collectPending({ run: null, transcriptTail: "", now: T })).toEqual([]);
    expect(collectPending({ run: null, transcriptTail: undefined, now: T })).toEqual([]);
  });

  it("ignora los TodoWrite de subagentes", () => {
    const tail = line(tool("TodoWrite", { todos: [{ content: "ajeno", status: "pending" }] }), { isSidechain: true });
    expect(collectPending({ run: null, transcriptTail: tail, now: T })).toEqual([]);
  });
});

describe("formatPending", () => {
  it("lista vacía → null", () => { expect(formatPending([], { runId: "r1", t: T })).toBeNull(); });

  it("markdown corto con título y ejecución", () => {
    const md = formatPending([{ type: "tarea", text: "Haz X" }, { type: "todo", text: "dos" }], { runId: "r1", t: T });
    expect(md).toContain("# Pendientes guardados antes de compactar");
    expect(md).toContain("r1");
    expect(md).toContain("- Tarea abierta: Haz X");
    expect(md).toContain("- Lista de tareas: dos");
  });

  it("recorta por el final con '…y N más'", () => {
    const list = Array.from({ length: 200 }, (_, i) => ({ type: "todo", text: `elemento número ${i} `.repeat(3) }));
    const md = formatPending(list, { runId: "r1", t: T });
    expect(md.length).toBeLessThanOrEqual(2500);
    expect(md).toMatch(/…y \d+ más$/);
    expect(md).toContain("elemento número 0");
  });
});

describe("reducer: compact", () => {
  it("acumula las compactaciones", () => {
    const r = reduceEvents([
      { type: "run_start", runId: "r1", task: "x", mode: "sesion", model: "opus", t: T },
      { type: "compact", trigger: "auto", pendingCount: 2, t: T + 1 },
      { type: "compact", trigger: "manual", pendingCount: 0, t: T + 2 }
    ]);
    expect(r.compactions).toEqual([{ trigger: "auto", pendingCount: 2, t: T + 1 }, { trigger: "manual", pendingCount: 0, t: T + 2 }]);
    expect(reduceRun(null, { type: "compact" })).toBeNull();
  });
});

describe("config.pendingDir", () => {
  it("cuelga de home", () => { expect(loadConfig({ ROUTER_HOME: "/h", HOME: "/u" }).pendingDir).toBe("/h/pendientes"); });
});

describe("hook: PreCompact y SessionStart(compact)", () => {
  let home;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "router-pend-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const runHook = (payload) => new Promise((resolve) => {
    const env = { ...process.env, ROUTER_HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    const child = spawn(process.execPath, [join(ROOT, "bin/router-hook.mjs")], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });

  it("recorrido completo: guarda, inyecta una sola vez y limpia", async () => {
    const sid = "sess-compact-1";
    const main = join(home, "main.jsonl");
    await writeFile(main, line(tool("TodoWrite", { todos: [{ content: "Migrar tabla", status: "in_progress" }, { content: "Hecho ya", status: "completed" }] })) + "\n");
    await runHook({ hook_event_name: "UserPromptSubmit", prompt: "Refactoriza el login", session_id: sid, transcript_path: main });

    const pre = await runHook({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, session_id: sid, transcript_path: main });
    expect(pre).toEqual({ code: 0, out: "" });
    const md = await readFile(join(home, "pendientes", `${sid}.md`), "utf8");
    expect(md).toContain("Refactoriza el login");
    expect(md).toContain("Migrar tabla");
    expect(md).not.toContain("Hecho ya");
    const files = await readdir(join(home, "runs"));
    const r = reduceEvents(parseJsonl(await readFile(join(home, "runs", files[0]), "utf8")));
    expect(r.compactions).toMatchObject([{ trigger: "auto", pendingCount: 2 }]);

    const start = await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: sid, transcript_path: main });
    expect(start.code).toBe(0);
    const ctx = JSON.parse(start.out).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("SessionStart");
    expect(ctx.additionalContext).toContain("Antes de compactar quedaban estos pendientes; revísalos y retómalos si siguen vigentes:");
    expect(ctx.additionalContext).toContain("Migrar tabla");
    const after = await readdir(join(home, "pendientes"));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(new RegExp(`^${sid}\\.\\d{4}-\\d{2}-\\d{2}\\.usado\\.md$`));

    expect(await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: sid })).toEqual({ code: 0, out: "" });
  });

  it("SessionStart(compact) anota el límite de compactación del transcript (una vez por límite)", async () => {
    const sid = "sess-compact-5";
    const main = join(home, "main5.jsonl");
    const bnd = (uuid, trigger) => JSON.stringify({ type: "system", subtype: "compact_boundary", uuid, timestamp: "2026-10-01T10:00:00.000Z", isSidechain: false, compactMetadata: { trigger, preTokens: 900000, postTokens: 20000, durationMs: 9000 } });
    const sum = JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "r".repeat(3000) } });
    const asst = JSON.stringify({ type: "assistant", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } } });
    await writeFile(main, [asst, bnd("viejo", "auto"), sum, asst, bnd("b9", "manual"), sum].join("\n") + "\n");
    await runHook({ hook_event_name: "UserPromptSubmit", prompt: "Haz algo", session_id: sid, transcript_path: main });
    await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: sid, transcript_path: main });
    await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: sid, transcript_path: main });
    const files = await readdir(join(home, "runs"));
    const r = reduceEvents(parseJsonl(await readFile(join(home, "runs", files[0]), "utf8")));
    expect(r.compactStats).toMatchObject([{ id: "b9", trigger: "manual", preTokens: 900000, summaryChars: 3000, model: "claude-opus-5-5" }]);
  });

  it("otro source no devuelve nada ni toca el archivo; sin pendientes no escribe", async () => {
    const sid = "sess-compact-2";
    await mkdir(join(home, "pendientes"), { recursive: true });
    await writeFile(join(home, "pendientes", `${sid}.md`), "algo");
    expect(await runHook({ hook_event_name: "SessionStart", source: "startup", session_id: sid })).toEqual({ code: 0, out: "" });
    expect(await readdir(join(home, "pendientes"))).toEqual([`${sid}.md`]);
    await runHook({ hook_event_name: "PreCompact", trigger: "manual", session_id: "sess-vacia" });
    expect(await readdir(join(home, "pendientes"))).toEqual([`${sid}.md`]);
  });

  it("borra los .usado.md de más de 7 días", async () => {
    const sid = "sess-compact-3";
    const dir = join(home, "pendientes");
    await mkdir(dir, { recursive: true });
    const viejo = join(dir, "otra.2020-01-01.usado.md");
    await writeFile(viejo, "x");
    const hace8 = new Date(Date.now() - 8 * 86400_000);
    await utimes(viejo, hace8, hace8);
    await writeFile(join(dir, `${sid}.md`), "- algo");
    await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: sid });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(".usado.md");
    expect(files[0]).not.toContain("otra");
  });

  it("una sesión sin ejecución ni transcript no rompe nada (lee lastRunId)", async () => {
    const sid = "sess-compact-4";
    await createSessions({ dir: join(home, "sessions") }).save(sid, { runId: null, lastRunId: "no-existe", seq: 1 });
    expect(await runHook({ hook_event_name: "PreCompact", trigger: "manual", session_id: sid })).toEqual({ code: 0, out: "" });
  });
});
