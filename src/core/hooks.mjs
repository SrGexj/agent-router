// Traduce los hooks de una sesión interactiva de Claude Code (alias `co`) a los mismos
// eventos que produce el router. Puro: la sesión, el reloj y el generador de ids entran
// como parámetros. Cada mensaje del usuario es una ejecución del dashboard.

import { sanitizePrompt } from "./classifier.mjs";

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const WAIT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const RESULT_MAX = 8000;

const short = (text, max) => {
  const s = (text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function asObject(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

function normalizeQuestions(input) {
  const qs = Array.isArray(asObject(input)?.questions) ? asObject(input).questions : [];
  return qs.filter((q) => q && typeof q === "object").map((q) => ({
    question: String(q.question ?? ""), header: String(q.header ?? ""), multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o === "object")
      .map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") }))
  }));
}

const asText = (v) => (typeof v === "string" ? v.trim() : "");

// No conocemos la forma exacta de tool_response: se prueban las razonables y, si ninguna encaja, null.
export function answerFrom(response, tool) {
  const r = asObject(response);
  if (typeof response === "string" && !r) return short(response, 500) || null;
  if (typeof r === "string") return short(r, 500) || null;
  if (!r) return null;
  const a = r.answers;
  if (a && typeof a === "object") {
    const vals = (Array.isArray(a) ? a : Object.values(a)).map((v) => (Array.isArray(v) ? v.join(", ") : asText(v))).filter(Boolean);
    if (vals.length) return vals.join(" · ");
  }
  for (const k of ["answer", "result", "response"]) if (asText(r[k])) return short(r[k], 500);
  if (Array.isArray(r.content)) {
    const txt = r.content.map((b) => asText(b?.text)).filter(Boolean).join(" ");
    if (txt) return short(txt, 500);
  }
  if (tool === "ExitPlanMode" && typeof r.approved === "boolean") return r.approved ? "Aprobado" : "Rechazado";
  return null;
}

const usageEvents = (type, u, t, extra = {}) => (u && Object.keys(u.byModel ?? {}).length ? [{ type, ...extra, byModel: u.byModel, t }] : []);

const INTERRUPT = "[Request interrupted by user";

// Solo cuenta la entrada que escribe Claude Code al pulsar Esc: un mensaje "user" de la sesión
// principal cuyo texto empieza por la marca. Buscar el texto a secas daba falsos positivos
// cuando aparecía dentro de un resultado de herramienta (p. ej. al leer este mismo archivo).
function isInterruptEntry(line) {
  if (!line.includes(INTERRUPT)) return false;
  let e;
  try { e = JSON.parse(line); } catch { return false; }
  if (e?.type !== "user" || e.isSidechain === true) return false;
  const content = e.message?.content;
  if (typeof content === "string") return content.startsWith(INTERRUPT);
  return Array.isArray(content) && content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(INTERRUPT));
}

export function interruptedIn(transcriptText) {
  return (transcriptText ?? "").split("\n").some(isInterruptEntry);
}

const cancelEvent = (t) => ({ type: "run_end", exitCode: 130, status: "cancelled", t });
const cancelEvents = (t, usage) => [...usageEvents("orchestrator_usage", usage, t), cancelEvent(t)];

// Esc no dispara ningún hook: quien detecta la marca en el transcript (la statusline) cierra así.
export function closeInterrupted(session, now, usage = null) {
  if (!session.runId) return null;
  return { runId: session.runId, events: cancelEvents(now, usage), session: { runId: null, lastRunId: session.runId, seq: session.seq } };
}

// Gasto del orquestador en vivo: PostToolUse del orquestador, PreToolUse al delegar (Agent/Task) y SubagentStop,
// como mucho una vez cada 20 s por sesión. Un run nuevo parte de sesión limpia (sin lastUsageAt), así que su primer volcado no espera.
export const LIVE_USAGE_MS = 20_000;
export function liveUsageDue(p, session, now) {
  if (!session.runId || session.transcriptOffset == null) return false;
  const eligible = p.hook_event_name === "SubagentStop" || (!p.agent_id && (p.hook_event_name === "PostToolUse" || (p.hook_event_name === "PreToolUse" && AGENT_TOOLS.has(p.tool_name))));
  return eligible && now - (session.lastUsageAt ?? 0) >= LIVE_USAGE_MS;
}

// Gasto de un subagente en vivo: sus PreToolUse/PostToolUse, como mucho una vez cada 20 s por subagente.
// session.agentUsage[agentId] = { at, state } recuerda cuándo y hasta dónde se leyó su transcript.
export function liveAgentUsageDue(p, session, now) {
  if (!session.runId || !p.agent_id) return false;
  if (p.hook_event_name !== "PreToolUse" && p.hook_event_name !== "PostToolUse") return false;
  return now - (session.agentUsage?.[p.agent_id]?.at ?? 0) >= LIVE_USAGE_MS;
}

// ctx: { profile, transcriptSize, interrupted, agentUsage, orchestratorUsage } — lo que el proceso del hook sabe leer del disco.
export function translateHook(p, session, now, makeRunId, ctx = {}) {
  const t = now;
  const open = session.runId;
  const none = { events: [], session, runId: open };

  if (p.hook_event_name === "UserPromptSubmit") {
    // Con una ejecución abierta: si hubo Esc, se cierra y empieza otra; si no, es un mensaje a mitad de turno.
    if (open && !ctx.interrupted) return none;
    const before = open ? { runId: open, events: cancelEvents(t, ctx.orchestratorUsage) } : undefined;
    const seq = session.seq + 1;
    const runId = makeRunId(now, String(p.session_id ?? "sesion").slice(0, 8), seq);
    const next = { runId, lastRunId: runId, seq };
    if (ctx.transcriptSize != null) next.transcriptOffset = ctx.transcriptSize;
    const res = {
      runId,
      session: next,
      events: [{ type: "run_start", runId, task: p.prompt ?? "", mode: "sesion", model: "opus", cwd: p.cwd ?? null, profile: ctx.profile ?? "trabajo", t }]
    };
    if (before) res.before = before;
    // Solo al abrir ejecución: el proceso del hook lanza el clasificador en modo sombra con este prompt ya saneado.
    const shadowPrompt = sanitizePrompt(p.prompt).trim();
    if (shadowPrompt) res.shadow = { runId, prompt: shadowPrompt };
    return res;
  }
  if (!open) return none;

  // Al cerrar, el coste del orquestador va antes del run_end.
  const close = (events) => {
    const end = events.findIndex((e) => e.type === "run_end");
    const all = [...events.slice(0, end), ...usageEvents("orchestrator_usage", ctx.orchestratorUsage, t), ...events.slice(end)];
    return { runId: open, session: { runId: null, lastRunId: open, seq: session.seq }, events: all };
  };
  // Con el estrangulado cumplido y datos leídos, la instantánea acumulada va al final y se recuerda cuándo y hasta dónde se leyó.
  const live = liveUsageDue(p, session, t) && ctx.orchestratorUsage;
  const liveAgent = liveAgentUsageDue(p, session, t) && ctx.agentLive?.usage;
  const keep = (events) => {
    let out = events;
    let next = session;
    if (live) {
      out = [...out, ...usageEvents("orchestrator_usage", ctx.orchestratorUsage, t)];
      next = { ...next, lastUsageAt: t, ...(ctx.usageState ? { usageState: ctx.usageState } : {}) };
    }
    if (liveAgent) {
      out = [...out, ...usageEvents("task_usage", ctx.agentLive.usage, t, { taskId: p.agent_id, snapshot: true })];
      next = { ...next, agentUsage: { ...(next.agentUsage ?? {}), [p.agent_id]: { at: t, state: ctx.agentLive.state ?? null } } };
    }
    return { runId: open, session: next, events: out };
  };

  switch (p.hook_event_name) {
    case "PreToolUse": {
      if (p.agent_id) return keep([{ type: "tool", taskId: p.agent_id, name: p.tool_name, t }]);
      if (AGENT_TOOLS.has(p.tool_name)) {
        const i = p.tool_input ?? {};
        return keep([{
          type: "task_request", toolUseId: p.tool_use_id ?? null, agent: i.subagent_type ?? "general-purpose",
          description: i.description ?? "", prompt: i.prompt ?? "", t
        }]);
      }
      const tool = { type: "tool", taskId: null, name: p.tool_name, t };
      if (p.tool_name === "AskUserQuestion") {
        const questions = normalizeQuestions(p.tool_input);
        return keep([tool, { type: "waiting", kind: "question", text: questions[0]?.question ?? "", questions, t }]);
      }
      if (p.tool_name === "ExitPlanMode") return keep([tool, { type: "waiting", kind: "plan", text: "Aprobar el plan", questions: [], t }]);
      return keep([tool]);
    }
    case "Notification": {
      const permiso = p.notification_type ? p.notification_type === "permission_prompt" : /permission/i.test(p.message ?? "");
      return keep(permiso ? [{ type: "waiting", kind: "permission", text: p.message ?? "", questions: [], t }] : []);
    }
    case "PostToolUse": {
      if (!p.agent_id && WAIT_TOOLS.has(p.tool_name)) return keep([{ type: "waiting_end", answer: answerFrom(p.tool_response, p.tool_name), t }]);
      if (p.agent_id || !AGENT_TOOLS.has(p.tool_name)) return keep([]);
      const r = asObject(p.tool_response);
      if (!r?.agentId || !r.resolvedModel) return keep([]);
      return keep([{
        type: "task_stats", taskId: r.agentId, model: r.resolvedModel, tokens: r.totalTokens ?? null,
        toolUses: r.totalToolUseCount ?? null, durationMs: r.totalDurationMs ?? null, t
      }]);
    }
    case "SubagentStart":
      return keep([{ type: "task_start", taskId: p.agent_id, agent: p.agent_type ?? "general-purpose", description: "", prompt: "", t }]);
    case "SubagentStop": {
      // Lectura completa del transcript: sustituye a las instantáneas en vivo. El estado incremental ya no hace falta.
      const res = keep([
        ...usageEvents("task_usage", ctx.agentUsage, t, { taskId: p.agent_id, snapshot: true }),
        {
          type: "task_end", taskId: p.agent_id, status: "completed", summary: short(p.last_assistant_message, 200),
          result: short(p.last_assistant_message, RESULT_MAX), tokens: null, toolUses: null, durationMs: null, t
        }
      ]);
      if (res.session.agentUsage && p.agent_id in res.session.agentUsage) {
        const rest = { ...res.session.agentUsage };
        delete rest[p.agent_id];
        res.session = { ...res.session, agentUsage: rest };
      }
      return res;
    }
    case "PermissionDenied":
      return keep([{ type: "error", kind: "permission", message: `${p.tool_name ?? "Herramienta"} denegado`, t }]);
    case "Stop":
      // Tareas en segundo plano que no son subagentes del run (shells, monitores) no dejan la ejecución abierta:
      // sin subagentes en marcha la sesión queda parada esperando al usuario. Sin dato (ctx.runningTasks) se asume que sí hay.
      if ((p.background_tasks ?? []).length > 0 && (ctx.runningTasks ?? 1) > 0) return keep([{ type: "thinking", taskId: null, text: "", t }]);
      return close([{ type: "run_end", exitCode: 0, t }]);
    case "StopFailure": {
      const err = p.error === "rate_limit"
        ? { type: "error", kind: "limit", window: null, resetsAt: null, message: "Límite de uso alcanzado", t }
        : { type: "error", kind: "api", message: p.error_details ? `${p.error}: ${p.error_details}` : String(p.error ?? "error"), t };
      return close([err, { type: "run_end", exitCode: 1, t }]);
    }
    case "SessionEnd":
      return close([{ type: "run_end", exitCode: 0, status: "cancelled", t }]);
    default:
      return keep([]);
  }
}

function windowFrom(w) {
  if (!w || w.used_percentage == null) return null;
  return { utilization: Math.round(w.used_percentage * 10) / 1000, resetsAt: w.resets_at ?? null };
}

export function quotaFromStatusline(input, now, profile = "trabajo") {
  const rl = input?.rate_limits;
  if (!rl) return null;
  const fiveHour = windowFrom(rl.five_hour);
  const sevenDay = windowFrom(rl.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const worst = Math.max(fiveHour?.utilization ?? 0, sevenDay?.utilization ?? 0);
  const status = worst >= 1 ? "rejected" : worst >= 0.8 ? "allowed_warning" : "allowed";
  return { type: "quota", status, limitType: null, fiveHour, sevenDay, profile, t: now };
}

const pct = (w) => (w ? Math.round(w.utilization * 100) : null);

export function sameQuota(a, b) {
  if (!a || !b) return false;
  return pct(a.fiveHour) === pct(b.fiveHour) && pct(a.sevenDay) === pct(b.sevenDay);
}
