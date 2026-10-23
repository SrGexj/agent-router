import { describe, it, expect } from "vitest";
import { runTitle, promptParts, costBreakdown, aggregateSavings, spendShare, taskRows, isWaiting, normalizeText, groupRuns, filterRuns, filterTasks, actualRoute, shadowVerdict, aggregateShadow, aggregateSavingsByProfile, aggregateShadowByProfile, runTotals, trainingLabel, trainingSummary, classifierName, spendByFamily, spendUnknown, tokensByFamily, tokenShare } from "../src/core/details.mjs";
import { fmtTokens, usageTitle } from "../dashboard/src/captions.js";

const M = 1_000_000;
const u = (input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });
const task = (node, model, usage, over = {}) => ({ id: "x", agent: node, node, description: "d", prompt: "p", status: "completed", startedAt: 1000, endedAt: 4000, model, summary: "", usage, ...over });
const mkRun = (tasks, over = {}) => ({
  id: "r", task: "t", status: "completed", startedAt: 0, endedAt: 9000, tasks: Object.fromEntries(tasks.map((t, i) => [`t${i}`, t])),
  taskOrder: tasks.map((_, i) => `t${i}`), usage: null, ...over
});
const full = () => mkRun([
  task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M, 100_000) }),
  task("asistente", "claude-haiku-5-5", { "claude-haiku-5-5": u(M) })
], { orchestratorUsage: { "claude-opus-5-5": u(100_000, 50_000) } });

describe("runTitle y promptParts", () => {
  it("usa las palabras propias fuera de los bloques pegados", () => {
    expect(runTitle('Retoma esto\n\n<pasted_content id="a">línea 1\nlínea 2</pasted_content>  y sigue')).toBe("Retoma esto y sigue");
  });
  it("un bloque sin cierre llega hasta el final", () => {
    expect(runTitle('Mira esto <pasted_content id="a">texto cortado')).toBe("Mira esto");
    expect(promptParts('Hola <pasted_content id="a">cortado')).toEqual([{ kind: "text", text: "Hola" }, { kind: "pasted", text: "cortado" }]);
  });
  it("solo pegado: marca y primera línea no vacía", () => {
    expect(runTitle('<pasted_content id="ce0e">\n\n  Retoma el trabajo   de ayer\nmás</pasted_content>')).toBe("[texto pegado] Retoma el trabajo de ayer");
    expect(runTitle('<pasted_content id="ce0e"> Retoma el trabajo')).toBe("[texto pegado] Retoma el trabajo");
  });
  it("texto normal, vacío y objeto con task", () => {
    expect(runTitle("  Corrige\n las erratas ")).toBe("Corrige las erratas");
    expect(runTitle("")).toBe("Sin título");
    expect(runTitle({ task: "hola" })).toBe("hola");
    expect(runTitle(undefined)).toBe("Sin título");
  });
  it("promptParts conserva el orden de texto y pegados", () => {
    const parts = promptParts('a <pasted_content id="1">b</pasted_content> c <pasted_content id="2">d</pasted_content>');
    expect(parts.map((p) => `${p.kind}:${p.text}`)).toEqual(["text:a", "pasted:b", "text:c", "pasted:d"]);
  });
});

describe("costBreakdown", () => {
  it("separa orquestador, asistente y programador, con tokens y desglose", () => {
    const b = costBreakdown(full());
    expect(b.orchestrator.costUsd).toBeCloseTo(1.4);
    expect(b.programador.costUsd).toBeCloseTo(3);
    expect(b.asistente.costUsd).toBeCloseTo(0.1);
    expect(b.programador.models).toEqual(["claude-sonnet-5-5"]);
    expect(b.orchestrator.tokens).toBe(150_000);
    expect(b.tokens).toBe(150_000 + 1_100_000 + 1_000_000);
    expect(b.tokenTypes).toEqual({ input: 2_100_000, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    expect(b.total).toBeCloseTo(4.5);
    expect(b.opusEquivalentUsd).toBeCloseTo(11.4);
    expect(b.savingsUsd).toBeCloseTo(6.9);
    expect(b.savingsPct).toBeCloseTo((6.9 / 11.4) * 100);
    expect(b.complete).toBe(true);
  });
  it("suma escrituras de caché de 5 min y 1 h en un solo tipo", () => {
    const b = costBreakdown(mkRun([task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(0, 0, 5, 3, 2) })]));
    expect(b.tokenTypes).toEqual({ input: 0, output: 0, cacheRead: 5, cacheWrite: 5 });
  });
  it("marca parcial si falta usage en un encargo terminado o en el orquestador", () => {
    const r = full();
    r.tasks.t1 = { ...r.tasks.t1, usage: null };
    expect(costBreakdown(r).complete).toBe(false);
    expect(costBreakdown({ ...full(), orchestratorUsage: null }).complete).toBe(false);
  });
  it("un encargo en curso sin usage no hace parcial una ejecución en curso", () => {
    const r = mkRun([task("programador", "m", null, { status: "running" })], { status: "running", endedAt: null });
    expect(costBreakdown(r).complete).toBe(true);
  });
  it("ejecución antigua sin campos nuevos: sin datos y sin romper", () => {
    const b = costBreakdown(mkRun([task("programador", null, undefined)]));
    expect(b).toMatchObject({ total: 0, tokens: 0, hasData: false, savingsUsd: null, savingsPct: null, complete: false });
    expect(costBreakdown(null).total).toBe(0);
  });
  it("modo router: usa run.usage.costUsd como total sin ahorro", () => {
    const b = costBreakdown(mkRun([], { usage: { costUsd: 0.21 } }));
    expect(b).toMatchObject({ total: 0.21, hasData: true, savingsUsd: null });
  });
});

