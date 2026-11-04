import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createSessions } from "../src/core/sessions.mjs";
import { buildCoSettings } from "../src/core/install.mjs";
import {
  RELEVO_TOKENS_DEFAULT, contextState, contextFromStatusline, contextAdvice, runContext, RELEVO_HELP
} from "../src/core/compaction.mjs";
import { reduceRun } from "../src/core/reducer.mjs";
import { claudeProjectSlug, memoryIndexPath, relevoPath, relevoPrompt, relevoStartupContext, decideRelevo, withRelevoTag } from "../src/core/relevo.mjs";
import { buildOrchestratorPrompt } from "../src/core/prompt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Los dos orquestadores: co (perfil principal) y cop (segundo perfil).
const PROFILES = [
  { alias: "co", id: "trabajo", dir: ".claude" },
  { alias: "cop", id: "personal", dir: ".claude-personal" }
];

describe("config: ROUTER_RELEVO_TOKENS", () => {
  it.each(PROFILES)("$alias: por defecto 150000 y se puede cambiar", ({ dir, id, alias }) => {
    const env = { HOME: "/h", ROUTER_HOME: "/h/.agent-router", CLAUDE_CONFIG_DIR: `/h/${dir}`, ROUTER_PROFILE2_DIR: "/h/.claude-personal" };
    const load = (extra = {}) => loadConfig({ ...env, ...extra }, { exists: () => false, readFile: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }, warn: () => {} });
    expect(load()).toMatchObject({ relevoTokens: 150_000, profile: id, profileAlias: alias });
    expect(RELEVO_TOKENS_DEFAULT).toBe(150_000);
    expect(load({ ROUTER_RELEVO_TOKENS: "100000" }).relevoTokens).toBe(100_000);
    expect(load({ ROUTER_RELEVO_TOKENS: "basura" }).relevoTokens).toBe(150_000);
    expect(load({ ROUTER_RELEVO_TOKENS: "-5" }).relevoTokens).toBe(150_000);
  });
});

describe("relevo: reglas puras", () => {
  it("relevo en la raíz del cwd, igual para los dos perfiles", () => {
    expect(relevoPath({ cwd: "/p/app" })).toBe("/p/app/RELEVO.md");
  });

  it("slug de proyecto de Claude y ruta del índice de memoria", () => {
    expect(claudeProjectSlug("/Users/juano/1. Proyectos (local)/agent-router")).toBe("-Users-juano-1--Proyectos--local--agent-router");
    expect(memoryIndexPath({ claudeDir: "/h/.claude", cwd: "/p/app" })).toBe("/h/.claude/projects/-p-app/memory/MEMORY.md");
  });

  it("mensaje de relevo: umbral, ruta, secciones y /clear", () => {
    const m = relevoPrompt("/p/app/RELEVO.md", 150_000);
    expect(m).toContain("Relevo: contexto ≥150k.");
    expect(m).toContain("/p/app/RELEVO.md");
    for (const sec of ["Hecho", "No hecho", "Pendiente", "Decisiones", "Contexto mínimo"]) expect(m).toContain(sec);
    expect(m).toContain("/clear");
    expect(relevoPrompt("/r.md", 100_000)).toContain("≥100k");
  });

  it("decideRelevo: solo en el umbral, una vez y con datos", () => {
    const ok = { tokens: 150_000, threshold: 150_000, asked: false, path: "/r.md" };
    expect(decideRelevo(ok)).toBe(relevoPrompt("/r.md", 150_000));
    expect(decideRelevo({ ...ok, tokens: 149_999 })).toBeNull();
    expect(decideRelevo({ ...ok, tokens: 400_000 })).not.toBeNull();
    expect(decideRelevo({ ...ok, asked: true })).toBeNull();
    expect(decideRelevo({ ...ok, tokens: 0 })).toBeNull();
    expect(decideRelevo({ ...ok, tokens: undefined })).toBeNull();
  });

  it("contexto de arranque: relevo + memoria, instrucción de volcar y borrar, sin ninguno null", () => {
    const c = relevoStartupContext({ relevo: "# Relevo\n- hecho X", memory: "- [Nota](n.md)" });
    expect(c).toContain("# Relevo\n- hecho X");
    expect(c).toContain("- [Nota](n.md)");
    expect(c).toMatch(/vuelca un resumen del relevo a la memoria/i);
    expect(c).toMatch(/hecho \/ no hecho \/ pendiente/);
    expect(c).toMatch(/Write\/Edit/);
    expect(c).toMatch(/no lo borra el hook/);
    const soloMemoria = relevoStartupContext({ relevo: null, memory: "M" });
    expect(soloMemoria).toContain("M");
    expect(soloMemoria).not.toMatch(/relevo de la sesión anterior/i);
    expect(relevoStartupContext({ relevo: " ", memory: null })).toBeNull();
  });

  it("etiqueta 'relevo' en la statusline al pasar el umbral, sin tocar el resto", () => {
    expect(withRelevoTag("co · 5 h 10 %", 150_000, 150_000)).toBe("co · 5 h 10 % · relevo");
    expect(withRelevoTag("co · 5 h 10 %\n", 200_000, 150_000)).toBe("co · 5 h 10 % · relevo\n");
    expect(withRelevoTag("co", 149_999, 150_000)).toBe("co");
    expect(withRelevoTag("co", null, 150_000)).toBe("co");
    expect(withRelevoTag("", 200_000, 150_000)).toBe("relevo");
  });
});

