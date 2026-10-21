import { describe, it, expect } from "vitest";
import { decideBlock, blockEvent } from "../src/core/block-agents.mjs";
import { loadConfig } from "../src/config.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";

const pre = (input, tool = "Agent") => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
const BLOCKED = ["general-purpose", "fork", "claude", "Explore", "Plan"];

describe("decideBlock", () => {
  it("bloquea general-purpose, fork y la ausencia de subagent_type", () => {
    for (const input of [{ subagent_type: "general-purpose" }, { subagent_type: "fork" }, { description: "x" }, {}]) {
      const d = decideBlock(pre(input), BLOCKED);
      expect(d?.agent).toBe(input.subagent_type ?? "general-purpose");
      expect(d.reason).toMatch(/^Bloqueado por agent-router: .* corre en Opus\. Relanza con subagent_type "asistente"/);
      expect(d.reason).toContain("pídeselo al usuario");
    }
  });
  it("bloquea claude, Explore y Plan, sin distinguir mayúsculas", () => {
    for (const a of ["claude", "Explore", "explore", "Plan", "PLAN"]) expect(decideBlock(pre({ subagent_type: a }), BLOCKED)?.agent).toBe(a);
  });
  it("el motivo apunta a asistente (Haiku) y programador (Sonnet)", () => {
    const r = decideBlock(pre({ subagent_type: "Explore" }), BLOCKED).reason;
    expect(r).toContain('"asistente" (Haiku: docs, web, navegador, comprobaciones)');
    expect(r).toContain('"programador" (Sonnet: código)');
  });
  it("también con la herramienta Task", () => {
    expect(decideBlock(pre({ subagent_type: "fork" }, "Task"), BLOCKED)).not.toBeNull();
  });
  it("deja pasar programador, asistente y otras herramientas", () => {
    expect(decideBlock(pre({ subagent_type: "programador" }), BLOCKED)).toBeNull();
    expect(decideBlock(pre({ subagent_type: "asistente" }), BLOCKED)).toBeNull();
    expect(decideBlock(pre({}, "Bash"), BLOCKED)).toBeNull();
    expect(decideBlock({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {} }, BLOCKED)).toBeNull();
  });
  it("lista vacía desactiva", () => {
    expect(decideBlock(pre({}), [])).toBeNull();
    expect(decideBlock(pre({ subagent_type: "fork" }), undefined)).toBeNull();
  });
});

describe("blockEvent y reducer", () => {
  it("registra task_blocked y el reducer lo cuenta", () => {
    const ev = blockEvent(pre({ subagent_type: "fork", description: "buscar" }), "fork", 5);
    expect(ev).toEqual({ type: "task_blocked", agent: "fork", description: "buscar", t: 5 });
    const run = reduceEvents([{ type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 1 }, ev, ev]);
    expect(run.blockedCount).toBe(2);
    expect(run.status).toBe("running");
  });
});

describe("config blockedAgents", () => {
  const cfg = (env) => loadConfig({ HOME: "/h", ...env }, { exists: () => false }).blockedAgents;
  it("por defecto general-purpose, fork, claude, Explore y Plan", () => expect(cfg({})).toEqual(BLOCKED));
  it("coma-separada, recortada", () => expect(cfg({ ROUTER_BLOCKED_AGENTS: " a, b ,," })).toEqual(["a", "b"]));
  it("vacío = desactivado", () => expect(cfg({ ROUTER_BLOCKED_AGENTS: "" })).toEqual([]));
});
