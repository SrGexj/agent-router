import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_SCRIPT } from "../src/core/laya-tools.mjs";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "router-evaluar-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// `laya` falso: system_one devuelve la forma real del servicio, {"answers": {qid: {...}}}.
const STUB = `
def load(model):
    class Agent:
        def system_one(self, state, questions):
            body = state["body"]
            return {"answers": {"route": {"choice": "asistente" if "doc" in body else "opus", "confidence": 0.75 if "doc" in body else None}}}
    return Agent()
`;

describe.skipIf(!hasPython)("laya-evaluar.py", () => {
  it("lee result['answers'][qid]['choice'] y escribe la confianza aparte si existe", async () => {
    await mkdir(join(dir, "stub"));
    await writeFile(join(dir, "stub/laya.py"), STUB);
    const rows = ["doc", "otra"].map((body) => ({ state: { body }, questions: { route: {} }, expected: { route: "opus" } }));
    await writeFile(join(dir, "eval.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
    const out = join(dir, "pred.json");
    const r = spawnSync("python3", [EVAL_SCRIPT, join(dir, "eval.jsonl"), "modelo", out], { env: { ...process.env, PYTHONPATH: join(dir, "stub") }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(["asistente", "opus"]);
    expect(JSON.parse(await readFile(`${out}.confianza`, "utf8"))).toEqual([0.75, null]);
  });
});