describe("relevo: avisos de compaction.mjs", () => {
  it("contextState marca relevo con el umbral del evento y no cambia el nivel de 80/90 %", () => {
    expect(contextState({ tokens: 149_999, model: "m", relevoAt: 150_000 }).relevo).toBe(false);
    expect(contextState({ tokens: 150_000, model: "m", relevoAt: 150_000 })).toMatchObject({ relevo: true, level: "ok" });
    expect(contextState({ tokens: 230_000, model: "claude-opus-5-5[1m]", relevoAt: 150_000, limit: 250_000 })).toMatchObject({ relevo: true, level: "critical" });
    expect(contextState({ tokens: 150_000, model: "m" }).relevo).toBe(false);
  });

  it("el evento de la statusline lleva el umbral y runContext lo usa (150k si falta)", () => {
    const input = { model: { id: "claude-opus-5-5[1m]" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 160_000 } } };
    expect(contextFromStatusline(input, 7, 120_000)).toMatchObject({ tokens: 160_000, relevoAt: 120_000 });
    expect(contextFromStatusline(input, 7)).not.toHaveProperty("relevoAt");
    const run = reduceRun(reduceRun(null, { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 }), contextFromStatusline(input, 7, 120_000));
    expect(runContext(run)).toMatchObject({ relevo: true });
    expect(runContext({ context: { tokens: 140_000, model: "m", window: 1_000_000 } }).relevo).toBe(false);
    expect(runContext({ context: { tokens: 150_000, model: "m", window: 1_000_000 } }).relevo).toBe(true);
  });

  it("un evento por turno del transcript (sin umbral) conserva el relevoAt de la statusline", () => {
    let run = reduceRun(null, { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 });
    run = reduceRun(run, { type: "context", tokens: 100_000, model: "m", window: 1_000_000, relevoAt: 90_000, t: 2 });
    run = reduceRun(run, { type: "context", turn: 3, tokens: 120_000, model: "m", t: 3 });
    expect(run.context).toMatchObject({ tokens: 120_000, relevoAt: 90_000, turn: 3 });
    expect(runContext(run)).toMatchObject({ relevo: true });
  });

  it("contextAdvice: relevo en el umbral y se mantienen 80/90 %", () => {
    expect(contextAdvice(60, true, true)).toEqual({ level: "relevo", text: "relevo", relevo: true });
    expect(contextAdvice(60, false, true)).toEqual({ level: "relevo", text: "relevo", relevo: true });
    expect(contextAdvice(60, false, false)).toEqual({ level: "ok", text: null });
    expect(contextAdvice(80, true, true)).toEqual({ level: "warn", text: "compactar pronto", relevo: true });
    expect(contextAdvice(90, false, true)).toEqual({ level: "critical", text: "haz /clear", relevo: true });
    expect(contextAdvice(90, false)).toEqual({ level: "critical", text: "haz /clear" });
    expect(RELEVO_HELP).toMatch(/relevo/i);
  });
});

describe("relevo: instalación y prompt", () => {
  it("SessionStart corre tras compactar, al arrancar y tras /clear", () => {
    const s = buildCoSettings({ node: "/n", appRoot: "/r" });
    expect(s.hooks.SessionStart.map((h) => h.matcher).sort()).toEqual(["clear", "compact", "startup"]);
    for (const h of s.hooks.SessionStart) expect(h.hooks[0].command).toBe("\"/n\" \"/r/bin/router-hook.mjs\"");
  });

  it("la regla 7 manda el resumen a RELEVO.md en la raíz y no al chat", () => {
    const p = buildOrchestratorPrompt({ agents: {}, quota: null, now: 0 });
    expect(p).toContain("7. El resumen de lo hecho no va al chat: va a RELEVO.md en la raíz del proyecto");
    expect(p).toContain("/clear");
    expect(p).toContain("Al usuario, solo lo pendiente o las dudas, en el estilo de su CLAUDE.md (p. ej. caveman), también al relatar informes de subagentes.");
    expect(p).not.toMatch(/Cierra solo con lo pendiente/);
  });
});

