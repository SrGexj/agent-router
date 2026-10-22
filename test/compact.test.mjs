import { describe, it, expect } from "vitest";
import { windowLine, savingsLines, shadowLines, p90Lines, p90ForecastLine, sourcesLines, quotaBadge } from "../dashboard/src/compact.js";
import { fmtClock } from "../dashboard/src/captions.js";

const clock = (s) => fmtClock(s);

describe("windowLine", () => {
  it("5 h con reinicio: etiqueta corta, porcentaje y hora", () => {
    const l = windowLine("5h", 67.4, 1_800_000_000);
    expect(l).toMatchObject({ label: "5 h", pct: 67, tone: "ok", reset: `↻ ${clock(1_800_000_000)}` });
    expect(l.text).toBe(`5 h · 67 % · ↻ ${clock(1_800_000_000)}`);
    expect(l.title).toMatch(/5 horas/);
  });
  it("7 d, sin hora de reinicio no deja hueco", () => {
    const l = windowLine("7d", 31, null);
    expect(l.label).toBe("7 d");
    expect(l.text).toBe("7 d · 31 %");
    expect(l.title).toMatch(/7 días/);
  });
  it("tonos: aviso a 70 %, rojo desde 90 %, y rojo al 100 %", () => {
    expect(windowLine("5h", 70, null).tone).toBe("warn");
    expect(windowLine("5h", 90, null).tone).toBe("err");
    expect(windowLine("5h", 100, null).tone).toBe("err");
  });
  it("ventana ya reiniciada: 0 % y lo dice", () => {
    const l = windowLine("5h", 88, 10, { expired: true });
    expect(l).toMatchObject({ pct: 0, tone: "ok", reset: "reiniciada" });
  });
  it("el aviso de la fuente va al title", () => {
    expect(windowLine("5h", 10, null, { note: "estimación local" }).title).toMatch(/estimación local/);
  });
});

describe("windowLine con fuente no oficial", () => {
  it("estimación del monitor: el % lleva ~ delante, en pantalla y en el texto", () => {
    const l = windowLine("5h", 54.6, 1_800_000_000, { estimate: true });
    expect(l.pctText).toBe("~55 %");
    expect(l.pct).toBe(55);
    expect(l.text).toBe(`5 h · ~55 % · ↻ ${clock(1_800_000_000)}`);
    expect(l.title).toMatch(/~55 % usado/);
  });
  it("fuente oficial: sin ~", () => {
    expect(windowLine("5h", 55, null).pctText).toBe("55 %");
    expect(windowLine("7d", 12, null, { estimate: false }).text).toBe("7 d · 12 %");
  });
  it("ventana reiniciada: 0 % sin ~ aunque la fuente fuese estimada", () => {
    expect(windowLine("5h", 88, 10, { expired: true, estimate: true }).pctText).toBe("0 %");
  });
});

