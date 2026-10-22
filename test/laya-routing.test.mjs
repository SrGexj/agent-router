import { describe, it, expect } from "vitest";
import { decideRouting, layaText, routeAgent, layaDecisionEvent, updatedInputOutput } from "../src/core/laya-routing.mjs";
import { loadConfig } from "../src/config.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { createLayaClassifier, LAYA_MODEL } from "../src/core/classifier.mjs";

describe("modelo propio del enrutado", () => {
  it("la petición usa el modelo indicado y por defecto el multilingüe", async () => {
    const bodies = [];
    const fetch = async (_u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ answers: { route: { choice: "opus", confidence: 0.5 } } }) }; };
    await createLayaClassifier({ url: "u", fetch, model: "encargos" }).classify("x");
    await createLayaClassifier({ url: "u", fetch }).classify("x");
    expect(bodies.map((b) => b.model)).toEqual(["encargos", LAYA_MODEL]);
  });
});

const pre = (input, tool = "Agent", extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra });
const res = (choice, confidence) => ({ choice, confidence });

describe("decideRouting (tabla)", () => {
  const cases = [
    // mode, requested, result, threshold, applied, nota
    ["shadow", "programador", res("asistente", 0.99), 0.9, false, "shadow nunca aplica"],
    ["off", "programador", res("asistente", 0.99), 0.9, false, "off nunca aplica"],
    ["downgrade", "programador", res("asistente", 0.95), 0.9, true, "caso exacto"],
    ["downgrade", "programador", res("asistente", 0.9), 0.9, true, "umbral inclusivo"],
    ["downgrade", "programador", res("asistente", 0.89), 0.9, false, "bajo el umbral"],
    ["downgrade", "programador", res("asistente", null), 0.9, false, "sin confianza"],
    ["downgrade", "programador", res("programador", 0.99), 0.9, false, "misma elección"],
    ["downgrade", "programador", res("opus", 0.99), 0.9, false, "nunca sube"],
    ["downgrade", "asistente", res("opus", 0.99), 0.9, false, "nunca sube desde asistente"],
    ["downgrade", "asistente", res("asistente", 0.99), 0.9, false, "asistente no se toca"],
    ["downgrade", "consultor", res("asistente", 0.99), 0.9, false, "consultor no se baja"],
    ["downgrade", "Explore", res("asistente", 0.99), 0.9, false, "otros tipos no se tocan"],
    ["downgrade", "general-purpose", res("asistente", 0.99), 0.9, false, "general-purpose no se toca"],
    ["downgrade", "programador", null, 0.9, false, "timeout/error"]
  ];
  it.each(cases)("%s %s %j umbral %s -> applied=%s (%s)", (mode, requested, result, threshold, applied) => {
    expect(decideRouting({ mode, requested, result, threshold }).applied).toBe(applied);
  });
});

describe("layaText", () => {
  it("description + salto + prompt, recortado como en el entrenamiento", () => {
    expect(layaText({ description: "Arreglar", prompt: "haz esto" })).toBe("Arreglar\nhaz esto");
    expect(layaText({ prompt: "x".repeat(5000) })).toHaveLength(3999); // sanitizePrompt corta a 4000; el salto inicial se recorta
    expect(layaText({ description: "a", prompt: "<pasted_content>l1\nl2</pasted_content>" })).toBe("a\n[texto pegado: 2 líneas]");
  });
});