// --- Procesos reales (hook y statusline) en los dos perfiles ---
let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "router-relevo-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function runBin(script, stdin, env = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env, ROUTER_HOME: join(home, ".agent-router"), HOME: home };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.ROUTER_RELEVO_TOKENS;
    const child = spawn(process.execPath, [join(ROOT, script)], { env: { ...base, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

describe.each(PROFILES)("hook de relevo en $alias", ({ id, dir }) => {
  const env = () => ({ CLAUDE_CONFIG_DIR: join(home, dir), ROUTER_PROFILE2_DIR: join(home, ".claude-personal") });
  const sid = "sess1234-relevo";
  const cwd = "/proyectos/app";
  const routerHome = () => join(home, ".agent-router");
  const saveCtx = (tokens) => createSessions({ dir: join(routerHome(), "sessions") }).saveContext(sid, { type: "context", tokens, model: "claude-opus-5-5[1m]", window: 1_000_000, t: 1 });
  const prompt = (extra = {}) => runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "sigue", session_id: sid, cwd, ...extra }, env());

  it("UserPromptSubmit inyecta el aviso una sola vez al pasar el umbral", async () => {
    await saveCtx(149_000);
    expect((await prompt()).out).toBe("");
    await saveCtx(151_000);
    const r = await prompt();
    const o = JSON.parse(r.out);
    expect(o.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(o.hookSpecificOutput.additionalContext).toBe(relevoPrompt(join(cwd, "RELEVO.md"), 150_000));
    expect((await prompt()).out).toBe("");
    await saveCtx(240_000);
    expect((await prompt()).out).toBe("");
  });

  it("respeta ROUTER_RELEVO_TOKENS y sin dato de contexto no avisa", async () => {
    expect((await prompt()).out).toBe("");
    await saveCtx(90_000);
    const r = await runBin("bin/router-hook.mjs", { hook_event_name: "UserPromptSubmit", prompt: "x", session_id: sid, cwd }, { ...env(), ROUTER_RELEVO_TOKENS: "80000" });
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toContain("≥80k");
  });

  // cwd temporal real con RELEVO.md y memoria falsa en <config>/projects/<slug>/memory/MEMORY.md.
  async function proyecto({ relevo, memoria }) {
    const proj = join(home, "proj", "mi app");
    await mkdir(proj, { recursive: true });
    if (relevo != null) await writeFile(join(proj, "RELEVO.md"), relevo);
    if (memoria != null) {
      const m = join(home, dir, "projects", claudeProjectSlug(proj), "memory");
      await mkdir(m, { recursive: true });
      await writeFile(join(m, "MEMORY.md"), memoria);
    }
    return proj;
  }
  const start = (source, cwd) => runBin("bin/router-hook.mjs", { hook_event_name: "SessionStart", source, session_id: `n-${source}`, cwd }, env());

  it.each(["clear", "startup"])("SessionStart %s inyecta RELEVO.md y MEMORY.md y no borra el relevo", async (source) => {
    const proj = await proyecto({ relevo: "# Relevo\nsiguiente paso: tests", memoria: "- [Memoria falsa](m.md)" });
    const r = await start(source, proj);
    const o = JSON.parse(r.out).hookSpecificOutput;
    expect(o.hookEventName).toBe("SessionStart");
    expect(o.additionalContext).toContain("siguiente paso: tests");
    expect(o.additionalContext).toContain("Memoria falsa");
    expect(o.additionalContext).toMatch(/no lo borra el hook/);
    expect(await readFile(join(proj, "RELEVO.md"), "utf8")).toContain("siguiente paso");
    expect(await readdir(proj)).toEqual(["RELEVO.md"]);
  });

  it.each(["clear", "startup"])("SessionStart %s sin RELEVO.md solo inyecta la memoria, y sin nada no escribe", async (source) => {
    const proj = await proyecto({ memoria: "- [Solo memoria](m.md)" });
    const o = JSON.parse((await start(source, proj)).out).hookSpecificOutput;
    expect(o.additionalContext).toContain("Solo memoria");
    expect(o.additionalContext).not.toMatch(/Relevo de la sesión anterior/);
    const vacio = join(home, "vacio");
    await mkdir(vacio, { recursive: true });
    expect((await start(source, vacio)).out).toBe("");
  });

  it("SessionStart 'resume' no inyecta nada", async () => {
    const proj = await proyecto({ relevo: "x", memoria: "y" });
    expect((await start("resume", proj)).out).toBe("");
  });

  it("la statusline marca 'relevo' al pasar el umbral y el evento lleva el umbral", async () => {
    const input = (tokens) => ({ session_id: sid, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: tokens } }, model: { id: "claude-opus-5-5[1m]" } });
    const sessions = createSessions({ dir: join(routerHome(), "sessions") });
    await sessions.save(sid, { runId: "r-1", lastRunId: "r-1", seq: 1 });
    const bajo = await runBin("bin/router-statusline.mjs", input(100_000), env());
    expect(bajo.out).not.toMatch(/relevo/);
    const alto = await runBin("bin/router-statusline.mjs", input(160_000), env());
    expect(alto.out).toMatch(/ · relevo$/);
    expect(alto.out.startsWith(id === "trabajo" ? "co" : "cop")).toBe(true);
    expect((await sessions.loadContext(sid)).relevoAt).toBe(150_000);
  });
});
