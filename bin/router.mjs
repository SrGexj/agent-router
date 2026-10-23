#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { loadAgents } from "../src/core/agents.mjs";
import { parseCliArgs, isLayaCommand, isCuotaCommand, isTelemetryCommand, isActualizarCommand, USAGE } from "../src/core/cli.mjs";
import { makeRunId, runTask } from "../src/core/run.mjs";
import { buildOrchestratorPrompt } from "../src/core/prompt.mjs";
import { launchTelemetryFlush } from "../src/core/telemetry-flush.mjs";

const AGENTS_DIR = fileURLToPath(new URL("../src/agents", import.meta.url));

if (isLayaCommand(process.argv[2])) {
  const { main } = await import("./router-laya.mjs");
  process.exit(await main(process.argv.slice(2)));
}

if (isCuotaCommand(process.argv[2])) {
  const { main } = await import("./router-cuota.mjs");
  process.exit(await main(process.argv.slice(2)));
}

if (isTelemetryCommand(process.argv[2])) {
  const { main } = await import("./router-telemetry.mjs");
  process.exit(await main(process.argv.slice(2)));
}

// Actualiza la copia estable: delega en el instalador (--actualizar), que ya sabe moverla y reiniciar el server.
if (isActualizarCommand(process.argv[2])) {
  const { status } = spawnSync(process.execPath, [fileURLToPath(new URL("./instalar.mjs", import.meta.url)), "--actualizar"], { stdio: "inherit" });
  process.exit(status ?? 1);
}

let opts;
try {
  opts = parseCliArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const config = loadConfig();
const store = createStore({ runsDir: config.runsDir });

if (opts.printPrompt) {
  const agents = await loadAgents(AGENTS_DIR);
  process.stdout.write(buildOrchestratorPrompt({ agents, quota: await store.latestQuota(config.profile), now: Date.now(), browser: config.browser }));
  process.exit(0);
}
const mode = opts.model ? "manual" : "orquestado";
const model = opts.model ?? "opus";
const agents = mode === "orquestado" && !opts.ownAgents ? await loadAgents(AGENTS_DIR) : null;
const runId = makeRunId(Date.now(), process.pid, randomBytes(2).toString("hex"));

const ac = new AbortController();
process.on("SIGINT", () => ac.abort());

console.error(`[router] ${mode === "orquestado" ? "Opus orquesta" : `manual → ${model}`} · ${runId}`);

const res = await runTask({
  task: opts.task, mode, model, effort: opts.effort, agents, config, store, profile: config.profile, browser: config.browser,
  spawn, now: Date.now, out: process.stdout, cwd: process.cwd(), runId, signal: ac.signal
});

console.error(`[router] ${res.status} · código ${res.exitCode}`);
// Run cerrado: envío de telemetría desacoplado (desactivada, no lanza nada).
launchTelemetryFlush({ config, script: fileURLToPath(import.meta.url) });
process.exit(res.exitCode);
