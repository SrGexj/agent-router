#!/usr/bin/env node
// Proceso hijo del modo sombra (lo lanza router-hook.mjs, desacoplado): clasifica el prompt con el proveedor
// configurado (Laya local o Jev) y anota shadow_route. Único sitio que lee la clave de OpenRouter (solo con Jev). Nunca escribe en stdout.
import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { createShadowClassifier, LAYA_MODEL } from "../src/core/classifier.mjs";
import { runShadow } from "../src/core/shadow.mjs";

const config = loadConfig();

try {
  const file = process.argv[2];
  const { runId, prompt } = JSON.parse(await readFile(file, "utf8"));
  await unlink(file).catch(() => {});
  if (config.shadow.enabled) {
    const apiKey = config.shadow.provider === "jev" ? (await readFile(config.shadow.keyPath, "utf8").catch(() => "")).trim() : "";
    const classifier = createShadowClassifier({ shadow: config.shadow, apiKey, fetch: globalThis.fetch, now: Date.now });
    const model = config.shadow.provider === "laya" ? LAYA_MODEL : config.shadow.model;
    if (classifier) await runShadow({ classifier, store: createStore({ runsDir: config.runsDir }), runId, prompt, model });
  }
} catch (e) {
  try {
    await mkdir(config.home, { recursive: true });
    await appendFile(join(config.home, "hook-errors.log"), `${new Date().toISOString()} shadow: ${e.message}\n`);
  } catch { /* sin disco tampoco podemos hacer nada más */ }
}
process.exit(0);