describe("routeAgent", () => {
  const input = { description: "d", prompt: "p", subagent_type: "programador", run_in_background: true };
  const classifierOf = (r) => ({ classify: async () => r });
  const times = (...ts) => () => ts.shift();

  it("shadow: registra, no cambia nada", async () => {
    const out = await routeAgent({ payload: pre(input, "Agent", { tool_use_id: "tu1" }), mode: "shadow", threshold: 0.9, classifier: classifierOf({ choice: "asistente", confidence: 0.99, latencyMs: 12 }), now: times(90, 100) });
    expect(out.output).toBeNull();
    expect(out.event).toEqual({ type: "laya_decision", toolUseId: "tu1", requested: "programador", choice: "asistente", confidence: 0.99, latencyMs: 12, mode: "shadow", applied: false, t: 100 });
  });
  it("downgrade: updatedInput completo con subagent_type asistente", async () => {
    const out = await routeAgent({ payload: pre(input), mode: "downgrade", threshold: 0.9, classifier: classifierOf({ choice: "asistente", confidence: 0.95, latencyMs: 3 }), now: () => 1 });
    expect(out.event.applied).toBe(true);
    expect(out.input).toEqual({ ...input, subagent_type: "asistente" });
    expect(out.input).not.toBe(input);
    expect(input.subagent_type).toBe("programador");
    expect(out.output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, subagent_type: "asistente" } } });
  });
  it("error del clasificador: fail-open, sin evento de decisión aplicada", async () => {
    const classifier = { classify: async () => { throw new Error("laya no disponible"); } };
    const out = await routeAgent({ payload: pre(input), mode: "downgrade", threshold: 0.9, classifier, now: times(10, 20) });
    expect(out.output).toBeNull();
    expect(out.event).toMatchObject({ type: "laya_decision", choice: null, confidence: null, applied: false, error: "laya no disponible" });
  });
  it("timeout: Promise.race corta aunque el clasificador no responda", async () => {
    const classifier = { classify: () => new Promise(() => {}) };
    const out = await routeAgent({ payload: pre(input), mode: "downgrade", threshold: 0.9, classifier, timeoutMs: 20, now: () => 1 });
    expect(out.output).toBeNull();
    expect(out.event).toMatchObject({ choice: null, applied: false, error: "timeout" });
  });
  it("modo off, otras herramientas y otros eventos: no consulta", async () => {
    const classifier = { classify: async () => { throw new Error("no debería llamarse"); } };
    expect(await routeAgent({ payload: pre(input), mode: "off", classifier })).toBeNull();
    expect(await routeAgent({ payload: pre(input, "Bash"), mode: "shadow", classifier })).toBeNull();
    expect(await routeAgent({ payload: { ...pre(input), hook_event_name: "PostToolUse" }, mode: "shadow", classifier })).toBeNull();
  });
  it("sin clasificador (Laya sin configurar): no hace nada", async () => {
    expect(await routeAgent({ payload: pre(input), mode: "shadow", classifier: null })).toBeNull();
  });
  it("funciona con Task y sin subagent_type", async () => {
    const out = await routeAgent({ payload: pre({ description: "d", prompt: "p" }, "Task"), mode: "shadow", threshold: 0.9, classifier: classifierOf({ choice: "opus", confidence: 0.8 }), now: () => 1 });
    expect(out.event.requested).toBe("general-purpose");
  });
});

describe("layaDecisionEvent / updatedInputOutput", () => {
  it("omite toolUseId si no existe", () => {
    expect("toolUseId" in layaDecisionEvent({ payload: pre({}), requested: "x", result: null, latencyMs: 1, mode: "shadow", applied: false, t: 1 })).toBe(false);
  });
  it("updatedInputOutput", () => {
    expect(updatedInputOutput({ a: 1 }).hookSpecificOutput.updatedInput).toEqual({ a: 1 });
  });
});

describe("reducer", () => {
  it("cuenta decisiones de Laya y aplicadas", () => {
    const ev = (applied) => ({ type: "laya_decision", requested: "programador", choice: "asistente", confidence: 0.95, latencyMs: 1, mode: "downgrade", applied, t: 2 });
    const run = reduceEvents([{ type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 }, ev(true), ev(false), ev(true)]);
    expect(run.layaDecisions).toBe(3);
    expect(run.layaApplied).toBe(2);
    expect(run.status).toBe("running");
  });
});

describe("config layaRouting", () => {
  const cfg = (env) => loadConfig({ HOME: "/h", ...env }, { exists: () => false, readFile: () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  it("por defecto off, 0.9 y 300 ms", () => {
    const c = cfg({});
    expect([c.layaRouting, c.layaDowngradeThreshold, c.layaTimeoutMs]).toEqual(["off", 0.9, 300]);
  });
  it("lee el entorno", () => {
    const c = cfg({ ROUTER_LAYA_ROUTING: "shadow", ROUTER_LAYA_DOWNGRADE_THRESHOLD: "0.95", ROUTER_LAYA_TIMEOUT_MS: "500" });
    expect([c.layaRouting, c.layaDowngradeThreshold, c.layaTimeoutMs]).toEqual(["shadow", 0.95, 500]);
  });
  it("valores no válidos", () => {
    expect(() => cfg({ ROUTER_LAYA_ROUTING: "raro" })).toThrow(/ROUTER_LAYA_ROUTING/);
    expect(cfg({ ROUTER_LAYA_DOWNGRADE_THRESHOLD: "2", ROUTER_LAYA_TIMEOUT_MS: "x" })).toMatchObject({ layaDowngradeThreshold: 0.9, layaTimeoutMs: 300 });
  });
});
