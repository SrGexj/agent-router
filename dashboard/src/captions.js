// Título y explicación de la fase actual, bajo la línea de tiempo. Puro.
import { isStale, workerView } from "../../src/core/view.mjs";
import { costBreakdown, runTotals, shadowVerdict, spendUnknown } from "../../src/core/details.mjs";

const pad = (n) => String(n).padStart(2, "0");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtCost(usd) {
  return `${usd.toFixed(2).replace(".", ",")} $`;
}

// Para importes pequeños (la llamada al clasificador cuesta fracciones de céntimo): 4 decimales por debajo de 0,01 $.
export function fmtCostFine(usd) {
  return Math.abs(usd) < 0.01 && usd !== 0 ? `${usd.toFixed(4).replace(".", ",")} $` : fmtCost(usd);
}

export function fmtClock(epochSec) {
  const d = new Date(epochSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tasksOf(run) {
  return run ? run.taskOrder.map((id) => run.tasks[id]) : [];
}

// "5 encargos · 4,20 $ · 1,2 M tok · 3 min 10 s". Sin datos de uso, sin $ ni tokens; "parcial" si faltan datos.
export function summaryLine(run, now) {
  const t = runTotals(run, now);
  const parts = [plural(t.tasks, "encargo", "encargos")];
  if (t.costUsd != null) parts.push(fmtCost(t.costUsd));
  if (t.tokens != null) parts.push(`${fmtTokens(t.tokens)} tok`);
  if (t.partial) parts.push("parcial");
  parts.push(fmtDuration(t.durationMs));
  return parts.join(" · ");
}

const familyName = (model) => {
  const m = /(haiku|sonnet|opus|fable)/i.exec(model ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}` : null;
};

// Bajo el orquestador: "Opus · 1,40 $ · 150 k tok". null sin datos de uso suyos.
export function orchestratorSub(run) {
  const o = costBreakdown(run).orchestrator;
  if (o.tokens <= 0) return null;
  return [familyName(o.models[0]) ?? "Opus", fmtCost(o.costUsd), `${fmtTokens(o.tokens)} tok`].join(" · ");
}

// Bajo el orquestador: sus subagentes propios (Explore, general-purpose, Plan...), que no van a los nodos de rol.
// "+1 Explore en curso" mientras trabajan (varios tipos: "+3 subagentes en curso") y "subagentes: N" al acabar.
export function ownSubagentsLine(run) {
  const own = tasksOf(run).filter((t) => t.node === "propio");
  if (own.length === 0) return null;
  const running = own.filter((t) => t.status === "running");
  if (running.length === 0) return `subagentes: ${own.length}`;
  const types = [...new Set(running.map((t) => t.agent))];
  return `+${running.length} ${types.length === 1 ? types[0] : "subagentes"} en curso`;
}

// Tras este tiempo sin respuesta de Laya en una ejecución en curso se deja de esperarla (sombra desactivada o caída).
export const LAYA_WAIT_MS = 30_000;
const ROUTE_NAME = { asistente: "Asistente", programador: "Programador", opus: "Opus" };

// Nodo "Laya (sombra)" de la escena: null = no se pinta (demo, router CLI, ejecuciones sin shadow).
// Solo las sesiones co lanzan el clasificador, así que ahí es donde tiene sentido esperarlo.
export function layaNode(run, now) {
  if (!run) return null;
  const sh = run.shadow ?? null;
  if (!sh) {
    if (run.mode !== "sesion" || run.endedAt != null || now - run.startedAt > LAYA_WAIT_MS) return null;
    return { text: "Consultando…", dot: "idle pulse", title: "Laya está clasificando el mensaje", verdict: null };
  }
  const v = shadowVerdict(run);
  if (v.na) return { text: "no aplica", dot: "idle", title: "Aviso del sistema: no se clasifica", verdict: null };
  if (sh.error || !v.choice) {
    return { text: "sin respuesta", dot: "warn", title: sh.error ? `Laya: ${sh.error}` : "Laya no devolvió ninguna elección", verdict: null };
  }
  const name = ROUTE_NAME[v.choice] ?? v.choice;
  const text = v.confidence == null ? name : `${name} ${Math.round(v.confidence * 100)} %`;
  const title = [`Laya habría elegido ${name.toLowerCase()}`, sh.reason].filter(Boolean).join(": ");
  let verdict = null;
  if (run.endedAt != null && v.match != null) verdict = v.match ? { text: "coincide", tone: "ok" } : { text: "no coincide", tone: "warn" };
  return { text, dot: "idle", title, verdict };
}

// Barra de gasto de una ejecución en curso sin datos de uso todavía: en vez de tres "—" sueltos.
export const spendPending = (run, share) => (run?.status === "running" && !share ? "se calcula en vivo" : null);

// Texto de cada parte del reparto de gasto. Un trabajador con encargos sin uso todavía no es 0 %: "…" en curso, "—" si ya no llegará.
export function spendLabels(run, share) {
  const unknown = spendUnknown(run);
  const gap = run?.status === "running" ? "…" : "—";
  const one = (key, hasUnknown) => (hasUnknown ? gap : share ? `${share[key]}%` : "—");
  return { opus: one("opus", unknown.opus), sonnet: one("sonnet", unknown.sonnet), haiku: one("haiku", unknown.haiku) };
}

// Bajo un trabajador: "Sonnet 5.5 · 3 encargos · 3,00 $ · 1,1 M tok" (coste y tokens si hay uso), o "Sonnet · sin encargos".
export function workerSub(run, node, fallback) {
  const v = workerView(run, node, 0);
  if (v.total === 0) return run?.endedAt != null ? fallback : `${fallback} · sin encargos`; // terminada: el pill ya dice "Sin encargos"
  const part = costBreakdown(run)[node];
  const tokens = part.tokens || v.tokens;
  const parts = [fmtModel(v.model ?? "") === "—" ? fallback : fmtModel(v.model), plural(v.total, "encargo", "encargos")];
  if (part.costUsd > 0) parts.push(fmtCost(part.costUsd));
  if (tokens) parts.push(`${fmtTokens(tokens)} tok`);
  return parts.join(" · ");
}

export function captionFor(phase, run, now) {
  const tasks = tasksOf(run);
  const running = tasks.filter((t) => t.status === "running");
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "killed");

  if (run?.status === "running" && run.waiting && !["fallo", "limitado", "entrega"].includes(phase)) {
    const what = { question: "una pregunta", permission: "un permiso", plan: "la aprobación de un plan" }[run.waiting.kind] ?? "tu respuesta";
    return { title: "Esperando tu respuesta", text: `Opus necesita ${what}: respóndela en la terminal.`, tone: "normal" };
  }

  switch (phase) {
    case "reposo":
      return { title: "En espera", text: "Abre una sesión con co (o lanza router \"…\") y Opus repartirá el trabajo entre el equipo.", tone: "normal" };
    case "recibe":
      return { title: "Tarea recibida", text: run.task, tone: "normal" };
    case "analiza":
      return { title: "Opus analiza", text: "Lee el contexto y decide qué hace él y qué delega.", tone: "normal" };
    case "delega": {
      const p = tasks.filter((t) => t.node === "programador").length;
      const a = tasks.filter((t) => t.node === "asistente").length;
      const o = tasks.length - p - a;
      const parts = [];
      if (p) parts.push(`${p} a Programador (Sonnet)`);
      if (a) parts.push(`${a} a Asistente (Haiku)`);
      if (o) parts.push(`${o} ${o === 1 ? "subagente propio" : "subagentes propios"} de Opus`);
      return { title: "Reparto", text: `${plural(tasks.length, "encargo", "encargos")}: ${parts.join(" y ")}.`, tone: "normal" };
    }
    case "ejecuta":
      return {
        title: "Ejecutando",
        text: `${running.length} en curso. Cada cubo encendido es un encargo trabajando; parpadea con cada herramienta.`,
        tone: "normal"
      };
    case "revisa":
      return {
        title: "Revisión",
        text: failed.length
          ? `Opus revisa los resultados; ${plural(failed.length, "encargo falló", "encargos fallaron")} y decide si reintentar.`
          : "Opus comprueba los resultados antes de darlos por buenos.",
        tone: "normal"
      };
    case "entrega":
      return { title: "Terminada", text: summaryLine(run, now), tone: "normal" };
    case "limitado": {
      const win = run.limit?.window === "seven_day" ? "7 días" : "5 h";
      const reset = run.limit?.resetsAt ? ` Se reinicia a las ${fmtClock(run.limit.resetsAt)}.` : "";
      return { title: "Límite de uso", text: `Ventana de ${win} agotada.${reset}`, tone: "error" };
    }
    case "fallo": {
      if (isStale(run, now)) {
        return { title: "Sin señal", text: `No llegan eventos desde hace ${fmtDuration(now - run.updatedAt).replace(/ \d+ s$/, "")}: la sesión se cerró o se quedó esperando.`, tone: "error" };
      }
      if (run.status === "cancelled") return { title: "Cancelada", text: summaryLine(run, now), tone: "error" };
      const last = run.errors.at(-1);
      return { title: "Falló", text: `${summaryLine(run, now)}. ${last?.message ?? `Código de salida ${run.exitCode}`}`, tone: "error" };
    }
    default:
      return { title: "", text: "", tone: "normal" };
  }
}

export function fmtTokens(n) {
  const short = (v) => v.toFixed(1).replace(".", ",").replace(/,0$/, "");
  if (n >= 1_000_000) return `${short(n / 1_000_000)} M`;
  if (n >= 1000) return `${short(n / 1000)} k`;
  return String(n ?? 0);
}

export function fmtModel(model) {
  const m = /(haiku|sonnet|opus|fable)-(\d+)-(\d+)/i.exec(model ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model ?? "—";
}

// Desglose por tipo de token, para tooltips y listas desplegables.
export function fmtTokenTypes(t) {
  if (!t) return "";
  return `entrada ${fmtTokens(t.input)} · salida ${fmtTokens(t.output)} · lectura de caché ${fmtTokens(t.cacheRead)} · escritura de caché ${fmtTokens(t.cacheWrite)}`;
}

// Barra de reparto única con selector GASTO · USO. Lógica pura (sin DOM) para poder probarla.
export const SPLIT_KEY = "agent-router.split-mode";
export const normalizeSplitMode = (v) => (v === "uso" ? "uso" : "gasto");

export function readSplitMode(storage) {
  try { return normalizeSplitMode(storage.getItem(SPLIT_KEY)); } catch { return "gasto"; }
}

export function saveSplitMode(storage, mode) {
  try { storage.setItem(SPLIT_KEY, normalizeSplitMode(mode)); return true; } catch { return false; }
}

// Qué pintar según el modo: la barra (null = sin datos, se muestra "—"), su tooltip y si se oculta entera.
export function splitView(mode, share, uso) {
  if (normalizeSplitMode(mode) === "uso") {
    if (!uso) return { mode: "uso", bar: null, title: "Sin datos de uso todavía", hidden: true };
    return { mode: "uso", bar: { opus: uso.opus, sonnet: uso.sonnet, haiku: uso.haiku }, title: usageTitle(uso), hidden: false };
  }
  return {
    mode: "gasto",
    bar: share ?? null,
    title: share ? "Reparto del gasto real en dólares (precios API), orquestador incluido" : "Sin datos de uso todavía",
    hidden: false
  };
}

// Tooltip de la barra de uso: tokens totales por modelo y, aparte, los nuevos (sin lectura de caché).
export function usageTitle(uso) {
  const row = (label, k) => `${label} ${fmtTokens(uso.tokens[k])} (nuevos ${fmtTokens(uso.fresh[k])})`;
  return `Reparto de tokens (entrada + salida + caché leída + caché escrita), orquestador incluido. ${row("Opus", "opus")} · ${row("Sonnet", "sonnet")} · ${row("Haiku", "haiku")}. «Nuevos» = sin caché leída.`;
}
