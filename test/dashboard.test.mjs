import { describe, it, expect } from "vitest";
import { reduceEvents, reduceRun } from "../src/core/reducer.mjs";
import { derivePhase, PHASES } from "../src/core/view.mjs";
import { packetsFor, truncate } from "../dashboard/src/packets.js";
import { captionFor, fmtDuration, summaryLine, orchestratorSub, workerSub, layaNode, spendPending, spendLabels, ownSubagentsLine } from "../dashboard/src/captions.js";
import { spendShare } from "../src/core/details.mjs";
import { DEMO_EVENTS, DEMO_LENGTH, demoRunAt, phaseSpans } from "../dashboard/src/demo.js";
import { iso, boxFaces, bezierPoint, shadowLink, LAYA } from "../dashboard/src/scene/geometry.js";

const start = { type: "run_start", runId: "r", task: "Añade validación al formulario de registro", mode: "orquestado", model: "opus", cwd: "/", t: 0 };

describe("packetsFor", () => {
  const seq = () => { let i = 0; return () => ++i; };

  it("la tarea entra por la arista del usuario con su texto", () => {
    const run = reduceRun(null, start);
    const [p] = packetsFor(start, run, 100, seq());
    expect(p).toMatchObject({ edge: "in", dir: 1, kind: "label", label: "Añade validación al f…", born: 100 });
  });

  it("un encargo sale hacia su trabajador y vuelve con OK o fallo", () => {
    const ts = { type: "task_start", taskId: "a", agent: "asistente", description: "Entrada en CHANGELOG", prompt: "", t: 1 };
    let run = reduceEvents([start, ts]);
    expect(packetsFor(ts, run, 5, seq())[0]).toMatchObject({ edge: "asistente", dir: 1, kind: "label", label: "Entrada en CHANGELOG" });
    const ok = { type: "task_end", taskId: "a", status: "completed", summary: "", t: 2 };
    run = reduceRun(run, ok);
    expect(packetsFor(ok, run, 6, seq())[0]).toMatchObject({ edge: "asistente", dir: -1, kind: "ok", label: "OK" });
    const bad = { type: "task_end", taskId: "a", status: "failed", summary: "", t: 3 };
    expect(packetsFor(bad, reduceRun(run, bad), 7, seq())[0]).toMatchObject({ dir: -1, kind: "error", label: "fallo" });
  });

  it("cada herramienta de un subagente es un punto hacia su nodo", () => {
    const run = reduceEvents([start, { type: "task_start", taskId: "p", agent: "programador", description: "", prompt: "", t: 1 }]);
    expect(packetsFor({ type: "tool", taskId: "p", name: "Edit", t: 2 }, run, 9, seq())).toEqual([
      { id: "9-1", edge: "programador", dir: 1, kind: "dot", label: null, born: 9, dur: 1300 }
    ]);
  });

  it("límite, permisos y final de ejecución vuelven hacia el usuario", () => {
    const run = reduceRun(null, start);
    expect(packetsFor({ type: "error", kind: "limit", t: 1 }, run, 1, seq())[0]).toMatchObject({ edge: "in", dir: -1, kind: "error", label: "429 límite" });
    expect(packetsFor({ type: "error", kind: "permission", t: 1 }, run, 1, seq())[0]).toMatchObject({ kind: "error", label: "permiso" });
    expect(packetsFor({ type: "run_end", exitCode: 0, t: 1 }, run, 1, seq())[0]).toMatchObject({ dir: -1, kind: "ok", label: "hecho" });
    expect(packetsFor({ type: "run_end", exitCode: 1, t: 1 }, run, 1, seq())[0]).toMatchObject({ kind: "error", label: "error" });
  });

  it("eventos sin representación no generan paquetes", () => {
    expect(packetsFor({ type: "usage", t: 1 }, null, 1, seq())).toEqual([]);
    expect(packetsFor({ type: "thinking", t: 1 }, null, 1, seq())).toEqual([]);
  });

  it("truncate", () => {
    expect(truncate("corto", 10)).toBe("corto");
    expect(truncate("  muy largo de verdad  ", 8)).toBe("muy lar…");
    expect(truncate(null, 8)).toBe("");
  });
});

