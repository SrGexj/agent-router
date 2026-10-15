// Traduce el stream-json de Claude Code (`claude -p --output-format stream-json --verbose`)
// a eventos propios, estables y pequeños. Guarda el mínimo estado necesario para atribuir
// los mensajes de cada subagente a su encargo (parent_tool_use_id → task_id).

const LIMIT_TEXT = /usage limit|limit reached|rate[ _-]?limit/i;
const AGENT_TOOLS = new Set(["Agent", "Task"]);

function windowOf(info, key) {
  const w = info?.unifiedWindows?.[key];
  return w ? { utilization: w.utilization ?? null, resetsAt: w.resetsAt ?? null } : null;
}

function limitResetFromText(text) {
  const m = /\|(\d{9,})/.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

export function createParser() {
  const taskByToolUse = new Map();
  const modelSeen = new Set();
  const taskModel = new Map(); // taskId → modelo real visto en sus mensajes
  const open = new Set(); // encargos arrancados y aún sin cerrar
  const closed = new Set(); // encargos ya cerrados: un aviso repetido no emite otro task_end
  let mainModel = null;

  function onAssistant(msg, t) {
    const out = [];
    const parent = msg.parent_tool_use_id ?? null;
    const taskId = parent ? taskByToolUse.get(parent) ?? null : null;
    const model = msg.message?.model ?? null;

    if (taskId && model && !modelSeen.has(taskId)) {
      modelSeen.add(taskId);
      taskModel.set(taskId, model);
      out.push({ type: "task_model", taskId, model, t });
    }
    if (!parent && model && model !== mainModel) {
      mainModel = model;
      out.push({ type: "main_model", model, t });
    }

    const before = out.length;
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use") {
        if (!parent && AGENT_TOOLS.has(block.name)) continue;
        out.push({ type: "tool", taskId, name: block.name, t });
      } else if ((block.type === "text" || block.type === "thinking") && !parent) {
        out.push({ type: "thinking", taskId: null, text: block.type === "text" ? block.text ?? "" : "", t });
      }
    }
    // Un mensaje del orquestador que solo delega también es actividad suya.
    if (!parent && out.length === before) out.push({ type: "thinking", taskId: null, text: "", t });
    return out;
  }

  function onSystem(msg, t) {
    switch (msg.subtype) {
      case "task_started":
        if (open.has(msg.task_id)) return [];
        closed.delete(msg.task_id);
        open.add(msg.task_id);
        if (msg.tool_use_id) taskByToolUse.set(msg.tool_use_id, msg.task_id);
        return [{
          type: "task_start",
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id ?? null,
          agent: msg.subagent_type ?? "general-purpose",
          description: msg.description ?? "",
          prompt: msg.prompt ?? "",
          t
        }];
      case "task_notification":
        if (closed.has(msg.task_id)) return [];
        open.delete(msg.task_id);
        closed.add(msg.task_id);
        return [{
          type: "task_end",
          taskId: msg.task_id,
          status: msg.status === "completed" ? "completed" : msg.status === "killed" ? "killed" : "failed",
          summary: msg.summary ?? "",
          ...(taskModel.has(msg.task_id) ? { model: taskModel.get(msg.task_id) } : {}),
          tokens: msg.usage?.total_tokens ?? null,
          toolUses: msg.usage?.tool_uses ?? null,
          durationMs: msg.usage?.duration_ms ?? null,
          t
        }];
      default:
        return [];
    }
  }

  function onRateLimit(msg, t) {
    const info = msg.rate_limit_info ?? {};
    const out = [{
      type: "quota",
      status: info.status ?? "allowed",
      limitType: info.rateLimitType ?? null,
      fiveHour: windowOf(info, "five_hour"),
      sevenDay: windowOf(info, "seven_day"),
      t
    }];
    if (info.status === "rejected") {
      out.push({
        type: "error",
        kind: "limit",
        window: info.rateLimitType ?? null,
        resetsAt: info.resetsAt ?? null,
        message: "Límite de uso alcanzado",
        t
      });
    }
    return out;
  }

  function onResult(msg, t) {
    const out = [];
    const byModel = {};
    for (const [model, u] of Object.entries(msg.modelUsage ?? {})) {
      byModel[model] = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        costUsd: u.costUSD ?? 0
      };
    }
    out.push({ type: "usage", costUsd: msg.total_cost_usd ?? 0, byModel, t });

    for (const d of msg.permission_denials ?? []) {
      out.push({ type: "error", kind: "permission", message: `${d.tool_name ?? "Herramienta"} denegado`, t });
    }
    if (msg.is_error) {
      const text = typeof msg.result === "string" ? msg.result : msg.subtype ?? "Error";
      if (LIMIT_TEXT.test(text)) {
        out.push({ type: "error", kind: "limit", window: null, resetsAt: limitResetFromText(text), message: "Límite de uso alcanzado", t });
      } else {
        out.push({ type: "error", kind: "api", message: text, t });
      }
    }
    return out;
  }

  function push(msg, t) {
    if (!msg || typeof msg !== "object") return [];
    switch (msg.type) {
      case "assistant": return onAssistant(msg, t);
      case "system": return onSystem(msg, t);
      case "rate_limit_event": return onRateLimit(msg, t);
      case "result": return onResult(msg, t);
      default: return [];
    }
  }

  function pushLine(line, t) {
    try {
      return push(JSON.parse(line), t);
    } catch {
      return [];
    }
  }

  return { push, pushLine };
}
