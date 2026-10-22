// Disposición de la escena: nodos, lista de trabajadores y aristas. Puro. Añadir un trabajador es añadir una fila a WORKERS:
// de ella salen su nodo, su arista, sus etiquetas y su arista de paquetes.

export const VB = { w: 960, h: 580 };

export const N = {
  tu: { x: 130, y: 302 },
  orq: { x: 340, y: 302 }
};

// id = nodo del reducer (run.tasks[].node). fallback = modelo que se muestra mientras no se sabe el real.
// Sin nodos dinámicos por tipo: "propio" agrupa Explore, Plan, general-purpose... y sus tipos van en el tooltip.
const X = 590;
const ROW = 135;
export const WORKERS = [
  { id: "asistente", title: "Asistente", fallback: "Haiku" },
  { id: "programador", title: "Programador", fallback: "Sonnet" },
  { id: "consultor", title: "Consultor", fallback: "Opus" },
  { id: "propio", title: "Otros", fallback: "Opus", tip: "Subagentes que no son del equipo (Explore, Plan, general-purpose…)" }
].map((w, i, all) => ({ ...w, x: X, y: Math.round(N.orq.y + (i - (all.length - 1) / 2) * ROW) }));

// Etiquetas a la derecha del nodo, alineadas a la izquierda: título, pastilla y subtítulo (desplazamientos desde el centro).
export const SIDE = { dx: 112, title: -26, pill: -2, sub: 22 };

export function workerEdge(w) {
  const dy = w.y - N.orq.y;
  return [[N.orq.x + 30, N.orq.y - 12], [N.orq.x + 190, N.orq.y - 12 + dy * 0.2], [w.x - 130, w.y - 10], [w.x - 62, w.y - 6]];
}

export function buildEdges(inEdge) {
  return { in: inEdge, ...Object.fromEntries(WORKERS.map((w) => [w.id, workerEdge(w)])) };
}

export const IN_EDGE = [[N.tu.x + 22, N.tu.y - 16], [N.tu.x + 85, N.tu.y - 64], [N.orq.x - 80, N.orq.y - 64], [N.orq.x - 18, N.orq.y - 24]];
export const EDGES = buildEdges(IN_EDGE);