describe("captionFor", () => {
  it("explica cada fase con datos de la ejecución", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "task_start", taskId: "b", agent: "asistente", description: "", prompt: "", t: 1 }
    ]);
    expect(captionFor("delega", run, 2).text).toBe("2 encargos: 1 a Programador (Sonnet) y 1 a Asistente (Haiku).");
    expect(captionFor("ejecuta", run, 9000).text).toMatch(/^2 en curso/);
    expect(captionFor("recibe", run, 0).text).toBe(start.task);
    expect(captionFor("reposo", null, 0).title).toBe("En espera");
  });

  it("entrega resume duración, encargos y coste", () => {
    const run = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "usage", costUsd: 0.864, byModel: {}, t: 2 },
      { type: "run_end", exitCode: 0, t: 134_000 }
    ]);
    expect(captionFor("entrega", run, 0)).toEqual({ title: "Terminada", text: "1 encargo · 0,86 $ · 2 min 14 s", tone: "normal" });
  });

  it("límite y fallo en tono de error", () => {
    const limited = reduceEvents([start, { type: "error", kind: "limit", window: "five_hour", resetsAt: Date.UTC(2026, 9, 14, 16, 0) / 1000, message: "", t: 1 }]);
    const c = captionFor("limitado", limited, 0);
    expect(c.tone).toBe("error");
    expect(c.text).toMatch(/Ventana de 5 h agotada\. Se reinicia a las \d\d:00\./);
    const failed = reduceEvents([start, { type: "error", kind: "api", message: "Overloaded", t: 1 }, { type: "run_end", exitCode: 1, t: 2 }]);
    expect(captionFor("fallo", failed, 0)).toEqual({ title: "Falló", text: "0 encargos · 0 s. Overloaded", tone: "error" });
    const cancelled = reduceEvents([start, { type: "run_end", exitCode: 130, status: "cancelled", t: 2 }]);
    expect(captionFor("fallo", cancelled, 0)).toMatchObject({ title: "Cancelada", tone: "error" });
  });

  it("sin señal explica que la sesión se cerró o se colgó", () => {
    const run = reduceEvents([start, { type: "tool", taskId: null, name: "Bash", t: 0 }]);
    expect(captionFor("fallo", run, 25 * 60_000)).toEqual({
      title: "Sin señal",
      text: "No llegan eventos desde hace 25 min: la sesión se cerró o se quedó esperando.",
      tone: "error"
    });
  });

  it("con una pregunta pendiente dice que espera tu respuesta", () => {
    const run = { ...reduceEvents([start, { type: "tool", taskId: null, name: "Bash", t: 0 }]), waiting: { kind: "question", text: "¿Seguimos?", questions: [], t: 1 } };
    expect(captionFor("analiza", run, 5)).toMatchObject({ title: "Esperando tu respuesta", tone: "normal" });
    expect(captionFor("ejecuta", { ...run, status: "completed" }, 5).title).not.toBe("Esperando tu respuesta");
  });

  it("fmtDuration", () => {
    expect(fmtDuration(4_000)).toBe("4 s");
    expect(fmtDuration(134_000)).toBe("2 min 14 s");
    expect(fmtDuration(3_720_000)).toBe("1 h 2 min");
  });
});

