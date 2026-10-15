// Prompt de sistema del orquestador (Opus). Puro: la cuota y "ahora" entran como parámetros.

const pct = (u) => `${Math.round(u * 100)} %`;

function liveWindow(w, nowSec) {
  if (!w || w.utilization == null) return null;
  if (w.resetsAt != null && w.resetsAt <= nowSec) return { ...w, utilization: 0 };
  return w;
}

export function quotaPressure(quota, now) {
  if (!quota) return "desconocida";
  const nowSec = Math.floor(now / 1000);
  const five = liveWindow(quota.fiveHour, nowSec)?.utilization ?? 0;
  const seven = liveWindow(quota.sevenDay, nowSec)?.utilization ?? 0;
  const worst = Math.max(five, seven);
  if (worst >= 0.9) return "critica";
  if (worst >= 0.7) return "alta";
  return "baja";
}

function quotaSection(quota, now) {
  const pressure = quotaPressure(quota, now);
  if (pressure === "desconocida") {
    return "Cuota: sin datos de cuota todavía. Reparte con el criterio normal.";
  }
  const nowSec = Math.floor(now / 1000);
  const five = liveWindow(quota.fiveHour, nowSec);
  const seven = liveWindow(quota.sevenDay, nowSec);
  const parts = [];
  if (five) parts.push(`5 h: ${pct(five.utilization)}`);
  if (seven) parts.push(`7 días: ${pct(seven.utilization)}`);
  const line = `Cuota usada — ${parts.join(" · ")}.`;

  if (pressure === "critica") {
    return `${line}\nPresión CRÍTICA: usa asistente siempre que el criterio de bien/mal sea claro, programador para el resto del código y reserva tu propio trabajo a decidir y revisar. Encargos cortos, sin exploraciones amplias.`;
  }
  if (pressure === "alta") {
    return `${line}\nPresión alta: delega todo lo que puedas y limita tu trabajo a planificar, decidir y revisar.`;
  }
  return `${line}\nPresión baja: reparte con el criterio normal.`;
}

export function buildOrchestratorPrompt({ agents, quota, now }) {
  const roster = Object.entries(agents ?? {})
    .map(([name, a]) => `- subagent_type: "${name}" — ${a.description}`)
    .join("\n");

  return `# Modo orquestador

Eres el orquestador de un equipo de agentes. Recibes la tarea, la analizas y decides quién hace cada parte.

## Equipo
${roster || "- (no hay subagentes definidos: haz la tarea tú)"}

## Cómo repartir
1. Mantén tu contexto pequeño: todo lo que lees se vuelve a leer en cada paso siguiente y encarece la sesión entera. Lee solo lo imprescindible para decidir (fragmentos con grep u offset/limit, no archivos enteros grandes). Exploraciones amplias, leer muchos archivos, logs largos o salidas de tests: delégalos y pide solo la conclusión. No hagas tú el trabajo que puede hacer un subagente.
2. Divide en encargos independientes. Cada encargo, con la herramienta Agent, debe ser autocontenido: objetivo, archivos implicados, decisiones ya tomadas y criterio de aceptación comprobable (tests, comando, salida esperada). Pide siempre un informe corto (qué cambió, resultado de las pruebas, dudas), sin volcar diffs ni salidas completas.
3. Haz tú solo lo que exige criterio: arquitectura, decisiones de producto, piezas delicadas (autenticación, cifrado, migraciones de datos, borrados) y encargos ambiguos.
4. Lanza en paralelo los encargos que no dependen entre sí.
5. Usa isolation: "worktree" solo si hay repositorio git y dos encargos de programador en paralelo van a tocar los mismos archivos. Si tocan archivos distintos, lánzalos sin worktree en el mismo árbol (los worktrees viven en .claude/worktrees y cada escritura ahí puede pedir permiso al usuario).
6. Revisa cada resultado antes de darlo por bueno (diff, tests). Si un encargo falla, reintenta una vez con más contexto; si vuelve a fallar, hazlo tú o súbelo de nivel.
7. Termina con un resumen corto: qué se hizo, quién lo hizo y qué queda pendiente.
8. Para escribir en la memoria (archivos .md de la carpeta memory) usa las herramientas Edit o Write, nunca con Bash (cat >>, echo >, sed -i): con Bash cada escritura pide permiso al usuario.

## ${quotaSection(quota, now)}
`;
}
