// Reducer puro: eventos normalizados → estado de una ejecución.
// Se usa igual en el servidor y en el dashboard (sin dependencias de Node).

import { addUsage, emptyUsage } from "./pricing.mjs";

export const WORKERS = ["asistente", "programador"];
const ROUTE_LABELS = ["asistente", "programador", "opus"];

// Subagentes que no son de los roles (Explore, general-purpose, Plan...): cuelgan del orquestador.
export const OWN = "propio";

// Nodo de un encargo según el tipo de subagente. Solo "asistente" y "programador" van a sus nodos; cualquier otro
// tipo es del orquestador. Sin tipo (ejecuciones antiguas) se decide por el modelo, como antes.
export function nodeFor(agent, model) {
  if (WORKERS.includes(agent)) return agent;
  if (agent) return OWN;
  if (model && /haiku/i.test(model)) return "asistente";
  return "programador";
}

function withTask(run, taskId, patch) {
  const prev = run.tasks[taskId] ?? {
    id: taskId, agent: "general-purpose", node: "programador", description: "", prompt: "",
    status: "running", startedAt: null, endedAt: null, model: null, summary: "", result: "", usage: null, error: null,
    tokens: null, toolUses: null, durationMs: null, tools: 0, lastToolAt: null
  };
  const known = taskId in run.tasks;
  return {
    ...run,
    tasks: { ...run.tasks, [taskId]: { ...prev, ...patch } },
    taskOrder: known ? run.taskOrder : [...run.taskOrder, taskId]
  };
}

// Suma dos { [modelo]: uso } (varios eventos de uso para la misma pieza).
function mergeByModel(a, b) {
  const out = { ...(a ?? {}) };
  for (const [model, u] of Object.entries(b ?? {})) out[model] = addUsage(out[model] ?? emptyUsage(), u);
  return out;
}

// Actividad del orquestador que demuestra que ya no espera al usuario. Lo que hagan los
// subagentes en segundo plano (taskId) no cuenta: pueden seguir mientras la pregunta está abierta.
const CLEARS_WAITING = new Set(["tool", "task_request", "thinking", "run_end"]);