describe("demo", () => {
  it("los eventos están ordenados y caben en el bucle", () => {
    const ts = DEMO_EVENTS.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts.at(-1)).toBeLessThan(DEMO_LENGTH);
  });

  it("recorre todas las fases en orden, con un fallo reintentado, y acaba bien", () => {
    const spans = phaseSpans(DEMO_EVENTS, DEMO_LENGTH);
    expect(spans.map((s) => s.phase)).toEqual(["recibe", "analiza", "delega", "ejecuta", "revisa", "ejecuta", "revisa", "entrega"]);
    expect(new Set(spans.map((s) => s.phase))).toEqual(new Set(PHASES));
    const end = demoRunAt(DEMO_LENGTH);
    expect(end.status).toBe("completed");
    expect(Object.values(end.tasks).some((t) => t.status === "failed")).toBe(true);
    expect(derivePhase(end, DEMO_LENGTH)).toBe("entrega");
  });

  it("demoRunAt solo aplica los eventos ya ocurridos", () => {
    expect(demoRunAt(-1)).toBeNull();
    expect(demoRunAt(0).status).toBe("running");
  });
});

describe("geometría isométrica", () => {
  it("proyecta: x va abajo a la derecha, y abajo a la izquierda, z hacia arriba", () => {
    const o = { x: 100, y: 100 };
    expect(iso(o, 0, 0, 0)).toEqual([100, 100]);
    const [x1, y1] = iso(o, 10, 0, 0);
    expect(x1).toBeGreaterThan(100); expect(y1).toBeGreaterThan(100);
    const [x2, y2] = iso(o, 0, 10, 0);
    expect(x2).toBeLessThan(100); expect(y2).toBeGreaterThan(100);
    expect(iso(o, 0, 0, 10)).toEqual([100, 90]);
  });

  it("boxFaces devuelve tres caras de cuatro puntos", () => {
    const f = boxFaces({ x: 0, y: 0 }, { x: 0, y: 0, z: 0, w: 10, d: 10, h: 5 });
    expect(Object.keys(f)).toEqual(["top", "left", "right"]);
    expect(f.top.split(" ")).toHaveLength(4);
  });

  it("bezierPoint en los extremos devuelve los extremos", () => {
    const c = [[0, 0], [10, 0], [20, 10], [30, 10]];
    expect(bezierPoint(c, 0)).toEqual([0, 0]);
    expect(bezierPoint(c, 1)).toEqual([30, 10]);
  });
});

