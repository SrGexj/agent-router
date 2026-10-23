import { describe, it, expect } from "vitest";
import {
  CONTEXT_WARN, CONTEXT_CRITICAL, WINDOW_DEFAULT, WINDOW_1M,
  contextWindowFor, contextTokens, contextState, contextFromStatusline, sameContext, runContext, CO_AUTOCOMPACT_WINDOW,
  parseCompactBoundary, compactSummaryChars, compactionsFromTranscript,
  compactionUsage, compactionCost, summarizeCompactions, contextAdvice, runBusy, BUSY_MS, CONTEXT_HELP
} from "../src/core/compaction.mjs";
import { reduceRun } from "../src/core/reducer.mjs";
import { costBreakdown } from "../src/core/details.mjs";
import { costOf, emptyUsage } from "../src/core/pricing.mjs";

const line = (o) => JSON.stringify(o);
const boundary = (extra = {}, meta = {}) => ({
  type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-01T10:00:00.000Z", isSidechain: false,
  compactMetadata: { trigger: "auto", preTokens: 900000, postTokens: 20000, durationMs: 90000, ...meta }, ...extra
});
const summary = (chars) => ({ type: "user", isCompactSummary: true, message: { role: "user", content: "x".repeat(chars) } });
const asst = (id, model, usage) => ({ type: "assistant", message: { id, model, usage } });

describe("ventana de contexto", () => {
  it("1M con [1m] en el modelo, 200k si no", () => {
    expect(contextWindowFor("claude-opus-5-5[1m]")).toBe(WINDOW_1M);
    expect(contextWindowFor("claude-opus-5-5")).toBe(WINDOW_DEFAULT);
    expect(contextWindowFor(null)).toBe(WINDOW_DEFAULT);
  });
  it("un tamaño informado por Claude Code manda sobre el nombre", () => {
    expect(contextWindowFor("claude-opus-5-5", 1_000_000)).toBe(1_000_000);
  });
  it("si el contexto ya supera la ventana supuesta, es de 1M", () => {
    expect(contextWindowFor("claude-opus-5-5", null, 450_000)).toBe(WINDOW_1M);
  });
});

describe("contexto actual", () => {
  it("suma input + cache read + cache creation del último turno (no el output)", () => {
    expect(contextTokens({ input_tokens: 2, output_tokens: 999, cache_read_input_tokens: 100, cache_creation_input_tokens: 30 })).toBe(132);
    expect(contextTokens({ input: 2, output: 999, cacheRead: 100, cacheWrite5m: 10, cacheWrite1h: 20 })).toBe(132);
    expect(contextTokens(null)).toBe(0);
  });

  it("umbrales: ok por debajo del 80 %, aviso desde el 80 %, crítico desde el 90 %", () => {
    expect(CONTEXT_WARN).toBe(0.8);
    expect(CONTEXT_CRITICAL).toBe(0.9);
    const at = (tokens) => contextState({ tokens, model: "claude-opus-5-5" });
    expect(at(159_999)).toMatchObject({ window: 200_000, level: "ok" });
    expect(at(160_000)).toMatchObject({ pct: 80, level: "warn" });
    expect(at(179_999).level).toBe("warn");
    expect(at(180_000)).toMatchObject({ pct: 90, level: "critical" });
  });

  it("el límite efectivo (autocompact) adelanta el aviso sin cambiar la ventana", () => {
    const s = contextState({ tokens: 210_000, model: "claude-opus-5-5[1m]", limit: 250_000 });
    expect(s).toMatchObject({ window: 1_000_000, limit: 250_000, level: "warn" });
    expect(s.pct).toBe(84);
  });

  it("sin datos no hay estado", () => {
    expect(contextState({ tokens: 0, model: "x" })).toBeNull();
    expect(contextState(null)).toBeNull();
  });

  it("contextFromStatusline lee current_usage y el tamaño de ventana", () => {
    const input = { model: { id: "claude-opus-5-5[1m]" }, context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 9 } } };
    expect(contextFromStatusline(input, 7)).toEqual({ type: "context", tokens: 210, model: "claude-opus-5-5[1m]", window: 1_000_000, t: 7 });
    expect(contextFromStatusline({ model: { id: "m" } }, 7)).toBeNull();
    expect(contextFromStatusline({ context_window: { current_usage: null } }, 7)).toBeNull();
    expect(contextFromStatusline(null, 7)).toBeNull();
  });
});

describe("runContext", () => {
  it("mide contra la ventana de autocompact de las sesiones co y es null sin datos", () => {
    expect(CO_AUTOCOMPACT_WINDOW).toBe(250_000);
    expect(runContext({ context: { tokens: 230_000, model: "claude-opus-5-5[1m]", window: 1_000_000 } })).toMatchObject({ pct: 92, level: "critical", window: 1_000_000 });
    expect(runContext({})).toBeNull();
    expect(runContext(null)).toBeNull();
  });
  it("buildCoSettings usa la misma constante", async () => {
    const { buildCoSettings } = await import("../src/core/install.mjs");
    expect(buildCoSettings({ node: "n", appRoot: "/r" }).autoCompactWindow).toBe(CO_AUTOCOMPACT_WINDOW);
  });
});

