import { describe, it, expect } from "vitest";
import { esAvisoDelSistema } from "../src/core/avisos.mjs";
import { runShadow } from "../src/core/shadow.mjs";
import { reduceRun as reduce } from "../src/core/reducer.mjs";
import { shadowVerdict, aggregateShadow, trainingLabel, trainingSummary } from "../src/core/details.mjs";
import { trainingRows } from "../src/core/laya-data.mjs";

const AVISO = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";

describe("esAvisoDelSistema", () => {
  it("true con la etiqueta al principio, también tras espacios o saltos", () => {
    expect(esAvisoDelSistema(AVISO)).toBe(true);
    expect(esAvisoDelSistema("  \n\t<task-notification>hola")).toBe(true);
  });
  it("false con prompt normal o con la etiqueta solo mencionada en medio", () => {
    expect(esAvisoDelSistema("arregla el login")).toBe(false);
    expect(esAvisoDelSistema("explícame qué es <task-notification> en medio")).toBe(false);
    expect(esAvisoDelSistema("")).toBe(false);
    expect(esAvisoDelSistema(undefined)).toBe(false);
  });
});

describe("runShadow con aviso del sistema", () => {
  it("no llama al clasificador y anota shadow_route como no aplica", async () => {
    let llamadas = 0;
    const classifier = { classify: async () => { llamadas += 1; return { choice: "opus" }; } };
    const eventos = [];
    const store = { append: async (id, ev) => { eventos.push([id, ev]); } };
    const ev = await runShadow({ classifier, store, runId: "r1", prompt: AVISO, model: "m", now: () => 5 });
    expect(llamadas).toBe(0);
    expect(ev).toMatchObject({ type: "shadow_route", na: true, choice: null, error: null });
    expect(eventos).toEqual([["r1", ev]]);
  });
});

const base = (task, extra = {}) => {
  let run = reduce(undefined, { type: "run_start", runId: "r1", task, mode: "sesion", model: "opus", profile: "trabajo", t: 1 });
  run = reduce(run, { type: "shadow_route", model: "convaiinnovations/laya-multilingual", choice: null, na: true, t: 2 });
  run = reduce(run, { type: "run_end", status: "completed", t: 3 });
  return { ...run, ...extra };
};

describe("no aplica en el resto del sistema", () => {
  it("el reducer guarda na y el veredicto no cuenta como coincidencia", () => {
    const run = base(AVISO);
    expect(run.shadow.na).toBe(true);
    const v = shadowVerdict(run);
    expect(v.na).toBe(true);
    expect(v.match).toBe(null);
    expect(v.pending).toBe(false);
  });
  it("las estadísticas lo excluyen", () => {
    const agg = aggregateShadow([base(AVISO)]);
    expect(agg.n).toBe(0);
    expect(agg.errors).toBe(0);
  });
  it("no se usa para entrenar (ni etiqueta, ni resumen, ni filas)", () => {
    const run = { ...base(AVISO), routeLabel: { label: "opus", t: 4 } };
    expect(trainingLabel(run)).toBe(null);
    expect(trainingSummary([run]).n).toBe(0);
    expect(trainingRows([run])).toEqual([]);
    const normal = { ...base("haz algo"), routeLabel: { label: "opus", t: 4 } };
    expect(trainingRows([normal])).toHaveLength(1);
  });
});
