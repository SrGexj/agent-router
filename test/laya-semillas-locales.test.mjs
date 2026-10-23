import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalSeeds } from "../src/core/laya-tools.mjs";
import { splitRows, withSeeds } from "../src/core/laya-data.mjs";

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "semillas-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadLocalSeeds", () => {
  it("fichero ausente: lista vacía, sin error", async () => {
    expect(await loadLocalSeeds(join(dir, "no-existe.jsonl"))).toEqual([]);
  });
  it("ruta ilegible (directorio): lista vacía, sin error", async () => {
    expect(await loadLocalSeeds(dir)).toEqual([]);
  });
  it("lee las líneas buenas y salta las malas", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(f, `${JSON.stringify({ origin: "historico", label: "opus", text: "plan local" })}\nbasura\n`);
    expect(await loadLocalSeeds(f)).toEqual([{ text: "plan local", label: "opus", origin: "historico" }]);
  });
  it("las semillas solo se añaden al train: se mezclan después de separar train/eval", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ text: `t${i}`, label: "programador", runId: `r${i}` }));
    const { train, eval: ev } = splitRows(rows);
    const seeded = withSeeds(train, [{ text: "local", label: "opus", origin: "historico" }]);
    expect(seeded.some((r) => r.text === "local")).toBe(true);
    expect(ev.some((r) => r.text === "local")).toBe(false);
  });
});
