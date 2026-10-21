// Parseo de argumentos del router y construcción de la llamada a `claude`. Puro.

const MODELS = new Set(["haiku", "sonnet", "opus", "fable"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const USAGE = `Uso:
  router "Describe la tarea"                  Opus analiza y delega en asistente/programador
  router --model haiku|sonnet|opus "Tarea"    Sin orquestador: un solo modelo
Opciones:
  --model MODELO       Modo manual con un único modelo.
  --effort NIVEL       low | medium | high | xhigh | max
  --agentes-usuario    Usa tus agentes de ~/.claude/agents en vez de los del router.
  --prompt             Imprime el prompt del orquestador con la cuota actual (lo usa el alias co).
  -h, --help           Esta ayuda.

Copia estable:
  router actualizar                           Pasa ~/.agent-router/app a origin/main (fetch), reconstruye y reinicia el dashboard.

Ajustar Laya con tus datos:
  router laya-datos [--out archivo.csv] [--perfil <id>|todos]   Exporta las ejecuciones etiquetadas (y un CSV de evaluación aparte).
  router laya-entrenar [--perfil P] [--forzar] [--simular]                  Exporta, ajusta Laya con laya-train y compara con el modelo base.
      [--datos CARPETA]   usa CARPETA/train.jsonl y test.jsonl en vez de las ejecuciones guardadas
      [--micro-batch N] [--grad-accum N] [--max-len N]   memoria (por defecto 1, 64 y 512)
  router laya-usar CARPETA | --quitar                                       Anota qué checkpoint usar y explica cómo aplicarlo.`;

export const isActualizarCommand = (word) => word === "actualizar";

const LAYA_COMMANDS = new Set(["laya-datos", "laya-entrenar", "laya-usar"]);
export const isLayaCommand = (word) => LAYA_COMMANDS.has(word);

// Argumentos de los subcomandos laya-*. Puro; lanza con un mensaje en castellano si algo no cuadra.
export function parseLayaArgs(argv) {
  const [command, ...rest] = argv;
  if (!LAYA_COMMANDS.has(command)) throw new Error(`Subcomando no válido: ${command ?? "(vacío)"}.`);
  const out = { command, out: null, profile: "todos", force: false, dryRun: false, dir: null, remove: false, datos: null, microBatch: 1, gradAccum: 64, maxLen: 512 };
  const posInt = (flag, i) => {
    const v = value(flag, i);
    if (!/^[1-9]\d*$/.test(v)) throw new Error(`Valor de ${flag} no válido: ${v} (entero positivo).`);
    return Number(v);
  };
  const value = (flag, i) => {
    const v = rest[i];
    if (v == null || v.startsWith("--")) throw new Error(`Falta el valor de ${flag}.`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out" && command === "laya-datos") out.out = value(a, ++i);
    else if (a === "--perfil" && command !== "laya-usar") {
      out.profile = value(a, ++i);
      if (!/^[a-z0-9-]+$/i.test(out.profile)) throw new Error(`Valor de --perfil no válido: ${out.profile}.`);
    } else if (a === "--forzar" && command === "laya-entrenar") out.force = true;
    else if (a === "--simular" && command === "laya-entrenar") out.dryRun = true;
    else if (a === "--datos" && command === "laya-entrenar") out.datos = value(a, ++i);
    else if (a === "--micro-batch" && command === "laya-entrenar") out.microBatch = posInt(a, ++i);
    else if (a === "--grad-accum" && command === "laya-entrenar") out.gradAccum = posInt(a, ++i);
    else if (a === "--max-len" && command === "laya-entrenar") out.maxLen = posInt(a, ++i);
    else if (a === "--quitar" && command === "laya-usar") out.remove = true;
    else if (command === "laya-usar" && !a.startsWith("--") && !out.dir) out.dir = a;
    else throw new Error(`Opción no válida para ${command}: ${a}.`);
  }
  if (command === "laya-usar" && !out.dir && !out.remove) throw new Error("Falta la carpeta del checkpoint (o --quitar).");
  return out;
}

export function parseCliArgs(argv) {
  const out = { task: "", model: null, effort: null, ownAgents: false, help: false, printPrompt: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--model") {
      const m = argv[++i];
      if (!MODELS.has(m)) throw new Error(`Modelo no válido: ${m ?? "(vacío)"}. Usa haiku, sonnet, opus o fable.`);
      out.model = m;
    } else if (a === "--effort") {
      const e = argv[++i];
      if (!EFFORTS.has(e)) throw new Error(`Esfuerzo no válido: ${e ?? "(vacío)"}.`);
      out.effort = e;
    } else if (a === "--agentes-usuario") out.ownAgents = true;
    else if (a === "--prompt") out.printPrompt = true;
    else rest.push(a);
  }
  out.task = rest.join(" ").trim();
  if (!out.help && !out.printPrompt && !out.task) throw new Error("Falta la tarea.");
  return out;
}

export function buildClaudeArgs({ mode, model, systemPrompt = null, agents = null, config, effort = null }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--permission-mode", config.permissionMode];
  if (mode === "orquestado" && systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (mode === "orquestado" && agents) args.push("--agents", JSON.stringify(agents));
  if (config.fallbackModel && config.fallbackModel !== model) args.push("--fallback-model", config.fallbackModel);
  const lvl = effort ?? config.effort;
  if (lvl) args.push("--effort", lvl);
  if (config.maxBudgetUsd != null) args.push("--max-budget-usd", String(config.maxBudgetUsd));
  return args;
}
