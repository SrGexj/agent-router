import { describe, it, expect } from "vitest";
import { createEngine } from "../dashboard/src/engine.js";
import { reduceEvents, reduceRun } from "../src/core/reducer.mjs";
import { workerView } from "../src/core/view.mjs";

const demoEvents = [
  { type: "run_start", runId: "demo", task: "demo", mode: "orquestado", model: "opus", cwd: "/", t: 0 },
  { type: "thinking", taskId: null, text: "", t: 100 },
  { type: "task_start", taskId: "a", agent: "asistente", description: "uno", prompt: "", t: 1000 },
  { type: "task_end", taskId: "a", status: "completed", summary: "", t: 3000 },
  { type: "run_end", exitCode: 0, t: 4000 }
];

const mk = () => createEngine({ demoEvents, demoLength: 6000 });
const frame = (e, perfNow, extra = {}) => e.frame({ perfNow, wallNow: 1_000_000 + perfNow, view: "auto", runs: {}, paused: false, ...extra });

describe("motor de animación", () => {
  it("sin ejecuciones queda en espera: escena quieta, sin paquetes ni línea de tiempo", () => {
    const e = mk();
    const s = frame(e, 0);
    expect(s).toMatchObject({ mode: "idle", run: null, phase: "reposo", packets: [], fills: [0, 0, 0, 0, 0, 0] });
    expect(s.caption.title).toBe("En espera");
    expect(frame(e, 5000).mode).toBe("idle");
  });

  it("la demo, a petición, avanza con el reloj", () => {
    const e = mk();
    const a = frame(e, 0, { view: "demo" });
    expect(a.mode).toBe("demo");
    expect(a.phase).toBe("recibe");
    const b = frame(e, 1200, { view: "demo" });
    expect(b.phase).toBe("delega");
    expect(b.packets.some((p) => p.edge === "asistente" && p.kind === "label")).toBe(true);
    expect(b.fills[0]).toBe(1);
  });

  it("la demo vuelve a empezar al terminar el bucle y limpia los paquetes", () => {
    const e = mk();
    const demo = { view: "demo" };
    frame(e, 0, demo); frame(e, 3100, demo);
    const again = frame(e, 6050, demo);
    expect(again.now).toBe(50);
    expect(again.packets.every((p) => p.born <= 50)).toBe(true);
  });

  it("la pausa congela el tiempo y al reanudar sigue donde estaba", () => {
    const e = mk();
    frame(e, 0, { view: "demo" });
    const before = frame(e, 500, { paused: true, view: "demo" });
    const during = frame(e, 5000, { paused: true, view: "demo" });
    expect(during.now).toBe(before.now);
    expect(frame(e, 5100, { view: "demo" }).now).toBe(500);
    expect(frame(e, 5200, { view: "demo" }).now).toBe(600);
  });

  it("muestra en vivo la ejecución en curso más reciente y solo anima sus eventos", () => {
    const e = mk();
    const r1 = reduceEvents([{ type: "run_start", runId: "r1", task: "x", mode: "orquestado", model: "opus", cwd: "/", t: 1_000_000 }]);
    const r0 = reduceEvents([{ type: "run_start", runId: "r0", task: "y", mode: "orquestado", model: "opus", cwd: "/", t: 900_000 }]);
    const runs = { r1, r0 };
    const s = frame(e, 10, { runs });
    expect(s.mode).toBe("live");
    expect(s.run.id).toBe("r1");

    const ev = { type: "task_start", taskId: "t", agent: "programador", description: "d", prompt: "", t: 1_000_020 };
    e.onLiveEvent("r0", ev, reduceRun(r0, ev), 1_000_020);
    expect(frame(e, 20, { runs }).packets).toHaveLength(0);
    e.onLiveEvent("r1", ev, reduceRun(r1, ev), 1_000_020);
    expect(frame(e, 30, { runs }).packets).toHaveLength(1);
  });

  it("una ejecución terminada seleccionada se ve en historial con la línea de tiempo llena", () => {
    const e = mk();
    const done = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "orquestado", model: "opus", cwd: "/", t: 1 },
      { type: "run_end", exitCode: 0, t: 2 }
    ]);
    const s = frame(e, 0, { runs: { r: done }, view: "r" });
    expect(s.mode).toBe("historial");
    expect(s.phase).toBe("entrega");
    expect(s.fills).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("un fallo marca en rojo el paso donde se paró", () => {
    const e = mk();
    const failed = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "orquestado", model: "opus", cwd: "/", t: 1 },
      { type: "run_end", exitCode: 1, t: 2 }
    ]);
    const s = frame(e, 0, { runs: { r: failed }, view: "r" });
    expect(s.phase).toBe("fallo");
    expect(s.errorAt).toBe(1);
    expect(s.caption.tone).toBe("error");
  });

  it("en automático, una ejecución terminada se queda en pantalla con sus huecos finales, sin volver a reposo por tiempo", () => {
    const e = mk();
    const done = reduceEvents([
      { type: "run_start", runId: "r", task: "x", mode: "orquestado", model: "opus", cwd: "/", t: 1_000_000 },
      { type: "task_start", taskId: "a", agent: "asistente", description: "", prompt: "", t: 1_000_010 },
      { type: "task_end", taskId: "a", status: "completed", summary: "", t: 1_000_050 },
      { type: "run_end", exitCode: 0, t: 1_000_100 }
    ]);
    expect(frame(e, 1000, { runs: { r: done } })).toMatchObject({ mode: "historial", phase: "entrega" });
    const later = e.frame({ perfNow: 2000, wallNow: 1_000_100 + 30 * 24 * 3600_000, view: "auto", runs: { r: done }, paused: false });
    expect(later).toMatchObject({ mode: "historial", phase: "entrega", run: { id: "r" } });
    expect(later.caption.title).toBe("Terminada");
    expect(workerView(later.run, "asistente", later.now).slots[0]).toBe("done");
    // Una ejecución nueva en curso sí la releva.
    const next = reduceEvents([{ type: "run_start", runId: "n", task: "y", mode: "orquestado", model: "opus", cwd: "/", t: 1_000_100 + 30 * 24 * 3600_000 }]);
    expect(e.frame({ perfNow: 3000, wallNow: 1_000_200 + 30 * 24 * 3600_000, view: "auto", runs: { r: done, n: next }, paused: false })).toMatchObject({ mode: "live", run: { id: "n" } });
  });

  it("view demo fuerza la demo aunque haya una ejecución en vivo", () => {
    const e = mk();
    const r1 = reduceEvents([{ type: "run_start", runId: "r1", task: "x", mode: "orquestado", model: "opus", cwd: "/", t: 1 }]);
    expect(frame(e, 0, { runs: { r1 }, view: "demo" }).mode).toBe("demo");
  });
});