describe("resumen final de una ejecución", () => {
  const M = 1_000_000;
  const u = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const full = (extra = []) => reduceEvents([
    start,
    { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1000 },
    { type: "task_model", taskId: "a", model: "claude-sonnet-5-5", t: 1100 },
    { type: "task_usage", taskId: "a", byModel: { "claude-sonnet-5-5": u(M, 100_000) }, t: 2000 },
    { type: "task_end", taskId: "a", status: "completed", summary: "", t: 3000 },
    { type: "task_start", taskId: "b", agent: "asistente", description: "", prompt: "", t: 3100 },
    { type: "task_model", taskId: "b", model: "claude-haiku-5-5", t: 3200 },
    { type: "task_usage", taskId: "b", byModel: { "claude-haiku-5-5": u(M) }, t: 3300 },
    { type: "task_end", taskId: "b", status: "completed", summary: "", t: 4000 },
    { type: "orchestrator_usage", byModel: { "claude-opus-5-5": u(100_000, 50_000) }, t: 5000 },
    ...extra
  ]);

  it("summaryLine junta encargos, coste, tokens y duración", () => {
    const run = full([{ type: "run_end", exitCode: 0, t: 190_000 }]);
    expect(summaryLine(run, 0)).toBe("2 encargos · 4,50 $ · 2,3 M tok · 3 min 10 s");
  });

  it("sin datos de uso omite coste y tokens; con datos incompletos añade parcial", () => {
    const bare = reduceEvents([start, { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 }, { type: "run_end", exitCode: 0, t: 5000 }]);
    expect(summaryLine(bare, 0)).toBe("1 encargo · 5 s");
    const partial = reduceEvents([
      start,
      { type: "task_start", taskId: "a", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "task_usage", taskId: "a", byModel: { "claude-sonnet-5-5": u(M) }, t: 2 },
      { type: "task_end", taskId: "a", status: "completed", summary: "", t: 3 },
      { type: "task_start", taskId: "b", agent: "asistente", description: "", prompt: "", t: 4 },
      { type: "task_end", taskId: "b", status: "completed", summary: "", t: 5 },
      { type: "run_end", exitCode: 0, t: 6000 }
    ]);
    expect(summaryLine(partial, 0)).toBe("2 encargos · 2,00 $ · 1 M tok · parcial · 6 s");
  });

  it("el caption de una ejecución terminada lleva el resumen; cancelada y fallida con su título", () => {
    const ok = full([{ type: "run_end", exitCode: 0, t: 190_000 }]);
    expect(captionFor("entrega", ok, 0)).toMatchObject({ title: "Terminada", text: "2 encargos · 4,50 $ · 2,3 M tok · 3 min 10 s" });
    const cancelled = full([{ type: "run_end", exitCode: 130, status: "cancelled", t: 190_000 }]);
    expect(captionFor("fallo", cancelled, 0)).toMatchObject({ title: "Cancelada", text: "2 encargos · 4,50 $ · 2,3 M tok · 3 min 10 s", tone: "error" });
    const failed = full([{ type: "error", kind: "api", message: "Overloaded", t: 6000 }, { type: "run_end", exitCode: 1, t: 190_000 }]);
    expect(captionFor("fallo", failed, 0)).toMatchObject({ title: "Falló", text: "2 encargos · 4,50 $ · 2,3 M tok · 3 min 10 s. Overloaded" });
  });

  it("orchestratorSub: modelo, coste y tokens del orquestador; null sin datos", () => {
    expect(orchestratorSub(full())).toBe("Opus · 1,40 $ · 150 k tok");
    expect(orchestratorSub(reduceEvents([start]))).toBeNull();
    expect(orchestratorSub(null)).toBeNull();
  });

  it("Explore en Opus: el Programador no lo cuenta ni toma su modelo; el orquestador lo muestra aparte", () => {
    const evs = [
      start,
      { type: "task_start", taskId: "p", agent: "programador", description: "", prompt: "", t: 1 },
      { type: "task_model", taskId: "p", model: "claude-sonnet-5-5", t: 2 },
      { type: "task_start", taskId: "e", agent: "Explore", description: "", prompt: "", t: 3 },
      { type: "task_model", taskId: "e", model: "claude-opus-5-5", t: 4 }
    ];
    const run = reduceEvents(evs);
    expect(workerSub(run, "programador", "Sonnet")).toBe("Sonnet 5.5 · 1 encargo");
    expect(ownSubagentsLine(run)).toBe("+1 Explore en curso");
    const sin = reduceEvents(evs.slice(0, 3));
    expect(ownSubagentsLine(sin)).toBeNull();
    expect(ownSubagentsLine(null)).toBeNull();
  });

  it("ownSubagentsLine: varios tipos y subagentes terminados", () => {
    const e = (id, agent) => ({ type: "task_start", taskId: id, agent, description: "", prompt: "", t: 1 });
    const run = reduceEvents([start, e("a", "Explore"), e("b", "Plan"), e("c", "Explore")]);
    expect(ownSubagentsLine(run)).toBe("+3 subagentes en curso");
    const done = reduceRun(reduceRun(run, { type: "task_end", taskId: "a", status: "completed", t: 2 }), { type: "task_end", taskId: "b", status: "completed", t: 2 });
    expect(ownSubagentsLine(done)).toBe("+1 Explore en curso");
    expect(ownSubagentsLine(reduceRun(done, { type: "task_end", taskId: "c", status: "completed", t: 3 }))).toBe("subagentes: 3");
  });

  it("los subagentes propios no mueven paquetes por aristas de roles", () => {
    const ts = { type: "task_start", taskId: "e", agent: "Explore", description: "Busca", prompt: "", t: 1 };
    const run = reduceEvents([start, ts]);
    expect(packetsFor(ts, run, 1, () => 1)).toEqual([]);
    expect(packetsFor({ type: "tool", taskId: "e", name: "Grep", t: 2 }, run, 1, () => 1)).toEqual([]);
  });

  it("workerSub: encargos, coste y tokens por trabajador; también en curso", () => {
    const run = full([{ type: "run_end", exitCode: 0, t: 190_000 }]);
    expect(workerSub(run, "programador", "Sonnet")).toBe("Sonnet 5.5 · 1 encargo · 3,00 $ · 1,1 M tok");
    expect(workerSub(run, "asistente", "Haiku")).toBe("Haiku 5.5 · 1 encargo · 0,10 $ · 1 M tok");
    expect(workerSub(reduceEvents([start]), "asistente", "Haiku")).toBe("Haiku · sin encargos");
    expect(workerSub(null, "asistente", "Haiku")).toBe("Haiku · sin encargos");
    expect(workerSub(full([{ type: "run_end", exitCode: 0, t: 6000 }]), "asistente", "Haiku")).toMatch(/^Haiku 5\.5/);
    expect(workerSub(reduceEvents([start, { type: "run_end", exitCode: 0, t: 6000 }]), "asistente", "Haiku")).toBe("Haiku");
    const live = reduceEvents([start, { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 1 }, { type: "task_model", taskId: "a", model: "claude-haiku-5-5", t: 2 }]);
    expect(workerSub(live, "asistente", "Haiku")).toBe("Haiku 5.5 · 1 encargo");
  });
});

