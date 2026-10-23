// Único módulo que lee variables de entorno. El resto recibe la configuración ya resuelta.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LAYA_ROUTING_MODES } from "./core/laya-routing.mjs";
import { RELEVO_TOKENS_DEFAULT } from "./core/compaction.mjs";

const PERMISSION_MODES = new Set(["acceptEdits", "auto", "manual", "dontAsk", "plan"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Id interno de un perfil a partir de su carpeta: ~/.claude → "trabajo" (id histórico del perfil por defecto,
// no se cambia para no romper las ejecuciones ya guardadas); ~/.claude-X → "X"; otra carpeta → su nombre sin el punto.
export function profileIdFromDir(dir) {
  const name = basename(dir);
  if (name === ".claude") return "trabajo";
  return name.replace(/^\.claude-?/, "").replace(/^\./, "") || "trabajo";
}

// Compatibilidad con la instalación original: si existe ~/.claude-personal y no hay ROUTER_PROFILE2_DIR,
// se comporta como antes (etiquetas Trabajo/Personal, alias cop y canal de Telegram).
const LEGACY = { dirName: ".claude-personal", defaultLabel: "Trabajo", label: "Personal", args: "--channels plugin:telegram@claude-plugins-official" };
const SAFE_ALIAS = /^[A-Za-z][A-Za-z0-9_-]*$/;
const BROWSER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ARG = /^[A-Za-z0-9_@:./=,+-]+$/;

// deviceId del navegador de Claude in Chrome de un perfil: opcional; si se da, debe ser un UUID.
function browserIdFrom(env, key) {
  const v = (env[key] ?? "").trim();
  if (!v) return null;
  if (!BROWSER_ID.test(v)) throw new Error(`${key} no válido: debe ser un UUID (deviceId de Claude in Chrome).`);
  return v;
}

// Telemetría opt-in: activa solo con URL y token, y la URL ha de ser https (http solo hacia la propia máquina).
// El token vive aquí y en nadie más: ni se imprime ni va a logs.
function resolveTelemetry(env, home) {
  const files = { sentFile: join(home, "telemetry-sent.json"), rejectedFile: join(home, "telemetry-rejected.json"), errorsFile: join(home, "telemetry-errors.log"), lockFile: join(home, "telemetry.lock") };
  const off = { enabled: false, url: null, endpoint: null, token: null, ...files };
  const rawUrl = (env.ROUTER_TELEMETRY_URL ?? "").trim();
  const token = (env.ROUTER_TELEMETRY_TOKEN ?? "").trim();
  if (!rawUrl || !token) return off;
  let u;
  try { u = new URL(rawUrl); } catch { return off; }
  const local = LOCAL_HOSTS.has(u.hostname.replace(/^\[|\]$/g, ""));
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return off;
  const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return { enabled: true, url: u.origin, endpoint: `${base}/v1/runs`, token, ...files };
}

function resolveProfiles(env, home, exists) {
  const defDir = join(home, ".claude");
  const legacyDir = join(home, LEGACY.dirName);
  const legacy = !env.ROUTER_PROFILE2_DIR && exists(legacyDir);
  const dir2 = env.ROUTER_PROFILE2_DIR || (legacy ? legacyDir : null);
  const def = { id: "trabajo", label: env.ROUTER_PROFILE_LABEL || (legacy ? LEGACY.defaultLabel : "Principal"), dir: defDir, browserId: browserIdFrom(env, "ROUTER_PROFILE_BROWSER_ID") };
  if (!dir2 || profileIdFromDir(dir2) === def.id) return { default: def, second: null };

  const id = profileIdFromDir(dir2);
  const alias = env.ROUTER_PROFILE2_ALIAS || "cop";
  if (!SAFE_ALIAS.test(alias) || alias === "co") throw new Error(`ROUTER_PROFILE2_ALIAS no válido: ${alias} (letras, números, - y _; distinto de co).`);
  const rawArgs = env.ROUTER_PROFILE2_ARGS ?? (legacy ? LEGACY.args : "");
  const args = rawArgs.split(/\s+/).filter(Boolean);
  const bad = args.find((a) => !SAFE_ARG.test(a));
  if (bad) throw new Error(`ROUTER_PROFILE2_ARGS no válido: ${bad} (solo letras, números y _ @ : . / = , + -; se escriben tal cual en tu shell).`);
  return { default: def, second: { id, label: env.ROUTER_PROFILE2_LABEL || (legacy ? LEGACY.label : id), dir: dir2, alias, args, browserId: browserIdFrom(env, "ROUTER_PROFILE2_BROWSER_ID") } };
}

// Variables que se aceptan en <ROUTER_HOME>/config.env y que el instalador guarda allí.
// ROUTER_HOME no está: sirve para localizar el archivo. HOME, SHELL y CLAUDE_CONFIG_DIR son del entorno de cada proceso.
export const CONFIG_KEYS = Object.freeze([
  "CLAUDE_BIN",
  "ROUTER_HOST", "ROUTER_PORT", "ROUTER_ALLOW_REMOTE", "ROUTER_ACCESS_TOKEN", "ROUTER_PERMISSION_MODE", "ROUTER_EFFORT", "ROUTER_FALLBACK_MODEL", "ROUTER_MAX_BUDGET_USD",
  "ROUTER_RELEVO_TOKENS", "ROUTER_SEAT_USD", "ROUTER_MONITOR_BIN", "ROUTER_MONITOR_WAREHOUSE",
  "ROUTER_SHADOW", "ROUTER_SHADOW_PROVIDER", "ROUTER_SHADOW_MODEL",
  "ROUTER_LAYA_URL", "ROUTER_LAYA_ROUTING", "ROUTER_LAYA_ROUTING_MODEL", "ROUTER_LAYA_EXTRA_MODELS", "ROUTER_LAYA_DOWNGRADE_THRESHOLD", "ROUTER_LAYA_TIMEOUT_MS", "ROUTER_LAYA_VENV", "ROUTER_LAYA_HF_HOME", "ROUTER_LAYA_PYTHON",
  "ROUTER_PROFILE_LABEL", "ROUTER_PROFILE2_DIR", "ROUTER_PROFILE2_LABEL", "ROUTER_PROFILE2_ALIAS", "ROUTER_PROFILE2_ARGS",
  "ROUTER_PROFILE_BROWSER_ID", "ROUTER_PROFILE2_BROWSER_ID",
  "ROUTER_TELEMETRY_URL", "ROUTER_TELEMETRY_TOKEN"
]);
const KEY_SET = new Set(CONFIG_KEYS);
const KEY_NAME = /^[A-Z0-9_]+$/;
const CONFIG_FILE = "config.env";

// Parser estricto de KEY=VALUE por línea: sin expansión ni ejecución. El valor es literal hasta fin de línea
// (se quita una pareja de comillas simples o dobles que lo envuelva). Devuelve los valores válidos y los avisos.
export function parseConfigEnv(text, source = CONFIG_FILE) {
  const values = {};
  const warnings = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (!KEY_NAME.test(key)) return warnings.push(`${source} línea ${i + 1}: no es CLAVE=valor, se ignora`);
    if (!KEY_SET.has(key)) return warnings.push(`${source} línea ${i + 1}: ${key} no es una variable soportada${key === "ROUTER_HOME" ? " en el archivo (se usa para localizarlo)" : ""}, se ignora`);
    let value = line.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    values[key] = value;
  });
  return { values, warnings };
}

// Del entorno, solo las variables soportadas que estén definidas (un vacío explícito cuenta).
export function pickSupportedEnv(env) {
  return Object.fromEntries(CONFIG_KEYS.filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]));
}