describe("pastillas de ejecuciones en curso", () => {
  const startOf = (id, t, cwd) => ({ type: "run_start", runId: id, task: id, mode: "sesion", model: "opus", cwd, t });

  it("lista las ejecuciones activas con su proyecto y su fase, la más reciente primero", () => {
    const e = mk();
    const runs = {
      a: reduceEvents([startOf("a", 1_000_000, "/home/user/demo-app"), { type: "thinking", taskId: null, text: "", t: 1_000_001 }]),
      b: reduceEvents([startOf("b", 1_000_500, "/home/user/web")]),
      viejo: reduceEvents([startOf("viejo", -1_000_000, "/x")])
    };
    const s = frame(e, 1000, { runs });
    expect(s.active.map((p) => [p.id, p.project, p.phase])).toEqual([["b", "web", "recibe"], ["a", "demo-app", "analiza"]]);
    expect(s.active.find((p) => p.id === "b").shown).toBe(true);
    expect(s.active.find((p) => p.id === "a").profile).toBe("trabajo");
  });

  it("avisa de un fallo en una ejecución que no estás mirando hasta que la miras", () => {
    const e = mk();
    const a0 = reduceEvents([startOf("a", 1_000_000, "/p/a"), { type: "task_start", taskId: "t", agent: "programador", description: "", prompt: "", t: 1_000_001 }]);
    const b = reduceEvents([startOf("b", 1_000_500, "/p/b")]);
    frame(e, 1000, { runs: { a: a0, b } });
    const a1 = reduceRun(a0, { type: "task_end", taskId: "t", status: "failed", summary: "", t: 1_000_900 });
    expect(frame(e, 1100, { runs: { a: a1, b } }).active.find((p) => p.id === "a").alert).toBe(true);
    frame(e, 1200, { runs: { a: a1, b }, view: "a" });
    expect(frame(e, 1300, { runs: { a: a1, b } }).active.find((p) => p.id === "a").alert).toBe(false);
  });

  it("un encargo sin señal durante LOST_AFTER_MS deja de contar como trabajando en la escena", () => {
    const e = mk();
    const r = reduceEvents([startOf("a", 1_000_000, "/p/a"), { type: "task_start", taskId: "t", agent: "asistente", description: "", prompt: "", t: 1_000_001 }]);
    const alive = frame(e, 1000, { runs: { a: r } }).run;
    expect(alive.tasks.t.status).toBe("running");
    const later = e.frame({ perfNow: 2000, wallNow: 1_000_001 + 10 * 60_000, view: "auto", runs: { a: r }, paused: false }).run;
    expect(later.tasks.t).toMatchObject({ status: "failed", lost: true });
  });

  it("una ejecución sin señal no secuestra el modo automático", () => {
    const e = mk();
    const stale = reduceEvents([startOf("s", -1_000_000, "/p")]);
    expect(frame(e, 0, { runs: { s: stale } }).mode).toBe("idle");
  });
});