describe("savingsLines", () => {
  const s = { runs: 8, savingsPct: 15.2, total: 16.28, opusEquivalentUsd: 19.18, tokens: 3_200_000, tokenTypes: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
  it("una línea de porcentaje y una de importes; tokens al title", () => {
    const l = savingsLines(s);
    expect(l.pct).toBe("15 %");
    expect(l.detail).toBe("16,28 $ de 19,18 $ · 8 ejec.");
    expect(l.title).toContain("3,2 M tok");
    expect(l.title).toContain("entrada");
  });
  it("sin ejecuciones no hay bloque; sin porcentaje, guion", () => {
    expect(savingsLines({ ...s, runs: 0 })).toBeNull();
    expect(savingsLines(null)).toBeNull();
    expect(savingsLines({ ...s, savingsPct: null }).pct).toBe("—");
  });
});

describe("shadowLines", () => {
  const sh = { name: "Laya", n: 22, matches: 9, matchPct: 40.9, savingsUsd: 0.5, jevCostUsd: 0.0012, errors: 1, others: [{ n: 2, name: "Otro" }], training: { n: 5, corrected: 1, byLabel: { asistente: 2, programador: 2, opus: 1 } } };
  it("resumen de una línea con (aciertos/total)", () => {
    const l = shadowLines(sh);
    expect(l).toMatchObject({ name: "Laya", pct: "41 %", ratio: "(9/22)", summary: "Detalle Laya" });
    expect(l.title).toBe("Laya en sombra: acierta 9 de 22");
  });
  it("el resto va al detalle sin perder datos", () => {
    const d = shadowLines(sh).detail.join("\n");
    expect(d).toContain("ahorraría");
    expect(d).toContain("0,0012 $");
    expect(d).toContain("1 fallo");
    expect(d).toContain("estimación gruesa");
    expect(d).toContain("no incluye 2 de Otro");
    expect(d).toContain("Datos para entrenar: 5 (1 corregida)");
    expect(d).toContain("orquestador 1");
  });
  it("coste negativo dice costaría; sin n no hay bloque", () => {
    expect(shadowLines({ ...sh, savingsUsd: -1 }).detail.join()).toContain("costaría");
    expect(shadowLines({ ...sh, n: 0 })).toBeNull();
  });
});

const p90 = (o = {}) => ({
  available: true, active: true, sampleHours: 192, provenance: { confidence: "local_estimate" },
  used: { tokens: 101_700, messages: 678, costUsd: 87.89 }, limits: { tokens: 394_200 }, pct: { tokens: 25.8 },
  burnRate: { tokensPerMinute: 822.4, costPerHour: 5.5 }, forecast: { beforeReset: false }, resetAt: 1_800_000_000, ...o
});

describe("p90Lines", () => {
  it("tokens en una línea y mensajes · coste · ritmo en otra", () => {
    const l = p90Lines(p90());
    expect(l.tokens).toBe("101,7 k / 394,2 k tok · 26 %");
    expect(l.pct).toBe(26);
    expect(l.detail).toBe("678 mensajes · ≈ 87,89 $ · 822 tok/min");
    expect(l.detailTitle).toContain("5,50 $/h");
  });
  it("título corto y subtítulo en el tooltip", () => {
    const l = p90Lines(p90());
    expect(l.title).toBe("Tu sesión vs tu P90");
    expect(l.hint).toContain("Referencia personal del monitor, no es el límite de tu plan");
    expect(l.hint).toContain("8 días");
  });
  it("omite lo que falta y no pone filas sin P90", () => {
    const l = p90Lines(p90({ used: { tokens: 10, messages: 1, costUsd: null }, burnRate: null }));
    expect(l.detail).toBe("1 mensaje");
    expect(p90Lines(p90({ used: { tokens: null, messages: null, costUsd: null }, burnRate: null })).detail).toBeNull();
  });
  it("sin tokens usados muestra solo el P90", () => {
    expect(p90Lines(p90({ used: { tokens: null }, pct: {} })).tokens).toBe("P90 394,2 k tok");
  });
  it("sin sesión activa no hay detalle", () => {
    expect(p90Lines(p90({ active: false })).detail).toBeNull();
  });
  it("no disponible: devuelve el motivo", () => {
    expect(p90Lines({ available: false, reason: "plan-no-custom" }).unavailable).toMatch(/plan Custom/);
    expect(p90Lines({ available: false, reason: "x" }).unavailable).toMatch(/Pocos datos/);
  });
});

describe("p90ForecastLine", () => {
  const at = clock(1_800_000_000);
  it("fusiona la previsión con el reinicio en una línea", () => {
    expect(p90ForecastLine(p90())).toBe(`A este ritmo no llegas a tu P90 antes del reinicio de las ${at}`);
    expect(p90ForecastLine(p90({ forecast: { beforeReset: true, hitAt: 1_799_990_000 } }))).toBe(`A este ritmo llegarías a tu P90 a las ${clock(1_799_990_000)} · la sesión se reinicia a las ${at}`);
  });
  it("sin previsión, solo el reinicio; sin nada, null", () => {
    expect(p90ForecastLine(p90({ forecast: null }))).toBe(`La sesión de 5 h del monitor se reinicia a las ${at}`);
    expect(p90ForecastLine(p90({ forecast: null, resetAt: null }))).toBeNull();
  });
  it("P90 superado", () => {
    expect(p90ForecastLine(p90({ pct: { tokens: 120 } }))).toContain("Ya has superado tu P90");
  });
});

describe("sourcesLines", () => {
  const base = { toolVersion: "4.0.0", provenance: { confidence: "local_estimate" } };
  it("tokens, precios del router y fuente de ventanas", () => {
    const l = sourcesLines(base, { window5h: { confidence: "local_estimate" }, window7d: null }).join("\n");
    expect(l).toContain("claude-monitor 4.0.0 (estimación local)");
    expect(l).toContain("precios del monitor");
    expect(l).toContain("Ventanas: estimación local (puede no reflejar tu plan)");
    expect(l).toContain("warehouse del monitor apagado");
  });
  it("con totales, precios del router y diferencia con el monitor", () => {
    const tk = { month: { costUsd: { router: 100, monitor: 1928 } } };
    const l = sourcesLines({ ...base, tokens: tk }, { window5h: { confidence: "official" }, window7d: { confidence: "official" } }).join("\n");
    expect(l).toContain("pricing.mjs");
    expect(l).toContain("≈ 1928,00 $");
    expect(l).toContain("Ventanas: oficial");
    expect(l).not.toContain("warehouse");
  });
  it("incluye la procedencia del P90", () => {
    expect(sourcesLines({ ...base, p90: { available: true, provenance: { confidence: "local_estimate" } } }, {}).join("\n")).toContain("P90: estimación local");
  });
});

describe("quotaBadge", () => {
  it("un badge por estado de cuenta", () => {
    expect(quotaBadge({ status: "rejected" })).toEqual({ dot: "err", text: "Agotada" });
    expect(quotaBadge({ status: "allowed" }).text).toBe("Disponible");
    expect(quotaBadge({ status: "allowed_warning" }).dot).toBe("warn");
    expect(quotaBadge({ status: "raro" }).text).toBe("Sin datos");
  });
  it("sin cuota no hay badge", () => {
    expect(quotaBadge(undefined)).toBeNull();
  });
});