describe("nodo Laya (sombra) de la escena", () => {
  const ses = { ...start, mode: "sesion" };
  const route = (o = {}) => ({ type: "shadow_route", model: "laya", choice: "programador", confidence: 0.63, reason: "Cambio de código", latencyMs: 40, costUsd: 0, t: 500, ...o });
  const task = (node) => [
    { type: "task_start", taskId: "a", agent: node, description: "x", prompt: "", t: 100 },
    { type: "task_end", taskId: "a", status: "completed", summary: "", t: 200 }
  ];
  const end = { type: "run_end", exitCode: 0, t: 900 };

  it("sin ejecución, en demo o en una ejecución terminada sin shadow no se muestra", () => {
    expect(layaNode(null, 0)).toBeNull();
    expect(layaNode(reduceEvents([{ ...start, runId: "demo" }]), 1000)).toBeNull(); // demo y router CLI: mode "orquestado"
    expect(layaNode(reduceEvents([ses, end]), 1000)).toBeNull();
  });

  it("en curso sin shadow: Consultando…; pasado un rato sin respuesta deja de esperarse y se oculta", () => {
    const run = reduceEvents([ses]);
    expect(layaNode(run, 5000)).toMatchObject({ text: "Consultando…", dot: "idle pulse", verdict: null });
    expect(layaNode(run, 60_000)).toBeNull();
  });

  it("con elección: Programador 63 %, sin veredicto mientras sigue en curso", () => {
    const n = layaNode(reduceEvents([ses, route()]), 1000);
    expect(n).toMatchObject({ text: "Programador 63 %", verdict: null });
    expect(n.title).toContain("Cambio de código");
    expect(layaNode(reduceEvents([ses, route({ choice: "opus", confidence: 0.9 })]), 1000).text).toBe("Opus 90 %");
    expect(layaNode(reduceEvents([ses, route({ confidence: null })]), 1000).text).toBe("Programador");
  });

  it("error: sin respuesta, con el error en el title", () => {
    const n = layaNode(reduceEvents([ses, route({ choice: null, confidence: null, error: "laya no disponible" })]), 1000);
    expect(n).toMatchObject({ text: "sin respuesta", dot: "warn", verdict: null });
    expect(n.title).toContain("laya no disponible");
  });

  it("terminada: coincide (verde) o no coincide (ámbar) con lo que hizo Opus", () => {
    expect(layaNode(reduceEvents([ses, route(), ...task("programador"), end]), 1000).verdict).toEqual({ text: "coincide", tone: "ok" });
    expect(layaNode(reduceEvents([ses, route({ choice: "asistente" }), ...task("programador"), end]), 1000).verdict).toEqual({ text: "no coincide", tone: "warn" });
    expect(layaNode(reduceEvents([ses, route({ choice: "opus" }), end]), 1000).verdict).toEqual({ text: "coincide", tone: "ok" });
  });

  it("terminada con shadow pero sin elección ni error no inventa veredicto", () => {
    const n = layaNode(reduceEvents([ses, route({ choice: null, confidence: null }), end]), 1000);
    expect(n.verdict).toBeNull();
  });
});

