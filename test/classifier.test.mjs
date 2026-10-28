import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizePrompt, buildClassifierRequest, buildLayaRequest, parseClassifierResponse, createOpenRouterClassifier, createLayaClassifier, createShadowClassifier, CHOICES, DECISIONS_URL, LAYA_MODEL } from "../src/core/classifier.mjs";
import { runShadow } from "../src/core/shadow.mjs";
import { createStore, parseJsonl } from "../src/core/store.mjs";
import { reduceEvents } from "../src/core/reducer.mjs";
import { costOf } from "../src/core/pricing.mjs";
import { loadConfig } from "../src/config.mjs";
import { translateHook } from "../src/core/hooks.mjs";

// Esta fixture sigue la forma documentada por TypeSafe (docs.typesafe.ai): la cuenta de OpenRouter
// no tenía créditos y no se pudo capturar una respuesta real. Sustituirla cuando se pueda.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/jev-response.json", import.meta.url), "utf8"));
// Respuesta real de laya-serve 0.4.7 (checkpoint multilingüe) capturada en 127.0.0.1.
const layaFixture = JSON.parse(readFileSync(new URL("./fixtures/laya-response.json", import.meta.url), "utf8"));
const T = 1_792_000_000_000;

describe("sanitizePrompt", () => {
  it("sustituye los bloques pegados por un marcador con el número de líneas", () => {
    const s = sanitizePrompt('antes <pasted_content id="1">a\nb\nc</pasted_content> después');
    expect(s).toBe("antes [texto pegado: 3 líneas] después");
  });
  it("también sin cierre: se come hasta el final", () => {
    expect(sanitizePrompt("mira <pasted_content x>l1\nl2\nsecreto")).toBe("mira [texto pegado: 3 líneas]");
  });
  it("recorta a 4000 caracteres", () => {
    expect(sanitizePrompt("x".repeat(5000))).toHaveLength(4000);
  });
  it("tolera entradas no textuales", () => {
    expect(sanitizePrompt(undefined)).toBe("");
  });
});

describe("buildClassifierRequest", () => {
  it("pide una pregunta de elección con las 3 opciones del dashboard", () => {
    const r = buildClassifierRequest("Corrige las erratas", "typesafe/jev-1.13");
    expect(r.model).toBe("typesafe/jev-1.13");
    expect(r.state).toBe("Corrige las erratas");
    expect(r.questions.route.type).toBe("choice");
    expect(Object.keys(r.questions.route.criteria)).toEqual(CHOICES);
  });
});

describe("pregunta de ruta", () => {
  const q = buildClassifierRequest("x", "m").questions.route;
  it("no sesga a programación y describe opus como planificar/diseñar/riesgo", () => {
    expect(q.instructions).not.toMatch(/programaci/i);
    for (const k of ["planific", "diseño", "arquitectura", "riesgos", "migraciones", "ambigu"]) expect(q.criteria.opus.toLowerCase()).toContain(k);
  });
  it("programador = código ya decidido; asistente = acotado con criterio claro", () => {
    expect(q.criteria.programador).toMatch(/código ya decidido/);
    expect(q.criteria.asistente).toMatch(/criterio claro/);
  });
});

describe("parseClassifierResponse", () => {
  it("lee la fixture", () => {
    expect(parseClassifierResponse(fixture)).toMatchObject({ choice: "asistente", confidence: 0.97, usage: { input: 312, output: 34 }, costUsd: null });
  });
  it("usa el coste de OpenRouter si viene", () => {
    expect(parseClassifierResponse({ ...fixture, usage: { ...fixture.usage, cost: 0.00001 } }).costUsd).toBe(0.00001);
  });
  it("rechaza respuestas rotas o con elección desconocida", () => {
    for (const bad of [null, "texto", {}, { answers: {} }, { answers: { route: { choice: "gpt" } } }, { answers: { route: { choice: 3 } } }]) {
      expect(() => parseClassifierResponse(bad)).toThrow();
    }
  });
  it("confidence fuera de rango o ausente queda en null", () => {
    expect(parseClassifierResponse({ answers: { route: { choice: "opus", confidence: 7 } } }).confidence).toBeNull();
  });
});

const okFetch = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body });

