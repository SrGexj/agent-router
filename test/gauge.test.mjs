import { describe, it, expect } from "vitest";
import { barSegments, legendItems, contextTone, CTX_AMBER, CTX_RED, contextValue } from "../dashboard/src/gauge.js";

describe("barSegments", () => {
  it("devuelve un segmento por familia en orden Opus, Sonnet, Haiku", () => {
    expect(barSegments({ opus: 60, sonnet: 30, haiku: 10 })).toEqual([
      { key: "opus", pct: 60 }, { key: "sonnet", pct: 30 }, { key: "haiku", pct: 10 }
    ]);
  });
  it("omite las familias al 0 %", () => {
    expect(barSegments({ opus: 100, sonnet: 0, haiku: 0 })).toEqual([{ key: "opus", pct: 100 }]);
  });
  it("sin datos o todo a 0 no hay segmentos", () => {
    expect(barSegments(null)).toEqual([]);
    expect(barSegments({ opus: 0, sonnet: 0, haiku: 0 })).toEqual([]);
  });
});

describe("legendItems", () => {
  it("oculta los modelos al 0 % y conserva el orden", () => {
    expect(legendItems({ opus: 70, sonnet: 0, haiku: 30 })).toEqual([
      { key: "opus", name: "Opus", pct: 70 }, { key: "haiku", name: "Haiku", pct: 30 }
    ]);
  });
  it("lista vacía si todo es 0 o no hay datos (la vista pinta «—»)", () => {
    expect(legendItems({ opus: 0, sonnet: 0, haiku: 0 })).toEqual([]);
    expect(legendItems(null)).toEqual([]);
  });
});

describe("contextTone", () => {
  it("neutro bajo el 60 %, ámbar desde el 60 % y rojo desde el 80 %", () => {
    expect(CTX_AMBER).toBe(60);
    expect(CTX_RED).toBe(80);
    expect(contextTone(0)).toBe("ok");
    expect(contextTone(59)).toBe("ok");
    expect(contextTone(60)).toBe("warn");
    expect(contextTone(79)).toBe("warn");
    expect(contextTone(80)).toBe("critical");
    expect(contextTone(100)).toBe("critical");
  });
});

describe("contextValue", () => {
  it("porcentaje, tokens y tope", () => {
    expect(contextValue({ pct: 28, tokens: 189_300, limit: 1_000_000, window: 1_000_000 })).toBe("28 % · 189,3 k / 1 M");
    expect(contextValue({ pct: 75, tokens: 150_000, limit: null, window: 200_000 })).toBe("75 % · 150 k / 200 k");
  });
});
