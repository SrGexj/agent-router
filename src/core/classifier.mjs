// Clasificador de "modo sombra": pregunta a un modelo de decisión quién debería llevar la tarea.
// Proveedores intercambiables tras classify(prompt): Laya en local (por defecto) o Jev (TypeSafe, vía OpenRouter).
// Las reglas son puras; la E/S (fetch, reloj, clave) entra por parámetros. Ningún test llama a la red.
import { costOf } from "./pricing.mjs";

export const CHOICES = ["asistente", "programador", "opus"];
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MAX_PROMPT = 4000;
const PRICING_MODEL = "typesafe/jev";
export const LAYA_MODEL = "convaiinnovations/laya-multilingual";
const LAYA_TIMEOUT_MS = 5000;

// Los pegados (con o sin cierre) pueden traer secretos o ruido: solo se conserva cuántas líneas eran.
export function sanitizePrompt(text) {
  const s = typeof text === "string" ? text : "";
  const lines = (body) => body.split("\n").length;
  return s
    .replace(/<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g, (_m, body) => `[texto pegado: ${lines(body)} líneas]`)
    .replace(/<pasted_content\b[^>]*>([\s\S]*)$/, (_m, body) => `[texto pegado: ${lines(body)} líneas]`)
    .slice(0, MAX_PROMPT);
}

const ROUTE_QUESTIONS = {
  route: {
    type: "choice",
    instructions: "¿Qué modelo debe llevar esta tarea: el más capaz para planificar, diseñar o valorar riesgos, o uno menor para ejecutar lo ya decidido?",
    criteria: {
      asistente: "Basta un modelo pequeño (Haiku): encargo acotado con criterio claro de bien/mal, como pasar tests y reportar, cambios de texto o documentación, renombrar, comprobar salidas.",
      programador: "Un modelo medio (Sonnet): escribir código ya decidido, arreglar bugs concretos, refactors localizados. Si falta decidir el enfoque, no es para él.",
      opus: "Hace falta el modelo más capaz (Opus): planificar (más de 3 pasos o varias piezas), diseño y arquitectura, decisiones de producto, valorar riesgos (seguridad, datos, migraciones, rendimiento), revisión delicada de un cambio (autenticación, cifrado, borrados) y tareas ambiguas o abiertas."
    }
  }
};

// Forma nativa de TypeSafe (/v1/systemone), que OpenRouter expone en /api/alpha/decisions.
export function buildClassifierRequest(prompt, model) {
  return { model, state: prompt, questions: ROUTE_QUESTIONS };
}

// Laya (laya-serve) habla el mismo protocolo, pero el estado es un objeto {body}; se fija el checkpoint multilingüe.
export function buildLayaRequest(prompt, model = LAYA_MODEL) {
  return { model, state: { body: prompt }, questions: ROUTE_QUESTIONS };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Tolerante con la forma, estricto con el contenido: sin elección válida no hay resultado.
export function parseClassifierResponse(json) {
  const answers = json?.answers ?? json?.data?.answers;
  const a = answers?.route;
  if (!a || typeof a !== "object") throw new Error("respuesta sin answers.route");
  if (!CHOICES.includes(a.choice)) throw new Error("elección no válida");
  // Laya: `confidence` es entropía normalizada; `x_jev_confidence` es la que Jev daría con las mismas probabilidades.
  const c = num(a.x_jev_confidence) ?? num(a.confidence);
  const u = json.usage ?? json.data?.usage ?? {};
  return {
    choice: a.choice,
    confidence: c != null && c >= 0 && c <= 1 ? c : null,
    reason: typeof a.reason === "string" ? a.reason.slice(0, 200) : null,
    usage: { input: num(u.input_tokens ?? u.prompt_tokens) ?? 0, output: num(u.output_tokens ?? u.completion_tokens) ?? 0 },
    costUsd: num(u.cost ?? u.cost_usd)
  };
}

// POST JSON con timeout. Los fallos de transporte salen con `netMsg` (sin detalles: nunca el cuerpo, el prompt ni la clave).
// El error lleva `errorKind`: "timeout" (abortado por tiempo) o "connection" (cualquier otro fallo de transporte).
async function postJson({ url, headers = {}, body, fetch, timeoutMs, netMsg }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw Object.assign(new Error(netMsg(e), { cause: e }), { errorKind: e?.name === "AbortError" ? "timeout" : "connection" });
  } finally { clearTimeout(timer); }
  return res;
}

