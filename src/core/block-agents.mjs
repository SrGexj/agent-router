// Bloqueo de subagentes que heredan el modelo del orquestador (Opus). Puro: la lista entra como parámetro.
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Sin subagent_type, Claude Code usa general-purpose.
const agentOf = (p) => String(p.tool_input?.subagent_type || "general-purpose");

// Devuelve { agent, reason } si el PreToolUse debe denegarse, o null.
export function decideBlock(payload, blockedAgents) {
  if (payload?.hook_event_name !== "PreToolUse" || !AGENT_TOOLS.has(payload.tool_name)) return null;
  if (!blockedAgents?.length) return null;
  const agent = agentOf(payload);
  if (!blockedAgents.some((b) => b.toLowerCase() === agent.toLowerCase())) return null;
  return {
    agent,
    reason: `Bloqueado por agent-router: ${agent} corre en Opus. Relanza con subagent_type "asistente" (Haiku: docs, web, navegador, comprobaciones) o "programador" (Sonnet: código). Si hace falta Opus, usa subagent_type "consultor" (Opus, solo lectura: decisiones de diseño o riesgo). Para otro uso de Opus, pídeselo al usuario.`
  };
}

export const blockEvent = (payload, agent, t) => ({ type: "task_blocked", agent, description: payload.tool_input?.description ?? "", t });

export const denyOutput = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
