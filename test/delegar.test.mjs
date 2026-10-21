import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectEdit, DIRECT_EDIT_WARNING, directEditsLine } from "../src/core/delegar.mjs";
import { translateHook } from "../src/core/hooks.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { parseJsonl } from "../src/core/store.mjs";
import { orchestratorSub } from "../dashboard/src/captions.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROFILES = [
  { alias: "co", id: "trabajo", dir: ".claude" },
  { alias: "cop", id: "personal", dir: ".claude-personal" }
];
const edit = (extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/p/app/src/a.js" }, ...extra });

describe("isDirectEdit", () => {
  it("Edit, Write, MultiEdit y NotebookEdit de la sesión principal", () => {
    for (const tool_name of ["Edit", "Write", "MultiEdit"]) expect(isDirectEdit(edit({ tool_name }))).toBe(true);
    expect(isDirectEdit({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: "/p/n.ipynb" } })).toBe(true);
  });
  it("no cuenta a los subagentes, otras herramientas ni otros eventos", () => {
    expect(isDirectEdit(edit({ agent_id: "ag1" }))).toBe(false);
    expect(isDirectEdit(edit({ tool_name: "Read" }))).toBe(false);
    expect(isDirectEdit(edit({ tool_name: "Bash", tool_input: { command: "ls" } }))).toBe(false);
    expect(isDirectEdit(edit({ hook_event_name: "PostToolUse" }))).toBe(false);
  });
  it("memory/ y relevo/ están exentas, en cualquier nivel de la ruta", () => {
    for (const file_path of ["/h/.claude/projects/x/memory/MEMORY.md", "/h/memory/a.md", "/h/.agent-router/relevo/trabajo/p.md", "C:\\u\\relevo\\personal\\p.md"]) {
      expect(isDirectEdit(edit({ tool_input: { file_path } }))).toBe(false);
    }
    // Solo cuentan carpetas completas, no nombres parecidos.
    for (const file_path of ["/p/memory.md", "/p/memory-notes/a.js", "/p/relevo.md", "/p/src/memoryless/a.js"]) {
      expect(isDirectEdit(edit({ tool_input: { file_path } }))).toBe(true);
    }
  });
  it("sin ruta conocida también cuenta", () => {
    expect(isDirectEdit(edit({ tool_input: {} }))).toBe(true);
    expect(isDirectEdit(edit({ tool_input: undefined }))).toBe(true);
  });
  it("el aviso es solo informativo", () => {
    expect(DIRECT_EDIT_WARNING).toBe("Aviso: el orquestador está editando directamente. Si el contenido ya está decidido, delega a asistente (texto, config, docs) o a programador (código).");
  });
});

describe("ediciones directas en el reducer y el dashboard", () => {
  const T = 1_792_000_000_000;
  const mk = (n) => (i) => `r-${n}-${i}`;
  const open = () => translateHook({ hook_event_name: "UserPromptSubmit", prompt: "x", session_id: "abcdef12", cwd: "/p" }, { runId: null, seq: 0 }, T, mk("a"));

  it("PreToolUse del orquestador emite direct_edit con el total de la sesión", () => {
    const s0 = open();
    const res = translateHook({ session_id: "abcdef12", ...edit() }, s0.session, T, mk("a"), { directEdits: 2 });
    expect(res.events.map((e) => e.type)).toEqual(["tool", "direct_edit"]);
    expect(res.events[1]).toMatchObject({ name: "Edit", n: 3 });
    const sub = translateHook({ session_id: "abcdef12", ...edit({ agent_id: "ag1" }) }, s0.session, T, mk("a"), { directEdits: 2 });
    expect(sub.events.map((e) => e.type)).toEqual(["tool"]);
    const mem = translateHook({ session_id: "abcdef12", ...edit({ tool_input: { file_path: "/x/memory/a.md" } }) }, s0.session, T, mk("a"), { directEdits: 2 });
    expect(mem.events.map((e) => e.type)).toEqual(["tool"]);
  });

  it("una ejecución nueva arranca con el total acumulado de la sesión", () => {
    expect(open().events[0]).not.toHaveProperty("directEdits");
    const r = translateHook({ hook_event_name: "UserPromptSubmit", prompt: "y", session_id: "abcdef12" }, { runId: null, seq: 1 }, T, mk("a"), { directEdits: 4 });
    expect(r.events[0].directEdits).toBe(4);
    expect(reduceEvents(r.events).directEdits).toBe(4);
    expect(reduceEvents(open().events).directEdits).toBe(0);
  });

  it("el reducer guarda el total y la línea del orquestador lo muestra solo si no es 0", () => {
    const s0 = open();
    const run = reduceEvents([...s0.events, { type: "direct_edit", name: "Edit", n: 3, t: T }]);
    expect(run.directEdits).toBe(3);
    expect(directEditsLine(run)).toBe("ediciones directas: 3");
    expect(directEditsLine(reduceEvents(s0.events))).toBeNull();
    expect(directEditsLine(null)).toBeNull();
    expect(orchestratorSub(run)).toBeNull(); // el contador va en su propia línea, no mezclado con el gasto
  });
});

