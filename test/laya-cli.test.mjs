import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLayaArgs, isLayaCommand, isActualizarCommand, USAGE } from "../src/core/cli.mjs";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { createPlatform } from "../src/core/platform/index.mjs";
import { layaDatos, layaEntrenar, layaUsar } from "../src/core/laya-tools.mjs";

describe("parseLayaArgs", () => {
  it("reconoce los subcomandos", () => {
    expect(isLayaCommand("laya-datos")).toBe(true);
    expect(isLayaCommand("arregla el bug")).toBe(false);
    expect(USAGE).toMatch(/laya-datos/);
  });
  it("laya-datos: out y perfil", () => {
    expect(parseLayaArgs(["laya-datos"])).toMatchObject({ command: "laya-datos", out: null, profile: "todos", force: false });
    expect(parseLayaArgs(["laya-datos", "--out", "a.csv", "--perfil", "personal"])).toMatchObject({ out: "a.csv", profile: "personal" });
    expect(() => parseLayaArgs(["laya-datos", "--perfil", "x y"])).toThrow(/perfil/);
    expect(() => parseLayaArgs(["laya-datos", "--out"])).toThrow(/--out/);
    expect(() => parseLayaArgs(["laya-datos", "--raro"])).toThrow(/--raro/);
  });
  it("laya-entrenar: forzar y simular", () => {
    expect(parseLayaArgs(["laya-entrenar", "--forzar", "--simular"])).toMatchObject({ command: "laya-entrenar", force: true, dryRun: true });
  });
  it("laya-entrenar: --datos y parámetros de memoria, con valores seguros por defecto", () => {
    expect(parseLayaArgs(["laya-entrenar"])).toMatchObject({ datos: null, microBatch: 1, gradAccum: 8, maxLen: 512, loss: "soft-ce", epochs: 6, freezeEncoder: false, seed: null });
    expect(parseLayaArgs(["laya-entrenar", "--loss", "rlcd", "--epochs", "3", "--freeze-encoder", "--seed", "0"])).toMatchObject({ loss: "rlcd", epochs: 3, freezeEncoder: true, seed: 0 });
    expect(() => parseLayaArgs(["laya-entrenar", "--loss", "mse"])).toThrow(/--loss/);
    expect(() => parseLayaArgs(["laya-entrenar", "--seed", "-1"])).toThrow(/--seed/);
    expect(() => parseLayaArgs(["laya-entrenar", "--epochs", "0"])).toThrow(/--epochs/);
    expect(parseLayaArgs(["laya-entrenar", "--datos", "/d", "--micro-batch", "2", "--grad-accum", "32", "--max-len", "256"]))
      .toMatchObject({ datos: "/d", microBatch: 2, gradAccum: 32, maxLen: 256 });
    expect(() => parseLayaArgs(["laya-entrenar", "--micro-batch", "0"])).toThrow(/--micro-batch/);
    expect(() => parseLayaArgs(["laya-entrenar", "--max-len", "abc"])).toThrow(/--max-len/);
    expect(() => parseLayaArgs(["laya-entrenar", "--datos"])).toThrow(/--datos/);
    expect(() => parseLayaArgs(["laya-datos", "--datos", "/d"])).toThrow(/--datos/);
  });
  it("laya-usar: carpeta o --quitar", () => {
    expect(parseLayaArgs(["laya-usar", "/x/modelo"])).toMatchObject({ command: "laya-usar", dir: "/x/modelo", remove: false });
    expect(parseLayaArgs(["laya-usar", "--quitar"])).toMatchObject({ remove: true });
    expect(() => parseLayaArgs(["laya-usar"])).toThrow(/carpeta/);
  });
});

let home;
let config;
let store;
const logs = [];
const log = (m) => logs.push(m);
const NOW = Date.UTC(2026, 9, 15, 8, 30, 5);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "router-laya-"));
  config = loadConfig({ HOME: home, ROUTER_HOME: join(home, "r") });
  store = createStore({ runsDir: config.runsDir });
  logs.length = 0;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

