import { describe, it, expect } from "vitest";
import { priceFor, costOf, addUsage, emptyUsage, OPUS_REFERENCE } from "../src/core/pricing.mjs";

const M = 1_000_000;

describe("precios", () => {
  it("reconoce la familia y la versión por el id del modelo", () => {
    expect(priceFor("claude-opus-5-5").input).toBe(4);
    expect(priceFor("claude-sonnet-5-5").output).toBe(10);
    expect(priceFor("claude-haiku-5-5").input).toBe(0.1);
    expect(priceFor("claude-haiku-4-5-20251001").input).toBe(1);
    expect(priceFor("claude-opus-4-8").input).toBe(5);
    expect(priceFor("claude-sonnet-4-6").input).toBe(3);
  });

  it("un modelo desconocido no tiene precio", () => {
    expect(priceFor("gpt-x")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  it("calcula el coste con entrada, salida, escritura y lectura de caché", () => {
    const u = { input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M };
    // Opus 5.5: 4 + 20 + 4*1.25 + 4*2 + 0.20
    expect(costOf("claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 5 + 8 + 0.2, 6);
  });

  it("sin precio conocido el coste es null", () => {
    expect(costOf("desconocido", { input: 10, output: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 })).toBeNull();
  });

  it("suma usos y convierte el formato de la API", () => {
    const api = { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 } };
    expect(addUsage(emptyUsage(), api)).toEqual({ input: 2, output: 20, cacheRead: 100, cacheWrite5m: 30, cacheWrite1h: 10 });
    // Sin desglose de caché: todo cuenta como escritura de 5 min.
    expect(addUsage(emptyUsage(), { cache_creation_input_tokens: 7 }).cacheWrite5m).toBe(7);
  });

  it("la referencia para comparar es Opus 5.5", () => {
    expect(OPUS_REFERENCE).toBe("claude-opus-5-5");
  });
});