describe("aggregateSavings", () => {
  it("suma solo las ejecuciones con datos", () => {
    const a = aggregateSavings([full(), full(), mkRun([task("programador", null, undefined)]), mkRun([], { usage: { costUsd: 1 } })]);
    expect(a.runs).toBe(2);
    expect(a.total).toBeCloseTo(9);
    expect(a.opusEquivalentUsd).toBeCloseTo(22.8);
    expect(a.savingsUsd).toBeCloseTo(13.8);
    expect(a.savingsPct).toBeCloseTo((13.8 / 22.8) * 100);
    expect(a.tokens).toBe(2 * 2_250_000);
    expect(a.tokenTypes.input).toBe(4_200_000);
  });
  it("sin datos: porcentaje nulo", () => {
    expect(aggregateSavings([])).toMatchObject({ runs: 0, total: 0, savingsPct: null });
    expect(aggregateSavings(undefined).runs).toBe(0);
  });
});

describe("spendShare", () => {
  it("reparte el gasto real incluyendo al orquestador", () => {
    expect(spendShare(full())).toEqual({ opus: 31, sonnet: 67, haiku: 2 });
  });
  it("sin usage no inventa un reparto por número de encargos", () => {
    expect(spendShare(mkRun([task("programador", null, undefined)]))).toBeNull();
    expect(spendShare(null)).toBeNull();
  });
});

describe("taskRows", () => {
  it("calcula duración, coste y tokens por encargo", () => {
    const [a, b] = taskRows(full(), 99_000);
    expect(a).toMatchObject({ node: "programador", durationMs: 3000, tokens: 1_100_000, result: "" });
    expect(a.costUsd).toBeCloseTo(3);
    expect(b.tokenTypes.input).toBe(M);
  });
  it("en curso usa now; sin usage coste nulo y resultado cae al resumen", () => {
    const run = mkRun([task("asistente", null, undefined, { status: "running", endedAt: null, summary: "resumen", tokens: 500 })], { status: "running" });
    expect(taskRows(run, 6000)[0]).toMatchObject({ durationMs: 5000, costUsd: null, tokens: 500, result: "resumen" });
    expect(taskRows({}, 0)).toEqual([]);
  });
});

describe("isWaiting y fmtTokens", () => {
  it("solo espera si está en curso", () => {
    expect(isWaiting({ status: "running", waiting: { kind: "question" } })).toBe(true);
    expect(isWaiting({ status: "completed", waiting: { kind: "question" } })).toBe(false);
    expect(isWaiting({ status: "running" })).toBe(false);
  });
  it("formato compacto", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(12_345)).toBe("12,3 k");
    expect(fmtTokens(1_200_000)).toBe("1,2 M");
    expect(fmtTokens(150_000)).toBe("150 k");
  });
});

const NOW = 100 * 60_000;
const R = (id, over = {}) => ({ id, task: `tarea ${id}`, status: "completed", startedAt: 0, updatedAt: NOW, taskOrder: [], tasks: {}, ...over });

