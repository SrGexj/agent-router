import { describe, it, expect } from "vitest";
import {
  trainingRows, csvField, toCsv, CSV_HEADER, inEvalSet, splitRows, distribution, classWarnings, checkMinimum,
  toJsonl, withSeeds, parseLocalSeeds, scoreEval, compareScores, layaTrainArgs
} from "../src/core/laya-data.mjs";

const run = (id, task, over = {}) => ({
  id, task, status: "completed", profile: "trabajo", startedAt: 0, endedAt: 1, tasks: {}, taskOrder: [], ...over
});
const withTask = (node) => ({ tasks: { a: { node } }, taskOrder: ["a"] });

describe("trainingRows", () => {
  it("toma las ejecuciones con etiqueta, con el texto saneado que recibe Laya", () => {
    const runs = [
      run("b", 'Revisa esto <pasted_content id="1">uno\ndos\ntres</pasted_content>', withTask("programador")),
      run("a", "Dime qué opinas", { routeLabel: { label: "opus", t: 1 } }),
      run("c", "tarea fallida", { status: "failed" }),
      run("d", "   ", {})
    ];
    expect(trainingRows(runs)).toEqual([
      { text: "Dime qué opinas", label: "opus", profile: "trabajo", source: "usuario", runId: "a" },
      { text: "Revisa esto [texto pegado: 3 líneas]", label: "programador", profile: "trabajo", source: "auto", runId: "b" }
    ]);
  });
  it("filtra por perfil (todos por defecto)", () => {
    const runs = [run("a", "x", { profile: "personal" }), run("b", "y")];
    expect(trainingRows(runs, { profile: "personal" }).map((r) => r.runId)).toEqual(["a"]);
    expect(trainingRows(runs, { profile: "trabajo" }).map((r) => r.runId)).toEqual(["b"]);
    expect(trainingRows(runs, { profile: "todos" })).toHaveLength(2);
    expect(trainingRows([{ ...run("c", "z"), profile: undefined }], { profile: "trabajo" })).toHaveLength(1);
  });
});

describe("CSV", () => {
  it("escapa comas, comillas y saltos de línea", () => {
    expect(csvField("hola")).toBe("hola");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('di "hola"')).toBe('"di ""hola"""');
    expect(csvField("l1\nl2")).toBe('"l1\nl2"');
    expect(csvField("l1\r\nl2")).toBe('"l1\r\nl2"');
  });
  it("cabecera fija y una fila por ejemplo", () => {
    const rows = [{ text: 'Añade "x", y\nluego z', label: "programador", profile: "trabajo", source: "auto", runId: "r1" }];
    expect(toCsv(rows)).toBe(`${CSV_HEADER}\n"Añade ""x"", y\nluego z",programador,trabajo,auto,r1\n`);
    expect(CSV_HEADER).toBe("texto,etiqueta,perfil,fuente,runId");
    expect(toCsv([])).toBe(`${CSV_HEADER}\n`);
  });
});

describe("conjunto de evaluación", () => {
  it("es estable por runId y cercano al ratio", () => {
    expect(inEvalSet("r1", 0.2)).toBe(inEvalSet("r1", 0.2));
    const ids = Array.from({ length: 2000 }, (_, i) => `2026${i}-id`);
    const share = ids.filter((id) => inEvalSet(id, 0.2)).length / ids.length;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
    expect(ids.some((id) => inEvalSet(id, 0))).toBe(false);
    expect(ids.every((id) => inEvalSet(id, 1))).toBe(true);
  });
  it("splitRows reparte sin perder ni duplicar", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ text: `t${i}`, label: "opus", profile: "trabajo", source: "auto", runId: `id-${i}` }));
    const { train, eval: ev } = splitRows(rows, 0.2);
    expect(train.length + ev.length).toBe(100);
    expect(new Set([...train, ...ev].map((r) => r.runId)).size).toBe(100);
    expect(ev.length).toBeGreaterThan(5);
  });
});

describe("reparto y mínimos", () => {
  const rows = (a, p, o) => [
    ...Array(a).fill({ label: "asistente" }), ...Array(p).fill({ label: "programador" }), ...Array(o).fill({ label: "opus" })
  ];
  it("distribution cuenta las tres clases", () => {
    expect(distribution(rows(1, 2, 0))).toEqual({ asistente: 1, programador: 2, opus: 0 });
  });
  it("classWarnings avisa de las clases por debajo del mínimo", () => {
    expect(classWarnings({ asistente: 20, programador: 14, opus: 0 }, 15)).toEqual(["programador", "opus"]);
    expect(classWarnings({ asistente: 20, programador: 15, opus: 99 }, 15)).toEqual([]);
  });
  it("checkMinimum se niega con pocos ejemplos o clases escasas", () => {
    expect(checkMinimum({ asistente: 20, programador: 20, opus: 20 })).toEqual({ ok: true, reasons: [] });
    const few = checkMinimum({ asistente: 10, programador: 10, opus: 10 });
    expect(few.ok).toBe(false);
    expect(few.reasons.join(" ")).toMatch(/30/);
    const scarce = checkMinimum({ asistente: 50, programador: 50, opus: 3 });
    expect(scarce.ok).toBe(false);
    expect(scarce.reasons.join(" ")).toMatch(/opus/);
  });
});

