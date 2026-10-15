// Almacén de ejecuciones: un JSONL por ejecución en runsDir. Así dos `router` simultáneos
// nunca escriben en el mismo archivo. Las escrituras de una misma ejecución se serializan.
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function checkId(runId) {
  if (!SAFE_ID.test(runId ?? "")) throw new Error(`id de ejecución no válido: ${runId}`);
  return runId;
}

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* línea a medio escribir o corrupta */ }
  }
  return out;
}

export function createStore({ runsDir }) {
  const queues = new Map();
  let ready = null;
  const ensureDir = () => (ready ??= mkdir(runsDir, { recursive: true }));

  function append(runId, event) {
    try { checkId(runId); } catch (e) { return Promise.reject(e); }
    const prev = queues.get(runId) ?? Promise.resolve();
    const next = prev
      .then(ensureDir)
      .then(() => appendFile(join(runsDir, `${runId}.jsonl`), JSON.stringify(event) + "\n"));
    queues.set(runId, next.catch(() => {}));
    return next;
  }

  async function readRun(runId) {
    checkId(runId);
    try {
      return parseJsonl(await readFile(join(runsDir, `${runId}.jsonl`), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async function listRunIds() {
    try {
      return (await readdir(runsDir))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -6))
        .filter((id) => SAFE_ID.test(id))
        .sort()
        .reverse();
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  // Cuota más reciente por perfil (cada perfil es una cuenta con sus propios límites).
  async function latestQuotas(maxRuns = 30) {
    const out = {};
    for (const id of (await listRunIds()).slice(0, maxRuns)) {
      for (const e of await readRun(id)) {
        if (e.type !== "quota") continue;
        const profile = e.profile ?? "trabajo";
        if (!out[profile] || e.t >= out[profile].t) out[profile] = e;
      }
    }
    return out;
  }

  async function latestQuota(profile = "trabajo") {
    return (await latestQuotas())[profile] ?? null;
  }

  return { append, readRun, listRunIds, latestQuota, latestQuotas, runsDir };
}
