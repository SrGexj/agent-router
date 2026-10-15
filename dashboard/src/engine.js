// Motor de animación: decide qué se ve (en espera, en vivo, historial o demo a petición), lleva el reloj de la
// demo, la pausa y los paquetes en vuelo. Se avanza fuera del render (requestAnimationFrame)
// y devuelve una instantánea inmutable. Los relojes entran como parámetros.
import { reduceRun } from "../../src/core/reducer.mjs";
import { derivePhase, isActive, PHASES } from "../../src/core/view.mjs";
import { isWaiting } from "../../src/core/details.mjs";
import { packetsFor } from "./packets.js";
import { captionFor } from "./captions.js";
import { phaseSpans } from "./demo.js";

const FINAL = new Set(["entrega", "fallo", "limitado"]);

export function createEngine({ demoEvents, demoLength }) {
  const spans = phaseSpans(demoEvents, demoLength);
  let seq = 0;
  const nextSeq = () => ++seq;

  let base = null;          // perfNow en el que empezó el bucle de demo actual
  let frozen = null;        // { perf, wall } mientras está en pausa
  let demo = { idx: 0, run: null, lastT: -1 };
  let packets = [];
  let shownKey = null;
  let phaseStart = { phase: null, at: 0 };
  const seenAlerts = new Map(); // runId → nº de fallos/avisos ya vistos en pantalla

  const alertCount = (r) => r.taskOrder.filter((id) => ["failed", "killed"].includes(r.tasks[id].status)).length + r.errors.length;

  function activePills(runs, wall, shownId) {
    return Object.values(runs)
      .filter((r) => isActive(r, wall))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => {
        const shown = r.id === shownId;
        if (shown) seenAlerts.set(r.id, alertCount(r));
        return {
          id: r.id,
          project: (r.cwd ?? "").split("/").filter(Boolean).at(-1) ?? "—",
          profile: r.profile ?? "trabajo",
          phase: derivePhase(r, wall),
          shown,
          waiting: isWaiting(r),
          alert: !shown && alertCount(r) > (seenAlerts.get(r.id) ?? 0)
        };
      });
  }

  function onLiveEvent(runId, event, run, wallNow) {
    if (runId !== shownKey) return;
    packets = [...packets, ...packetsFor(event, run, wallNow, nextSeq)];
  }

  function pick(view, runs, wall) {
    const list = Object.values(runs).sort((a, b) => b.startedAt - a.startedAt);
    const liveRun = list.find((r) => isActive(r, wall)) ?? null;
    if (view === "demo") return { mode: "demo", run: null };
    if (view === "auto") {
      if (liveRun) return { mode: "live", run: liveRun };
      // Sin ejecución en curso se queda la última terminada, sin límite de tiempo, hasta que empiece otra o se elija algo.
      const recent = list.find((r) => r.endedAt != null);
      if (recent) return { mode: "historial", run: recent };
      return { mode: "idle", run: null };
    }
    const run = runs[view] ?? null;
    return { mode: run?.status === "running" ? "live" : "historial", run };
  }

  function advanceDemo(t) {
    if (t < demo.lastT) { demo = { idx: 0, run: null, lastT: -1 }; packets = []; }
    let { idx, run } = demo;
    const born = [];
    while (idx < demoEvents.length && demoEvents[idx].t <= t) {
      const ev = demoEvents[idx++];
      run = reduceRun(run, ev);
      born.push(...packetsFor(ev, run, ev.t, nextSeq));
    }
    demo = { idx, run, lastT: t };
    if (born.length) packets = [...packets, ...born];
    return run;
  }

  function frame({ perfNow, wallNow, view, runs, paused }) {
    if (base == null) base = perfNow;
    if (paused && !frozen) frozen = { perf: perfNow, wall: wallNow };
    if (!paused && frozen) { base += perfNow - frozen.perf; frozen = null; }
    const perf = frozen?.perf ?? perfNow;
    const wall = frozen?.wall ?? wallNow;

    let { mode, run } = pick(view, runs, wall);
    let now;
    if (mode === "demo") {
      now = (perf - base) % demoLength;
      run = advanceDemo(now);
    } else {
      now = wall;
    }

    const key = mode === "demo" ? "demo" : run?.id ?? mode;
    if (key !== shownKey) {
      shownKey = key;
      packets = [];
      phaseStart = { phase: null, at: now };
      if (mode === "demo") { demo = { idx: 0, run: null, lastT: -1 }; base = perf; now = 0; run = advanceDemo(0); }
    }
    packets = packets.filter((p) => now - p.born <= p.dur && now >= p.born - 50);

    const phase = derivePhase(run, now);
    if (phaseStart.phase !== phase) phaseStart = { phase, at: now };
    const idx = PHASES.indexOf(phase);

    let fills = PHASES.map(() => 0);
    let current = idx;
    let errorAt = -1;
    if (mode === "demo") {
      const span = spans.find((s) => now >= s.start && now < s.end) ?? spans.at(-1);
      const f = Math.min(1, (now - span.start) / (span.end - span.start));
      fills = PHASES.map((_, i) => (i < idx ? 1 : i === idx ? f : 0));
    } else if (FINAL.has(phase)) {
      const stop = phase === "entrega" ? PHASES.length - 1 : run?.taskOrder.length ? 4 : 1;
      fills = PHASES.map((_, i) => (i <= stop ? 1 : 0));
      if (phase !== "entrega") { errorAt = stop; current = stop; }
    } else if (idx >= 0) {
      const f = Math.min(0.95, 1 - Math.exp(-(now - phaseStart.at) / 6000));
      fills = PHASES.map((_, i) => (i < idx ? 1 : i === idx ? f : 0));
    }

    const active = activePills(runs, wall, mode === "demo" ? null : run?.id);
    return { mode, run, now, wallNow: wall, phase, fills, current, errorAt, packets, active, caption: captionFor(phase, run, now) };
  }

  return { frame, onLiveEvent };
}
