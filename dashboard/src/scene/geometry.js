// Proyección isométrica (algo aplanada, como la referencia) y curvas. Puro.

export const COS = 0.866;
export const SIN = 0.43;

export function iso(origin, x, y, z) {
  return [origin.x + (x - y) * COS, origin.y + (x + y) * SIN - z];
}

const pts = (origin, list) => list.map(([x, y, z]) => iso(origin, x, y, z).map((n) => +n.toFixed(2)).join(",")).join(" ");

// Caja con esquina (x, y, z) y tamaño w×d×h: cara superior y las dos frontales visibles.
export function boxFaces(origin, { x, y, z, w, d, h }) {
  const top = z + h;
  return {
    top: pts(origin, [[x, y, top], [x + w, y, top], [x + w, y + d, top], [x, y + d, top]]),
    left: pts(origin, [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, top], [x, y + d, top]]),
    right: pts(origin, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, top], [x + w, y, top]])
  };
}

// Elipse de un círculo de radio r apoyado en el plano horizontal.
export function isoCircle(r) {
  return { rx: r * COS * Math.SQRT2, ry: r * SIN * Math.SQRT2 };
}

export function bezierPoint([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

export function bezierPath([p0, p1, p2, p3]) {
  return `M${p0[0]},${p0[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`;
}

export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// Nodo "Laya (sombra)": pequeño, arriba, entre Tú y el orquestador. Su línea discontinua baja en vertical
// hasta el punto medio del camino Tú → Orquestador (la x del nodo es la de ese punto). Textos del nodo, de arriba abajo:
// título (+32), pastilla (+56), veredicto (+78); la línea arranca por debajo del veredicto y la etiqueta "sombra" va a su lado.
export const LAYA = { y: 84, title: 32, pill: 56, verdict: 78, linkFrom: 102 };

export function shadowLink(inEdge) {
  const [x, y] = bezierPoint(inEdge, 0.5);
  return { node: { x, y: LAYA.y }, from: [x, LAYA.y + LAYA.linkFrom], to: [x, y] };
}
