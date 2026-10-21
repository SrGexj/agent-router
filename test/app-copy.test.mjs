// Copia estable: rutas y plan de instalación/actualización de <home>/app. Todo puro, sin tocar git ni disco.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncApp } from "../src/core/app-sync.mjs";
import { appPaths, appRootFor, planAppRemove, planAppSync, planLink } from "../src/core/app-copy.mjs";
import { buildCoSettings, serverServiceSpec } from "../src/core/install.mjs";
import { coFunction } from "../src/core/platform/shell.mjs";

const HOME = "/h/.agent-router";
const APP = "/h/.agent-router/app";
const sync = (o) => planAppSync({ appRoot: APP, repoRoot: "/dev/repo", appExists: true, appClean: true, appHead: "aaa", mainHead: "aaa", distExists: true, ...o });
const cmds = (plan) => plan.steps.map((s) => `${s.cmd} ${s.args.join(" ")}`);

describe("rutas de la copia estable", () => {
  it("la copia vive en <home>/app", () => {
    expect(appRootFor(HOME)).toBe(APP);
  });

  it("appPaths cuelga todo de appRoot, nunca del repo de desarrollo", () => {
    const p = appPaths(APP);
    expect(p).toEqual({ hook: `${APP}/bin/router-hook.mjs`, statusline: `${APP}/bin/router-statusline.mjs`, server: `${APP}/server/index.mjs`, router: `${APP}/bin/router.mjs`, agent: expect.any(Function) });
    expect(p.agent("programador")).toBe(`${APP}/src/agents/programador.md`);
  });
});

describe("planAppSync", () => {
  it("sin copia: crea el worktree desatado de main desde el repo, instala, construye y poda", () => {
    const plan = sync({ appExists: false, appHead: null, distExists: false });
    expect(plan.ok).toBe(true);
    expect(cmds(plan)).toEqual([
      "git -C /dev/repo worktree add --detach /h/.agent-router/app main",
      "npm ci --no-audit --no-fund",
      "npm run build",
      "npm prune --omit=dev --no-audit --no-fund"
    ]);
    expect(plan.steps.slice(1).every((s) => s.cwd === APP)).toBe(true);
  });

  it("copia limpia y atrasada: checkout --detach main y reconstruye", () => {
    const plan = sync({ appHead: "old", mainHead: "new" });
    expect(cmds(plan)).toEqual([`git -C ${APP} checkout --detach main`, "npm ci --no-audit --no-fund", "npm run build", "npm prune --omit=dev --no-audit --no-fund"]);
  });

  it("copia sucia: para y avisa, sin pasos", () => {
    const plan = sync({ appClean: false, appHead: "old", mainHead: "new" });
    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.reason).toContain(APP);
  });

  it("copia al día con dist: no hace nada", () => {
    const plan = sync({});
    expect(plan).toEqual({ ok: true, steps: [], changed: false });
  });

  it("al día pero sin dist: reconstruye sin mover el HEAD", () => {
    const plan = sync({ distExists: false });
    expect(cmds(plan)).toEqual(["npm ci --no-audit --no-fund", "npm run build", "npm prune --omit=dev --no-audit --no-fund"]);
  });
});

describe("planAppRemove", () => {
  const base = { appRoot: APP, repoRoot: "/dev/repo", appExists: true, appClean: true };
  it("limpia: git worktree remove, sin --force", () => {
    expect(cmds(planAppRemove(base))).toEqual([`git -C /dev/repo worktree remove ${APP}`]);
  });
  it("sucia: no la quita y avisa", () => {
    const p = planAppRemove({ ...base, appClean: false });
    expect(p.ok).toBe(false);
    expect(p.steps).toEqual([]);
  });
  it("no existe: nada que hacer", () => expect(planAppRemove({ ...base, appExists: false })).toEqual({ ok: true, steps: [] }));
});

describe("planLink", () => {
  const T = `${APP}/src/agents/a.md`;
  const OLD = "/dev/repo/src/agents/a.md";
  it("no existe: crea", () => expect(planLink({ current: null, target: T })).toBe("create"));
  it("ya apunta a la copia: nada", () => expect(planLink({ current: { symlink: true, target: T }, target: T })).toBe("keep"));
  it("apunta al repo antiguo: migra", () => expect(planLink({ current: { symlink: true, target: OLD }, target: T, legacyTargets: [OLD] })).toBe("replace"));
  it("ajeno: se omite o se respalda según pida el llamador", () => {
    expect(planLink({ current: { symlink: false }, target: T })).toBe("skip");
    expect(planLink({ current: { symlink: true, target: "/otro" }, target: T })).toBe("skip");
    expect(planLink({ current: { symlink: false }, target: T, backupForeign: true })).toBe("backup");
  });
});