describe("createOpenRouterClassifier (fetch doble, sin red)", () => {
  const make = (fetch, extra = {}) => createOpenRouterClassifier({ apiKey: "k-secreta", model: "typesafe/jev-1.13", fetch, now: (() => { let n = 0; return () => (n += 5); })(), timeoutMs: 1000, ...extra });

  it("clasifica, calcula latencia y coste a 0,042 $/M de entrada", async () => {
    let seen;
    const c = make(async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => fixture }; });
    const r = await c.classify("Corrige las erratas");
    expect(seen.url).toBe(DECISIONS_URL);
    expect(seen.init.headers.Authorization).toBe("Bearer k-secreta");
    expect(JSON.parse(seen.init.body).questions.route.type).toBe("choice");
    expect(r).toMatchObject({ choice: "asistente", confidence: 0.97, latencyMs: 5, usage: { input: 312, output: 34 } });
    expect(r.costUsd).toBeCloseTo(312 * 0.042 / 1e6, 12);
  });
  it("errores HTTP: mensaje corto sin cuerpo ni clave", async () => {
    for (const status of [402, 429, 500]) {
      const err = await make(okFetch({ error: { message: "k-secreta tu prompt" } }, status)).classify("x").catch((e) => e);
      expect(err.message).toBe(`HTTP ${status}`);
    }
  });
  it("JSON roto", async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } });
    await expect(make(f).classify("x")).rejects.toThrow(/JSON/);
  });
  it("timeout con AbortController", async () => {
    const f = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    await expect(make(f, { timeoutMs: 20 }).classify("x")).rejects.toThrow(/timeout/);
  });
  it("error de red: sin detalles", async () => {
    const f = async () => { throw new Error("connect k-secreta"); };
    const err = await make(f).classify("x").catch((e) => e);
    expect(err.message).toBe("red");
  });
});