// n ejecuciones completadas; node = quién las lleva (opus = solo un encargo al consultor: sin subagentes no se entrena).
async function seed(prefix, n, node, profile = "trabajo") {
  for (let i = 0; i < n; i++) {
    const id = `2026${prefix}${String(i).padStart(3, "0")}-1-a`;
    await store.append(id, { type: "run_start", runId: id, task: `Tarea ${prefix} número ${i}, con "comillas"`, mode: "orquestado", model: "opus", cwd: "/", profile, t: 1 });
    await store.append(id, { type: "task_start", taskId: "a", agent: node === "opus" ? "consultor" : node, description: "d", prompt: "p", t: 2 });
    await store.append(id, { type: "run_end", exitCode: 0, t: 3 });
  }
}

describe("laya-datos", () => {
  it("escribe el CSV de entrenamiento y el de evaluación, y avisa de las clases escasas", async () => {
    await seed("a", 40, "asistente");
    await seed("p", 40, "programador");
    await seed("o", 5, "opus");
    const out = join(home, "datos.csv");
    const res = await layaDatos({ store, opts: { out, profile: "todos" }, log });
    expect(res.dist).toEqual({ asistente: 40, programador: 40, opus: 5 });
    const train = await readFile(out, "utf8");
    const ev = await readFile(join(home, "datos-eval.csv"), "utf8");
    expect(train.split("\n")[0]).toBe("texto,etiqueta,perfil,fuente,runId");
    const lines = (s) => s.trim().split("\n").length - 1;
    expect(lines(train) + lines(ev)).toBe(85);
    expect(lines(ev)).toBeGreaterThan(5);
    expect(train).toContain('"Tarea a número');
    const text = logs.join("\n");
    expect(text).toMatch(/asistente\D+40/);
    expect(text).toMatch(/opus.*menos de 15/s);
  });
  it("sin --out usa laya-datos.csv en el directorio dado", async () => {
    await seed("a", 3, "asistente");
    const res = await layaDatos({ store, opts: { out: null, profile: "todos" }, cwd: home, log });
    expect(res.trainPath).toBe(join(home, "laya-datos.csv"));
  });
});

