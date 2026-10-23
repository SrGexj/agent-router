// Piezas puras del instalador del alias `co`: settings con hooks, especificación de los servicios y plan de Laya.
// Lo que depende de la plataforma (plist, unit de systemd, bloque de shell) vive en ./platform/.
import { CO_AUTOCOMPACT_WINDOW } from "./compaction.mjs";
import { buildLayaRequest } from "./classifier.mjs";
import { servicePlist } from "./platform/darwin.mjs";
import { coFunction, withBlock, withoutBlock, SHELL_START } from "./platform/shell.mjs";

// Nombres históricos (el bloque se llamaba "de zsh" cuando solo había macOS).
export { coFunction };
export const withZshBlock = withBlock;
export const withoutZshBlock = withoutBlock;
export const ZSH_START = SHELL_START;

const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PermissionDenied", "SessionEnd", "Notification", "PreCompact", "SessionStart"];
// SessionStart solo tras compactar (pendientes) y al arrancar (relevo), con una entrada por origen; el resto, sin filtro.
const MATCHERS = { SessionStart: ["compact", "startup"] };

const cmd = (node, script) => `"${node}" "${script}"`;

export function buildCoSettings({ node, appRoot }) {
  const hook = cmd(node, `${appRoot}/bin/router-hook.mjs`);
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [MATCHERS[e] ?? ""].flat().map((matcher) => ({ matcher, hooks: [{ type: "command", command: hook, timeout: 5 }] }))]));
  return {
    hooks,
    // Compactar antes (ventana de 250k) para no llegar al límite con el contexto ya degradado; solo sesiones co/cop.
    autoCompactWindow: CO_AUTOCOMPACT_WINDOW,
    // Los subagentes con isolation "worktree" escriben en .claude/worktrees/, que Claude Code protege:
    // sin esto cada escritura pide permiso. Solo afecta a las sesiones co (este archivo va por --settings).
    // `git branch -d` solo borra ramas ya mergeadas (git se niega si no), así que es seguro sin preguntar; -D no se permite.
    permissions: { allow: ["Edit(**/.claude/worktrees/**)", "Bash(git branch -d *)"] },
    // refreshInterval: Esc no dispara hooks; la statusline mira el transcript cada 2 s para cerrar la ejecución.
    statusLine: { type: "command", command: cmd(node, `${appRoot}/bin/router-statusline.mjs`), padding: 0, refreshInterval: 2 }
  };
}

// Decide qué statusline queda encadenada tras co: un statusline-next ya existente y no vacío (p. ej. un envoltorio
// a mano) manda y no se pisa; si no, se encadena la del usuario salvo que sea la del propio router.
export function planStatuslineChain({ userCmd, existingNext }) {
  const existing = (existingNext ?? "").trim();
  if (existing) return { write: false, chained: existing };
  if (userCmd && !userCmd.includes("router-statusline")) return { write: true, chained: userCmd };
  return { write: false, chained: null };
}

// Servicio del dashboard: spec neutra que cada plataforma convierte en plist o unit.
export function serverServiceSpec({ label, node, appRoot, home, env = {} }) {
  return { label, argv: [node, `${appRoot}/server/index.mjs`], cwd: appRoot, env: { ROUTER_HOME: home, ...env }, logFile: `${home}/server.log` };
}

// Solo macOS: se conserva por compatibilidad; el instalador usa serverServiceSpec con la plataforma.
export const launchAgentPlist = (o) => servicePlist(serverServiceSpec(o));

// Laya en local: servidor de decisión de pesos abiertos (PyPI `laya`), versión fijada.
export const LAYA_VERSION = "0.4.7";

// Pasos para dejar el venv listo: crearlo si falta e instalar el paquete fijado. Sin E/S: el instalador los ejecuta.
export function layaInstallPlan({ python, venv, venvExists }) {
  const pip = { cmd: `${venv}/bin/pip`, args: ["install", "--quiet", `laya[serve]==${LAYA_VERSION}`] };
  return venvExists ? [pip] : [{ cmd: python, args: ["-m", "venv", venv] }, pip];
}

// laya-serve escucha por defecto en 0.0.0.0: aquí se ata SIEMPRE a `host` (127.0.0.1). Solo el checkpoint multilingüe.
export function layaServiceSpec({ label, serveBin, home, host, port, extraModels = {} }) {
  const env = { LAYA_HOST: host, LAYA_PORT: String(port), LAYA_MODELS: "multilingual", LAYA_DEFAULT_MODEL: "multilingual", USE_TF: "0", HF_HOME: `${home}/hf`, ...(Object.keys(extraModels).length && { LAYA_EXTRA_MODELS: JSON.stringify(extraModels) }) };
  return { label, argv: [serveBin], env, logFile: `${home}/laya.log` };
}

// Calentamiento: petición mínima y válida cada 45 s para que el servidor no se enfríe (la latencia en frío ronda los 300 ms).
// Tarea periódica (startInterval), no demonio: solo la ejecuta launchd en macOS.
export const LAYA_WARM_INTERVAL_S = 45;
export function layaWarmSpec({ label, home, url, model }) {
  const body = JSON.stringify(buildLayaRequest("calentamiento", model));
  return { label, argv: ["/usr/bin/curl", "-sS", "-m", "10", "-o", "/dev/null", "-X", "POST", "-H", "Content-Type: application/json", "-d", body, url], env: {}, logFile: `${home}/laya-warm.log`, startInterval: LAYA_WARM_INTERVAL_S };
}

export const layaLaunchAgentPlist = (o) => servicePlist(layaServiceSpec(o));

// "Python 3.12.4" → [3, 12]; cualquier otra cosa → null.
export function parsePythonVersion(text) {
  const m = /Python\s+(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Primer intérprete válido (≥3.12): override (ROUTER_LAYA_PYTHON) o python3.12 y luego python3 del PATH.
// probe(cmd) devuelve la salida de `cmd --version` o null si no existe. Sin E/S: el instalador pasa la sonda.
export function pickPython({ override = null, probe }) {
  for (const cmd of override ? [override] : ["python3.12", "python3"]) {
    const v = parsePythonVersion(probe(cmd));
    if (v && (v[0] > 3 || (v[0] === 3 && v[1] >= 12))) return cmd;
  }
  return null;
}