describe("la copia estable en co y cop", () => {
  const spec = { node: "/n", appRoot: APP, home: HOME };

  it("co-settings no menciona el repo de desarrollo", () => {
    const text = JSON.stringify(buildCoSettings(spec));
    expect(text).toContain(`${APP}/bin/router-hook.mjs`);
    expect(text).toContain(`${APP}/bin/router-statusline.mjs`);
    expect(text).not.toContain("/dev/repo");
  });

  it("el servicio del server arranca desde la copia", () => {
    const s = serverServiceSpec({ label: "l", ...spec });
    expect(s.argv).toEqual(["/n", `${APP}/server/index.mjs`]);
    expect(s.cwd).toBe(APP);
  });

  it("co y cop usan el mismo co-settings y la misma copia", () => {
    const body = coFunction({ ...spec, personalDir: "/h/.claude-personal", alias: "cop" });
    expect(body).toContain("co() {");
    expect(body).toContain("cop() {");
    expect(body.match(new RegExp(`--settings "${HOME}/co-settings.json"`, "g"))).toHaveLength(1); // cop llama a co
    expect(body).toContain(`"${APP}/bin/router.mjs" --prompt`);
    expect(body).toMatch(/cop\(\) \{\n\s+\( export CLAUDE_CONFIG_DIR="\/h\/\.claude-personal"; co "\$@"/);
  });
});

describe("syncApp con git de verdad (npm doblado)", () => {
  const sh = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), "copia-"));
    const repo = join(base, "repo");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@t");
    sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1");
    writeFileSync(join(repo, ".gitignore"), "dashboard/dist/\nnode_modules/\n");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "uno");
    const npmCalls = [];
    const run = (cmd, args, cwd) => {
      if (cmd === "npm") { npmCalls.push(args[0]); if (args[0] === "run") { mkdirSync(join(cwd, "dashboard/dist"), { recursive: true }); writeFileSync(join(cwd, "dashboard/dist/index.html"), "x"); } return { status: 0, stdout: "", stderr: "" }; }
      return spawnSync(cmd, args, { encoding: "utf8" });
    };
    return { base, repo, app: join(base, "home/app"), run, npmCalls };
  };
  const opts = (t) => ({ appRoot: t.app, repoRoot: t.repo, run: t.run, exists: existsSync });

  it("crea el worktree desatado, sigue a main sin tocar la rama del repo y no pisa una copia sucia", () => {
    const t = setup();
    mkdirSync(join(t.base, "home"));
    expect(syncApp(opts(t))).toEqual({ ok: true, changed: true });
    expect(t.npmCalls).toEqual(["ci", "run", "prune"]);
    expect(sh(t.app, "rev-parse", "HEAD")).toBe(sh(t.repo, "rev-parse", "main"));
    expect(spawnSync("git", ["-C", t.app, "symbolic-ref", "-q", "HEAD"]).status).not.toBe(0); // detached

    // el repo de desarrollo cambia de rama y avanza: la copia no se entera hasta actualizar
    sh(t.repo, "checkout", "-qb", "otra");
    writeFileSync(join(t.repo, "a.txt"), "2"); sh(t.repo, "commit", "-qam", "dos-en-otra");
    expect(readFileSync(join(t.app, "a.txt"), "utf8")).toBe("1");
    expect(syncApp(opts(t))).toEqual({ ok: true, changed: false });
    sh(t.repo, "checkout", "-q", "main"); writeFileSync(join(t.repo, "a.txt"), "3"); sh(t.repo, "commit", "-qam", "tres-en-main");
    t.npmCalls.length = 0;
    expect(syncApp(opts(t)).ok).toBe(true);
    expect(readFileSync(join(t.app, "a.txt"), "utf8")).toBe("3");
    expect(t.npmCalls).toEqual(["ci", "run", "prune"]);

    // sucia: para y no mueve nada
    writeFileSync(join(t.app, "a.txt"), "sucio");
    writeFileSync(join(t.repo, "a.txt"), "4"); sh(t.repo, "commit", "-qam", "cuatro");
    const res = syncApp(opts(t));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("sin confirmar");
    expect(readFileSync(join(t.app, "a.txt"), "utf8")).toBe("sucio");
  });

  it("rechaza una carpeta app que no es worktree", () => {
    const t = setup();
    mkdirSync(t.app, { recursive: true });
    expect(syncApp(opts(t)).ok).toBe(false);
  });

  it("hace fetch y mueve la copia a origin/main (remoto bare); sin red, sigue con main local y avisa", () => {
    const t = setup();
    mkdirSync(join(t.base, "home"));
    const bare = join(t.base, "remoto.git");
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    sh(t.repo, "remote", "add", "origin", bare);
    sh(t.repo, "push", "-q", "origin", "main");
    expect(syncApp(opts(t)).ok).toBe(true);
    // otro clon sube un commit a origin/main; el main local del repo no se mueve
    const otro = join(t.base, "otro");
    spawnSync("git", ["clone", "-q", bare, otro]);
    sh(otro, "config", "user.email", "t@t"); sh(otro, "config", "user.name", "t");
    writeFileSync(join(otro, "a.txt"), "remoto"); sh(otro, "commit", "-qam", "remoto"); sh(otro, "push", "-q", "origin", "main");
    expect(syncApp(opts(t)).ok).toBe(true);
    expect(readFileSync(join(t.app, "a.txt"), "utf8")).toBe("remoto");
    expect(sh(t.repo, "show", "main:a.txt")).toBe("1");
    // sin red: el remoto desaparece
    sh(t.repo, "remote", "set-url", "origin", join(t.base, "no-existe.git"));
    const logs = [];
    expect(syncApp({ ...opts(t), log: (m) => logs.push(m) }).ok).toBe(true);
    expect(logs.join("\n")).toContain("AVISO");
  });
});