export function reduceRun(run, ev) {
  if (!ev) return run;
  if (ev.type === "run_start") {
    return {
      id: ev.runId, task: ev.task, mode: ev.mode, model: ev.model, cwd: ev.cwd ?? null, profile: ev.profile ?? "trabajo",
      status: "running", startedAt: ev.t, endedAt: null, exitCode: null,
      mainModel: null, orchestratorActiveAt: null, lastText: "",
      tasks: {}, taskOrder: [], pending: [], quota: null, usage: null, orchestratorUsage: null, errors: [], limit: null,
      waiting: null, asked: [], shadow: null, updatedAt: ev.t
    };
  }
  if (!run) return null;
  const cleared = (CLEARS_WAITING.has(ev.type) && !ev.taskId) || (ev.type === "error" && ev.kind === "permission");
  const base = { ...run, updatedAt: ev.t, ...(cleared ? { waiting: null } : {}) };

  switch (ev.type) {
    case "main_model":
      return { ...base, mainModel: ev.model };
    case "thinking":
      return { ...base, orchestratorActiveAt: ev.t, lastText: ev.text || base.lastText };
    case "tool": {
      if (!ev.taskId) return { ...base, orchestratorActiveAt: ev.t };
      const prev = base.tasks[ev.taskId];
      return withTask(base, ev.taskId, { lastToolAt: ev.t, tools: (prev?.tools ?? 0) + 1 });
    }
    case "task_request":
      return {
        ...base,
        pending: [...(base.pending ?? []), {
          agent: ev.agent, description: ev.description, prompt: ev.prompt,
          ...(ev.attempt != null ? { attempt: ev.attempt } : {}),
          ...(ev.previousAgent ? { previousAgent: ev.previousAgent } : {}),
          ...(ev.escalated ? { escalated: true } : {})
        }]
      };
    case "task_start": {
      // Los hooks no traen la descripción en SubagentStart: se toma de la llamada a Agent pendiente. Si un hook reescribió
      // el subagent_type no coincide ninguna: se toma la más antigua y se anota qué agente se pidió.
      let { description, prompt } = ev;
      let pending = base.pending ?? [];
      let extra = {};
      if (!description) {
        let i = pending.findIndex((r) => r.agent === ev.agent);
        const rewritten = i < 0 && pending.length > 0;
        if (rewritten) i = 0;
        if (i >= 0) {
          const { agent: requested, description: d, prompt: pr, ...retry } = pending[i];
          ({ description, prompt } = { description: d, prompt: pr });
          extra = { ...retry, ...(rewritten ? { requestedAgent: requested } : {}) };
          pending = pending.filter((_, j) => j !== i);
        }
      }
      const node = nodeFor(ev.agent, ev.model);
      return withTask({ ...base, pending }, ev.taskId, {
        agent: ev.agent, node, description,
        prompt, status: "running", startedAt: ev.t, ...extra, ...(ev.model ? { model: ev.model } : {})
      });
    }
    case "task_model": {
      const prev = base.tasks[ev.taskId];
      const node = nodeFor(prev?.agent, ev.model);
      return withTask(base, ev.taskId, { model: ev.model, node });
    }
    case "task_stats": {
      const prev = base.tasks[ev.taskId];
      const node = nodeFor(prev?.agent, ev.model);
      return withTask(base, ev.taskId, {
        model: ev.model, node, tokens: ev.tokens ?? prev?.tokens ?? null,
        toolUses: ev.toolUses ?? prev?.toolUses ?? null, durationMs: ev.durationMs ?? prev?.durationMs ?? null
      });
    }
    case "task_end":
      // Un cierre sin arranque (agentes internos de Claude Code en datos antiguos) no es un encargo.
      if (!(ev.taskId in base.tasks)) return base;
      return withTask(base, ev.taskId, {
        status: ev.status, endedAt: ev.t, error: ev.error ?? null, ...(ev.model ? { model: ev.model } : {}), summary: ev.summary ?? "", result: ev.result ?? base.tasks[ev.taskId]?.result ?? "",
        tokens: ev.tokens ?? base.tasks[ev.taskId]?.tokens ?? null,
        toolUses: ev.toolUses ?? base.tasks[ev.taskId]?.toolUses ?? null,
        durationMs: ev.durationMs ?? base.tasks[ev.taskId]?.durationMs ?? null
      });
    case "waiting":
      return {
        ...base, waiting: { kind: ev.kind, text: ev.text ?? "", questions: ev.questions ?? [], t: ev.t },
        asked: [...(base.asked ?? []), { kind: ev.kind, text: ev.text ?? "", answer: null, answeredAt: null, t: ev.t }]
      };
    case "waiting_end": {
      const asked = [...(base.asked ?? [])];
      const i = asked.findLastIndex((a) => a.answeredAt == null);
      if (i >= 0) asked[i] = { ...asked[i], answer: ev.answer ?? null, answeredAt: ev.t };
      return { ...base, waiting: null, asked };
    }
    case "task_usage":
      // snapshot: instantánea acumulada del transcript del subagente (sustituye); sin ella, suma.
      return withTask(base, ev.taskId, { usage: ev.snapshot ? { ...(ev.byModel ?? {}) } : mergeByModel(base.tasks[ev.taskId]?.usage, ev.byModel) });
    case "orchestrator_usage":
      // Instantánea acumulada desde el inicio de la ejecución (se emite varias veces para el gasto en vivo).
      return { ...base, orchestratorUsage: ev.byModel ?? null };
    case "shadow_route":
      return {
        ...base, shadow: {
          model: ev.model ?? null, choice: ev.choice ?? null, confidence: ev.confidence ?? null, reason: ev.reason ?? null,
          latencyMs: ev.latencyMs ?? null, costUsd: ev.costUsd ?? null, error: ev.error ?? null, t: ev.t,
          ...(ev.na ? { na: true } : {})
        }
      };
    case "route_label":
      // Corrección manual de quién debía llevar la tarea (para entrenar a Laya). null la quita.
      if (ev.label !== null && !ROUTE_LABELS.includes(ev.label)) return run;
      return { ...base, routeLabel: ev.label === null ? null : { label: ev.label, t: ev.t } };
    case "compact":
      return { ...base, compactions: [...(base.compactions ?? []), { trigger: ev.trigger ?? null, pendingCount: ev.pendingCount ?? 0, t: ev.t }] };
    case "context":
      // Contexto actual (último turno) según la statusline; se sobrescribe en cada cambio.
      // Los eventos por turno (del transcript) llevan `turn`: uno ya visto no cambia nada (releer no duplica ni retrocede).
      if (ev.turn != null && ev.turn <= (run.context?.turn ?? 0)) return run;
      const turn = ev.turn ?? run.context?.turn;
      return {
        ...base,
        context: { tokens: ev.tokens, model: ev.model ?? null, window: ev.window ?? run.context?.window ?? null, ...(turn != null ? { turn } : {}), t: ev.t }
      };
    case "compact_stats": {
      // Datos del límite de compactación leídos del transcript; upsert por id (el mismo límite puede llegar dos veces).
      const byId = new Map((base.compactStats ?? []).map((c) => [c.id, c]));
      for (const r of ev.records ?? []) byId.set(r.id, { ...(byId.get(r.id) ?? {}), ...r });
      return { ...base, compactStats: [...byId.values()] };
    }
    case "quota":
      return { ...base, quota: { status: ev.status, limitType: ev.limitType ?? null, fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, t: ev.t } };
    case "usage":
      return { ...base, usage: { costUsd: ev.costUsd, byModel: ev.byModel } };
    case "error": {
      const errors = [...base.errors, { kind: ev.kind, message: ev.message, t: ev.t }];
      const limit = ev.kind === "limit" ? { resetsAt: ev.resetsAt ?? null, window: ev.window ?? null } : base.limit;
      return { ...base, errors, limit };
    }
    case "run_end": {
      let status = ev.status === "cancelled" ? "cancelled" : ev.exitCode === 0 ? "completed" : "failed";
      if (base.limit && status !== "cancelled") status = "limited";
      const tasks = { ...base.tasks };
      for (const id of base.taskOrder) {
        if (tasks[id].status === "running") tasks[id] = { ...tasks[id], status: "failed", endedAt: ev.t };
      }
      return { ...base, tasks, status, endedAt: ev.t, exitCode: ev.exitCode ?? null };
    }
    default:
      return run;
  }
}

export function reduceEvents(events, initial = null) {
  return events.reduce(reduceRun, initial);
}
