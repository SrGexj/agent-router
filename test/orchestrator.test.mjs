import { describe, it, expect } from "vitest";
import { buildOrchestratorPrompt, quotaPressure } from "../src/core/prompt.mjs";
import { parseAgentMarkdown, agentsFromFiles } from "../src/core/agents.mjs";
import { buildClaudeArgs, parseCliArgs } from "../src/core/cli.mjs";
import { loadConfig } from "../src/config.mjs";

const NOW_MS = 1_792_000_000_000; // segundos: 1_792_000_000

describe("quotaPressure", () => {
  it("clasifica la presión de cuota por la ventana de 5 h y la de 7 días", () => {
    const q = (five, seven = 0.1) => ({
      fiveHour: { utilization: five, resetsAt: 1_792_003_600 },
      sevenDay: { utilization: seven, resetsAt: 1_792_500_000 }
    });
    expect(quotaPressure(null, NOW_MS)).toBe("desconocida");
    expect(quotaPressure(q(0.2), NOW_MS)).toBe("baja");
    expect(quotaPressure(q(0.75), NOW_MS)).toBe("alta");
    expect(quotaPressure(q(0.95), NOW_MS)).toBe("critica");
    expect(quotaPressure(q(0.2, 0.92), NOW_MS)).toBe("critica");
  });

  it("descarta una ventana ya reiniciada", () => {
    const stale = { fiveHour: { utilization: 0.99, resetsAt: 1_791_999_000 }, sevenDay: null };
    expect(quotaPressure(stale, NOW_MS)).toBe("baja");
  });
});

describe("buildOrchestratorPrompt", () => {
  const agents = { asistente: { description: "Haiku. Mecánico." }, programador: { description: "Sonnet. Código." } };

  it("explica el reparto y nombra a los subagentes disponibles", () => {
    const p = buildOrchestratorPrompt({ agents, quota: null, now: NOW_MS });
    expect(p).toMatch(/orquestador/i);
    expect(p).toContain("subagent_type: \"asistente\"");
    expect(p).toContain("subagent_type: \"programador\"");
    expect(p).toMatch(/worktree/);
    // Los worktrees viven en .claude/worktrees y cada escritura ahí pide permiso: solo si chocan archivos.
    expect(p).toMatch(/mismos archivos/);
    // Todo lo que entra en el contexto del orquestador se relee (lectura de caché) en cada paso siguiente.
    expect(p).toMatch(/contexto/);
    expect(p).toMatch(/informe corto en frases telegráficas/i);
    expect(p).toMatch(/7\. El resumen de lo hecho no va al chat/);
    expect(p).not.toMatch(/Termina con un resumen corto/);
    // Escribir la memoria con Bash (cat >>) pide permiso siempre; con Edit/Write lo cubre la regla de ajustes.
    expect(p).toMatch(/memoria.*Edit.*Write.*nunca con Bash/is);
    expect(p).toMatch(/sin datos de cuota/i);
  });

  it("pide ahorrar Opus cuando la cuota está alta", () => {
    const quota = { fiveHour: { utilization: 0.8, resetsAt: 1_792_003_600 }, sevenDay: { utilization: 0.3, resetsAt: 1_792_500_000 } };
    const p = buildOrchestratorPrompt({ agents, quota, now: NOW_MS });
    expect(p).toContain("5 h: 80 %");
    expect(p).toContain("7 días: 30 %");
    expect(p).toMatch(/delega todo lo que puedas/i);
  });

  it("en presión crítica prioriza Haiku", () => {
    const quota = { fiveHour: { utilization: 0.96, resetsAt: 1_792_003_600 }, sevenDay: null };
    expect(buildOrchestratorPrompt({ agents, quota, now: NOW_MS })).toMatch(/asistente siempre que/i);
  });
});

describe("perfiles de agente en markdown", () => {
  const md = `---
name: asistente
description: "Haiku. Tareas mecánicas."
model: haiku
tools: Bash, Read, Edit
---

Haces tareas acotadas.
`;

  it("lee el frontmatter y el cuerpo", () => {
    expect(parseAgentMarkdown(md)).toEqual({
      name: "asistente",
      description: "Haiku. Tareas mecánicas.",
      model: "haiku",
      tools: ["Bash", "Read", "Edit"],
      prompt: "Haces tareas acotadas."
    });
  });

  it("rechaza un perfil sin nombre o sin descripción", () => {
    expect(() => parseAgentMarkdown("hola")).toThrow(/frontmatter/);
    expect(() => parseAgentMarkdown("---\nname: x\n---\ncuerpo")).toThrow(/description/);
  });

  it("los perfiles que trae el router son válidos y usan Haiku y Sonnet", async () => {
    const { loadAgents } = await import("../src/core/agents.mjs");
    const agents = await loadAgents(new URL("../src/agents", import.meta.url).pathname);
    expect(Object.keys(agents)).toEqual(["asistente", "programador"]);
    expect(agents.asistente.model).toBe("haiku");
    expect(agents.programador.model).toBe("sonnet");
    expect(agents.asistente.prompt.length).toBeGreaterThan(50);
  });

  it("monta el objeto para --agents", () => {
    const json = agentsFromFiles([md]);
    expect(json).toEqual({
      asistente: { description: "Haiku. Tareas mecánicas.", prompt: "Haces tareas acotadas.", model: "haiku", tools: ["Bash", "Read", "Edit"] }
    });
  });
});

