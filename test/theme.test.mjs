import { describe, it, expect } from "vitest";
import { PREFS, STORAGE_KEY, normalizePref, resolveTheme, readPref, savePref } from "../dashboard/src/theme.js";

const memStorage = (init = {}) => {
  const m = { ...init };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, dump: () => m };
};
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

describe("normalizePref", () => {
  it("acepta las tres opciones", () => {
    for (const p of PREFS) expect(normalizePref(p)).toBe(p);
  });
  it("cualquier otro valor cae en sistema", () => {
    for (const v of [null, undefined, "", "dark ", "azul", 3, {}]) expect(normalizePref(v)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("claro y oscuro explícitos ignoran el sistema", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("sistema sigue prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("preferencia inválida se trata como sistema", () => {
    expect(resolveTheme("raro", true)).toBe("dark");
    expect(resolveTheme(undefined, false)).toBe("light");
  });
});

describe("readPref / savePref", () => {
  it("sin nada guardado devuelve sistema", () => {
    expect(readPref(memStorage())).toBe("system");
  });
  it("guarda y lee", () => {
    const s = memStorage();
    expect(savePref(s, "light")).toBe(true);
    expect(s.dump()[STORAGE_KEY]).toBe("light");
    expect(readPref(s)).toBe("light");
  });
  it("valor corrupto guardado devuelve sistema", () => {
    expect(readPref(memStorage({ [STORAGE_KEY]: "xx" }))).toBe("system");
  });
  it("si el almacenamiento falla no lanza", () => {
    expect(readPref(broken)).toBe("system");
    expect(savePref(broken, "dark")).toBe(false);
    expect(readPref(undefined)).toBe("system");
  });
});
