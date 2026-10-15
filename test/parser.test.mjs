import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createParser } from "../src/core/parser.mjs";

const fixture = readFileSync(new URL("./fixtures/stream-subagente.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

const T = 1_000;
const parseAll = (lines) => {
  const p = createParser();
  return lines.flatMap((l) => p.push(l, T));
};

describe("parser del stream-json de Claude Code", () => {
  it("convierte el stream real con un subagente en eventos normalizados", () => {
    const events = parseAll(fixture);
    const types = events.map((e) => e.type);
    expect(types).toContain("task_start");
    expect(types).toContain("task_end");
    expect(types).toContain("quota");
    expect(types).toContain("usage");

    const start = events.find((e) => e.type === "task_start");
    expect(start).toMatchObject({
      taskId: "b1c2d3e4f5a6b7c8",
      toolUseId: "toolu_01UGCNkWMr43abZqB5y2numf",
      agent: "asistente",
      description: "saludo",
      prompt: "di OK",
      t: T
    });

    const end = events.find((e) => e.type === "task_end");
    expect(end).toMatchObject({
      taskId: "b1c2d3e4f5a6b7c8",
      status: "completed",
      summary: "OK",
      tokens: 2902,
      toolUses: 0,
      durationMs: 1907
    });
  });

  it("atribuye los mensajes del subagente a su encargo y detecta su modelo", () => {
    const events = parseAll(fixture);
    const model = events.find((e) => e.type === "task_model");
    expect(model).toEqual({ type: "task_model", taskId: "b1c2d3e4f5a6b7c8", model: "claude-haiku-5-5", t: T });
    // El texto del subagente no se cuenta como pensamiento del orquestador
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.every((e) => e.taskId === null)).toBe(true);
  });

  it("emite el modelo del hilo principal una sola vez", () => {
    const events = parseAll(fixture);
    const main = events.filter((e) => e.type === "main_model");
    expect(main).toEqual([{ type: "main_model", model: "claude-haiku-5-5", t: T }]);
  });

  it("lee las dos ventanas de cuota del rate_limit_event", () => {
    const quota = parseAll(fixture).filter((e) => e.type === "quota").at(-1);
    expect(quota).toEqual({
      type: "quota",
      status: "allowed_warning",
      limitType: "seven_day",
      fiveHour: { utilization: 0.15, resetsAt: 1792000800 },
      sevenDay: { utilization: 0.32, resetsAt: 1792522800 },
      t: T
    });
  });

  it("acumula el coste por modelo del último result", () => {
    const usage = parseAll(fixture).filter((e) => e.type === "usage").at(-1);
    expect(usage.costUsd).toBeCloseTo(0.20588085);
    expect(usage.byModel["claude-haiku-5-5"]).toMatchObject({ outputTokens: 140, costUsd: 0.20588085 });
  });

  it("marca un error de límite cuando la cuota es rechazada", () => {
    const events = parseAll([{
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected", resetsAt: 1792000800, rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792000800 } }
      }
    }]);
    expect(events.map((e) => e.type)).toEqual(["quota", "error"]);
    expect(events[1]).toMatchObject({ kind: "limit", resetsAt: 1792000800, window: "five_hour" });
  });

  it("detecta el límite de uso en un result con error", () => {
    const events = parseAll([{
      type: "result", subtype: "error_during_execution", is_error: true,
      result: "Claude AI usage limit reached|1792000800", total_cost_usd: 0, modelUsage: {}
    }]);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ kind: "limit", resetsAt: 1792000800 });
  });

  it("convierte otros result con error en error de API", () => {
    const events = parseAll([{ type: "result", is_error: true, result: "Overloaded", modelUsage: {} }]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "api", message: "Overloaded" });
  });

  it("registra permisos denegados del result", () => {
    const events = parseAll([{
      type: "result", is_error: false, modelUsage: {},
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf x" } }]
    }]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "permission", message: "Bash denegado" });
  });

  it("separa herramientas del orquestador y de los subagentes", () => {
    const p = createParser();
    p.push({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", subagent_type: "programador", description: "d", prompt: "p" }, T);
    const sub = p.push({ type: "assistant", parent_tool_use_id: "tu1", message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "x", name: "Edit", input: {} }] } }, T);
    const main = p.push({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "y", name: "Read", input: {} }] } }, T);
    expect(sub.filter((e) => e.type === "tool")).toEqual([{ type: "tool", taskId: "t1", name: "Edit", t: T }]);
    expect(main.filter((e) => e.type === "tool")).toEqual([{ type: "tool", taskId: null, name: "Read", t: T }]);
  });

  it("no emite tool para la propia llamada a Agent (ya la cubre task_start)", () => {
    const p = createParser();
    const ev = p.push({ type: "assistant", message: { model: "m", content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } }, T);
    expect(ev.some((e) => e.type === "tool")).toBe(false);
  });

  it("un mensaje del orquestador que solo delega cuenta como actividad suya", () => {
    const p = createParser();
    const ev = p.push({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } }, T);
    expect(ev).toContainEqual({ type: "thinking", taskId: null, text: "", t: T });
  });

  it("ignora líneas desconocidas o mal formadas", () => {
    const p = createParser();
    expect(p.push(null, T)).toEqual([]);
    expect(p.push({ type: "loquesea" }, T)).toEqual([]);
    expect(p.pushLine("{no es json", T)).toEqual([]);
  });

  it("marca como fallido un encargo que termina con status failed", () => {
    const p = createParser();
    const ev = p.push({ type: "system", subtype: "task_notification", task_id: "t9", status: "failed", summary: "tests en rojo" }, T);
    expect(ev).toEqual([{ type: "task_end", taskId: "t9", status: "failed", summary: "tests en rojo", tokens: null, toolUses: null, durationMs: null, t: T }]);
  });
});