describe("precio", () => {
  it("typesafe/jev cuesta 0,042 $/M de entrada y salida gratis", () => {
    expect(costOf("typesafe/jev-1.13", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(0.042, 9);
  });
});

describe("runShadow", () => {
  it("escribe shadow_route en el JSONL y el reducer lo refleja", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shadow-"));
    try {
      const store = createStore({ runsDir: dir });
      await store.append("r1", { type: "run_start", runId: "r1", task: "x", mode: "sesion", model: "opus", t: 0 });
      const ok = { classify: async () => ({ choice: "opus", confidence: 0.6, reason: null, latencyMs: 120, usage: { input: 10, output: 1 }, costUsd: 1e-7 }) };
      await runShadow({ classifier: ok, store, runId: "r1", prompt: "p", model: "m", now: () => T });
      const ko = { classify: async () => { throw new Error("HTTP 402"); } };
      await runShadow({ classifier: ko, store, runId: "r1", prompt: "p", model: "m", now: () => T + 1 });
      const events = parseJsonl(await readFile(join(dir, "r1.jsonl"), "utf8"));
      expect(events[1]).toEqual({ type: "shadow_route", model: "m", choice: "opus", confidence: 0.6, reason: null, latencyMs: 120, costUsd: 1e-7, t: T });
      expect(events[2]).toMatchObject({ type: "shadow_route", model: "m", choice: null, error: "HTTP 402", t: T + 1 });
      expect(reduceEvents(events.slice(0, 2)).shadow).toEqual({ model: "m", choice: "opus", confidence: 0.6, reason: null, latencyMs: 120, costUsd: 1e-7, error: null, t: T });
      expect(reduceEvents(events).shadow).toMatchObject({ choice: null, error: "HTTP 402" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("reducer", () => {
  it("run_start inicia shadow en null", () => {
    expect(reduceEvents([{ type: "run_start", runId: "r", task: "x", mode: "sesion", model: "opus", t: 0 }]).shadow).toBeNull();
  });
});

describe("translateHook pide la sombra solo al abrir una ejecución", () => {
  const mk = (now, short, n) => `r-${short}-${n}`;
  const p = { session_id: "abcdef12-3", hook_event_name: "UserPromptSubmit", prompt: 'hola <pasted_content>a\nb</pasted_content>' };
  it("run_start: devuelve shadow con el prompt saneado", () => {
    const res = translateHook(p, { runId: null, seq: 0 }, T, mk);
    expect(res.shadow).toEqual({ runId: "r-abcdef12-1", prompt: "hola [texto pegado: 2 líneas]" });
  });
  it("mensaje a mitad de turno u otros hooks: sin shadow", () => {
    expect(translateHook(p, { runId: "r", seq: 1 }, T, mk).shadow).toBeUndefined();
    expect(translateHook({ ...p, hook_event_name: "Stop" }, { runId: "r", seq: 1 }, T, mk).shadow).toBeUndefined();
  });
  it("prompt vacío: sin shadow", () => {
    expect(translateHook({ ...p, prompt: "  " }, { runId: null, seq: 0 }, T, mk).shadow).toBeUndefined();
  });
});

describe("config.shadow", () => {
  it("valores por defecto y variables", () => {
    expect(loadConfig({ HOME: "/h" }, { exists: () => false }).shadow).toEqual({ enabled: false, provider: "laya", layaUrl: "http://127.0.0.1:4318/v1/systemone", keyPath: "/h/.agent-router/openrouter.key", model: "typesafe/jev-1.13", timeoutMs: 15000 });
    const c = loadConfig({ HOME: "/h", ROUTER_HOME: "/r", ROUTER_SHADOW: "1", ROUTER_SHADOW_MODEL: "x/y", ROUTER_SHADOW_PROVIDER: "jev", ROUTER_LAYA_URL: "http://127.0.0.1:9/v1/systemone" });
    expect(c.shadow).toMatchObject({ enabled: true, provider: "jev", layaUrl: "http://127.0.0.1:9/v1/systemone", keyPath: "/r/openrouter.key", model: "x/y" });
  });
});

describe("Laya (local)", () => {
  it("buildLayaRequest: estado {body}, checkpoint multilingüe fijado y las mismas 3 opciones", () => {
    const r = buildLayaRequest("Corrige las erratas");
    expect(r.model).toBe(LAYA_MODEL);
    expect(r.state).toEqual({ body: "Corrige las erratas" });
    expect(Object.keys(r.questions.route.criteria)).toEqual(CHOICES);
  });
  it("el parser lee la respuesta real y prefiere x_jev_confidence (la confidence de Laya es entropía)", () => {
    const r = parseClassifierResponse(layaFixture);
    expect(r).toMatchObject({ choice: "programador", confidence: layaFixture.answers.route.x_jev_confidence, usage: { input: 149, output: 0 } });
  });
  const make = (fetch, extra = {}) => createLayaClassifier({ url: "http://127.0.0.1:4318/v1/systemone", fetch, now: (() => { let n = 0; return () => (n += 5); })(), ...extra });
  it("POST sin clave, coste 0 y modelo Laya", async () => {
    let seen;
    const r = await make(async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => layaFixture }; }).classify("hola");
    expect(seen.url).toBe("http://127.0.0.1:4318/v1/systemone");
    expect(seen.init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(seen.init.body).state).toEqual({ body: "hola" });
    expect(r).toMatchObject({ choice: "programador", costUsd: 0, latencyMs: 5, model: LAYA_MODEL });
  });
  it("sin servidor, timeout o HTTP 5xx: laya no disponible", async () => {
    const refused = async () => { throw new Error("ECONNREFUSED"); };
    await expect(make(refused).classify("x")).rejects.toThrow("laya no disponible");
    const slow = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    await expect(make(slow, { timeoutMs: 20 }).classify("x")).rejects.toThrow("laya no disponible");
    await expect(make(okFetch({}, 503)).classify("x")).rejects.toThrow("laya no disponible");
  });
  it("errorKind distingue timeout, conexión, http y parse sin cambiar el mensaje", async () => {
    const kind = async (p) => p.then(() => null, (e) => e.errorKind);
    const refused = async () => { throw new Error("ECONNREFUSED"); };
    const slow = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    expect(await kind(make(refused).classify("x"))).toBe("connection");
    expect(await kind(make(slow, { timeoutMs: 20 }).classify("x"))).toBe("timeout");
    expect(await kind(make(okFetch({}, 503)).classify("x"))).toBe("http");
    expect(await kind(make(okFetch({}, 400)).classify("x"))).toBe("http");
    expect(await kind(make(okFetch({ answers: { route: { choice: "gpt" } } })).classify("x"))).toBe("parse");
    expect(await kind(make(async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } })).classify("x"))).toBe("parse");
    await expect(make(slow, { timeoutMs: 20 }).classify("x")).rejects.toThrow("laya no disponible");
  });
  it("expone el modelo pedido", () => {
    expect(make(async () => ({})).model).toBe(LAYA_MODEL);
    expect(make(async () => ({}), { model: "encargos" }).model).toBe("encargos");
  });
  it("JSON roto o elección inválida: error propio, no 'no disponible'", async () => {
    await expect(make(okFetch({ answers: { route: { choice: "gpt" } } })).classify("x")).rejects.toThrow(/elección/);
  });
  it("timeout por defecto de 5 s", async () => {
    let timer;
    const real = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => { timer = ms; return real(fn, ms, ...a); };
    try { await make(okFetch(layaFixture)).classify("x"); } finally { globalThis.setTimeout = real; }
    expect(timer).toBe(5000);
  });
});

describe("createShadowClassifier elige proveedor por config", () => {
  const deps = { fetch: async () => ({}), now: Date.now };
  const shadow = { provider: "laya", layaUrl: "http://127.0.0.1:4318/v1/systemone", model: "m", timeoutMs: 1000 };
  it("laya no necesita clave", () => {
    expect(createShadowClassifier({ shadow, apiKey: "", ...deps }).classify).toBeTypeOf("function");
  });
  it("jev sin clave: null (no hay nada que hacer)", () => {
    expect(createShadowClassifier({ shadow: { ...shadow, provider: "jev" }, apiKey: "", ...deps })).toBeNull();
    expect(createShadowClassifier({ shadow: { ...shadow, provider: "jev" }, apiKey: "k", ...deps }).classify).toBeTypeOf("function");
  });
  it("laya con layaRoutingModel: la petición lleva ese modelo y el clasificador lo expone", async () => {
    let body;
    const fetch = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ...layaFixture, routing: { model: "encargos" } }) }; };
    const c = createShadowClassifier({ shadow, layaRoutingModel: "encargos", apiKey: "", fetch, now: Date.now });
    expect(c.model).toBe("encargos");
    const r = await c.classify("hola");
    expect(body.model).toBe("encargos");
    expect(r.model).toBe("encargos");
  });
  it("laya sin layaRoutingModel (o vacío): modelo base, como siempre", async () => {
    for (const layaRoutingModel of [undefined, ""]) {
      let body;
      const fetch = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => layaFixture }; };
      const c = createShadowClassifier({ shadow, layaRoutingModel, apiKey: "", fetch, now: Date.now });
      expect(c.model).toBe(LAYA_MODEL);
      await c.classify("hola");
      expect(body.model).toBe(LAYA_MODEL);
    }
  });
  it("proveedor desconocido: null", () => {
    expect(createShadowClassifier({ shadow: { ...shadow, provider: "x" }, apiKey: "k", ...deps })).toBeNull();
  });
});

