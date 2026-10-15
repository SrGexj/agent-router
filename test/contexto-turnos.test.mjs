import { describe, it, expect } from "vitest";
import { advanceContext, startContext } from "../src/core/context.mjs";
import { translateHook } from "../src/core/hooks.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { runContext } from "../src/core/compaction.mjs";
import { loadConfig } from "../src/config.mjs";

const asst = (id, usage, extra = {}, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", timestamp: "2026-10-15T10:00:00.000Z", message: { id, model, usage, content: [] }, ...extra }) + "\n";
const u = (input, read, create, out = 7) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: out });
const T = 1_792_000_000_000;

describe("contexto del orquestador por turno", () => {
  it("un evento por mensaje: entrada + caché leída + caché escrita, con turn y marca de tiempo del mensaje", () => {
    const text = asst("m1", u(2, 1000, 500)) + asst("m2", u(3, 2000, 100));
    const { events, state } = advanceContext(startContext(0), text, T);
    expect(events).toEqual([
      { type: "context", turn: 1, tokens: 1502, model: "claude-opus-5-5", ts: Date.parse("2026-10-15T10:00:00.000Z"), t: T },
      { type: "context", turn: 2, tokens: 2103, model: "claude-opus-5-5", ts: Date.parse("2026-10-15T10:00:00.000Z"), t: T }
    ]);
    expect(state.turn).toBe(2);
  });

  it("varias líneas con el mismo id son un solo turno", () => {
    const { events } = advanceContext(startContext(0), asst("m1", u(1, 10, 0)) + asst("m1", u(1, 10, 0, 99)), T);
    expect(events).toHaveLength(1);
  });

  it("incremental: releer no duplica y una línea a medias espera a la siguiente lectura", () => {
    const l1 = asst("m1", u(1, 10, 0));
    const l2 = asst("m2", u(1, 20, 0));
    const a = advanceContext(startContext(0), l1 + l2.slice(0, 20), T);
    expect(a.events.map((e) => e.turn)).toEqual([1]);
    const b = advanceContext(a.state, l2, T); // lo leído desde state.offset
    expect(b.events.map((e) => e.turn)).toEqual([2]);
    expect(advanceContext(b.state, "", T).events).toEqual([]);
    expect(advanceContext(a.state, l2, T).events.map((e) => e.turn)).toEqual([2]);
  });

  it("ignora subagentes, mensajes sintéticos y sin uso", () => {
    const text = asst("s", u(1, 1, 1), { isSidechain: true }) + asst("y", u(0, 0, 0), {}, "<synthetic>") + asst("z", u(0, 0, 0)) + "basura\n";
    expect(advanceContext(startContext(0), text, T).events).toEqual([]);
  });

  it("el offset avanza en bytes solo sobre líneas completas", () => {
    const l = asst("m1", u(1, 1, 1));
    const { state } = advanceContext(startContext(5), l + "{parcial", T);
    expect(state.offset).toBe(5 + Buffer.byteLength(l));
  });
});

describe("context en los hooks y en el reducer", () => {
  const base = { session_id: "abcdef12", cwd: "/r", transcript_path: "/t" };
  const open1 = () => ({ runId: "r1", lastRunId: "r1", seq: 1, transcriptOffset: 0, lastUsageAt: 0 });
  const ctxEv = (turn, tokens) => ({ type: "context", turn, tokens, model: "claude-opus-5-5", ts: 1, t: T });
  const cm = (contextEvents) => ({ contextEvents, contextState: { offset: 9, turn: 2, recent: [] }, orchestratorUsage: { byModel: {} } });

  it("PostToolUse del orquestador con lectura vencida añade los eventos y recuerda el estado", () => {
    const res = translateHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash" }, open1(), T, () => "x", cm([ctxEv(1, 10), ctxEv(2, 20)]));
    expect(res.events.filter((e) => e.type === "context").map((e) => e.turn)).toEqual([1, 2]);
    expect(res.session.contextState).toEqual({ offset: 9, turn: 2, recent: [] });
  });

  it("Stop los emite antes de run_end", () => {
    const res = translateHook({ ...base, hook_event_name: "Stop", background_tasks: [] }, open1(), T, () => "x", cm([ctxEv(3, 30)]));
    expect(res.events.map((e) => e.type)).toEqual(["context", "run_end"]);
  });

  it("el reducer guarda el último contexto, ignora turnos ya vistos y conserva la ventana de la statusline", () => {
    const run = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 },
      { type: "context", tokens: 1000, model: "m", window: 1_000_000, t: 2 },
      ctxEv(2, 5000), ctxEv(1, 100), ctxEv(2, 5000)
    ]);
    expect(run.context).toMatchObject({ tokens: 5000, turn: 2, window: 1_000_000 });
    expect(runContext(run).tokens).toBe(5000);
  });
});

describe("umbral de aviso del contexto en config", () => {
  it("por defecto 120000 tokens y configurable por ROUTER_CONTEXT_WARN_TOKENS", () => {
    const quiet = { exists: () => false, readFile: () => { throw Object.assign(new Error(), { code: "ENOENT" }); }, warn: () => {} };
    expect(loadConfig({ HOME: "/h" }, quiet).contextWarnTokens).toBe(120_000);
    expect(loadConfig({ HOME: "/h", ROUTER_CONTEXT_WARN_TOKENS: "90000" }, quiet).contextWarnTokens).toBe(90_000);
    expect(loadConfig({ HOME: "/h", ROUTER_CONTEXT_WARN_TOKENS: "abc" }, quiet).contextWarnTokens).toBe(120_000);
    expect(loadConfig({ HOME: "/h", ROUTER_CONTEXT_WARN_TOKENS: "-5" }, quiet).contextWarnTokens).toBe(120_000);
  });
});

describe("aviso del contexto de la ejecución en curso", () => {
  const running = (tokens) => ({ status: "running", context: { tokens, model: "claude-opus-5-5", t: 1 } });

  it("contextWatch: tokens actuales, umbral y si lo supera", async () => {
    const { contextWatch } = await import("../src/core/compaction.mjs");
    expect(contextWatch(running(100_000), 120_000)).toEqual({ tokens: 100_000, warnTokens: 120_000, over: false, pct: 83 });
    expect(contextWatch(running(120_000), 120_000)).toMatchObject({ over: true, pct: 100 });
    expect(contextWatch(running(300_000), 120_000)).toMatchObject({ over: true, pct: 250 });
  });

  it("sin contexto (ejecuciones antiguas) o sin umbral válido no hay aviso", async () => {
    const { contextWatch } = await import("../src/core/compaction.mjs");
    expect(contextWatch({ status: "running" }, 120_000)).toBeNull();
    expect(contextWatch(null, 120_000)).toBeNull();
    expect(contextWatch(running(5), 0)).toBeNull();
  });

  it("solo avisa en una ejecución en curso: terminada, over es false", async () => {
    const { contextWatch } = await import("../src/core/compaction.mjs");
    expect(contextWatch({ ...running(500_000), status: "completed" }, 120_000)).toMatchObject({ over: false });
  });
});
