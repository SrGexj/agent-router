// Lee lo que se ha añadido al transcript de una sesión desde un desplazamiento dado (en bytes).
import { open, stat } from "node:fs/promises";

const MAX = 512 * 1024;
// Para el coste hace falta casi todo el transcript, no solo la cola.
export const MAX_FULL = 64 * 1024 * 1024;

export async function transcriptSize(path) {
  try { return (await stat(path)).size; } catch { return null; }
}

// Texto añadido desde offset con tope alto; si lo supera se queda con el final (la primera línea puede venir cortada).
export const readFrom = (path, offset = 0) => readSince(path, offset, MAX_FULL);

export async function readSince(path, offset, max = MAX) {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    if (size <= offset) return "";
    const start = Math.max(offset, size - max);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    await fh?.close();
  }
}