let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "router-delegar-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function runBin(stdin, env) {
  return new Promise((resolve) => {
    const base = { ...process.env, ROUTER_HOME: join(home, ".agent-router"), HOME: home };
    delete base.CLAUDE_CONFIG_DIR;
    const child = spawn(process.execPath, [join(ROOT, "bin/router-hook.mjs")], { env: { ...base, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

describe.each(PROFILES)("aviso de delegar en $alias", ({ id, dir }) => {
  const env = () => ({ CLAUDE_CONFIG_DIR: join(home, dir), ROUTER_PROFILE2_DIR: join(home, ".claude-personal") });
  const sid = "sess9999-delegar";
  const send = (p) => runBin({ session_id: sid, cwd: "/p", ...p }, env());
  const runOf = async () => {
    const dirRuns = join(home, ".agent-router", "runs");
    const [f] = await readdir(dirRuns);
    return reduceEvents(parseJsonl(await readFile(join(dirRuns, f), "utf8")));
  };

  it("avisa sin bloquear, cuenta por sesión y no cuenta memory/relevo ni subagentes", async () => {
    await send({ hook_event_name: "UserPromptSubmit", prompt: "arregla" });
    const r1 = await send(edit());
    expect(r1.code).toBe(0);
    const o = JSON.parse(r1.out);
    expect(o).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: DIRECT_EDIT_WARNING } });
    expect(o.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(JSON.parse((await send(edit({ tool_name: "Write" }))).out).hookSpecificOutput.additionalContext).toBe(DIRECT_EDIT_WARNING);

    expect((await send(edit({ tool_input: { file_path: `/h/.claude/projects/p/memory/MEMORY.md` } }))).out).toBe("");
    expect((await send(edit({ tool_input: { file_path: `${home}/.agent-router/relevo/${id}/p.md` } }))).out).toBe("");
    expect((await send(edit({ agent_id: "ag1", agent_type: "programador" }))).out).toBe("");
    expect((await send({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/p/a" } })).out).toBe("");

    expect((await runOf()).directEdits).toBe(2);

    // Un mensaje nuevo abre otra ejecución que parte del total de la sesión.
    await send({ hook_event_name: "Stop", background_tasks: [] });
    await send({ hook_event_name: "UserPromptSubmit", prompt: "otra" });
    const files = (await readdir(join(home, ".agent-router", "runs"))).sort();
    const last = reduceEvents(parseJsonl(await readFile(join(home, ".agent-router", "runs", files.at(-1)), "utf8")));
    expect(last.task).toBe("otra");
    expect(last.directEdits).toBe(2);
    await send(edit());
    const last2 = reduceEvents(parseJsonl(await readFile(join(home, ".agent-router", "runs", files.at(-1)), "utf8")));
    expect(last2.directEdits).toBe(3);
  });
});
