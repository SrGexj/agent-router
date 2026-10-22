import { describe, it, expect } from "vitest";
import { VB, N, WORKERS, SIDE, EDGES } from "../dashboard/src/scene/layout.js";
import { WORKERS as REDUCER_WORKERS, OWN } from "../src/core/reducer.mjs";

describe("layout de la escena", () => {
  it("cuatro trabajadores: los del reducer más el nodo Otros (propio)", () => {
    expect(WORKERS.map((w) => w.id)).toEqual([...REDUCER_WORKERS, OWN]);
    expect(WORKERS.map((w) => w.title)).toEqual(["Asistente", "Programador", "Consultor", "Otros"]);
    expect(WORKERS.find((w) => w.id === OWN).tip).toMatch(/Explore/);
  });
  it("cada trabajador tiene su arista y la lista no se solapa ni se sale del viewBox", () => {
    expect(Object.keys(EDGES).sort()).toEqual(["in", ...WORKERS.map((w) => w.id)].sort());
    const ys = WORKERS.map((w) => w.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(120);
    for (const w of WORKERS) {
      expect(w.y - 75).toBeGreaterThan(0);
      expect(w.y + 50).toBeLessThan(VB.h);
      expect(w.x + SIDE.dx + 250).toBeLessThanOrEqual(VB.w + 20);
      expect(w.x - 100).toBeGreaterThan(N.orq.x + 84);
    }
  });
});