describe("precio de Laya", () => {
  it("cuesta 0 $", () => {
    expect(costOf(LAYA_MODEL, { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBe(0);
  });
});

describe("modelo desconocido en laya-serve (routing.model)", () => {
  const withRouting = (m) => ({ ...layaFixture, routing: { ...layaFixture.routing, model: m } });
  const make = (fetch, extra = {}) => createLayaClassifier({ url: "u", fetch, now: (() => { let n = 0; return () => (n += 5); })(), ...extra });
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  it("pedido = respondido: sin error y con ese modelo", async () => {
    const r = await make(ok(withRouting("encargos")), { model: "encargos" }).classify("x");
    expect(r.model).toBe("encargos");
    expect(r.errorKind).toBeUndefined();
    expect(r.error).toBeUndefined();
  });
  it("pedido distinto del respondido: guarda el real y marca modelo_desconocido, sin perder la elección", async () => {
    const r = await make(ok(withRouting("multilingual")), { model: "noexiste" }).classify("x");
    expect(r).toMatchObject({ choice: "programador", model: "multilingual", errorKind: "modelo_desconocido" });
    expect(r.error).toMatch(/noexiste.*multilingual/);
  });
  it("sin routing en la respuesta (LAYA_JEV_STRICT) o con modelo por defecto con barra: como antes", async () => {
    const sin = { ...layaFixture, routing: undefined };
    const a = await make(ok(sin), { model: "encargos" }).classify("x");
    expect(a).toMatchObject({ model: "encargos" });
    expect(a.errorKind).toBeUndefined();
    const b = await make(ok(layaFixture)).classify("x");
    expect(b).toMatchObject({ model: LAYA_MODEL });
    expect(b.errorKind).toBeUndefined();
  });
  it("runShadow guarda el modelo real y el errorKind", async () => {
    const events = [];
    const store = { append: async (_id, e) => { events.push(e); } };
    const classifier = make(ok(withRouting("multilingual")), { model: "noexiste" });
    await runShadow({ classifier, store, runId: "r", prompt: "p", model: "noexiste", now: () => 1 });
    expect(events[0]).toMatchObject({ type: "shadow_route", model: "multilingual", choice: "programador", errorKind: "modelo_desconocido" });
    expect(events[0].error).toMatch(/noexiste/);
    const good = [];
    await runShadow({ classifier: make(ok(withRouting("encargos")), { model: "encargos" }), store: { append: async (_i, e) => { good.push(e); } }, runId: "r", prompt: "p", model: "encargos", now: () => 1 });
    expect(good[0].model).toBe("encargos");
    expect(good[0].error).toBeUndefined();
    expect(good[0].errorKind).toBeUndefined();
  });
});

import { buildLayaContext, LAYA_CONTEXT_VERSION } from "../src/core/classifier.mjs";

describe("buildLayaContext", () => {
  it("versión del formato fija y fuera del texto", () => {
    expect(LAYA_CONTEXT_VERSION).toBe("ctx=v1");
    expect(buildLayaContext({ prompt: "hola" })).not.toContain("ctx=v1");
  });
  it("formato exacto con anterior, mensaje primero", () => {
    const t = buildLayaContext({ prompt: "arréglalo", prevTask: "crea el login", prevRoute: "programador" });
    expect(t).toBe("[mensaje] arréglalo\n[anterior] ruta=programador\n[encargo anterior] crea el login");
    expect(t.startsWith("[mensaje] ")).toBe(true);
  });
  it("sin anterior: ruta=sin_anterior y sin línea de encargo", () => {
    expect(buildLayaContext({ prompt: "hola" })).toBe("[mensaje] hola\n[anterior] ruta=sin_anterior");
    expect(buildLayaContext({ prompt: "hola", prevTask: null, prevRoute: "opus" })).toBe("[mensaje] hola\n[anterior] ruta=sin_anterior");
  });
  it("anterior sin ruta conocida: ninguna", () => {
    expect(buildLayaContext({ prompt: "x", prevTask: "y", prevRoute: null })).toBe("[mensaje] x\n[anterior] ruta=ninguna\n[encargo anterior] y");
    expect(buildLayaContext({ prompt: "x", prevTask: "y", prevRoute: "raro" })).toContain("ruta=ninguna");
  });
  it("recorta por la derecha: 1500 / 600 / 600", () => {
    const t = buildLayaContext({ prompt: "a".repeat(2000), prevTask: "b".repeat(900), prevRoute: "opus", prevReply: "c".repeat(900) });
    expect(t).toBe(`[mensaje] ${"a".repeat(1500)}\n[anterior] ruta=opus\n[encargo anterior] ${"b".repeat(600)}\n[orquestador] ${"c".repeat(600)}`);
  });
  it("sanea las tres partes", () => {
    const p = (n) => `<pasted_content id="1">${Array(n).fill("secreto").join("\n")}</pasted_content>`;
    const t = buildLayaContext({ prompt: p(2), prevTask: p(3), prevRoute: "opus", prevReply: p(4) });
    expect(t).not.toContain("secreto");
    expect(t).toContain("[mensaje] [texto pegado: 2 líneas]");
    expect(t).toContain("[encargo anterior] [texto pegado: 3 líneas]");
    expect(t).toContain("[orquestador] [texto pegado: 4 líneas]");
  });
  it("prevReply opcional: sin él no hay línea", () => {
    expect(buildLayaContext({ prompt: "x", prevTask: "y", prevRoute: "opus" })).not.toContain("[orquestador]");
    expect(buildLayaContext({ prompt: "x", prevTask: "y", prevRoute: "opus", prevReply: "" })).not.toContain("[orquestador]");
    expect(buildLayaContext({ prompt: "x", prevTask: "y", prevRoute: "opus", prevReply: "hecho" }).endsWith("\n[orquestador] hecho")).toBe(true);
  });
  it("determinista", () => {
    const a = { prompt: "x", prevTask: "y", prevRoute: "asistente", prevReply: "z" };
    expect(buildLayaContext(a)).toBe(buildLayaContext({ ...a }));
  });
});