describe("laya-entrenar", () => {
  // exec falso: no ejecuta nada real; el "script de evaluación" escribe predicciones (todas "programador" para la base, perfectas para el nuevo).
  function fakeExec(calls) {
    return async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd.endsWith("laya-train")) return { code: 0 };
      const [, data, model, outFile] = [args[0], args[1], args[2], args[3]];
      const rows = (await readFile(data, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const preds = rows.map((r) => (model === "multilingual" ? "programador" : r.expected.route));
      await writeFile(outFile, JSON.stringify(preds));
      return { code: 0 };
    };
  }
  const opts = { force: false, dryRun: false, profile: "todos", datos: null, microBatch: 1, gradAccum: 64, maxLen: 512 };

  it("se niega con pocos ejemplos o clases escasas, sin lanzar nada", async () => {
    await seed("a", 10, "asistente");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts, log });
    expect(res.refused).toBe(true);
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toMatch(/--forzar/);
  });

  it("el mínimo cuenta las semillas que entran al train: pocos opus reales no bloquean", async () => {
    await seed("a", 30, "asistente");
    await seed("p", 30, "programador");
    await seed("o", 5, "opus");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts, log });
    expect(res.refused).toBeFalsy();
    const trainRows = (await readFile(join(res.outDir, "datos", "train.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const evalRows = (await readFile(join(res.outDir, "datos", "eval.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const t = new Set(trainRows.map((r) => r.state.body));
    expect(evalRows.some((r) => t.has(r.state.body))).toBe(false);
    expect(evalRows.filter((r) => r.expected.route === "opus").length).toBeGreaterThan(0);
    expect(evalRows.filter((r) => r.expected.route === "asistente").length).toBeGreaterThan(0);
    const csv = await readFile(join(res.outDir, "datos", "train.csv"), "utf8");
    expect(csv.split("\n").filter((l) => l.includes(",semilla,")).length).toBe([...t].filter((b) => !b.startsWith("Tarea ")).length);
  });
  it("el mínimo sigue valiendo: sin suficientes ejemplos totales se niega aunque haya semillas", async () => {
    await seed("a", 2, "asistente");
    const res = await layaEntrenar({ store, config, exec: fakeExec([]), now: NOW, opts, log });
    expect(res.refused).toBe(true);
  });
  it("entrena, evalúa base y nuevo, y propone cambiar solo si el nuevo gana", async () => {
    await seed("a", 30, "asistente");
    await seed("p", 30, "programador");
    await seed("o", 30, "opus");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts, log });
    expect(res.refused).toBeFalsy();
    expect(res.outDir).toBe(join(config.laya.modelsDir, "20261015-083005"));
    const train = calls.find((c) => c.cmd.endsWith("laya-train"));
    expect(train.cmd).toBe(join(config.laya.venvDir, "bin/laya-train"));
    expect(train.args).toEqual(expect.arrayContaining(["--base", "multilingual", "--out", join(res.outDir, "modelo")]));
    expect(train.args[train.args.indexOf("--data") + 1]).toMatch(/train\.jsonl$/);
    const evals = calls.filter((c) => c.cmd.endsWith("python"));
    expect(evals).toHaveLength(2);
    expect(res.base.accuracy).toBeLessThan(0.5);
    expect(res.nuevo.accuracy).toBe(1);
    expect(res.winner).toBe("nuevo");
    const text = logs.join("\n");
    expect(text).toMatch(/laya-usar/);
    expect(text).toContain(join(res.outDir, "modelo"));
    await expect(readFile(config.laya.activeFile, "utf8")).rejects.toThrow(); // no cambia nada solo
  });

  it("si el base gana no propone el cambio", async () => {
    await seed("a", 30, "asistente");
    await seed("p", 30, "programador");
    await seed("o", 30, "opus");
    const exec = async (cmd, args) => {
      if (cmd.endsWith("laya-train")) return { code: 0 };
      const rows = (await readFile(args[1], "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      await writeFile(args[3], JSON.stringify(rows.map((r) => (args[2] === "multilingual" ? r.expected.route : "programador"))));
      return { code: 0 };
    };
    const res = await layaEntrenar({ store, config, exec, now: NOW, opts, log });
    expect(res.winner).toBe("base");
    expect(logs.join("\n")).not.toMatch(/router laya-usar/);
  });

  it("si la global sube pero una clase se hunde, avisa de la regresión y no propone el cambio", async () => {
    await seed("a", 30, "asistente");
    await seed("p", 30, "programador");
    await seed("o", 30, "opus");
    const exec = async (cmd, args) => {
      if (cmd.endsWith("laya-train")) return { code: 0 };
      const rows = (await readFile(args[1], "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const base = args[2] === "multilingual";
      await writeFile(args[3], JSON.stringify(rows.map((r) => (base ? ("asistente") : (r.expected.route === "asistente" ? "programador" : r.expected.route)))));
      return { code: 0 };
    };
    const res = await layaEntrenar({ store, config, exec, now: NOW, opts, log });
    expect(res.winner).toBe("regresion");
    const text = logs.join("\n");
    expect(text).toMatch(/asistente: 100,0 % → 0,0 %/);
    expect(text).not.toMatch(/router laya-usar/);
  });

  it("--forzar salta el mínimo y --simular solo hace dry-run", async () => {
    await seed("a", 6, "asistente");
    await seed("p", 6, "programador");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { ...opts, force: true, dryRun: true }, log });
    expect(res.refused).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
  });

  it("pasa a laya-train micro-batch, grad-accum y max-len", async () => {
    await seed("a", 6, "asistente");
    const calls = [];
    await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { ...opts, force: true, dryRun: true, microBatch: 2, gradAccum: 32, maxLen: 256 }, log });
    const a = calls[0].args;
    expect(a.slice(a.indexOf("--micro-batch"), a.indexOf("--micro-batch") + 2)).toEqual(["--micro-batch", "2"]);
    expect(a[a.indexOf("--grad-accum") + 1]).toBe("32");
    expect(a[a.indexOf("--max-len") + 1]).toBe("256");
  });

  it("sin opciones pasa los valores por defecto: soft-ce, grad-accum 8, 6 épocas y --eval con el eval.jsonl", async () => {
    await seed("a", 6, "asistente");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { force: true, dryRun: true, profile: "todos", datos: null }, log });
    const a = calls[0].args;
    expect(a[a.indexOf("--loss") + 1]).toBe("soft-ce");
    expect(a[a.indexOf("--grad-accum") + 1]).toBe("8");
    expect(a[a.indexOf("--epochs") + 1]).toBe("6");
    expect(a[a.indexOf("--eval") + 1]).toBe(join(res.outDir, "datos", "eval.jsonl"));
    expect(a).not.toContain("--freeze-encoder");
  });

  it("sobrescribe loss, epochs, seed y freeze-encoder desde opts", async () => {
    await seed("a", 6, "asistente");
    const calls = [];
    await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { ...opts, force: true, dryRun: true, loss: "rlcd", epochs: 2, seed: 5, freezeEncoder: true }, log });
    const a = calls[0].args;
    expect(a[a.indexOf("--loss") + 1]).toBe("rlcd");
    expect(a[a.indexOf("--epochs") + 1]).toBe("2");
    expect(a[a.indexOf("--seed") + 1]).toBe("5");
    expect(a).toContain("--freeze-encoder");
  });

  it("balancea solo el train con oversampling, deja el eval intacto y loguea antes/después y manual/auto", async () => {
    await seed("a", 20, "asistente");
    await seed("p", 40, "programador");
    await seed("o", 10, "opus");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { ...opts, force: true, dryRun: true }, log });
    const read = async (f) => (await readFile(join(res.outDir, "datos", f), "utf8")).trim().split("\n").map((l) => JSON.parse(l).expected.route);
    const trainLabels = await read("train.jsonl");
    const evalLabels = await read("eval.jsonl");
    const count = (arr, c) => arr.filter((x) => x === c).length;
    const max = Math.max(...["asistente", "programador", "opus"].map((c) => count(trainLabels, c)));
    for (const c of ["asistente", "programador", "opus"]) expect(count(trainLabels, c)).toBe(max);
    // eval sin duplicados: lo que hay en eval.csv
    const evCsv = (await readFile(join(res.outDir, "datos", "eval.csv"), "utf8")).trim().split("\n").length - 1;
    expect(evalLabels).toHaveLength(evCsv);
    const text = logs.join("\n");
    expect(text).toMatch(/Train antes de balancear/);
    expect(text).toMatch(/Train después de balancear/);
    expect(text).toMatch(/Train por origen/);
    expect(text).toMatch(/Eval por origen/);
    expect(text).toMatch(/asistente\D+0 a mano, [1-9]\d* auto/);
  });

  it("cuenta las correcciones manuales por clase en el log", async () => {
    await seed("a", 6, "asistente");
    await store.append("2026a000-1-a", { type: "route_label", label: "opus", t: 9 });
    await layaEntrenar({ store, config, exec: fakeExec([]), now: NOW, opts: { ...opts, force: true, dryRun: true }, log });
    expect(logs.join("\n")).toMatch(/opus\D+1 a mano, 0 auto/);
  });

  it("--datos usa train.jsonl y test.jsonl externos sin leer el store", async () => {
    const ds = join(home, "ds");
    await mkdir(ds, { recursive: true });
    const row = (label, i) => JSON.stringify({ state: { body: `t${i}` }, questions: { route: {} }, expected: { route: label } });
    await writeFile(join(ds, "train.jsonl"), ["asistente", "programador", "opus"].map(row).join("\n") + "\n");
    await writeFile(join(ds, "test.jsonl"), ["asistente", "programador", "opus", "opus"].map(row).join("\n") + "\n");
    const calls = [];
    const res = await layaEntrenar({ store, config, exec: fakeExec(calls), now: NOW, opts: { ...opts, datos: ds }, log });
    expect(res.refused).toBeFalsy();
    const train = calls.find((c) => c.cmd.endsWith("laya-train"));
    expect(train.args[train.args.indexOf("--data") + 1]).toBe(join(ds, "train.jsonl"));
    const evals = calls.filter((c) => c.cmd.endsWith("python"));
    expect(evals.map((c) => c.args[1])).toEqual([join(ds, "test.jsonl"), join(ds, "test.jsonl")]);
    expect(res.nuevo.n).toBe(4);
    expect(res.nuevo.accuracy).toBe(1);
  });

  it("--datos sin train.jsonl falla con un mensaje claro", async () => {
    await expect(layaEntrenar({ store, config, exec: fakeExec([]), now: NOW, opts: { ...opts, datos: join(home, "nada") }, log })).rejects.toThrow(/train\.jsonl/);
  });

  it("si laya-train falla lo cuenta y no evalúa", async () => {
    await seed("a", 6, "asistente");
    const calls = [];
    const exec = async (cmd, args) => { calls.push(cmd); return { code: 1, args }; };
    const res = await layaEntrenar({ store, config, exec, now: NOW, opts: { ...opts, force: true }, log });
    expect(res.failed).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("laya-usar", () => {
  it("anota el checkpoint elegido y explica cómo aplicarlo, sin tocar servicios", async () => {
    const dir = join(home, "modelo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rl_agent_config.json"), "{}");
    const res = await layaUsar({ config, opts: { dir, remove: false }, log, platform: createPlatform("darwin", { home, uid: 501 }) });
    expect(res.ok).toBe(true);
    expect((await readFile(config.laya.activeFile, "utf8")).trim()).toBe(dir);
    const text = logs.join("\n");
    expect(text).toContain("LAYA_EXTRA_MODELS");
    expect(text).toContain(JSON.stringify({ encargos: dir }));
    expect(text).toMatch(/launchctl kickstart -k gui\/\$\(id -u\)\/com\.agent-router\.laya/);
    expect(text).toContain("LaunchAgent");
  });
  it("en Linux explica el reinicio con systemctl --user", async () => {
    const dir = join(home, "modelo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rl_agent_config.json"), "{}");
    await layaUsar({ config, opts: { dir, remove: false }, log, platform: createPlatform("linux", { home, shell: "/bin/bash" }) });
    const text = logs.join("\n");
    expect(text).toMatch(/systemctl --user restart com\.agent-router\.laya\.service/);
    expect(text).not.toMatch(/launchctl/);
  });
  it("rechaza una carpeta que no es un checkpoint", async () => {
    const dir = join(home, "vacia");
    await mkdir(dir, { recursive: true });
    const res = await layaUsar({ config, opts: { dir, remove: false }, log });
    expect(res.ok).toBe(false);
    await expect(readFile(config.laya.activeFile, "utf8")).rejects.toThrow();
  });
  it("--quitar borra la elección", async () => {
    await mkdir(config.home, { recursive: true });
    await writeFile(config.laya.activeFile, "/x\n");
    const res = await layaUsar({ config, opts: { dir: null, remove: true }, log });
    expect(res.ok).toBe(true);
    await expect(readFile(config.laya.activeFile, "utf8")).rejects.toThrow();
  });
});

describe("router actualizar", () => {
  it("se reconoce como subcomando exacto y sale en la ayuda", () => {
    expect(isActualizarCommand("actualizar")).toBe(true);
    expect(isActualizarCommand("actualiza el README")).toBe(false);
    expect(USAGE).toMatch(/router actualizar/);
  });
});