describe("sameContext", () => {
  const a = { tokens: 100_000, model: "m", window: null };
  it("ignora cambios de menos del 1 % de la ventana y detecta el resto", () => {
    expect(sameContext(a, { ...a, tokens: 101_000 })).toBe(true);
    expect(sameContext(a, { ...a, tokens: 103_000 })).toBe(false);
    expect(sameContext(a, { ...a, model: "otro" })).toBe(false);
    expect(sameContext(a, { ...a, window: 1_000_000 })).toBe(false);
    expect(sameContext(null, a)).toBe(false);
  });
});

describe("detección de la compactación en el transcript", () => {
  it("parsea compact_boundary: trigger, tokens antes/después, duración e id", () => {
    expect(parseCompactBoundary(boundary())).toEqual({
      id: "b1", trigger: "auto", preTokens: 900000, postTokens: 20000, durationMs: 90000, t: Date.parse("2026-10-01T10:00:00.000Z")
    });
    expect(parseCompactBoundary(boundary({}, { trigger: "manual" })).trigger).toBe("manual");
  });
  it("ignora lo que no es un límite de compactación o viene del subagente", () => {
    expect(parseCompactBoundary({ type: "system", subtype: "turn_duration" })).toBeNull();
    expect(parseCompactBoundary({ type: "assistant" })).toBeNull();
    expect(parseCompactBoundary(boundary({ isSidechain: true }))).toBeNull();
    expect(parseCompactBoundary(boundary({ compactMetadata: undefined }))).toBeNull();
    expect(parseCompactBoundary(null)).toBeNull();
  });
  it("mide el mensaje resumen (string o bloques de texto)", () => {
    expect(compactSummaryChars(summary(120))).toBe(120);
    expect(compactSummaryChars({ type: "user", isCompactSummary: true, message: { content: [{ type: "text", text: "abc" }, { type: "text", text: "de" }] } })).toBe(5);
    expect(compactSummaryChars({ type: "user", message: { content: "x" } })).toBeNull();
  });

  it("compactionsFromTranscript une límite, resumen y modelo del último turno anterior", () => {
    const text = [
      line(asst("m1", "claude-opus-5-5", { input_tokens: 2, output_tokens: 1 })),
      line(asst("s", "<synthetic>", { input_tokens: 0, output_tokens: 0 })),
      line(boundary()),
      line(summary(9000)),
      "línea rota {",
      line(boundary({ uuid: "b2" }, { trigger: "manual", preTokens: 100000 })),
      line(summary(3000))
    ].join("\n");
    const recs = compactionsFromTranscript(text);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ id: "b1", trigger: "auto", summaryChars: 9000, model: "claude-opus-5-5" });
    expect(recs[1]).toMatchObject({ id: "b2", trigger: "manual", preTokens: 100000, summaryChars: 3000, model: "claude-opus-5-5" });
  });
  it("sin resumen visible deja summaryChars en null", () => {
    expect(compactionsFromTranscript(line(boundary()))[0].summaryChars).toBeNull();
    expect(compactionsFromTranscript("")).toEqual([]);
  });
});

describe("coste de la compactación", () => {
  const rec = { id: "b1", trigger: "auto", preTokens: 900000, postTokens: 20000, durationMs: 1, t: 1, summaryChars: 9000, model: "claude-opus-5-5" };
  it("entrada = contexto previo leído de caché; salida estimada por el tamaño del resumen", () => {
    expect(compactionUsage(rec)).toEqual({ ...emptyUsage(), cacheRead: 900000, output: 3000 });
    expect(compactionUsage({ ...rec, summaryChars: null })).toMatchObject({ output: 20000 }); // sin resumen: postTokens
  });
  it("coste con la tabla de precios del modelo; null si el modelo no se conoce", () => {
    const expected = costOf("claude-opus-5-5", { ...emptyUsage(), cacheRead: 900000, output: 3000 });
    expect(compactionCost(rec)).toBeCloseTo(expected, 10);
    expect(compactionCost({ ...rec, model: "modelo-raro" })).toBeNull();
  });

  it("resumen: número, tokens, coste y % sobre el gasto total (resto + compactaciones)", () => {
    const s = summarizeCompactions([rec, { ...rec, id: "b2", trigger: "manual" }], 10);
    const each = compactionCost(rec);
    expect(s.count).toBe(2);
    expect(s.auto).toBe(1);
    expect(s.manual).toBe(1);
    expect(s.costUsd).toBeCloseTo(2 * each, 10);
    expect(s.tokens).toBe(2 * (900000 + 3000));
    expect(s.pct).toBeCloseTo((2 * each) / (10 + 2 * each) * 100, 10);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ id: "b1", costUsd: each, tokens: 903000 });
  });
  it("sin compactaciones, null; con gasto 0 el porcentaje es 100 y sin coste conocido null", () => {
    expect(summarizeCompactions([], 5)).toBeNull();
    expect(summarizeCompactions(undefined, 5)).toBeNull();
    expect(summarizeCompactions([{ ...rec, model: "raro" }], 5).pct).toBeNull();
    expect(summarizeCompactions([rec], 0).pct).toBe(100);
  });
});