describe("normalizeText", () => {
  it("minúsculas y sin tildes", () => {
    expect(normalizeText("  Revisión ÁÉÍÓÚ ñ ")).toBe("  revision aeiou n ");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("groupRuns", () => {
  it("en curso arriba (esperando primero) y terminadas abajo, cada grupo por inicio descendente", () => {
    const runs = [
      R("a", { status: "running", startedAt: 30 }),
      R("w", { status: "running", startedAt: 10, waiting: { kind: "question" } }),
      R("b", { status: "running", startedAt: 40 }),
      R("c", { startedAt: 5 }),
      R("d", { status: "failed", startedAt: 20 }),
      R("e", { status: "cancelled", startedAt: 25 }),
      R("f", { status: "limited", startedAt: 1 })
    ];
    const g = groupRuns(runs, NOW);
    expect(g.running.map((r) => r.id)).toEqual(["w", "b", "a"]);
    expect(g.finished.map((r) => r.id)).toEqual(["e", "d", "c", "f"]);
  });
  it("una ejecución sin señal va a terminadas; esperando nunca es sin señal", () => {
    const stale = R("s", { status: "running", updatedAt: 0, startedAt: 9 });
    const waiting = R("w", { status: "running", updatedAt: 0, startedAt: 8, waiting: { kind: "permission" } });
    const g = groupRuns([stale, waiting], NOW);
    expect(g.running.map((r) => r.id)).toEqual(["w"]);
    expect(g.finished.map((r) => r.id)).toEqual(["s"]);
  });
  it("tolera lista vacía o ausente y no muta la entrada", () => {
    expect(groupRuns(undefined, NOW)).toEqual({ running: [], finished: [] });
    const input = [R("a", { startedAt: 1 }), R("b", { startedAt: 2 })];
    groupRuns(input, NOW);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("filterRuns", () => {
  const runs = [
    R("1", { task: "Revisión del módulo de pagos", profile: "trabajo" }),
    R("2", { task: "Corrige erratas", status: "failed", profile: "personal" }),
    R("3", { task: "Otra cosa", status: "limited", profile: "trabajo" }),
    R("4", { task: "Cancelada", status: "cancelled" }),
    R("5", { task: '<pasted_content id="x">texto con Pagos dentro</pasted_content>', status: "running" })
  ];
  const ids = (l) => l.map((r) => r.id);
  it("sin filtros devuelve todo", () => {
    expect(ids(filterRuns(runs, {}))).toEqual(["1", "2", "3", "4", "5"]);
    expect(ids(filterRuns(runs))).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("texto sin mayúsculas ni tildes, sobre título y prompt", () => {
    expect(ids(filterRuns(runs, { text: "REVISION" }))).toEqual(["1"]);
    expect(ids(filterRuns(runs, { text: "pagos" }))).toEqual(["1", "5"]);
  });
  it("estado: failed incluye limited", () => {
    expect(ids(filterRuns(runs, { status: "failed" }))).toEqual(["2", "3"]);
    expect(ids(filterRuns(runs, { status: "completed" }))).toEqual(["1"]);
    expect(ids(filterRuns(runs, { status: "cancelled" }))).toEqual(["4"]);
  });
  it("perfil, con trabajo como valor por defecto de ejecuciones antiguas sin campo", () => {
    expect(ids(filterRuns(runs, { profile: "personal" }))).toEqual(["2"]);
    expect(ids(filterRuns(runs, { profile: "trabajo" }))).toEqual(["1", "3", "4", "5"]);
  });
  it("filtros combinados", () => {
    expect(ids(filterRuns(runs, { text: "erratas", status: "failed", profile: "personal" }))).toEqual(["2"]);
    expect(ids(filterRuns(runs, { text: "erratas", profile: "trabajo" }))).toEqual([]);
  });
  it("ejecuciones antiguas sin campos no rompen", () => {
    expect(filterRuns([{ id: "old" }], { text: "x", status: "completed", profile: "personal" })).toEqual([]);
    expect(filterRuns([{ id: "old" }], { text: "sin título" }).length).toBe(1);
  });
});

describe("filterTasks", () => {
  const rows = [
    { id: "a", agent: "programador", node: "programador", description: "Arreglar IVA", status: "completed", prompt: "Corrige el redondeo", result: "Hecho" },
    { id: "b", agent: "asistente", node: "asistente", description: "Pasar tests", status: "failed", prompt: "npm test", result: "Fallan 2" },
    { id: "c", agent: "asistente", node: "asistente", description: "Lanzar", status: "killed", prompt: "", result: "" },
    { id: "d", agent: "programador", node: "programador", description: "Refactor", status: "running", prompt: "x", result: "" },
    { id: "e", agent: "x", node: "asistente", status: "completed" }
  ];
  const ids = (l) => l.map((r) => r.id);
  it("sin filtros devuelve todo", () => {
    expect(ids(filterTasks(rows, {}))).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("estado: failed incluye killed", () => {
    expect(ids(filterTasks(rows, { status: "failed" }))).toEqual(["b", "c"]);
    expect(ids(filterTasks(rows, { status: "running" }))).toEqual(["d"]);
    expect(ids(filterTasks(rows, { status: "completed" }))).toEqual(["a", "e"]);
  });
  it("agente por node", () => {
    expect(ids(filterTasks(rows, { agent: "asistente" }))).toEqual(["b", "c", "e"]);
    expect(ids(filterTasks(rows, { agent: "programador" }))).toEqual(["a", "d"]);
  });
  it("texto sobre descripción, prompt y resultado, sin tildes", () => {
    expect(ids(filterTasks(rows, { text: "iva" }))).toEqual(["a"]);
    expect(ids(filterTasks(rows, { text: "REDONDEO" }))).toEqual(["a"]);
    expect(ids(filterTasks(rows, { text: "fallan" }))).toEqual(["b"]);
  });
  it("combinados", () => {
    expect(ids(filterTasks(rows, { text: "tests", status: "failed", agent: "asistente" }))).toEqual(["b"]);
    expect(ids(filterTasks(rows, { text: "tests", agent: "programador" }))).toEqual([]);
  });
});

describe("modo sombra: actualRoute", () => {
  it("sin encargos, lo hizo Opus; con programador, programador; solo asistentes, asistente", () => {
    expect(actualRoute(mkRun([]))).toBe("opus");
    expect(actualRoute(full())).toBe("programador");
    expect(actualRoute(mkRun([task("asistente", "claude-haiku-5-5", {}), task("asistente", "claude-haiku-5-5", {})]))).toBe("asistente");
  });
  it("null si sigue en curso o no hay ejecución", () => {
    expect(actualRoute(mkRun([], { status: "running" }))).toBeNull();
    expect(actualRoute(null)).toBeNull();
  });
});

const shadow = (over = {}) => ({ model: "typesafe/jev-1.13", choice: "asistente", confidence: 0.85, reason: "Tarea mecánica", latencyMs: 400, costUsd: 0.001, error: null, t: 1, ...over });
// full(): real = 0,2 + 0,1·... se calcula abajo con costBreakdown para no repetir precios.

describe("modo sombra: shadowVerdict", () => {
  it("sin shadow: sin veredicto y sin pendiente si ya terminó", () => {
    const v = shadowVerdict(full());
    expect(v.choice).toBeNull();
    expect(v.pending).toBe(false);
    expect(v.savingsUsd).toBeNull();
  });
  it("pendiente: en curso y sin shadow todavía", () => {
    expect(shadowVerdict(mkRun([], { status: "running" })).pending).toBe(true);
    expect(shadowVerdict(mkRun([], { status: "running", shadow: shadow() })).pending).toBe(false);
  });
  it("con error: lo expone y no calcula ahorro", () => {
    const v = shadowVerdict({ ...full(), shadow: shadow({ choice: null, error: "timeout", costUsd: null }) });
    expect(v.error).toBe("timeout");
    expect(v.choice).toBeNull();
    expect(v.match).toBeNull();
    expect(v.hypotheticalUsd).toBeNull();
  });
  it("no coincide: Jev dice asistente y Opus delegó en programador; estima todo con Haiku más la llamada a Jev", () => {
    const run = { ...full(), shadow: shadow() };
    const v = shadowVerdict(run);
    expect(v).toMatchObject({ choice: "asistente", actual: "programador", match: false, confidence: 0.85, reason: "Tarea mecánica", pending: false });
    // tokens: entrada 1M+1M+100k, salida 100k+50k a precios de Haiku 5.5 (0,1 / 0,5)
    expect(v.hypotheticalUsd).toBeCloseTo((2.1 * 0.1) + (0.15 * 0.5) + 0.001, 6);
    expect(v.actualUsd).toBeCloseTo(costBreakdown(run).total, 9);
    expect(v.savingsUsd).toBeCloseTo(v.actualUsd - v.hypotheticalUsd, 9);
    expect(v.savingsUsd).toBeGreaterThan(0);
  });
  it("coincide: ejecución sin encargos y Jev dice opus", () => {
    const run = mkRun([], { orchestratorUsage: { "claude-opus-5-5": u(M, 0) }, shadow: shadow({ choice: "opus", costUsd: 0.002 }) });
    const v = shadowVerdict(run);
    expect(v.match).toBe(true);
    expect(v.actual).toBe("opus");
    expect(v.savingsUsd).toBeCloseTo(-0.002, 9); // mismo modelo: solo cuesta la llamada a Jev
  });
  it("ahorro negativo cuando el modelo elegido es más caro que lo real", () => {
    const run = mkRun([task("asistente", "claude-haiku-5-5", { "claude-haiku-5-5": u(M) })], { shadow: shadow({ choice: "opus" }) });
    expect(shadowVerdict(run).savingsUsd).toBeLessThan(0);
  });
  it("sin datos de uso no hay estimación", () => {
    const v = shadowVerdict(mkRun([], { shadow: shadow() }));
    expect(v.hypotheticalUsd).toBeNull();
    expect(v.savingsUsd).toBeNull();
  });
});

describe("modo sombra: aggregateShadow", () => {
  const withUsage = (choice, tasks) => mkRun(tasks, { orchestratorUsage: { "claude-opus-5-5": u(M, 0) }, shadow: shadow({ choice, costUsd: 0.001 }) });
  it("cuenta aciertos, matriz, ahorro y coste de Jev; ignora en curso, sin shadow y con error", () => {
    const prog = () => [task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M) })];
    const runs = [
      withUsage("programador", prog()),
      withUsage("asistente", prog()),
      withUsage("opus", []),
      { ...withUsage("asistente", []), status: "running" },
      full(),
      { ...full(), shadow: shadow({ choice: null, error: "timeout", costUsd: null }) }
    ];
    const a = aggregateShadow(runs);
    expect(a.n).toBe(3);
    expect(a.matches).toBe(2);
    expect(a.matchPct).toBeCloseTo(66.666, 2);
    expect(a.byPair).toEqual({ programador: { programador: 1 }, asistente: { programador: 1 }, opus: { opus: 1 } });
    expect(a.errors).toBe(1);
    expect(a.jevCostUsd).toBeCloseTo(0.003, 9);
    const sum = runs.slice(0, 3).reduce((x, r) => x + shadowVerdict(r).savingsUsd, 0);
    expect(a.savingsUsd).toBeCloseTo(sum, 9);
  });
  it("vacío: n = 0 y porcentaje null", () => {
    expect(aggregateShadow([])).toMatchObject({ n: 0, matches: 0, matchPct: null, byPair: {}, savingsUsd: 0, jevCostUsd: 0, errors: 0 });
  });
});

describe("runTotals", () => {
  it("resume encargos, duración, coste y tokens de una ejecución con todos los datos", () => {
    const t = runTotals(full(), 99_999);
    expect(t).toMatchObject({ tasks: 2, durationMs: 9000, hasUsage: true, partial: false, tokens: 2_250_000 });
    expect(t.costUsd).toBeCloseTo(4.5, 6);
  });

  it("en curso, la duración llega hasta ahora", () => {
    expect(runTotals(mkRun([], { status: "running", endedAt: null, startedAt: 1000 }), 6000).durationMs).toBe(5000);
  });

  it("sin datos de uso no hay coste ni tokens y no se marca parcial", () => {
    const t = runTotals(mkRun([task("programador", "claude-sonnet-5-5", undefined)]), 0);
    expect(t).toMatchObject({ tasks: 1, hasUsage: false, costUsd: null, tokens: null, partial: false });
  });

  it("con datos pero incompletos se marca parcial", () => {
    const run = mkRun([task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M) }), task("asistente", "claude-haiku-5-5", undefined)]);
    expect(runTotals(run, 0)).toMatchObject({ hasUsage: true, partial: true });
  });

  it("el coste que reporta el stream cuenta como dato completo", () => {
    const t = runTotals(mkRun([], { usage: { costUsd: 0.21 } }), 0);
    expect(t).toMatchObject({ hasUsage: true, costUsd: 0.21, partial: false, tokens: null });
  });
});

describe("agregados por perfil", () => {
  const prog = () => [task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M) })];
  const sh = (choice) => mkRun(prog(), { orchestratorUsage: { "claude-opus-5-5": u(M, 0) }, shadow: shadow({ choice, costUsd: 0.001 }) });
  it("ahorro: separa trabajo y personal; sin profile cuenta como trabajo; trabajo primero", () => {
    const by = aggregateSavingsByProfile([{ ...full(), profile: "personal" }, full(), full(), { ...full(), profile: "trabajo" }]);
    expect(Object.keys(by)).toEqual(["trabajo", "personal"]);
    expect(by.trabajo.runs).toBe(3);
    expect(by.personal.runs).toBe(1);
    expect(by.personal).toEqual(aggregateSavings([full()]));
    expect(by.trabajo).toEqual(aggregateSavings([full(), full(), full()]));
  });
  it("ahorro: un perfil sin datos no aparece y los demás van en orden alfabético", () => {
    const sinDatos = mkRun([task("programador", null, undefined)], { profile: "personal" });
    expect(Object.keys(aggregateSavingsByProfile([sinDatos, full()]))).toEqual(["trabajo"]);
    expect(Object.keys(aggregateSavingsByProfile([{ ...full(), profile: "zeta" }, { ...full(), profile: "alfa" }, full()]))).toEqual(["trabajo", "alfa", "zeta"]);
    expect(aggregateSavingsByProfile([])).toEqual({});
    expect(aggregateSavingsByProfile(undefined)).toEqual({});
  });
  it("sombra: separa por perfil, sin profile es trabajo, y omite perfiles sin comparables", () => {
    const runs = [sh("programador"), { ...sh("asistente"), profile: "personal" }, { ...sh("programador"), profile: "personal" }, { ...full(), profile: "otro" }];
    const by = aggregateShadowByProfile(runs);
    expect(Object.keys(by)).toEqual(["trabajo", "personal"]);
    expect(by.trabajo).toMatchObject({ n: 1, matches: 1 });
    expect(by.personal).toMatchObject({ n: 2, matches: 1 });
    expect(by.personal).toEqual(aggregateShadow(runs.slice(1, 3)));
    expect(aggregateShadowByProfile([])).toEqual({});
  });
});

describe("etiquetas de entrenamiento: trainingLabel", () => {
  it("automática: lo que hizo Opus, solo en ejecuciones completadas", () => {
    expect(trainingLabel(full())).toEqual({ label: "programador", source: "auto" });
    expect(trainingLabel(mkRun([task("consultor", "claude-opus-5-5", undefined)]))).toEqual({ label: "opus", source: "auto" });
    expect(trainingLabel(mkRun([task("propio", "claude-opus-5-5", undefined, { agent: "Explore" })]))).toEqual({ label: "opus", source: "auto" });
    expect(trainingLabel(mkRun([], { status: "failed" }))).toBeNull();
    expect(trainingLabel(mkRun([], { status: "running" }))).toBeNull();
    expect(trainingLabel(null)).toBeNull();
  });
  it("manda la corrección del usuario, también en una ejecución no completada", () => {
    const fix = { label: "asistente", t: 5 };
    expect(trainingLabel({ ...full(), routeLabel: fix })).toEqual({ label: "asistente", source: "usuario" });
    expect(trainingLabel(mkRun([], { status: "failed", routeLabel: fix }))).toEqual({ label: "asistente", source: "usuario" });
    expect(trainingLabel({ ...full(), routeLabel: null })).toEqual({ label: "programador", source: "auto" });
  });
});

describe("trainingLabel: ejecuciones sin ningún subagente", () => {
  it("se excluyen (ruido: Opus lo hizo todo sin delegar), aunque actualRoute siga diciendo opus", () => {
    expect(trainingLabel(mkRun([]))).toBeNull();
    expect(trainingLabel({ ...mkRun([]), taskOrder: undefined, tasks: undefined })).toBeNull();
    expect(actualRoute(mkRun([]))).toBe("opus");
  });
  it("con corrección manual del usuario se incluyen", () => {
    expect(trainingLabel(mkRun([], { routeLabel: { label: "opus", t: 1 } }))).toEqual({ label: "opus", source: "usuario" });
  });
});

describe("modo sombra con corrección manual", () => {
  it("el acierto se mide contra la etiqueta del usuario, no contra lo que hizo Opus", () => {
    const base = { ...full(), shadow: shadow({ choice: "asistente" }) };
    expect(shadowVerdict(base)).toMatchObject({ actual: "programador", target: "programador", match: false });
    const fixed = { ...base, routeLabel: { label: "asistente", t: 9 } };
    expect(shadowVerdict(fixed)).toMatchObject({ actual: "programador", target: "asistente", targetSource: "usuario", match: true });
  });
  it("aggregateShadow cuenta y reparte por la etiqueta buena", () => {
    const run = { ...full(), shadow: shadow({ choice: "asistente" }), routeLabel: { label: "asistente", t: 9 } };
    const a = aggregateShadow([run]);
    expect(a.matches).toBe(1);
    expect(a.byPair).toEqual({ asistente: { asistente: 1 } });
  });
});

describe("trainingSummary", () => {
  it("cuenta etiquetas, corregidas y reparto por clase", () => {
    const runs = [
      full(), // programador auto
      mkRun([task("consultor", "claude-opus-5-5", undefined)]), // opus auto
      mkRun([]), // sin subagentes: fuera
      { ...full(), routeLabel: { label: "asistente", t: 1 } }, // asistente usuario
      mkRun([], { status: "failed" }), // sin etiqueta
      mkRun([], { status: "running" })
    ];
    expect(trainingSummary(runs)).toEqual({ n: 3, corrected: 1, byLabel: { asistente: 1, programador: 1, opus: 1 } });
    expect(trainingSummary([])).toEqual({ n: 0, corrected: 0, byLabel: { asistente: 0, programador: 0, opus: 0 } });
  });
  it("aggregateShadow lo incluye aunque no haya datos de sombra", () => {
    expect(aggregateShadow([full()]).training).toMatchObject({ n: 1 });
    const withShadow = { ...full(), shadow: shadow() };
    expect(aggregateShadowByProfile([withShadow, full()]).trabajo.training.n).toBe(2);
  });
});

describe("classifierName", () => {
  it("Laya si el modelo contiene laya, sin distinguir mayúsculas", () => {
    expect(classifierName("convaiinnovations/laya-multilingual")).toBe("Laya");
    expect(classifierName("LAYA-X")).toBe("Laya");
  });
  it("Jev si el modelo contiene jev", () => {
    expect(classifierName("typesafe/jev-1.13")).toBe("Jev");
  });
  it("Clasificador en cualquier otro modelo", () => {
    expect(classifierName("otro/modelo-x")).toBe("Clasificador");
  });
  it("null y undefined dan Clasificador", () => {
    expect(classifierName(null)).toBe("Clasificador");
    expect(classifierName(undefined)).toBe("Clasificador");
  });
});

describe("modo sombra: aggregateShadow name", () => {
  const counted = (startedAt, model, choice = "opus") => mkRun([], { startedAt, shadow: shadow({ model, choice }) });
  it("sin ejecuciones comparables devuelve Clasificador", () => {
    expect(aggregateShadow([]).name).toBe("Clasificador");
    expect(aggregateShadow([full()]).name).toBe("Clasificador");
  });
  it("toma el modelo de la ejecución más reciente (mayor startedAt) del agregado", () => {
    const runs = [
      counted(100, "typesafe/jev-1.13"),
      counted(300, "convaiinnovations/laya-multilingual"),
      counted(200, "typesafe/jev-1.13")
    ];
    expect(aggregateShadow(runs).name).toBe("Laya");
    expect(aggregateShadow([...runs].reverse()).name).toBe("Laya");
  });
  it("ignora las más recientes que no entran en el agregado (en curso o con error)", () => {
    const enCurso = { ...counted(500, "convaiinnovations/laya-multilingual"), status: "running", endedAt: null };
    const conError = mkRun([], { startedAt: 400, shadow: shadow({ model: "typesafe/jev-1.13", choice: null, error: "timeout", costUsd: null }) });
    expect(aggregateShadow([counted(100, "typesafe/jev-1.13"), enCurso, conError]).name).toBe("Jev");
  });
});

describe("modo sombra: solo cuenta el clasificador actual", () => {
  const LAYA = "convaiinnovations/laya-multilingual";
  const JEV = "typesafe/jev-1.13";
  const ok = (startedAt, model, choice = "opus") => mkRun([], { startedAt, shadow: shadow({ model, choice, costUsd: 0.001 }) });
  const fail = (startedAt, model) => mkRun([], { startedAt, shadow: shadow({ model, choice: null, error: "HTTP 402", costUsd: null }) });
  const runs = [ok(100, JEV), fail(150, JEV), fail(160, JEV), ok(300, LAYA), ok(400, LAYA, "asistente"), fail(450, LAYA)];
  it("aciertos, coste y fallos solo de Laya; Jev va a others", () => {
    const a = aggregateShadow(runs);
    expect(a.name).toBe("Laya");
    expect(a.n).toBe(2);
    expect(a.matches).toBe(1);
    expect(a.errors).toBe(1);
    expect(a.jevCostUsd).toBeCloseTo(0.002, 9);
    expect(a.byPair).toEqual({ opus: { opus: 1 }, asistente: { opus: 1 } });
    expect(a.others).toEqual([{ name: "Jev", n: 3 }]);
  });
  it("sin otros clasificadores, others vacío", () => {
    expect(aggregateShadow([ok(1, LAYA)]).others).toEqual([]);
    expect(aggregateShadow([]).others).toEqual([]);
  });
  it("el contador de entrenamiento no depende del clasificador", () => {
    const labelled = runs.map((r) => ({ ...r, routeLabel: { label: "opus", t: 1 } })); // sin subagentes solo cuentan las corregidas
    expect(aggregateShadow(labelled).training.n).toBe(runs.length);
  });
  it("por perfil también", () => {
    const by = aggregateShadowByProfile(runs.map((r) => ({ ...r, profile: "trabajo" })));
    expect(by.trabajo.errors).toBe(1);
    expect(by.trabajo.others).toEqual([{ name: "Jev", n: 3 }]);
  });
});

describe("gasto por modelo real, no por rol", () => {
  const explore = (usage, over = {}) => task("propio", "claude-opus-5-5", usage, { agent: "Explore", ...over });
  const orch = { "claude-opus-5-5": u(M) }; // 4 $
  it("un Explore en Opus suma a Opus, no a Sonnet", () => {
    const r = mkRun([explore({ "claude-opus-5-5": u(M) }), task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M) })], { orchestratorUsage: orch });
    expect(spendByFamily(r)).toEqual({ opus: 8, sonnet: 2, haiku: 0 });
    expect(spendShare(r)).toEqual({ opus: 80, sonnet: 20, haiku: 0 });
  });
  it("general-purpose en Sonnet suma a Sonnet", () => {
    const r = mkRun([task("propio", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(M) }, { agent: "general-purpose" })], { orchestratorUsage: orch });
    expect(spendShare(r)).toEqual({ opus: 67, sonnet: 33, haiku: 0 });
  });
  it("un rol con modelo distinto al esperado respeta el modelo real", () => {
    const r = mkRun([task("programador", "claude-opus-5-5", { "claude-opus-5-5": u(M) })], { orchestratorUsage: orch });
    expect(spendShare(r)).toEqual({ opus: 100, sonnet: 0, haiku: 0 });
  });
  it("asistente y programador en su modelo suman a su barra", () => {
    expect(spendShare(full())).toEqual({ opus: 31, sonnet: 67, haiku: 2 });
  });
  it("el desglose por rol separa los subagentes propios", () => {
    const r = mkRun([explore({ "claude-opus-5-5": u(M) })], { orchestratorUsage: orch });
    const b = costBreakdown(r);
    expect(b.propio.costUsd).toBeCloseTo(4);
    expect(b.programador.costUsd).toBe(0);
    expect(b.total).toBeCloseTo(8);
  });
  it("ejecución antigua sin modelo en el encargo ni uso: sin datos y sin romper", () => {
    const r = mkRun([task("programador", null, undefined, { agent: undefined })]);
    expect(spendByFamily(r)).toEqual({ opus: 0, sonnet: 0, haiku: 0 });
    expect(spendShare(r)).toBeNull();
    expect(spendByFamily(null)).toEqual({ opus: 0, sonnet: 0, haiku: 0 });
  });
  it("spendUnknown: un propio sin uso es desconocido en Opus; un rol, en su barra", () => {
    const r = mkRun([explore(undefined, { status: "running" }), task("programador", null, undefined, { status: "running" })]);
    expect(spendUnknown(r)).toEqual({ opus: true, sonnet: true, haiku: false });
    expect(spendUnknown(mkRun([explore({ "claude-opus-5-5": u(1) })]))).toEqual({ opus: false, sonnet: false, haiku: false });
  });
  it("el desglose por rol separa el consultor (Opus) de programador y propios", () => {
    const r = mkRun([task("consultor", "claude-opus-5-5", { "claude-opus-5-5": u(M) }, { agent: "consultor" })], { orchestratorUsage: orch });
    const b = costBreakdown(r);
    expect(b.consultor.costUsd).toBeCloseTo(4);
    expect(b.programador.costUsd).toBe(0);
    expect(b.propio.costUsd).toBe(0);
    expect(b.total).toBeCloseTo(8);
    expect(spendShare(r)).toEqual({ opus: 100, sonnet: 0, haiku: 0 });
  });
  it("spendUnknown: un consultor sin uso ni modelo es desconocido en Opus", () => {
    const r = mkRun([task("consultor", null, undefined, { status: "running" })]);
    expect(spendUnknown(r)).toEqual({ opus: true, sonnet: false, haiku: false });
  });
  it("actualRoute: el consultor lo lleva Opus, como los propios", () => {
    expect(actualRoute(mkRun([task("consultor", "claude-opus-5-5", undefined)]))).toBe("opus");
    expect(actualRoute(mkRun([task("consultor", "claude-opus-5-5", undefined), task("asistente", "claude-haiku-5-5", undefined)]))).toBe("asistente");
  });
  it("actualRoute: solo subagentes propios = lo llevó Opus", () => {
    expect(actualRoute(mkRun([explore(undefined)]))).toBe("opus");
  });
});