// Lo ya guardado se conserva salvo que el entorno lo sobrescriba.
export const mergeConfigEnv = (existing, fromEnv) => ({ ...existing, ...fromEnv });

export function serializeConfigEnv(values) {
  const lines = Object.entries(values)
    .filter(([, v]) => !/[\r\n]/.test(v))
    .map(([k, v]) => `${k}=${v !== v.trim() || /^(["']).*\1$/.test(v) ? `"${v}"` : v}`);
  return ["# Configuración de agent-router. KEY=VALUE por línea; sin expansión de variables.", "# El entorno del proceso tiene prioridad sobre este archivo. Reinicia con `npm run instalar` para que el servicio lo recoja.", ...lines, ""].join("\n");
}

const realFs = { readFile: (p) => readFileSync(p, "utf8"), writeFile: writeFileSync, mkdir: mkdirSync, chmod: chmodSync };
const readOrNull = (readFile, path, warn) => {
  try { return readFile(path); } catch (e) { if (e?.code && e.code !== "ENOENT") warn(`${path}: no se puede leer (${e.code})`); return null; }
};

// Guarda en <home>/config.env las variables soportadas que haya en env (permisos 0600). fs inyectable.
export function saveConfigEnv({ home, env = process.env, fs = realFs }) {
  const path = join(home, CONFIG_FILE);
  const old = readOrNull(fs.readFile, path, () => {});
  const existing = old == null ? {} : parseConfigEnv(old, path).values;
  const fromEnv = pickSupportedEnv(env);
  const merged = mergeConfigEnv(existing, fromEnv);
  const keys = Object.keys(merged);
  if (!Object.keys(fromEnv).length) return { path, keys, changed: false };
  fs.mkdir(home, { recursive: true });
  fs.writeFile(path, serializeConfigEnv(merged), { mode: 0o600 });
  fs.chmod(path, 0o600);
  return { path, keys, changed: true };
}

