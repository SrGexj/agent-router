import { describe, it, expect } from "vitest";
import { normalizeSplitMode, readSplitMode, saveSplitMode, splitView, SPLIT_KEY } from "../dashboard/src/captions.js";

const uso = { opus: 10, sonnet: 60, haiku: 30, tokens: { opus: 1, sonnet: 2, haiku: 3 }, fresh: { opus: 1, sonnet: 1, haiku: 1 } };
const share = { opus: 70, sonnet: 20, haiku: 10 };
const mem = (init) => { const d = { ...init }; return { getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; };

describe("modo de la barra de reparto", () => {
  it("normaliza a gasto salvo uso", () => {
    expect(normalizeSplitMode("uso")).toBe("uso");
    expect(normalizeSplitMode("x")).toBe("gasto");
    expect(normalizeSplitMode(null)).toBe("gasto");
  });
  it("lee y guarda con la clave fijada", () => {
    expect(SPLIT_KEY).toBe("agent-router.split-mode");
    const s = mem({});
    expect(readSplitMode(s)).toBe("gasto");
    expect(saveSplitMode(s, "uso")).toBe(true);
    expect(readSplitMode(s)).toBe("uso");
  });
  it("tolera un almacenamiento que lanza", () => {
    const bad = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
    expect(readSplitMode(bad)).toBe("gasto");
    expect(saveSplitMode(bad, "uso")).toBe(false);
  });
});

describe("splitView", () => {
  it("gasto usa el reparto de gasto, null si falta", () => {
    expect(splitView("gasto", share, uso).bar).toEqual(share);
    expect(splitView("gasto", null, uso).bar).toBeNull();
  });
  it("uso usa tokenShare y su tooltip", () => {
    const v = splitView("uso", share, uso);
    expect(v.bar).toEqual({ opus: 10, sonnet: 60, haiku: 30 });
    expect(v.title).toMatch(/tokens/);
  });
  it("uso sin tokenShare oculta la barra; gasto nunca", () => {
    expect(splitView("uso", share, null).hidden).toBe(true);
    expect(splitView("gasto", null, null).hidden).toBe(false);
  });
});