describe("tokensByFamily y tokenShare (uso)", () => {
  const run = () => mkRun([
    task("programador", "claude-sonnet-5-5", { "claude-sonnet-5-5": u(100, 50, 800, 30, 20) }),
    task("asistente", "claude-haiku-5-5", { "claude-haiku-5-5": u(10, 10, 0, 0, 0) })
  ], { orchestratorUsage: { "claude-opus-5-5": u(100, 100, 600, 100, 0) } });
  it("suma input+output+cacheRead+cacheWrite(5m+1h) por familia, y los nuevos sin cacheRead", () => {
    expect(tokensByFamily(run())).toEqual({
      opus: { total: 900, fresh: 300 }, sonnet: { total: 1000, fresh: 200 }, haiku: { total: 20, fresh: 20 }
    });
  });
  it("reparte en % que suman 100 e incluye absolutos", () => {
    const s = tokenShare(run());
    expect(s).toMatchObject({ opus: 47, sonnet: 52, haiku: 1 });
    expect(s.opus + s.sonnet + s.haiku).toBe(100);
    expect(s.tokens).toEqual({ opus: 900, sonnet: 1000, haiku: 20 });
    expect(s.fresh).toEqual({ opus: 300, sonnet: 200, haiku: 20 });
  });
  it("un Explore en Opus cuenta como Opus; sin usage devuelve null", () => {
    const r = mkRun([task("propio", "claude-opus-5-5", { "claude-opus-5-5": u(10) }, { agent: "Explore" })]);
    expect(tokenShare(r)).toMatchObject({ opus: 100, sonnet: 0, haiku: 0 });
    expect(tokenShare(mkRun([task("programador", null, undefined)]))).toBeNull();
    expect(tokenShare(null)).toBeNull();
  });
  it("usageTitle muestra totales y nuevos por modelo", () => {
    const t = usageTitle({ tokens: { opus: 1500, sonnet: 2000, haiku: 5 }, fresh: { opus: 300, sonnet: 200, haiku: 5 } });
    expect(t).toContain("Opus 1,5 k (nuevos 300)");
    expect(t).toContain("Sonnet 2 k (nuevos 200)");
    expect(t).toContain("Haiku 5 (nuevos 5)");
  });
});
