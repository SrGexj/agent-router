// Relevo de conversación: cuando el contexto de la sesión principal pasa el umbral, el orquestador escribe un archivo
// de relevo y la siguiente sesión (co/cop) del mismo proyecto y perfil lo recibe al arrancar. Puro: sin E/S ni reloj.
import { join } from "node:path";

export const slugOfCwd = (cwd) => String(cwd ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sin-proyecto";

// <home del router>/relevo/<perfil>/<slug-del-cwd>.md
export const relevoPath = ({ home, profile, cwd }) => join(home, "relevo", profile, `${slugOfCwd(cwd)}.md`);

// <slug>.usado-<fecha ISO>.md (sin ":" ni milisegundos para que valga como nombre de archivo).
export function relevoUsedPath(path, now) {
  const iso = new Date(now).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return path.replace(/\.md$/, `.usado-${iso}.md`);
}

export const relevoPrompt = (path, threshold) =>
  `Relevo: contexto ≥${Math.round(threshold / 1000)}k. Escribe ahora el relevo en ${path} (≤40 líneas: objetivo, hecho, pendiente, decisiones tomadas, archivos clave, siguiente paso) y dile al usuario que abra un \`co\`/\`cop\` nuevo en este proyecto.`;

// Una sola vez por sesión (asked) y solo con dato de contexto: devuelve el aviso o null.
export function decideRelevo({ tokens, threshold, asked, path }) {
  if (asked || !(tokens > 0) || !(tokens >= threshold)) return null;
  return relevoPrompt(path, threshold);
}

export const relevoStartupContext = (md) => `Relevo de la sesión anterior en este proyecto; retómalo desde "siguiente paso" si sigue vigente:\n\n${md}`;

// Statusline: añade " · relevo" al texto cuando el contexto pasa el umbral (antes del salto de línea final, si lo hay).
export function withRelevoTag(text, tokens, threshold) {
  if (!(tokens >= threshold)) return text;
  const body = text.replace(/\s+$/, "");
  const tail = text.slice(body.length);
  return `${body ? `${body} · ` : ""}relevo${tail}`;
}
