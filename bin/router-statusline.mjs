#!/usr/bin/env node
// Statusline de las sesiones `co`/`cop`. Se ejecuta en cada cambio y cada 2 s (refreshInterval):
//  1. Si pulsaste Esc desde que empezó la ejecución (marca en el transcript), la cierra como cancelada.
//  2. Guarda la cuota (rate_limits) con el perfil de la cuenta, solo cuando cambia.
//  3. Muestra tu statusline de siempre (~/.agent-router/statusline-next), cacheada si la entrada no cambia.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { createSessions } from "../src/core/sessions.mjs";
import { contextFromStatusline, sameContext } from "../src/core/compaction.mjs";
import { closeInterrupted, interruptedIn, quotaFromStatusline, sameQuota } from "../src/core/hooks.mjs";
import { readFrom, readSince } from "../src/core/transcript.mjs";
import { usageFromTranscript } from "../src/core/usage.mjs";
import { withRelevoTag } from "../src/core/relevo.mjs";

const config = loadConfig();
const CACHE_MS = 30_000;

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function runNext(command, input) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const raw = await readStdin();
let quota = null;
let sessionId = null;
let contextTokens = null;
try {
  const input = JSON.parse(raw);
  sessionId = input.session_id ?? null;
  const store = createStore({ runsDir: config.runsDir });
  const sessions = createSessions({ dir: config.sessionsDir });

  if (sessionId) {
    const session = await sessions.load(sessionId);
    if (session.runId && session.transcriptOffset != null && input.transcript_path
      && interruptedIn(await readSince(input.transcript_path, session.transcriptOffset))) {
      let usage = null;
      try { usage = usageFromTranscript(await readFrom(input.transcript_path, session.transcriptOffset), { sidechain: false }); } catch { /* sin coste */ }
      const closed = closeInterrupted(session, Date.now(), usage, quotaFromStatusline(input, Date.now(), config.profile) ?? (await sessions.loadQuota(sessionId)));
      for (const ev of closed.events) await store.append(closed.runId, ev);
      await sessions.save(sessionId, closed.session);
    }
  }

  quota = quotaFromStatusline(input, Date.now(), config.profile);
  if (quota && sessionId) {
    const prev = await sessions.loadQuota(sessionId);
    if (!sameQuota(prev, quota)) {
      const { runId, lastRunId } = await sessions.load(sessionId);
      const target = runId ?? lastRunId;
      if (target) await store.append(target, quota);
      await sessions.saveQuota(sessionId, quota);
    }
  }

  // Contexto actual (último turno) frente a la ventana: solo cuando cambia, para no escribir cada 2 s.
  const ctxEvent = contextFromStatusline(input, Date.now(), config.relevoTokens);
  contextTokens = ctxEvent?.tokens ?? null;
  if (ctxEvent && sessionId) {
    const prev = await sessions.loadContext(sessionId);
    if (!sameContext(prev, ctxEvent)) {
      const { runId, lastRunId } = await sessions.load(sessionId);
      const target = runId ?? lastRunId;
      if (target) await store.append(target, ctxEvent);
      await sessions.saveContext(sessionId, ctxEvent);
    }
  }
} catch { /* la statusline nunca debe romperse por esto */ }

let next = "";
try { next = (await readFile(join(config.home, "statusline-next"), "utf8")).trim(); } catch { /* sin statusline original */ }

if (next) {
  // Con refreshInterval esto corre cada 2 s: si la entrada no cambia, se reutiliza la salida reciente.
  const hash = createHash("sha1").update(raw).digest("hex");
  const cacheFile = sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? join(config.sessionsDir, `${sessionId}.statusline.json`) : null;
  let out = null;
  try {
    const c = JSON.parse(await readFile(cacheFile, "utf8"));
    if (c.hash === hash && Date.now() - c.t < CACHE_MS) out = c.out;
  } catch { /* sin caché */ }
  if (out == null) {
    out = await runNext(next, raw);
    if (cacheFile) await writeFile(cacheFile, JSON.stringify({ hash, out, t: Date.now() })).catch(() => {});
  }
  process.stdout.write(withRelevoTag(out, contextTokens, config.relevoTokens));
} else {
  const five = quota?.fiveHour ? ` · 5 h ${Math.round(quota.fiveHour.utilization * 100)} %` : "";
  process.stdout.write(withRelevoTag(`${config.profileAlias}${five}`, contextTokens, config.relevoTokens));
}
