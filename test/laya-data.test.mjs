import { describe, it, expect } from "vitest";
import { CHOICES, buildLayaContext } from "../src/core/classifier.mjs";

const ctx = (prompt) => buildLayaContext({ prompt });
import { SEEDS } from "../src/core/laya-seeds.mjs";
import {
  trainingRows, csvField, toCsv, CSV_HEADER, inEvalSet, splitRows, distribution, classWarnings, checkMinimum,
  toJsonl, withSeeds, addSeeds, SEED_EVAL_RATIO, parseLocalSeeds, scoreEval, compareScores, layaTrainArgs,
  oversample, sourceBreakdown, TRAIN_DEFAULTS
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
      run("e", "charla sin delegar"),
      run("c", "tarea fallida", { status: "failed" }),
      run("d", "   ", {})
    ];
    expect(trainingRows(runs)).toEqual([
      { text: "[mensaje] Dime qué opinas\n[anterior] ruta=sin_anterior", label: "opus", profile: "trabajo", source: "usuario", runId: "a" },
      { text: "[mensaje] Revisa esto [texto pegado: 3 líneas]\n[anterior] ruta=sin_anterior", label: "programador", profile: "trabajo", source: "auto", runId: "b" }
    ]);
  });
  it("excluye runs sin subagente salvo corrección manual; consultor y propio entran como opus", () => {
    const runs = [
      run("a", "sin nada"),
      run("b", "corregido", { routeLabel: { label: "programador", t: 1 } }),
      run("c", "con consultor", withTask("consultor")),
      run("d", "con propio", withTask("propio"))
    ];
    expect(trainingRows(runs).map((r) => [r.runId, r.label, r.source])).toEqual([
      ["b", "programador", "usuario"], ["c", "opus", "auto"], ["d", "opus", "auto"]
    ]);
  });
  it("filtra por perfil (todos por defecto)", () => {
    const runs = [run("a", "x", { profile: "personal", ...withTask("programador") }), run("b", "y", withTask("programador"))];
    expect(trainingRows(runs, { profile: "personal" }).map((r) => r.runId)).toEqual(["a"]);
    expect(trainingRows(runs, { profile: "trabajo" }).map((r) => r.runId)).toEqual(["b"]);
    expect(trainingRows(runs, { profile: "todos" })).toHaveLength(2);
    expect(trainingRows([{ ...run("c", "z", withTask("programador")), profile: undefined }], { profile: "trabajo" })).toHaveLength(1);
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
  it("ninguna sesión queda en train y eval a la vez", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ text: `texto ${i}`, label: "opus", session: `s${i % 60}`, runId: `id-${i}` }));
    const { train, eval: ev } = splitRows(rows, 0.2);
    const inTrain = new Set(train.map((r) => r.session));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((r) => inTrain.has(r.session))).toBe(false);
    expect(train.length + ev.length).toBe(300);
    expect(splitRows(rows, 0.2).eval.map((r) => r.runId)).toEqual(ev.map((r) => r.runId));
  });
  it("sin sesión cada fila es su propia sesión (runId)", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ text: "igual", runId: `id-${i}` }));
    const { eval: ev } = splitRows(rows, 0.5);
    expect(ev.length).toBeGreaterThan(10);
    expect(ev.length).toBeLessThan(90);
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
  const cls = (a, p, o) => ({ asistente: { n: 10, accuracy: a }, programador: { n: 10, accuracy: p }, opus: { n: 10, accuracy: o } });
  it("compareScores: caso real, global sube pero el modelo colapsa a programador -> regresion", () => {
    const r = compareScores({ accuracy: 0.485, byClass: cls(0.3, 0.75, 0.188) }, { accuracy: 0.5, byClass: cls(0.1, 1, 0) });
    expect(r.winner).toBe("regresion");
    expect(r.regresiones).toEqual([
      { clase: "asistente", base: 0.3, nuevo: 0.1 },
      { clase: "opus", base: 0.188, nuevo: 0 }
    ]);
  });
  it("compareScores: mejora limpia por clase sigue dando nuevo", () => {
    const r = compareScores({ accuracy: 0.5, byClass: cls(0.3, 0.5, 0.5) }, { accuracy: 0.7, byClass: cls(0.6, 0.8, 0.7) });
    expect(r.winner).toBe("nuevo");
    expect(r.regresiones).toEqual([]);
  });
  it("compareScores: una caida de hasta 5 puntos se tolera; clases sin ejemplos se ignoran", () => {
    const byBase = { ...cls(0.5, 0.5, 0.5), opus: { n: 0, accuracy: null } };
    const byNuevo = { ...cls(0.46, 0.9, 0.9), opus: { n: 0, accuracy: null } };
    expect(compareScores({ accuracy: 0.5, byClass: byBase }, { accuracy: 0.7, byClass: byNuevo }).winner).toBe("nuevo");
  });
  it("compareScores: clase que queda en 0 % es regresion aunque la caida sea corta", () => {
    const r = compareScores({ accuracy: 0.5, byClass: cls(0.03, 0.5, 0.5) }, { accuracy: 0.7, byClass: cls(0, 0.9, 0.9) });
    expect(r.winner).toBe("regresion");
  });
  it("compareScores: si la global no sube no se llama regresion", () => {
    expect(compareScores({ accuracy: 0.7, byClass: cls(0.7, 0.7, 0.7) }, { accuracy: 0.6, byClass: cls(0.1, 0.9, 0.8) }).winner).toBe("base");
    expect(compareScores({ accuracy: 0.7, byClass: cls(0.7, 0.7, 0.7) }, { accuracy: 0.7, byClass: cls(0.1, 0.9, 0.9) }).winner).toBe("empate");
  });
});

