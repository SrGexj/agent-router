// Estado mínimo por sesión interactiva (qué ejecución está abierta, última cuota vista).
// Cada hook es un proceso nuevo, así que vive en disco. Escrituras atómicas (tmp + rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE = /^[A-Za-z0-9_-]+$/;

function checkId(id) {
  if (!SAFE.test(id ?? "")) throw new Error(`id de sesión no válido: ${id}`);
  return id;
}

export function createSessions({ dir }) {
  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(join(dir, file), "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${file}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, join(dir, file));
  }

  return {
    async load(id) { return readJson(`${checkId(id)}.json`, { runId: null, seq: 0 }); },
    async save(id, state) { return writeJson(`${checkId(id)}.json`, state); },
    async loadQuota(id) { return readJson(`${checkId(id)}.quota.json`, null); },
    async saveQuota(id, quota) { return writeJson(`${checkId(id)}.quota.json`, quota); },
    async loadContext(id) { return readJson(`${checkId(id)}.context.json`, null); },
    async saveContext(id, ctx) { return writeJson(`${checkId(id)}.context.json`, ctx); },
    // Marcas que sobreviven a las ejecuciones (cada mensaje abre una): aviso de relevo ya dado y ediciones directas del orquestador.
    async loadFlags(id) { return readJson(`${checkId(id)}.flags.json`, { relevoAsked: false, directEdits: 0 }); },
    async saveFlags(id, flags) { return writeJson(`${checkId(id)}.flags.json`, flags); }
  };
}