describe("formato de entrenamiento", () => {
  it("toJsonl usa el mismo estado y preguntas que el servicio", () => {
    const line = JSON.parse(toJsonl([{ text: "Hola", label: "opus" }]).trim());
    expect(line.state).toEqual({ body: "Hola" });
    expect(line.expected).toEqual({ route: "opus" });
    expect(Object.keys(line.questions.route.criteria)).toEqual(["asistente", "programador", "opus"]);
  });
  it("layaTrainArgs: flags reales de laya-train", () => {
    expect(layaTrainArgs({ data: "d.jsonl", out: "o", base: "multilingual" })).toEqual(["--data", "d.jsonl", "--out", "o", "--base", "multilingual"]);
    expect(layaTrainArgs({ data: "d.csv", out: "o", base: "multilingual", dryRun: true, textColumn: "texto", labelColumn: "etiqueta" }))
      .toEqual(["--data", "d.csv", "--out", "o", "--base", "multilingual", "--text-column", "texto", "--label-column", "etiqueta", "--dry-run"]);
  });
});

describe("evaluación", () => {
  const gold = [{ label: "asistente" }, { label: "asistente" }, { label: "programador" }, { label: "opus" }];
  it("accuracy global y por clase", () => {
    const s = scoreEval(gold, ["asistente", "programador", "programador", "programador"]);
    expect(s.n).toBe(4);
    expect(s.accuracy).toBeCloseTo(0.5);
    expect(s.byClass.asistente).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
    expect(s.byClass.programador).toEqual({ n: 1, correct: 1, accuracy: 1 });
    expect(s.byClass.opus).toEqual({ n: 1, correct: 0, accuracy: 0 });
  });
  it("sin ejemplos: accuracy null; clase vacía: null", () => {
    expect(scoreEval([], []).accuracy).toBeNull();
    expect(scoreEval([{ label: "opus" }], ["opus"]).byClass.asistente.accuracy).toBeNull();
  });
  it("falla si no hay una predicción por ejemplo", () => {
    expect(() => scoreEval(gold, ["opus"])).toThrow(/predicciones/);
  });
  it("compareScores: solo gana el nuevo si mejora estrictamente", () => {
    expect(compareScores({ accuracy: 0.5 }, { accuracy: 0.7 }).winner).toBe("nuevo");
    expect(compareScores({ accuracy: 0.7 }, { accuracy: 0.7 }).winner).toBe("empate");
    expect(compareScores({ accuracy: 0.7 }, { accuracy: 0.6 }).winner).toBe("base");
    expect(compareScores({ accuracy: null }, { accuracy: 0.6 }).winner).toBe("empate");
  });
});

describe("semillas versionadas", () => {
  it("withSeeds añade semillas opus con origen y sin duplicar texto", () => {
    const out = withSeeds([{ text: "a", label: "programador", runId: "r1" }]);
    expect(out[0]).toEqual({ text: "a", label: "programador", runId: "r1" });
    const seeds = out.slice(1);
    expect(seeds.length).toBeGreaterThanOrEqual(30);
    expect(seeds.every((r) => r.label === "opus" && r.source === "semilla" && ["manual", "historico"].includes(r.origin))).toBe(true);
    expect(new Set(seeds.map((r) => r.text)).size).toBe(seeds.length);
    expect(withSeeds(out)).toHaveLength(out.length);
  });
  it("las semillas no traen rutas personales ni correos", () => {
    for (const r of withSeeds([])) expect(r.text).not.toMatch(/\/Users\/|@\w+\.\w+|sk-/);
  });
  it("toJsonl las serializa como cualquier fila", () => {
    const l = JSON.parse(toJsonl(withSeeds([])).split("\n")[0]);
    expect(l.expected).toEqual({ route: "opus" });
  });
});

describe("semillas locales (JSONL fuera del repo)", () => {
  const l = (o) => JSON.stringify(o);
  it("parseLocalSeeds salta líneas inválidas y conserva las buenas", () => {
    const text = [
      l({ origin: "historico", label: "opus", text: "buena uno" }),
      "no es json",
      l({ origin: "historico", label: "otra", text: "etiqueta no válida" }),
      l({ origin: "historico", label: "opus", text: "   " }),
      l({ label: "programador", text: "buena dos" }),
      ""
    ].join("\n");
    const out = parseLocalSeeds(text);
    expect(out.map((r) => r.text)).toEqual(["buena uno", "buena dos"]);
    expect(out[0]).toEqual({ text: "buena uno", label: "opus", origin: "historico" });
    expect(parseLocalSeeds(undefined)).toEqual([]);
  });
  it("withSeeds añade las locales como semilla, sin repetir texto de filas ni de manuales", () => {
    const manual = withSeeds([]).find((r) => r.origin === "manual").text;
    const extra = [{ text: "local", label: "opus", origin: "historico" }, { text: manual, label: "opus", origin: "historico" }, { text: "fila", label: "opus", origin: "historico" }];
    const out = withSeeds([{ text: "fila", label: "programador" }], extra);
    expect(out.filter((r) => r.text === "local")).toEqual([{ text: "local", label: "opus", origin: "historico", source: "semilla" }]);
    expect(out.filter((r) => r.text === manual)).toHaveLength(1);
    expect(out.filter((r) => r.text === "fila")).toHaveLength(1);
  });
});
