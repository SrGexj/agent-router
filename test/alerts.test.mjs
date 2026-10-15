import { describe, it, expect, vi } from "vitest";
import { reduceEvents, reduceRun } from "../src/core/reducer.mjs";
import { detectAlerts, createAlertNotifier, loadAlertPrefs, saveAlertPrefs } from "../dashboard/src/alerts.js";

const start = { type: "run_start", runId: "r", task: "Arregla el login", mode: "orquestado", model: "opus", cwd: "/p/web", t: 0 };
const ts = (id, agent = "programador") => ({ type: "task_start", taskId: id, agent, description: `Encargo ${id}`, prompt: "", t: 1 });
const te = (id, status = "completed") => ({ type: "task_end", taskId: id, status, summary: "", t: 2 });
const runsOf = (run) => ({ [run.id]: run });
const types = (alerts) => alerts.map((a) => a.type);

describe("detectAlerts", () => {
  it("no avisa sin estado anterior (carga inicial)", () => {
    const done = reduceEvents([start, ts("a"), te("a"), { type: "run_end", exitCode: 0, t: 3 }]);
    expect(detectAlerts(null, runsOf(done))).toEqual([]);
  });

  it("no avisa si nada cambia", () => {
    const run = reduceEvents([start, ts("a"), te("a")]);
    expect(detectAlerts(runsOf(run), runsOf(run))).toEqual([]);
  });

  it("encargo terminado: task_done con su descripción", () => {
    const prev = reduceEvents([start, ts("a")]);
    const next = reduceRun(prev, te("a"));
    expect(detectAlerts(runsOf(prev), runsOf(next))).toEqual([
      expect.objectContaining({ type: "task_done", count: 1, runId: "r", body: expect.stringContaining("Encargo a") })
    ]);
  });

  it("encargo fallido: error", () => {
    const prev = reduceEvents([start, ts("a")]);
    expect(types(detectAlerts(runsOf(prev), runsOf(reduceRun(prev, te("a", "failed")))))).toEqual(["error"]);
  });

  it("varios encargos a la vez se agrupan en un aviso con count", () => {
    const prev = reduceEvents([start, ts("a"), ts("b")]);
    const next = reduceRun(reduceRun(prev, te("a")), te("b"));
    const alerts = detectAlerts(runsOf(prev), runsOf(next));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "task_done", count: 2 });
  });

  it("ejecución completada: delivered", () => {
    const prev = reduceEvents([start]);
    const next = reduceRun(prev, { type: "run_end", exitCode: 0, t: 3 });
    expect(types(detectAlerts(runsOf(prev), runsOf(next)))).toEqual(["delivered"]);
  });

  it("ejecución fallida: error, no delivered", () => {
    const prev = reduceEvents([start]);
    const next = reduceRun(prev, { type: "run_end", exitCode: 1, t: 3 });
    expect(types(detectAlerts(runsOf(prev), runsOf(next)))).toEqual(["error"]);
  });

  it("cancelada por el usuario no avisa", () => {
    const prev = reduceEvents([start]);
    const next = reduceRun(prev, { type: "run_end", status: "cancelled", t: 3 });
    expect(detectAlerts(runsOf(prev), runsOf(next))).toEqual([]);
  });

  it("error nuevo durante la ejecución: error", () => {
    const prev = reduceEvents([start]);
    const next = reduceRun(prev, { type: "error", kind: "api", message: "boom", t: 2 });
    expect(types(detectAlerts(runsOf(prev), runsOf(next)))).toEqual(["error"]);
  });

  it("límite de uso: limit una sola vez, sin error ni delivered al cerrar", () => {
    const prev = reduceEvents([start]);
    const limited = reduceRun(prev, { type: "error", kind: "limit", message: "Límite", t: 2 });
    expect(types(detectAlerts(runsOf(prev), runsOf(limited)))).toEqual(["limit"]);
    const ended = reduceRun(limited, { type: "run_end", exitCode: 1, t: 3 });
    expect(detectAlerts(runsOf(limited), runsOf(ended))).toEqual([]);
  });

  it("una ejecución nueva que no estaba antes no dispara aviso por existir", () => {
    expect(detectAlerts({}, runsOf(reduceEvents([start])))).toEqual([]);
  });
});