describe("semillas versionadas", () => {
  it("withSeeds añade semillas con origen y sin duplicar texto", () => {
    const out = withSeeds([{ text: "a", label: "programador", runId: "r1" }]);
    expect(out[0]).toEqual({ text: "a", label: "programador", runId: "r1" });
    const seeds = out.slice(1);
    expect(seeds.length).toBeGreaterThanOrEqual(30);
    expect(seeds.every((r) => CHOICES.includes(r.label) && r.source === "semilla" && ["manual", "historico"].includes(r.origin))).toBe(true);
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

describe("semillas por etiqueta", () => {
  const seeds = withSeeds([]);
  const of = (label) => seeds.filter((r) => r.label === label);
  it("hay semillas manuales de asistente, programador y opus", () => {
    expect(of("asistente").filter((r) => r.origin === "manual").length).toBeGreaterThanOrEqual(28);
    expect(of("programador").filter((r) => r.origin === "manual").length).toBeGreaterThanOrEqual(9);
    expect(of("opus").filter((r) => r.origin === "manual").length).toBeGreaterThanOrEqual(30);
  });
  it("cada semilla versionada tiene una etiqueta válida", () => {
    expect(seeds.every((r) => CHOICES.includes(r.label))).toBe(true);
  });
  it("una semilla sin etiqueta cuenta como opus", () => {
    const out = addSeeds([], [], [{ text: "sin etiqueta local", origin: "historico" }]);
    const row = [...out.train, ...out.eval].find((r) => r.text === ctx("sin etiqueta local"));
    expect(row.label).toBe("opus");
    expect(withSeeds([], [{ text: "otra sin etiqueta" }]).find((r) => r.text === ctx("otra sin etiqueta")).label).toBe("opus");
  });
  it("addSeeds reparte cada etiqueta ~75/25 y de forma determinista", () => {
    const a = addSeeds([], []);
    expect(addSeeds([], [])).toEqual(a);
    for (const label of CHOICES) {
      const t = a.train.filter((r) => r.label === label).length;
      const e = a.eval.filter((r) => r.label === label).length;
      expect(t + e).toBe(of(label).length);
      expect(t).toBeGreaterThan(0);
    }
    for (const label of ["asistente", "opus"]) {
      const e = a.eval.filter((r) => r.label === label).length;
      expect(e / of(label).length).toBeGreaterThan(0.1);
      expect(e / of(label).length).toBeLessThan(0.45);
    }
  });
  it("con muchas semillas locales de cada etiqueta el reparto se acerca a 75/25", () => {
    const local = CHOICES.flatMap((label) => Array.from({ length: 120 }, (_, i) => ({ text: `local ${label} ${i}`, label, origin: "historico" })));
    const a = addSeeds([], [], local);
    for (const label of CHOICES) {
      const e = a.eval.filter((r) => r.label === label && r.text.startsWith("[mensaje] local")).length;
      expect(e / 120).toBeGreaterThan(0.15);
      expect(e / 120).toBeLessThan(0.35);
    }
  });
  it("sin solape train/eval en ninguna etiqueta", () => {
    const a = addSeeds([], []);
    const t = new Set(a.train.map((r) => r.text.trim().toLowerCase()));
    expect(a.eval.some((r) => t.has(r.text.trim().toLowerCase()))).toBe(false);
  });
  it("las semillas de train cuentan en el mínimo de su propia clase", () => {
    const a = addSeeds([], []);
    const dist = distribution(a.train.filter((r) => r.source === "semilla"));
    for (const label of CHOICES) expect(dist[label]).toBe(a.train.filter((r) => r.label === label).length);
    expect(dist.asistente).toBeGreaterThanOrEqual(15);
    expect(checkMinimum(distribution([...a.train, ...a.eval]), { minTotal: 1, minPerClass: 1 }).ok).toBe(true);
  });
});

describe("semillas y evaluación", () => {
  it("una semilla cuyo texto está en eval no entra al train", () => {
    const manual = withSeeds([]).find((r) => r.origin === "manual").text;
    const out = withSeeds([], [{ text: "local", label: "opus", origin: "historico" }], [{ text: manual }, { text: ctx(" LOCAL ") }]);
    expect(out.some((r) => r.text === manual)).toBe(false);
    expect(out.some((r) => r.text === ctx("local"))).toBe(false);
    expect(out.length).toBe(withSeeds([]).length - 1);
  });
});

describe("addSeeds: reparto de semillas entre train y eval", () => {
  const manual = withSeeds([]).filter((r) => r.source === "semilla");
  const keys = (rs) => rs.map((r) => r.text.trim().replace(/\s+/g, " ").toLowerCase());
  it("determinista y con ~75/25 sobre las manuales", () => {
    const a = addSeeds([], []);
    const b = addSeeds([], []);
    expect(a).toEqual(b);
    expect(a.train.length + a.eval.length).toBe(manual.length);
    expect(SEED_EVAL_RATIO).toBe(0.25);
    expect(a.eval.length).toBeGreaterThan(0);
    expect(a.eval.length / manual.length).toBeGreaterThan(0.1);
    expect(a.eval.length / manual.length).toBeLessThan(0.4);
    expect(a.train.every((r) => r.source === "semilla") && a.eval.every((r) => r.source === "semilla")).toBe(true);
  });
  it("ninguna semilla está a la vez en train y eval, y mismo texto = mismo lado", () => {
    const local = Array.from({ length: 80 }, (_, i) => ({ text: `local ${i}`, label: "opus", origin: "historico" }));
    const a = addSeeds([], [], local);
    const t = new Set(keys(a.train));
    expect(keys(a.eval).some((k) => t.has(k))).toBe(false);
    const again = addSeeds([], [], [...local].reverse());
    expect(new Set(keys(again.eval))).toEqual(new Set(keys(a.eval)));
    expect(a.eval.length / (a.train.length + a.eval.length)).toBeGreaterThan(0.15);
  });
  it("conserva las filas reales y no repite textos de filas reales de ningún lado", () => {
    const m = manual[0].text;
    const m2 = manual[1].text;
    const out = addSeeds([{ text: m, label: "programador" }], [{ text: m2, label: "programador" }]);
    expect(out.train.filter((r) => r.text === m)).toHaveLength(1);
    expect([...out.train, ...out.eval].filter((r) => r.text === m2)).toHaveLength(1);
    expect(out.eval.find((r) => r.text === m2).source).toBeUndefined();
    expect(out.eval.some((r) => r.text === m)).toBe(false);
    expect(out.train.find((r) => r.text === m).label).toBe("programador");
  });
  it("las semillas locales también se reparten", () => {
    const out = addSeeds([], [], [{ text: "solo local", label: "opus", origin: "historico" }]);
    expect([...out.train, ...out.eval].filter((r) => r.text === ctx("solo local"))).toHaveLength(1);
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
  it("parseLocalSeeds: sin etiqueta = opus; etiqueta inválida se salta; asistente se conserva", () => {
    const out = parseLocalSeeds([l({ text: "sin etiqueta" }), l({ label: "asistente", text: "para haiku" }), l({ label: "otra", text: "mala" }), l({ label: 3, text: "numérica" })].join("\n"));
    expect(out).toEqual([
      { text: "sin etiqueta", label: "opus", origin: "historico" },
      { text: "para haiku", label: "asistente", origin: "historico" }
    ]);
  });
  it("withSeeds añade las locales como semilla, sin repetir texto de filas ni de manuales", () => {
    const manualRaw = SEEDS.find((r) => r.origin === "manual").text;
    const extra = [{ text: "local", label: "opus", origin: "historico" }, { text: manualRaw, label: "opus", origin: "historico" }, { text: "fila", label: "opus", origin: "historico" }];
    const out = withSeeds([{ text: ctx("fila"), label: "programador" }], extra);
    expect(out.filter((r) => r.text === ctx("local"))).toEqual([{ text: ctx("local"), label: "opus", origin: "historico", source: "semilla" }]);
    expect(out.filter((r) => r.text === ctx(manualRaw))).toHaveLength(1);
    expect(out.filter((r) => r.text === ctx("fila"))).toHaveLength(1);
  });
});

describe("layaTrainArgs: ajustes de entreno", () => {
  const base = { data: "d.jsonl", out: "o", base: "multilingual" };
  it("propaga loss, epochs, eval, freezeEncoder y seed con los nombres reales de laya-train", () => {
    const a = layaTrainArgs({ ...base, loss: "soft-ce", epochs: 6, eval: "e.jsonl", freezeEncoder: true, seed: 3 });
    expect(a.slice(a.indexOf("--loss"), a.indexOf("--loss") + 2)).toEqual(["--loss", "soft-ce"]);
    expect(a[a.indexOf("--epochs") + 1]).toBe("6");
    expect(a[a.indexOf("--eval") + 1]).toBe("e.jsonl");
    expect(a).toContain("--freeze-encoder");
    expect(a[a.indexOf("--seed") + 1]).toBe("3");
  });
  it("seed 0 se pasa; sin freezeEncoder no hay flag; sin nada no se añade nada", () => {
    expect(layaTrainArgs({ ...base, seed: 0 })).toEqual([...layaTrainArgs(base), "--seed", "0"]);
    expect(layaTrainArgs({ ...base, freezeEncoder: false })).not.toContain("--freeze-encoder");
    expect(layaTrainArgs(base)).toEqual(["--data", "d.jsonl", "--out", "o", "--base", "multilingual"]);
  });
  it("valores por defecto del entreno", () => {
    expect(TRAIN_DEFAULTS).toMatchObject({ loss: "soft-ce", gradAccum: 8, epochs: 6 });
  });
});

describe("oversample", () => {
  const mk = (label, n) => Array.from({ length: n }, (_, i) => ({ text: `${label}-${i}`, label }));
  const items = [...mk("programador", 10), ...mk("asistente", 4), ...mk("opus", 3)];
  it("iguala las clases minoritarias a la mayoritaria", () => {
    expect(distribution(oversample(items, { seed: 1 }))).toEqual({ asistente: 10, programador: 10, opus: 10 });
  });
  it("no toca la clase mayoritaria ni quita originales, y no modifica la entrada", () => {
    const copy = JSON.parse(JSON.stringify(items));
    const out = oversample(items, { seed: 1 });
    expect(items).toEqual(copy);
    expect(out.slice(0, items.length)).toEqual(items);
    expect(out.filter((r) => r.label === "programador")).toEqual(mk("programador", 10));
  });
  it("los duplicados salen de la propia clase y se reparten por igual (+-1)", () => {
    const out = oversample(items, { seed: 1 });
    const counts = {};
    for (const r of out.filter((r) => r.label === "opus")) counts[r.text] = (counts[r.text] ?? 0) + 1;
    expect(Object.keys(counts).sort()).toEqual(["opus-0", "opus-1", "opus-2"]);
    expect(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts))).toBeLessThanOrEqual(1);
  });
  it("es determinista con la misma semilla y puede variar con otra", () => {
    expect(oversample(items, { seed: 7 })).toEqual(oversample(items, { seed: 7 }));
    expect(oversample(items, { seed: 7 })).not.toEqual(oversample(items, { seed: 8 }));
  });
  it("sin clases vacías que inventar: una clase con 0 se queda en 0; entrada vacía da vacío", () => {
    expect(distribution(oversample([...mk("programador", 4), ...mk("opus", 2)], { seed: 1 })).asistente).toBe(0);
    expect(oversample([], { seed: 1 })).toEqual([]);
  });
});

describe("sourceBreakdown", () => {
  it("cuenta por clase corrección manual, automáticas y semillas", () => {
    const rows = [
      { label: "opus", source: "usuario" }, { label: "opus", source: "auto" }, { label: "opus", source: "semilla" },
      { label: "asistente", source: "auto" }, { label: "asistente", source: "auto" }
    ];
    expect(sourceBreakdown(rows)).toEqual({
      asistente: { usuario: 0, auto: 2, semilla: 0 },
      programador: { usuario: 0, auto: 0, semilla: 0 },
      opus: { usuario: 1, auto: 1, semilla: 1 }
    });
  });
});

describe("trainingRows con contexto del turno anterior", () => {
  const ses = (id, sid, t, task, node, over = {}) => run(id, task, { mode: "sesion", startedAt: t, endedAt: t + 5, ...withTask(node), ...over });
  const runs = [
    ses("20261001T000000Z-aaaa1111-1", "aaaa1111", 100, "crea el login", "programador"),
    ses("20261001T000100Z-aaaa1111-2", "aaaa1111", 200, "ahora arréglalo", "asistente"),
    ses("20261001T000200Z-bbbb2222-1", "bbbb2222", 150, "otra sesión", "programador"),
    ses("20261001T000300Z-aaaa1111-3", "aaaa1111", 300, "último", "programador")
  ];
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.runId, r.text]));

  it("encadena por sesión y orden de tiempo con tarea y ruta real del anterior", () => {
    const t = by(trainingRows(runs));
    expect(t["20261001T000000Z-aaaa1111-1"]).toBe("[mensaje] crea el login\n[anterior] ruta=sin_anterior");
    expect(t["20261001T000100Z-aaaa1111-2"]).toBe("[mensaje] ahora arréglalo\n[anterior] ruta=programador\n[encargo anterior] crea el login");
    expect(t["20261001T000200Z-bbbb2222-1"]).toContain("ruta=sin_anterior");
    expect(t["20261001T000300Z-aaaa1111-3"]).toContain("ruta=asistente\n[encargo anterior] ahora arréglalo");
  });
  it("no usa la etiqueta del usuario del anterior, solo actualRoute", () => {
    const rs = [ses("20261001T000000Z-cccc3333-1", "c", 1, "uno", "programador", { routeLabel: { label: "opus", t: 1 }, endedAt: 1 }), ses("20261001T000100Z-cccc3333-2", "c", 2, "dos", "asistente")];
    expect(by(trainingRows(rs))["20261001T000100Z-cccc3333-2"]).toContain("ruta=programador");
  });
  it("el anterior sin ruta (en curso o terminado después) es ninguna", () => {
    const rs = [ses("20261001T000000Z-dddd4444-1", "d", 1, "uno", "programador", { status: "running", endedAt: null }), ses("20261001T000100Z-dddd4444-2", "d", 2, "dos", "asistente")];
    expect(by(trainingRows(rs))["20261001T000100Z-dddd4444-2"]).toContain("ruta=ninguna\n[encargo anterior] uno");
    const tarde = [ses("20261001T000000Z-eeee5555-1", "e", 1, "uno", "programador", { endedAt: 99 }), ses("20261001T000100Z-eeee5555-2", "e", 2, "dos", "asistente")];
    expect(by(trainingRows(tarde))["20261001T000100Z-eeee5555-2"]).toContain("ruta=ninguna");
  });
  it("anti-fuga: solo entra información de runs que empezaron antes", () => {
    const rows = trainingRows(runs);
    for (const r of rows) {
      const me = runs.find((x) => x.id === r.runId);
      for (const other of runs) {
        if (other.startedAt < me.startedAt && other.mode === "sesion") continue;
        if (other.id === me.id) continue;
        if (other.task.length > 5) expect(r.text.replace(`[mensaje] ${me.task}`, "")).not.toContain(other.task);
      }
    }
  });
  it("runs que no son de sesión no se encadenan", () => {
    const rs = [run("a", "uno", { mode: "orquestado", startedAt: 1, ...withTask("programador") }), run("b", "dos", { mode: "orquestado", startedAt: 2, ...withTask("programador") })];
    expect(trainingRows(rs).every((r) => r.text.includes("sin_anterior"))).toBe(true);
  });
  it("el anterior puede ser un run sin etiqueta propia (no filtrado por perfil)", () => {
    const rs = [ses("20261001T000000Z-ffff6666-1", "f", 1, "uno", "programador", { profile: "personal" }), ses("20261001T000100Z-ffff6666-2", "f", 2, "dos", "asistente")];
    const out = trainingRows(rs, { profile: "trabajo" });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("[encargo anterior] uno");
  });
  it("las filas llevan sesión y el split nunca separa una sesión", () => {
    const many = [];
    for (let s = 0; s < 40; s++) for (let k = 1; k <= 4; k++) {
      many.push(ses(`20261001T0000${k}0Z-s${String(s).padStart(7, "0")}-${k}`, "x", s * 100 + k, `t${s}-${k}`, "programador"));
    }
    const rows = trainingRows(many);
    expect(rows.every((r) => r.session === r.runId.split("-")[1])).toBe(true);
    const { train, eval: ev } = splitRows(rows, 0.3);
    const tr = new Set(train.map((r) => r.session));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((r) => tr.has(r.session))).toBe(false);
  });
});

describe("semillas con contexto", () => {
  it("pasan por buildLayaContext con sin_anterior", () => {
    const seeds = withSeeds([]);
    expect(seeds.every((r) => /^\[mensaje\] [\s\S]*\n\[anterior\] ruta=sin_anterior$/.test(r.text))).toBe(true);
    const local = addSeeds([], [], [{ text: "local sola", label: "opus", origin: "historico" }]);
    expect([...local.train, ...local.eval].some((r) => r.text === "[mensaje] local sola\n[anterior] ruta=sin_anterior")).toBe(true);
  });
});
