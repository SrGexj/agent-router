// Precios de la API de Anthropic en USD por millón de tokens (tabla oficial a 2026-10-06).
// Con suscripción no se paga por token: sirve para comparar cuánto "costaría" cada parte.
// Puro y sin dependencias de Node: lo usan el hook y el dashboard.

export const OPUS_REFERENCE = "claude-opus-5-5";

// Escritura de caché: 1,25× la entrada (5 min) y 2× (1 h). Lectura: la del modelo o 0,1× la entrada.
const TABLE = [
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5(?!-\d)/, { input: 5, output: 25 }],
  [/opus-4-(8|7|6|5)/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet-4-6/, { input: 3, output: 15 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5 }],
  [/haiku-4-5/, { input: 1, output: 5 }],
  [/convaiinnovations\/laya/, { input: 0, output: 0 }],
  [/typesafe\/jev/, { input: 0.042, output: 0 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }]
];

// Familia de un modelo para el reparto de gasto: haiku, sonnet u opus (todo lo demás, fable incluido, cuenta como opus).
export function modelFamily(model) {
  if (/haiku/i.test(model ?? "")) return "haiku";
  if (/sonnet/i.test(model ?? "")) return "sonnet";
  return "opus";
}

export function priceFor(model) {
  if (!model) return null;
  const hit = TABLE.find(([re]) => re.test(model));
  if (!hit) return null;
  const p = hit[1];
  return { input: p.input, output: p.output, cacheWrite5m: p.input * 1.25, cacheWrite1h: p.input * 2, cacheRead: p.cacheRead ?? p.input * 0.1 };
}

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// Suma un `usage` con el formato de la API (message.usage del transcript) o uno ya normalizado.
export function addUsage(acc, u) {
  if (!u) return acc;
  if ("input" in u || "output" in u) {
    return {
      input: acc.input + (u.input ?? 0), output: acc.output + (u.output ?? 0), cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
      cacheWrite5m: acc.cacheWrite5m + (u.cacheWrite5m ?? 0), cacheWrite1h: acc.cacheWrite1h + (u.cacheWrite1h ?? 0)
    };
  }
  const split = u.cache_creation;
  const w1h = split?.ephemeral_1h_input_tokens ?? 0;
  const w5m = split ? split.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
  return {
    input: acc.input + (u.input_tokens ?? 0), output: acc.output + (u.output_tokens ?? 0),
    cacheRead: acc.cacheRead + (u.cache_read_input_tokens ?? 0), cacheWrite5m: acc.cacheWrite5m + w5m, cacheWrite1h: acc.cacheWrite1h + w1h
  };
}

export const totalTokens = (u) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h : 0);

export function costOf(model, u) {
  const p = priceFor(model);
  if (!p || !u) return null;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h) / 1_000_000;
}
