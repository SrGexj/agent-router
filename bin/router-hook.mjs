#!/usr/bin/env node
// Hook de las sesiones `co`/`cop`: traduce cada evento de Claude Code a eventos del dashboard.
// Siempre sale con 0. Solo escribe en stdout al inyectar pendientes tras compactar y al denegar subagentes bloqueados (blockedAgents) y al bajar de nivel un subagente (layaRouting=downgrade).
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { createSessions } from "../src/core/sessions.mjs";
import { interruptedIn, liveAgentUsageDue, liveUsageDue, translateHook } from "../src/core/hooks.mjs";
import { MAX_FULL, readFrom, readSince, transcriptSize } from "../src/core/transcript.mjs";
import { advanceUsage, agentTranscriptPath, startUsage, usageFromTranscript } from "../src/core/usage.mjs";
import { makeRunId } from "../src/core/run.mjs";
import { markLostTasks, reduceEvents } from "../src/core/reducer.mjs";
import { compactionsFromTranscript } from "../src/core/compaction.mjs";
import { blockEvent, decideBlock, denyOutput } from "../src/core/block-agents.mjs";
import { createLayaClassifier } from "../src/core/classifier.mjs";
import { routeAgent } from "../src/core/laya-routing.mjs";
import { collectPending, formatPending } from "../src/core/pending.mjs";

const config = loadConfig();

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// Leer un transcript para el coste nunca debe hacer fallar el hook: sin datos, sin evento.
async function usageOf(path, offset, sidechain) {
  try {
    if (!path) return null;
    return usageFromTranscript(await readFrom(path, offset), { sidechain });
  } catch { return null; }
}

// Gasto del orquestador desde session.transcriptOffset, incremental: la sesión guarda hasta dónde se leyó y lo acumulado,
// así que cada llamada lee solo lo nuevo. Nunca lanza: sin datos, null.
async function orchestratorUsageOf(path, session) {
  try {
    if (!path || session.transcriptOffset == null) return null;
    let state = session.usageState ?? startUsage(session.transcriptOffset);
    const size = await transcriptSize(path);
    if (size == null) return null;
    if (size < state.offset) state = startUsage(session.transcriptOffset); // transcript reescrito o más corto: de cero
    else if (size - state.offset > MAX_FULL) state = { ...state, offset: size - MAX_FULL }; // readSince solo devuelve el final
    const res = advanceUsage(state, await readSince(path, state.offset, MAX_FULL), { sidechain: false });
    return { usage: res.usage, state: res.state };
  } catch { return null; }
}

// Gasto de un subagente en vivo, incremental como el del orquestador: el estado (offset + acumulado) vive en la sesión.
async function agentUsageOf(path, state0) {
  try {
    if (!path) return null;
    let state = state0 ?? startUsage(0);
    const size = await transcriptSize(path);
    if (size == null) return null;
    if (size < state.offset) state = startUsage(0);
    else if (size - state.offset > MAX_FULL) state = { ...state, offset: size - MAX_FULL };
    const res = advanceUsage(state, await readSince(path, state.offset, MAX_FULL), { sidechain: true });
    return { usage: res.usage, state: res.state };
  } catch { return null; }
}

