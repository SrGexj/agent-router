#!/usr/bin/env node
// Doble de `claude` para las pruebas: ignora los argumentos, lee la tarea por stdin y
// reproduce el stream real guardado en test/fixtures con un retardo entre líneas.
import { readFileSync } from "node:fs";

const fixture = new URL("../test/fixtures/stream-subagente.jsonl", import.meta.url);
const lines = readFileSync(fixture, "utf8").trim().split("\n");
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 250);

process.stdin.resume();
process.stdin.on("end", async () => {
  for (const line of lines) {
    process.stdout.write(line + "\n");
    await new Promise((r) => setTimeout(r, delay));
  }
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
});
