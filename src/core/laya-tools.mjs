// Subcomandos `router laya-*`: exportar datos, ajustar Laya y apuntar qué checkpoint usar.
// La ejecución de procesos (exec), el reloj (now) y la salida (log) entran por parámetros; los tests no lanzan laya-train.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "./reducer.mjs";
import { CHOICES } from "./classifier.mjs";
import { defaultPlatform } from "./platform/index.mjs";
import {
  trainingRows, addSeeds, parseLocalSeeds, toCsv, toJsonl, splitRows, distribution, classWarnings, checkMinimum, scoreEval, compareScores, layaTrainArgs, rowsFromJsonl, oversample, sourceBreakdown, TRAIN_DEFAULTS,
  DEFAULT_EVAL_RATIO, MIN_PER_CLASS
} from "./laya-data.mjs";

export const EVAL_SCRIPT = fileURLToPath(new URL("../../bin/laya-evaluar.py", import.meta.url));

// Semillas locales opcionales (texto histórico que no se versiona). Fail-open: ausente o ilegible = ninguna.
export async function loadLocalSeeds(file) {
  if (!file) return [];
  try { return parseLocalSeeds(await readFile(file, "utf8")); } catch { return []; }
}

export async function loadRuns(store) {
  const runs = await Promise.all((await store.listRunIds()).map(async (id) => reduceEvents(await store.readRun(id))));
  return runs.filter(Boolean);
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1).replace(".", ",")} %`);

function describeDist(dist, rows, log) {
  const corrected = rows.filter((r) => r.source === "usuario").length;
  log(`Ejemplos: ${rows.length} (${corrected} corregidos a mano)`);
  for (const c of CHOICES) log(`  ${c.padEnd(12)} ${dist[c]}`);
  const scarce = classWarnings(dist, MIN_PER_CLASS);
  if (scarce.length) log(`Aviso: ${scarce.map((c) => `${c} (${dist[c]})`).join(", ")} con menos de ${MIN_PER_CLASS} ejemplos; el ajuste será poco fiable.`);
}

function describeSources(label, rows, log) {
  if (!rows.some((r) => r.source)) return;
  const b = sourceBreakdown(rows);
  log(`${label} por origen:`);
  for (const c of CHOICES) log(`  ${c.padEnd(12)} ${b[c].usuario} a mano, ${b[c].auto} auto, ${b[c].semilla} semilla`);
}

async function writeSplit(rows, trainPath, evalPath, ratio) {
  const { train, eval: ev } = splitRows(rows, ratio);
  await mkdir(dirname(trainPath), { recursive: true });
  await writeFile(trainPath, toCsv(train));
  await writeFile(evalPath, toCsv(ev));
  return { train, eval: ev };
}

const evalPathFor = (trainPath) => join(dirname(trainPath), `${basename(trainPath, extname(trainPath))}-eval${extname(trainPath) || ".csv"}`);

export async function layaDatos({ store, opts, cwd = process.cwd(), log = console.log }) {
  const rows = trainingRows(await loadRuns(store), { profile: opts.profile });
  const trainPath = resolve(cwd, opts.out ?? "laya-datos.csv");
  const evalPath = evalPathFor(trainPath);
  if (!opts.force) {
    for (const f of [trainPath, evalPath]) if (await stat(f).then(() => true, () => false)) throw new Error(`${f} ya existe; usa otra ruta con --out o --forzar para pisarlo.`);
  }
  const { train, eval: ev } = await writeSplit(rows, trainPath, evalPath, DEFAULT_EVAL_RATIO);
  const dist = distribution(rows);
  describeDist(dist, rows, log);
  log(`Entrenamiento: ${train.length} filas → ${trainPath}`);
  log(`Evaluación:    ${ev.length} filas → ${evalPath}`);
  return { rows, dist, train, eval: ev, trainPath, evalPath };
}

const stamp = (now) => new Date(now).toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

const layaEnv = (config) => config.laya.env;

async function predict({ config, exec, model, dataPath, outPath }) {
  const python = join(config.laya.venvDir, "bin/python");
  const r = await exec(python, [EVAL_SCRIPT, dataPath, model, outPath], { env: layaEnv(config) });
  if (r.code !== 0) throw new Error(`la evaluación de ${model} salió con código ${r.code}`);
  return JSON.parse(await readFile(outPath, "utf8"));
}

function printScores(log, base, nuevo) {
  log("");
  log(`Evaluación sobre ${nuevo.n} ejemplos que el modelo no ha visto:`);
  log(`  ${"".padEnd(12)} ${"base".padStart(8)} ${"nuevo".padStart(8)}`);
  for (const c of CHOICES) log(`  ${c.padEnd(12)} ${pct(base.byClass[c].accuracy).padStart(8)} ${pct(nuevo.byClass[c].accuracy).padStart(8)}  (${nuevo.byClass[c].n})`);
  log(`  ${"global".padEnd(12)} ${pct(base.accuracy).padStart(8)} ${pct(nuevo.accuracy).padStart(8)}`);
}

// Datos de entrada: o las ejecuciones etiquetadas del store, o train.jsonl/test.jsonl de una carpeta (--datos).
async function prepareData({ store, opts, dataDir, seedsFile, log }) {
  if (opts.datos) {
    const dir = resolve(opts.datos);
    const trainJsonl = join(dir, "train.jsonl");
    const evalJsonl = join(dir, "test.jsonl");
    const read = (p) => readFile(p, "utf8").catch(() => { throw new Error(`falta ${p} (--datos espera train.jsonl y test.jsonl)`); });
    const train = rowsFromJsonl(await read(trainJsonl));
    const ev = rowsFromJsonl(await read(evalJsonl));
    describeDist(distribution([...train, ...ev]), [...train, ...ev], log);
    log(`Datos externos en ${dir} (${train.length} para entrenar, ${ev.length} para evaluar)`);
    return { trainJsonl, evalJsonl, train, ev, dist: distribution(train) };
  }
  const rows = trainingRows(await loadRuns(store), { profile: opts.profile });
  const split = splitRows(rows, DEFAULT_EVAL_RATIO);
  // Las semillas se reparten train/eval; el mínimo cuenta las que entran al train.
  const seeded = addSeeds(split.train, split.eval, await loadLocalSeeds(seedsFile));
  const counted = [...rows, ...seeded.train.filter((r) => r.source === "semilla")];
  const dist = distribution(counted);
  describeDist(dist, counted, log);
  const min = checkMinimum(dist);
  if (!min.ok && !opts.force) {
    log(`No se entrena: ${min.reasons.join("; ")}.`);
    log("Etiqueta más ejecuciones en el dashboard o usa --forzar para saltarte el mínimo.");
    return { refused: true, dist };
  }
  if (!min.ok) log(`Aviso (--forzar): ${min.reasons.join("; ")}.`);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "train.csv"), toCsv(seeded.train));
  await writeFile(join(dataDir, "eval.csv"), toCsv(seeded.eval));
  // Para entrenar y evaluar se usa JSONL con el mismo estado y preguntas que el servicio (el CSV de laya-train sintetiza otra pregunta).
  const trainJsonl = join(dataDir, "train.jsonl");
  const evalJsonl = join(dataDir, "eval.jsonl");
  const ev = seeded.eval;
  // Sin esto las clases escasas quedan aplastadas por la mayoritaria; el eval no se toca para que mida la realidad.
  const before = distribution(seeded.train);
  const train = oversample(seeded.train, { seed: opts.seed ?? 0 });
  const after = distribution(train);
  const fmt = (d) => CHOICES.map((c) => `${c} ${d[c]}`).join(", ");
  log(`Train antes de balancear: ${fmt(before)}`);
  log(`Train después de balancear: ${fmt(after)}`);
  describeSources("Train", seeded.train, log);
  describeSources("Eval", ev, log);
  await writeFile(trainJsonl, toJsonl(train));
  await writeFile(evalJsonl, toJsonl(ev));
  log(`Datos en ${dataDir} (${train.length} para entrenar, ${ev.length} para evaluar)`);
  return { trainJsonl, evalJsonl, train, ev, dist };
}

export async function layaEntrenar({ store, config, exec, now, opts, log = console.log }) {
  const outDir = join(config.laya.modelsDir, stamp(now));
  const dataDir = join(outDir, "datos");
  const modelDir = join(outDir, "modelo");
  const data = await prepareData({ store, opts, dataDir, seedsFile: config.laya.seedsFile, log });
  if (data.refused) return { refused: true, dist: data.dist };
  const { trainJsonl, evalJsonl, ev, dist } = data;
  await mkdir(dataDir, { recursive: true });

  log("Ejecutando laya-train…");
  const trainRes = await exec(join(config.laya.venvDir, "bin/laya-train"), layaTrainArgs({ data: trainJsonl, out: modelDir, base: config.laya.base, dryRun: opts.dryRun, microBatch: opts.microBatch, gradAccum: opts.gradAccum ?? TRAIN_DEFAULTS.gradAccum, maxLen: opts.maxLen, loss: opts.loss ?? TRAIN_DEFAULTS.loss, epochs: opts.epochs ?? TRAIN_DEFAULTS.epochs, eval: evalJsonl, freezeEncoder: opts.freezeEncoder, seed: opts.seed }), { env: layaEnv(config) });
  if (trainRes.code !== 0) {
    log(`laya-train falló (código ${trainRes.code}).`);
    return { failed: true, outDir, dist };
  }
  if (opts.dryRun) {
    log("Simulación terminada: no se ha entrenado nada.");
    return { dryRun: true, outDir, dist };
  }

  if (ev.length === 0) {
    log(`No hay ejemplos de evaluación: no se puede comparar. Modelo en ${modelDir}`);
    return { outDir, modelDir, dist, winner: "empate" };
  }
  const base = scoreEval(ev, await predict({ config, exec, model: config.laya.base, dataPath: evalJsonl, outPath: join(dataDir, "pred-base.json") }));
  const nuevo = scoreEval(ev, await predict({ config, exec, model: modelDir, dataPath: evalJsonl, outPath: join(dataDir, "pred-nuevo.json") }));
  printScores(log, base, nuevo);
  const { winner, regresiones } = compareScores(base, nuevo);
  if (winner === "nuevo") {
    log(`\nEl modelo nuevo mejora al base. Para usarlo: router laya-usar ${modelDir}`);
  } else if (winner === "regresion") {
    log("\nLa global sube, pero el modelo nuevo empeora estas clases (base → nuevo):");
    for (const r of regresiones) log(`  ${r.clase}: ${pct(r.base)} → ${pct(r.nuevo)}`);
    log("No se propone cambiar: el modelo parece haber colapsado hacia otras clases. Más datos etiquetados de esas clases ayudarán.");
  } else {
    log(`\n${winner === "base" ? "El base sigue ganando" : "Empate"}: no se propone cambiar. Más datos etiquetados ayudarán.`);
  }
  return { outDir, modelDir, dist, base, nuevo, winner };
}

export async function layaUsar({ config, opts, log = console.log, platform = defaultPlatform({ home: config.userHome, shell: config.shell }) }) {
  if (opts.remove) {
    await rm(config.laya.activeFile, { force: true });
    log("Elección borrada: el servicio volverá al modelo base cuando se reinstale o se reinicie con la configuración por defecto.");
    return { ok: true };
  }
  const dir = resolve(opts.dir);
  const isCheckpoint = await stat(join(dir, "rl_agent_config.json")).then((s) => s.isFile(), () => false);
  if (!isCheckpoint) {
    log(`${dir} no parece un checkpoint de Laya (falta rl_agent_config.json).`);
    return { ok: false };
  }
  await mkdir(dirname(config.laya.activeFile), { recursive: true });
  await writeFile(config.laya.activeFile, `${dir}\n`);
  log(`Anotado en ${config.laya.activeFile}: ${dir}`);
  log("");
  log("Todavía no se aplica: laya-serve lee el checkpoint al arrancar. Para aplicarlo hay que arrancar laya-serve con");
  log(`  LAYA_EXTRA_MODELS='${JSON.stringify({ encargos: dir })}'`);
  log("(se registra con nombre propio; «multilingual» no cambia). Lo más simple: en config.env pon");
  log(`  ROUTER_LAYA_EXTRA_MODELS='${JSON.stringify({ encargos: dir })}'`);
  log("  ROUTER_LAYA_ROUTING_MODEL=encargos   (solo el enrutado de encargos usa ese modelo)");
  log(`y ejecuta npm run instalar (regenera el ${platform.serviceKind} com.agent-router.laya con LAYA_EXTRA_MODELS).`);
  log(`Reinicio manual del servicio: ${platform.restartHint("com.agent-router.laya")}`);
  log("Para volver al base: router laya-usar --quitar y quitar esas dos variables.");
  return { ok: true, dir };
}