describe("caption del gasto en curso", () => {
  it("en curso y sin datos de uso se calcula en vivo; con datos o terminada, no", () => {
    const run = reduceEvents([start]);
    expect(spendPending(run, null)).toBe("se calcula en vivo");
    expect(spendPending(run, { opus: 100, sonnet: 0, haiku: 0 })).toBeNull();
    expect(spendPending(reduceEvents([start, { type: "run_end", exitCode: 0, t: 5 }]), null)).toBeNull();
    expect(spendPending(null, null)).toBeNull();
  });
});

describe("spendLabels: sin uso de un encargo no se muestra 0 %", () => {
  const M = 1_000_000;
  const u = (input = 0, output = 0) => ({ input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const orch = { type: "orchestrator_usage", byModel: { "claude-opus-5-5": u(M) }, t: 1 };
  const prog = { type: "task_start", taskId: "p", agent: "programador", description: "d", prompt: "p", t: 2 };
  it("encargo de programador en curso sin uso: Sonnet pendiente, no 0 %", () => {
    const run = reduceEvents([start, orch, prog]);
    expect(spendLabels(run, spendShare(run))).toEqual({ opus: "100%", sonnet: "…", haiku: "0%" });
  });
  it("con uso en vivo del encargo, Sonnet sale con su porcentaje", () => {
    const run = reduceEvents([start, orch, prog, { type: "task_usage", taskId: "p", snapshot: true, byModel: { "claude-sonnet-5-5": u(M) }, t: 3 }]);
    const l = spendLabels(run, spendShare(run));
    expect(l.haiku).toBe("0%");
    expect(parseInt(l.sonnet)).toBeGreaterThan(0);
  });
  it("terminada con un encargo sin uso: raya; sin datos: rayas", () => {
    const run = reduceEvents([start, orch, prog, { type: "task_end", taskId: "p", status: "completed", t: 3 }, { type: "run_end", exitCode: 0, t: 4 }]);
    expect(spendLabels(run, spendShare(run)).sonnet).toBe("—");
    expect(spendLabels(reduceEvents([start]), null)).toEqual({ opus: "—", sonnet: "—", haiku: "—" });
  });
});

describe("geometría del nodo Laya", () => {
  it("la línea de sombra baja en vertical hasta el punto medio del camino Tú → Orquestador", () => {
    const edge = [[227, 284], [290, 236], [350, 236], [412, 276]];
    const mid = bezierPoint(edge, 0.5);
    const l = shadowLink(edge);
    expect(l.node).toEqual({ x: mid[0], y: LAYA.y });
    expect(l.to).toEqual(mid);
    expect(l.from[0]).toBe(mid[0]);
    expect(l.from[1]).toBeLessThan(l.to[1] - 40); // hay tramo de línea visible
    expect(LAYA.title).toBeLessThan(LAYA.pill);
    expect(LAYA.pill).toBeLessThan(LAYA.verdict);
    expect(LAYA.verdict).toBeLessThan(LAYA.linkFrom);
  });
});