// exists / readFile / warn: inyectables para probar sin disco (perfil personal heredado, detección de Laya y config.env).
// Precedencia: entorno del proceso > <ROUTER_HOME>/config.env > valores por defecto.
export function loadConfig(processEnv = process.env, { exists = existsSync, readFile = realFs.readFile, warn = (m) => console.error(`agent-router: ${m}`) } = {}) {
  const homeDir = processEnv.ROUTER_HOME || join(processEnv.HOME || ".", ".agent-router");
  const filePath = join(homeDir, CONFIG_FILE);
  const text = readOrNull(readFile, filePath, warn);
  const parsed = text == null ? { values: {}, warnings: [] } : parseConfigEnv(text, filePath);
  parsed.warnings.forEach(warn);
  const env = { ...parsed.values, ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v !== undefined)) };
  const home = env.ROUTER_HOME || join(env.HOME || ".", ".agent-router");
  const host = env.ROUTER_HOST || "127.0.0.1";
  if (!LOCAL_HOSTS.has(host) && env.ROUTER_ALLOW_REMOTE !== "1") {
    throw new Error(`ROUTER_HOST=${host} expone el servidor fuera de localhost. Pon ROUTER_ALLOW_REMOTE=1 si de verdad lo quieres.`);
  }

  const permissionMode = env.ROUTER_PERMISSION_MODE || "auto";
  if (permissionMode === "bypassPermissions") {
    throw new Error("ROUTER_PERMISSION_MODE=bypassPermissions no está permitido: usa auto o acceptEdits.");
  }
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`ROUTER_PERMISSION_MODE no válido: ${permissionMode}`);
  }

  // Perfiles de cuenta de Claude Code: el principal (~/.claude) y, opcionalmente, un segundo. El activo sale de CLAUDE_CONFIG_DIR.
  const userHome = env.HOME || ".";
  const profiles = resolveProfiles(env, userHome, exists);
  const profile = env.CLAUDE_CONFIG_DIR ? profileIdFromDir(env.CLAUDE_CONFIG_DIR) : profiles.default.id;
  const profileLabels = { [profiles.default.id]: profiles.default.label, ...(profiles.second && { [profiles.second.id]: profiles.second.label }) };
  const profileAlias = profile === profiles.default.id ? "co" : profiles.second?.id === profile ? profiles.second.alias : "cop";
  // Navegador de Claude in Chrome del perfil activo (null si no se configuró).
  const activeProfile = profiles.second?.id === profile ? profiles.second : profile === profiles.default.id ? profiles.default : null;
  const browser = activeProfile?.browserId ? { id: activeProfile.browserId, label: activeProfile.label } : null;
  const layaVenv = env.ROUTER_LAYA_VENV || join(home, "laya-venv");
  // Modo sombra: apagado salvo que Laya esté instalada (el instalador crea su venv) o se pida con ROUTER_SHADOW=1.
  const shadowEnabled = env.ROUTER_SHADOW === "1" ? true : env.ROUTER_SHADOW === "0" ? false : exists(join(layaVenv, "bin/laya-serve"));

  // Token de acceso remoto (túnel): con menos de 32 caracteres se ignora y se avisa (nunca se escribe el valor).
  let accessToken = env.ROUTER_ACCESS_TOKEN || null;
  if (accessToken && accessToken.length < 32) {
    warn("ROUTER_ACCESS_TOKEN tiene menos de 32 caracteres: se ignora y el dashboard queda sin autenticación.");
    accessToken = null;
  }

  // Enrutado por Laya en el hook de Agent/Task: off | shadow (solo anota) | downgrade (baja programador -> asistente con confianza alta).
  const layaRouting = env.ROUTER_LAYA_ROUTING || "off";
  if (!LAYA_ROUTING_MODES.includes(layaRouting)) throw new Error(`ROUTER_LAYA_ROUTING no válido: ${layaRouting} (${LAYA_ROUTING_MODES.join(", ")}).`);
  let layaExtraModels = {};
  if (env.ROUTER_LAYA_EXTRA_MODELS) {
    try { layaExtraModels = JSON.parse(env.ROUTER_LAYA_EXTRA_MODELS); } catch { layaExtraModels = null; }
    if (!layaExtraModels || typeof layaExtraModels !== "object" || Array.isArray(layaExtraModels)) throw new Error('ROUTER_LAYA_EXTRA_MODELS no válido: debe ser un objeto JSON {"nombre": "carpeta"}.');
  }
  const thr = Number(env.ROUTER_LAYA_DOWNGRADE_THRESHOLD);
  const tmo = Number(env.ROUTER_LAYA_TIMEOUT_MS);

  const relevo = Number(env.ROUTER_RELEVO_TOKENS);

  const budget = env.ROUTER_MAX_BUDGET_USD ? Number(env.ROUTER_MAX_BUDGET_USD) : null;
  const seat = env.ROUTER_SEAT_USD ? Number(env.ROUTER_SEAT_USD) : null;

  return {
    userHome,
    home,
    shell: env.SHELL || "",
    profile,
    profileAlias,
    profileLabels,
    profiles,
    browser,
    telemetry: resolveTelemetry(env, home),
    runsDir: join(home, "runs"),
    sessionsDir: join(home, "sessions"),
    pendingDir: join(home, "pendientes"),
    relevoDir: join(home, "relevo"),
    // Contexto (tokens) de la sesión principal a partir del cual el orquestador escribe el relevo.
    relevoTokens: env.ROUTER_RELEVO_TOKENS && Number.isInteger(relevo) && relevo > 0 ? relevo : RELEVO_TOKENS_DEFAULT,
    host,
    port: Number(env.ROUTER_PORT || 4317),
    accessToken,
    permissionMode,
    effort: env.ROUTER_EFFORT || null,
    fallbackModel: env.ROUTER_FALLBACK_MODEL ?? "sonnet",
    maxBudgetUsd: Number.isFinite(budget) ? budget : null,
    claudeBin: env.CLAUDE_BIN || "claude",
    // Subagentes que el hook PreToolUse deniega (heredan Opus). Vacío = desactivado.
    blockedAgents: (env.ROUTER_BLOCKED_AGENTS ?? "general-purpose,fork,claude,Explore,Plan").split(",").map((s) => s.trim()).filter(Boolean),
    layaRouting,
    // Modelo (nombre registrado en laya-serve) solo para la consulta de enrutado de encargos; vacío = el modelo actual.
    layaRoutingModel: env.ROUTER_LAYA_ROUTING_MODEL || "",
    // Checkpoints extra que el instalador pasa a laya-serve (LAYA_EXTRA_MODELS).
    layaExtraModels,
    layaDowngradeThreshold: env.ROUTER_LAYA_DOWNGRADE_THRESHOLD && thr > 0 && thr <= 1 ? thr : 0.9,
    layaTimeoutMs: env.ROUTER_LAYA_TIMEOUT_MS && Number.isInteger(tmo) && tmo > 0 ? tmo : 300,
    // Modo sombra: un clasificador anota qué habría elegido; no cambia nada. Proveedor: Laya local ("laya") o Jev vía OpenRouter ("jev").
    shadow: {
      enabled: shadowEnabled,
      provider: env.ROUTER_SHADOW_PROVIDER || "laya",
      layaUrl: env.ROUTER_LAYA_URL || "http://127.0.0.1:4318/v1/systemone",
      keyPath: join(home, "openrouter.key"),
      model: env.ROUTER_SHADOW_MODEL || "typesafe/jev-1.13",
      timeoutMs: 15000
    },
    // Ajuste de Laya con datos propios: el venv donde está laya-train, dónde se guardan los modelos y cuál está elegido.
    laya: {
      venvDir: layaVenv,
      // Python ≥3.12 para crear el venv; si es null el instalador busca python3.12 y python3 en el PATH.
      python: env.ROUTER_LAYA_PYTHON || null,
      hfHome: env.ROUTER_LAYA_HF_HOME || join(home, "hf"),
      modelsDir: join(home, "laya-modelos"),
      activeFile: join(home, "laya-modelo-activo"),
      base: "multilingual",
      // Entorno de los procesos hijos (laya-train y la evaluación): lo mínimo del sistema más lo de Laya.
      env: {
        PATH: env.PATH || "", HOME: env.HOME || "", TMPDIR: env.TMPDIR || "", LANG: env.LANG || "en_US.UTF-8",
        HF_HOME: env.ROUTER_LAYA_HF_HOME || join(home, "hf"), USE_TF: "0", TOKENIZERS_PARALLELISM: "false"
      }
    },
    // Panel de consumo: los datos salen de claude-monitor; el seat es el precio aproximado de la suscripción (sin ROUTER_SEAT_USD no se calcula el rendimiento).
    consumo: {
      seatUsdMonth: Number.isFinite(seat) && seat > 0 ? seat : null,
      monitorBin: env.ROUTER_MONITOR_BIN || "claude-monitor",
      refreshMs: 60000,
      // Histórico local de claude-monitor (unos MB por cuenta): sin él no hay totales por día/semana/mes.
      warehouseDir: env.ROUTER_MONITOR_WAREHOUSE === "0" ? null : join(home, "monitor")
    }
  };
}