// Modo sombra: el prompt saneado va a un JSON temporal (el hijo lo borra al leerlo) y el hijo, desacoplado,
// llama al clasificador. El hook no espera ni falla por esto; la clave la lee solo el hijo.
async function launchShadow({ runId, prompt }) {
  try {
    if (!config.shadow.enabled) return;
    await mkdir(config.sessionsDir, { recursive: true });
    const file = join(config.sessionsDir, `shadow-${runId}.json`);
    await writeFile(file, JSON.stringify({ runId, prompt }), { mode: 0o600 });
    const script = fileURLToPath(new URL("./router-shadow.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, file], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch { /* la sombra nunca puede romper el hook */ }
}

const TAIL_BYTES = 2 * 1024 * 1024;
const USED_TTL_MS = 7 * 86_400_000;
const PENDING_INTRO = "Antes de compactar quedaban estos pendientes; revísalos y retómalos si siguen vigentes:";

// PreCompact: guarda los pendientes en <pendingDir>/<sesión>.md (sobrescribe) y anota la compactación en la ejecución.
async function onPreCompact(payload, session, store, now) {
  const runId = session.runId ?? session.lastRunId ?? null;
  const events = runId ? await store.readRun(runId) : [];
  const run = events.length ? reduceEvents(events) : null;
  const size = payload.transcript_path ? await transcriptSize(payload.transcript_path) : null;
  const tail = size == null ? "" : await readSince(payload.transcript_path, 0, TAIL_BYTES);
  const list = collectPending({ run, transcriptTail: tail, now });
  const file = join(config.pendingDir, `${payload.session_id}.md`);
  const md = formatPending(list, { runId, t: now });
  if (md) {
    await mkdir(config.pendingDir, { recursive: true });
    await writeFile(file, md);
  } else {
    await rm(file, { force: true }); // un archivo viejo no vigente no debe inyectarse
  }
  if (runId) await store.append(runId, { type: "compact", trigger: payload.trigger ?? null, pendingCount: list.length, t: now });
}

// SessionStart (source "compact"): devuelve los pendientes como contexto adicional, una sola vez (el archivo pasa a .usado.md).
async function onSessionStartCompact(payload, now) {
  const file = join(config.pendingDir, `${payload.session_id}.md`);
  let md;
  try { md = await readFile(file, "utf8"); } catch { md = null; }
  if (md) {
    await rename(file, join(config.pendingDir, `${payload.session_id}.${new Date(now).toISOString().slice(0, 10)}.usado.md`));
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${PENDING_INTRO}\n\n${md}` } }));
  }
  try {
    for (const f of await readdir(config.pendingDir)) {
      if (!f.endsWith(".usado.md")) continue;
      const p = join(config.pendingDir, f);
      if (now - (await stat(p)).mtimeMs > USED_TTL_MS) await rm(p, { force: true });
    }
  } catch { /* limpieza best effort */ }
}

// SessionStart (source "compact"): el límite de compactación ya está en el transcript. Se anota el último (preTokens,
// postTokens, duración, tamaño del resumen, modelo) en la ejecución para estimar su coste. Una sola vez por límite.
async function onCompactStats(payload, session, store) {
  const runId = session.runId ?? session.lastRunId ?? null;
  if (!runId || !payload.transcript_path) return;
  const last = compactionsFromTranscript(await readSince(payload.transcript_path, 0, TAIL_BYTES)).at(-1);
  if (!last) return;
  const known = reduceEvents(await store.readRun(runId))?.compactStats ?? [];
  if (known.some((c) => c.id === last.id)) return;
  await store.append(runId, { type: "compact_stats", records: [last], t: Date.now() });
}

const CLOSING = new Set(["StopFailure", "SessionEnd"]);

try {
  const payload = JSON.parse(await readStdin());
  const store = createStore({ runsDir: config.runsDir });
  const sessions = createSessions({ dir: config.sessionsDir });
  const session = await sessions.load(payload.session_id);

  if (payload.hook_event_name === "PreCompact") {
    await onPreCompact(payload, session, store, Date.now());
    process.exit(0);
  }
  if (payload.hook_event_name === "SessionStart") {
    if (payload.source === "compact") {
      try { await onCompactStats(payload, session, store); } catch { /* el coste es accesorio: nunca impide inyectar pendientes */ }
      await onSessionStartCompact(payload, Date.now());
    }
    process.exit(0);
  }

  // Subagentes que heredan Opus: se deniega el lanzamiento (sin task_request, que quedaría pendiente para siempre).
  const block = decideBlock(payload, config.blockedAgents);
  if (block) {
    process.stdout.write(JSON.stringify(denyOutput(block.reason)));
    if (session.runId) await store.append(session.runId, blockEvent(payload, block.agent, Date.now()));
    process.exit(0);
  }

  // Laya (sombra/downgrade): fail-open; si baja de nivel, el resto del hook ve ya el tool_input corregido.
  if (config.layaRouting !== "off") {
    try {
      const classifier = createLayaClassifier({ url: config.shadow.layaUrl, fetch, timeoutMs: config.layaTimeoutMs, ...(config.layaRoutingModel && { model: config.layaRoutingModel }) });
      const routed = await routeAgent({ payload, mode: config.layaRouting, threshold: config.layaDowngradeThreshold, classifier, timeoutMs: config.layaTimeoutMs });
      if (routed) {
        if (session.runId) await store.append(session.runId, routed.event);
        if (routed.output) {
          process.stdout.write(JSON.stringify(routed.output));
          payload.tool_input = routed.input;
        }
      }
    } catch { /* Laya nunca puede romper ni bloquear el hook */ }
  }

  const ctx = { profile: config.profile };
  if (payload.hook_event_name === "UserPromptSubmit" && payload.transcript_path) {
    ctx.transcriptSize = await transcriptSize(payload.transcript_path);
    if (session.runId && session.transcriptOffset != null) {
      ctx.interrupted = interruptedIn(await readSince(payload.transcript_path, session.transcriptOffset));
      if (ctx.interrupted) ctx.orchestratorUsage = (await orchestratorUsageOf(payload.transcript_path, session))?.usage ?? null;
    }
  }
  if (payload.hook_event_name === "SubagentStop") ctx.agentUsage = await usageOf(agentTranscriptPath(payload), 0, true);
  if (liveAgentUsageDue(payload, session, Date.now())) {
    const a = await agentUsageOf(agentTranscriptPath(payload), session.agentUsage?.[payload.agent_id]?.state);
    if (a) ctx.agentLive = a;
  }
  if (payload.hook_event_name === "Stop" && session.runId && (payload.background_tasks ?? []).length > 0) {
    const run = markLostTasks(reduceEvents(await store.readRun(session.runId)), Date.now());
    ctx.runningTasks = Object.values(run?.tasks ?? {}).filter((t) => t.status === "running").length;
  }
  const closes = CLOSING.has(payload.hook_event_name) || (payload.hook_event_name === "Stop" && ((payload.background_tasks ?? []).length === 0 || ctx.runningTasks === 0));
  const now = Date.now();
  if ((closes && session.runId) || liveUsageDue(payload, session, now)) {
    const o = await orchestratorUsageOf(payload.transcript_path, session);
    if (o) { ctx.orchestratorUsage = o.usage; ctx.usageState = o.state; }
  }

  const res = translateHook(payload, session, now, makeRunId, ctx);
  if (res.before) for (const ev of res.before.events) await store.append(res.before.runId, ev);
  for (const ev of res.events) await store.append(res.runId, ev);
  if (res.session !== session) await sessions.save(payload.session_id, res.session);
  if (res.shadow) await launchShadow(res.shadow);
} catch (e) {
  try {
    await mkdir(config.home, { recursive: true });
    await appendFile(join(config.home, "hook-errors.log"), `${new Date().toISOString()} ${e.message}\n`);
  } catch { /* sin disco tampoco podemos hacer nada más */ }
}
process.exit(0);