async function readJson(res) {
  try { return await res.json(); } catch (e) { throw Object.assign(new Error("JSON no válido", { cause: e }), { errorKind: "parse" }); }
}

// Respuesta sin elección válida: error de contenido (errorKind "parse").
const parseClassifier = (json) => {
  try { return parseClassifierResponse(json); } catch (e) { throw Object.assign(e, { errorKind: "parse" }); }
};

export function createOpenRouterClassifier({ apiKey, model, fetch, now = Date.now, timeoutMs = 15000 }) {
  async function classify(prompt) {
    const t0 = now();
    const res = await postJson({
      url: DECISIONS_URL, headers: { Authorization: `Bearer ${apiKey}` }, body: buildClassifierRequest(prompt, model), fetch, timeoutMs,
      netMsg: (e) => (e?.name === "AbortError" ? `timeout ${timeoutMs} ms` : "red")
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { errorKind: "http" });
    const parsed = parseClassifier(await readJson(res));
    const costUsd = parsed.costUsd ?? costOf(PRICING_MODEL, { input: parsed.usage.input, output: parsed.usage.output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    return { ...parsed, costUsd, latencyMs: now() - t0 };
  }
  return { classify };
}

// laya-serve acepta con 200 un nombre de checkpoint desconocido (sin barra) y responde con el base; lo único que lo delata es
// `routing.model` (el checkpoint que contestó de verdad). Pedido ≠ respondido → el modelo real y un error "modelo_desconocido".
// Sin `routing` (LAYA_JEV_STRICT) o con nombre de repo (lleva barra: su `routing.model` es el alias corto) no se comprueba nada.
export function unknownModel(requested, json) {
  const used = json?.routing?.model;
  if (typeof used !== "string" || !used || requested.includes("/") || used === requested) return {};
  return { model: used, error: `modelo desconocido: pedido ${requested}, respondió ${used}`.slice(0, 120), errorKind: "modelo_desconocido" };
}

// Laya en local: sin clave, coste 0. Servidor caído, lento o con 5xx → "laya no disponible".
// `model`: nombre de un checkpoint registrado en laya-serve (p. ej. vía LAYA_EXTRA_MODELS); por defecto el multilingüe.
export function createLayaClassifier({ url, fetch, now = Date.now, timeoutMs = LAYA_TIMEOUT_MS, model = LAYA_MODEL }) {
  const down = () => new Error("laya no disponible");
  async function classify(prompt) {
    const t0 = now();
    const res = await postJson({ url, body: buildLayaRequest(prompt, model), fetch, timeoutMs, netMsg: () => "laya no disponible" });
    if (!res.ok) throw Object.assign(res.status >= 500 ? down() : new Error(`HTTP ${res.status}`), { errorKind: "http" });
    const json = await readJson(res);
    const parsed = parseClassifier(json);
    return { ...parsed, costUsd: 0, model, ...unknownModel(model, json), latencyMs: now() - t0 };
  }
  return { classify, model };
}

// Elige el proveedor según la config. null = no hay con qué clasificar (p. ej. Jev sin clave).
// `layaRoutingModel`: checkpoint de laya-serve para el enrutado de encargos (solo Laya); vacío = el base.
export function createShadowClassifier({ shadow, apiKey, fetch, now = Date.now, layaRoutingModel = "" }) {
  if (shadow.provider === "laya") return createLayaClassifier({ url: shadow.layaUrl, fetch, now, ...(layaRoutingModel && { model: layaRoutingModel }) });
  if (shadow.provider === "jev" && apiKey) return createOpenRouterClassifier({ apiKey, model: shadow.model, fetch, now, timeoutMs: shadow.timeoutMs });
  return null;
}