describe("createAlertNotifier", () => {
  const setup = (prefs = {}, hidden = false) => {
    let t = 10_000;
    const sound = { play: vi.fn() };
    const notify = { show: vi.fn() };
    const n = createAlertNotifier({ sound, notify, now: () => t, isHidden: () => hidden, prefs: { sound: true, notifications: false, ...prefs } });
    return { n, sound, notify, advance: (ms) => { t += ms; } };
  };
  const base = reduceEvents([start, ts("a"), ts("b")]);
  const doneA = reduceRun(base, te("a"));
  const doneB = reduceRun(doneA, te("b"));

  it("la primera sincronización (carga) solo fija la base", () => {
    const { n, sound } = setup();
    n.sync(runsOf(reduceEvents([start, ts("a"), te("a")])), 1);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("suena en una transición posterior", () => {
    const { n, sound } = setup();
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneA), 1);
    expect(sound.play).toHaveBeenCalledWith("task_done");
  });

  it("un nuevo hello (epoch distinto, p. ej. reconexión) es base nueva: no avisa", () => {
    const { n, sound } = setup();
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneB), 2);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("antispam: mismo tipo en menos de 1 s, un solo sonido", () => {
    const { n, sound, advance } = setup();
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneA), 1);
    advance(400);
    n.sync(runsOf(doneB), 1);
    expect(sound.play).toHaveBeenCalledTimes(1);
    const again = reduceEvents([start, ts("c")]);
    n.sync(runsOf(again), 1); // otra base distinta no cuenta; sigue sin sonar de más
    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  it("pasado 1 s vuelve a sonar", () => {
    const { n, sound, advance } = setup();
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneA), 1);
    advance(1200);
    n.sync(runsOf(doneB), 1);
    expect(sound.play).toHaveBeenCalledTimes(2);
  });

  it("silenciado: no suena", () => {
    const { n, sound } = setup({ sound: false });
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneA), 1);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("notificación solo si activada y la pestaña está oculta", () => {
    const hiddenOn = setup({ notifications: true }, true);
    hiddenOn.n.sync(runsOf(base), 1);
    hiddenOn.n.sync(runsOf(doneA), 1);
    expect(hiddenOn.notify.show).toHaveBeenCalledTimes(1);

    const visible = setup({ notifications: true }, false);
    visible.n.sync(runsOf(base), 1);
    visible.n.sync(runsOf(doneA), 1);
    expect(visible.notify.show).not.toHaveBeenCalled();

    const off = setup({ notifications: false }, true);
    off.n.sync(runsOf(base), 1);
    off.n.sync(runsOf(doneA), 1);
    expect(off.notify.show).not.toHaveBeenCalled();
  });

  it("setPrefs cambia el comportamiento en caliente", () => {
    const { n, sound } = setup();
    n.setPrefs({ sound: false, notifications: false });
    n.sync(runsOf(base), 1);
    n.sync(runsOf(doneA), 1);
    expect(sound.play).not.toHaveBeenCalled();
  });
});

describe("preferencias", () => {
  const mem = () => { const d = {}; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };

  it("por defecto: sonido activado, notificaciones desactivadas", () => {
    expect(loadAlertPrefs(mem())).toEqual({ sound: true, notifications: false });
  });

  it("guarda y recupera", () => {
    const s = mem();
    saveAlertPrefs({ sound: false, notifications: true }, s);
    expect(loadAlertPrefs(s)).toEqual({ sound: false, notifications: true });
  });

  it("tolera almacenamiento roto o JSON inválido", () => {
    const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
    expect(loadAlertPrefs(broken)).toEqual({ sound: true, notifications: false });
    expect(() => saveAlertPrefs({ sound: false, notifications: false }, broken)).not.toThrow();
    expect(loadAlertPrefs({ getItem: () => "{no json" })).toEqual({ sound: true, notifications: false });
    expect(loadAlertPrefs(null)).toEqual({ sound: true, notifications: false });
  });
});