describe("parseCliArgs", () => {
  it("modo orquestado por defecto", () => {
    expect(parseCliArgs(["Arregla", "el", "login"])).toEqual({ task: "Arregla el login", model: null, effort: null, ownAgents: false, help: false, printPrompt: false });
  });

  it("--model fuerza modo manual y valida el modelo", () => {
    expect(parseCliArgs(["--model", "haiku", "x"])).toMatchObject({ model: "haiku", task: "x" });
    expect(() => parseCliArgs(["--model", "gpt", "x"])).toThrow(/Modelo no válido/);
  });

  it("acepta --effort, --agentes-usuario y ayuda", () => {
    expect(parseCliArgs(["--effort", "high", "--agentes-usuario", "x"])).toMatchObject({ effort: "high", ownAgents: true });
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(() => parseCliArgs(["--effort", "turbo", "x"])).toThrow(/Esfuerzo no válido/);
  });

  it("exige tarea", () => {
    expect(() => parseCliArgs([])).toThrow(/Falta la tarea/);
  });
});

describe("buildClaudeArgs", () => {
  const cfg = { permissionMode: "auto", fallbackModel: "sonnet", maxBudgetUsd: null, effort: null };

  it("orquestado: Opus con prompt de orquestador y subagentes", () => {
    const args = buildClaudeArgs({ mode: "orquestado", model: "opus", systemPrompt: "SYS", agents: { a: {} }, config: cfg, effort: null });
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--permission-mode", "auto", "--append-system-prompt", "SYS", "--fallback-model", "sonnet"]));
    expect(args[args.indexOf("--agents") + 1]).toBe(JSON.stringify({ a: {} }));
  });

  it("manual: sin prompt de orquestador ni agentes, sin fallback si es el mismo modelo", () => {
    const args = buildClaudeArgs({ mode: "manual", model: "sonnet", systemPrompt: null, agents: null, config: cfg, effort: "low" });
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--agents");
    expect(args).not.toContain("--fallback-model");
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "low"]));
  });

  it("añade el tope de gasto si está configurado", () => {
    const args = buildClaudeArgs({ mode: "manual", model: "haiku", config: { ...cfg, maxBudgetUsd: 2 } });
    expect(args).toEqual(expect.arrayContaining(["--max-budget-usd", "2"]));
  });
});

describe("loadConfig", () => {
  it("usa valores por defecto seguros", () => {
    const c = loadConfig({ HOME: "/home/u" });
    expect(c).toMatchObject({ home: "/home/u/.agent-router", host: "127.0.0.1", port: 4317, permissionMode: "auto", fallbackModel: "sonnet", claudeBin: "claude", maxBudgetUsd: null });
  });

  it("lee las variables ROUTER_*", () => {
    const c = loadConfig({ HOME: "/h", ROUTER_HOME: "/data", ROUTER_PORT: "5000", ROUTER_PERMISSION_MODE: "acceptEdits", ROUTER_MAX_BUDGET_USD: "3.5", ROUTER_EFFORT: "high" });
    expect(c).toMatchObject({ home: "/data", port: 5000, permissionMode: "acceptEdits", maxBudgetUsd: 3.5, effort: "high" });
  });

  it("consumo: precio del seat y binario de claude-monitor, configurables", () => {
    expect(loadConfig({ HOME: "/h" }).consumo).toEqual({ seatUsdMonth: null, monitorBin: "claude-monitor", refreshMs: 60000, warehouseDir: "/h/.agent-router/monitor" });
    expect(loadConfig({ HOME: "/h", ROUTER_MONITOR_WAREHOUSE: "0" }).consumo.warehouseDir).toBeNull();
    const c = loadConfig({ HOME: "/h", ROUTER_SEAT_USD: "30", ROUTER_MONITOR_BIN: "/x/claude-monitor" });
    expect(c.consumo).toMatchObject({ seatUsdMonth: 30, monitorBin: "/x/claude-monitor" });
    expect(loadConfig({ HOME: "/h", ROUTER_SEAT_USD: "nada" }).consumo.seatUsdMonth).toBeNull();
  });

  it("no permite escuchar fuera de localhost sin pedirlo explícitamente", () => {
    expect(() => loadConfig({ HOME: "/h", ROUTER_HOST: "0.0.0.0" })).toThrow(/localhost/);
    expect(loadConfig({ HOME: "/h", ROUTER_HOST: "0.0.0.0", ROUTER_ALLOW_REMOTE: "1" }).host).toBe("0.0.0.0");
  });

  it("el perfil sale de CLAUDE_CONFIG_DIR: trabajo por defecto", () => {
    expect(loadConfig({ HOME: "/h" }).profile).toBe("trabajo");
    expect(loadConfig({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude" }).profile).toBe("trabajo");
    expect(loadConfig({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude-personal" }).profile).toBe("personal");
    expect(loadConfig({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude-cliente" }).profile).toBe("cliente");
  });

  it("rechaza bypassPermissions", () => {
    expect(() => loadConfig({ HOME: "/h", ROUTER_PERMISSION_MODE: "bypassPermissions" })).toThrow(/bypassPermissions/);
  });
});