describe("reducer: contexto y compactaciones", () => {
  const start = { type: "run_start", runId: "r", task: "t", mode: "sesion", model: "opus", t: 1 };
  const run0 = reduceRun(null, start);
  it("context guarda el último contexto", () => {
    const r = reduceRun(reduceRun(run0, { type: "context", tokens: 5, model: "m", window: null, t: 2 }), { type: "context", tokens: 9, model: "m", window: 1000, t: 3 });
    expect(r.context).toEqual({ tokens: 9, model: "m", window: 1000, t: 3 });
    expect(reduceRun(null, { type: "context", tokens: 1 })).toBeNull();
  });
  it("compact_stats hace upsert por id", () => {
    const a = { id: "b1", trigger: "auto", preTokens: 1, postTokens: 1, durationMs: 1, t: 1, summaryChars: null, model: "m" };
    let r = reduceRun(run0, { type: "compact_stats", records: [a], t: 2 });
    r = reduceRun(r, { type: "compact_stats", records: [{ ...a, summaryChars: 50 }, { ...a, id: "b2" }], t: 3 });
    expect(r.compactStats.map((c) => c.id)).toEqual(["b1", "b2"]);
    expect(r.compactStats[0].summaryChars).toBe(50);
  });
});

describe("costBreakdown con compactaciones", () => {
  it("las compactaciones van aparte: no cambian total ni roles", () => {
    const base = reduceRun(null, { type: "run_start", runId: "r", task: "t", mode: "sesion", model: "opus", t: 1 });
    const withU = reduceRun(base, { type: "orchestrator_usage", byModel: { "claude-opus-5-5": { input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: 2 });
    const rec = { id: "b1", trigger: "auto", preTokens: 900000, postTokens: 20000, durationMs: 1, t: 1, summaryChars: 9000, model: "claude-opus-5-5" };
    const withC = reduceRun(withU, { type: "compact_stats", records: [rec], t: 3 });
    const a = costBreakdown(withU);
    const b = costBreakdown(withC);
    expect(b.total).toBe(a.total);
    expect(b.orchestrator.costUsd).toBe(a.orchestrator.costUsd);
    expect(a.compactions).toBeNull();
    expect(b.compactions.count).toBe(1);
    expect(b.compactions.pct).toBeGreaterThan(50);
  });
});

describe("contextAdvice", () => {
  it("bajo 80: sin aviso", () => {
    expect(contextAdvice(79, true)).toEqual({ level: "ok", text: null });
    expect(contextAdvice(79, false)).toEqual({ level: "ok", text: null });
  });
  it("80 ocioso: buen momento para /clear (ámbar)", () => {
    expect(contextAdvice(80, false)).toEqual({ level: "warn", text: "buen momento para /clear" });
  });
  it("80 trabajando: compactar pronto", () => {
    expect(contextAdvice(80, true)).toEqual({ level: "warn", text: "compactar pronto" });
  });
  it("90 ocioso: haz /clear (rojo)", () => {
    expect(contextAdvice(90, false)).toEqual({ level: "critical", text: "haz /clear" });
  });
  it("90 trabajando: compacta ya", () => {
    expect(contextAdvice(90, true)).toEqual({ level: "critical", text: "compacta ya" });
  });
  it("hay ayuda corta", () => {
    expect(CONTEXT_HELP).toBe("Tarea cerrada y memoria al día → /clear. A mitad de tarea → deja que compacte.");
  });
});

describe("runBusy", () => {
  const base = { status: "running", waiting: null, updatedAt: 1000, taskOrder: [], tasks: {} };
  it("sin ejecución: ocioso", () => expect(runBusy(null, 0)).toBe(false));
  it("encargo running: trabajando aunque haya silencio", () => {
    const r = { ...base, taskOrder: ["a"], tasks: { a: { status: "running" } } };
    expect(runBusy(r, 1000 + BUSY_MS * 10)).toBe(true);
  });
  it("actividad reciente: trabajando", () => expect(runBusy(base, 1000 + BUSY_MS - 1)).toBe(true));
  it("silencio: ocioso", () => expect(runBusy(base, 1000 + BUSY_MS)).toBe(false));
  it("esperando al usuario o completada: ocioso", () => {
    expect(runBusy({ ...base, waiting: { kind: "q" } }, 1001)).toBe(false);
    expect(runBusy({ ...base, status: "completed" }, 1001)).toBe(false);
  });
});
