// Relevo de conversación: cuando el contexto pasa el umbral (o con /relevo), la sesión escribe RELEVO.md en la raíz del
// proyecto; tras /clear (o al arrancar) un hook SessionStart lo inyecta junto con la memoria. Puro: sin E/S ni reloj.
import { join } from "node:path";

// Carpeta de proyecto de Claude Code: el cwd con todo lo que no es letra o número cambiado por "-" (conserva mayúsculas).
export const claudeProjectSlug = (cwd) => String(cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-");

// El relevo vive en la raíz del proyecto (cwd de la sesión): <cwd>/RELEVO.md. Ya no depende del perfil.
export const relevoPath = ({ cwd }) => join(String(cwd ?? "."), "RELEVO.md");

// MEMORY.md de la memoria del proyecto: <config de Claude>/projects/<slug del cwd>/memory/MEMORY.md
export const memoryIndexPath = ({ claudeDir, cwd }) => join(claudeDir, "projects", claudeProjectSlug(cwd), "memory", "MEMORY.md");

export const relevoPrompt = (path, threshold) =>
  `Relevo: contexto ≥${Math.round(threshold / 1000)}k. Escribe ahora el relevo en ${path} (raíz del proyecto) con las secciones Hecho (terminado y comprobado), No hecho (intentado, falló o a medias), Pendiente (pasos siguientes en orden), Decisiones (y por qué) y Contexto mínimo (rama git, archivos clave, comandos de prueba), y dile al usuario que teclee /clear: al empezar la sesión nueva lo recibirá solo.`;

// Una sola vez por sesión (asked) y solo con dato de contexto: devuelve el aviso o null.
export function decideRelevo({ tokens, threshold, asked, path }) {
  if (asked || !(tokens > 0) || !(tokens >= threshold)) return null;
  return relevoPrompt(path, threshold);
}

// Contexto de SessionStart (clear/startup): relevo de la raíz y/o índice de memoria; sin ninguno de los dos, null.
export function relevoStartupContext({ relevo, memory, relevoFile }) {
  const parts = [];
  if (relevo?.trim()) {
    parts.push(`Relevo de la sesión anterior en este proyecto (${relevoFile ?? "RELEVO.md"}); retómalo desde Pendiente si sigue vigente. Instrucción: vuelca un resumen del relevo a la memoria del proyecto (hecho / no hecho / pendiente) con Write/Edit y luego borra RELEVO.md; no lo borra el hook.\n\n${relevo}`);
  }
  if (memory?.trim()) parts.push(`Memoria del proyecto (MEMORY.md):\n\n${memory}`);
  return parts.length ? parts.join("\n\n---\n\n") : null;
}

// Statusline: añade " · relevo" al texto cuando el contexto pasa el umbral (antes del salto de línea final, si lo hay).
export function withRelevoTag(text, tokens, threshold) {
  if (!(tokens >= threshold)) return text;
  const body = text.replace(/\s+$/, "");
  const tail = text.slice(body.length);
  return `${body ? `${body} · ` : ""}relevo${tail}`;
}
