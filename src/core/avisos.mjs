// Avisos del sistema: prompts que no son encargos de la persona (p. ej. un comando o agente en segundo plano
// terminó y se devuelve a la sesión principal). Siempre los procesa el orquestador, así que no se clasifican
// ni sirven para entrenar. Para ampliar la lista, añadir la etiqueta de apertura aquí. Puro.
export const ETIQUETAS_AVISO_SISTEMA = ["<task-notification>"];

export function esAvisoDelSistema(prompt) {
  if (typeof prompt !== "string") return false;
  const inicio = prompt.trimStart();
  return ETIQUETAS_AVISO_SISTEMA.some((etiqueta) => inicio.startsWith(etiqueta));
}

// Texto del encargo de una ejecución (el reducer guarda string; algunos datos antiguos, {task}).
export const esRunAvisoDelSistema = (run) => esAvisoDelSistema(typeof run?.task === "string" ? run.task : run?.task?.task);
