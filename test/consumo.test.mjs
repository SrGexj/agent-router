import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseMonitorSnapshot, summarizeEntries, seatValue, buildProfile, aggregateProfiles, provenanceLabel, forecastVerdict, pickWindows, parseP90View } from "../src/core/consumo.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const once = fixture("monitor-once.json");
const entries = fixture("monitor-entries.json");
const NOW = new Date(2026, 9, 15, 10, 0, 0); // 15 oct 2026, hora local

describe("parseMonitorSnapshot", () => {
  it("lee la salida real de claude-monitor --once --output json", () => {
    const s = parseMonitorSnapshot(once, { profile: "trabajo" });
    expect(s.profile).toBe("trabajo");
    expect(s.toolVersion).toBe("4.0.0");
    expect(s.window5h).toMatchObject({ usedPct: 26.4, resetsAt: 1792051200, source: "claude_code_jsonl", confidence: "local_estimate" });
    expect(s.window5h.tokensUsed).toBe(104141);
    expect(s.current.tokens.total).toBe(29277987);
    expect(s.current.costUsd).toBeCloseTo(73.533422, 4);
    expect(s.current.byModel.map((m) => m.family)).toEqual(["opus", "sonnet"]);
    expect(s.burnRate).toEqual({ tokensPerMinute: expect.any(Number), costPerHour: expect.any(Number) });
    expect(s.forecast).toMatchObject({ exhaustedAt: 1792087250, minutesRemaining: 662.7, confidence: "local_estimate" });
    expect(s.history).toMatchObject({ costUsd: 1885.5169, tokens: 1046330984 });
    expect(s.provenance).toMatchObject({ confidence: "local_estimate", source: "claude_code_jsonl", stale: false });
  });

  it("oculta la ventana de 7 días cuando el monitor no la conoce", () => {
    expect(parseMonitorSnapshot(once).window7d).toBeNull();
  });

  it("conserva la procedencia oficial de la statusline", () => {
    const j = structuredClone(once);
    j.limits.seven_day = { used_percentage: 12.5, resets_at_epoch: 1792500000, source: { kind: "statusline" }, confidence: "official" };
    const s = parseMonitorSnapshot(j);
    expect(s.window7d).toEqual({ usedPct: 12.5, resetsAt: 1792500000, source: "statusline", confidence: "official", tokensUsed: null, tokenLimit: null });
  });

  it("tolera campos ausentes, versiones raras y basura", () => {
    expect(parseMonitorSnapshot(null)).toBeNull();
    expect(parseMonitorSnapshot("hola")).toBeNull();
    const s = parseMonitorSnapshot({ schema_version: "9.9" }, { profile: "x" });
    expect(s).toMatchObject({ profile: "x", window5h: null, window7d: null, burnRate: null, forecast: null, history: null });
    expect(s.current).toBeNull();
    expect(s.provenance.confidence).toBe("unknown");
  });

  it("sin sesión activa no hay bloque actual pero sí histórico", () => {
    const j = structuredClone(once);
    delete j.local;
    delete j.forecast;
    const s = parseMonitorSnapshot(j);
    expect(s.current).toBeNull();
    expect(s.history.costUsd).toBeCloseTo(1885.5169, 3);
  });
});

describe("summarizeEntries", () => {
  const entry = (day, model, o = {}) => ({ day, model, input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 1500, cost_usd: 1, ...o });
  const report = { entries: [
    entry("2026-10-15", "claude-opus-5-5"),
    entry("2026-10-12", "claude-sonnet-5-5"),
    entry("2026-10-09", "claude-opus-5-5"),
    entry("2026-10-01", "claude-haiku-5-5"),
    entry("2026-09-30", "claude-opus-5-5")
  ] };

  it("reparte hoy, últimos 7 días y mes natural, con el día de now", () => {
    const t = summarizeEntries(report, { now: NOW });
    expect(t.today.tokens.total).toBe(1500);
    expect(t.week.tokens.total).toBe(4500); // 15, 12 y 9 oct (hoy-6)
    expect(t.month.tokens.total).toBe(6000);
  });

  it("la semana incluye el día hoy-6 y excluye el anterior", () => {
    const r = { entries: [entry("2026-10-09", "claude-opus-5-5"), entry("2026-10-08", "claude-opus-5-5")] };
    expect(summarizeEntries(r, { now: NOW }).week.tokens.total).toBe(1500);
  });

  it("desglosa por modelo, de más a menos tokens", () => {
    const t = summarizeEntries(report, { now: NOW });
    expect(t.month.byModel[0].model).toBe("claude-opus-5-5");
    expect(t.month.byModel[0].tokens.total).toBe(3000);
    expect(t.month.byModel.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  it("recalcula el coste con los precios del router y guarda el del monitor", () => {
    const r = { entries: [entry("2026-10-15", "claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000, cost_usd: 90 })] };
    const m = summarizeEntries(r, { now: NOW }).month;
    expect(m.costUsd.monitor).toBeCloseTo(90, 6);
    expect(m.costUsd.router).toBeCloseTo(24, 6); // 4 $ entrada + 20 $ salida
    expect(m.costUsd.mixed).toBe(false);
  });

  it("la escritura de caché se cobra como 5 min y la lectura al precio de lectura", () => {
    const r = { entries: [entry("2026-10-15", "claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 1_000_000, cache_read_tokens: 1_000_000, total_tokens: 2_000_000, cost_usd: 0 })] };
    expect(summarizeEntries(r, { now: NOW }).month.costUsd.router).toBeCloseTo(5 + 0.2, 6);
  });

  it("un modelo sin precio usa el coste del monitor y lo marca como mezclado", () => {
    const r = { entries: [entry("2026-10-15", "modelo-raro", { cost_usd: 2.5 })] };
    const m = summarizeEntries(r, { now: NOW }).month;
    expect(m.costUsd).toMatchObject({ router: 2.5, monitor: 2.5, mixed: true });
  });

  it("sin entradas devuelve ceros, no null", () => {
    const t = summarizeEntries({ entries: [] }, { now: NOW });
    expect(t.month.tokens.total).toBe(0);
    expect(t.month.costUsd.router).toBe(0);
    expect(summarizeEntries(null, { now: NOW })).toBeNull();
  });

  it("funciona con la salida real del warehouse", () => {
    const t = summarizeEntries(entries, { now: NOW });
    expect(t.month.tokens.total).toBe(entries.summary.total_tokens);
    expect(t.month.byModel.length).toBe(3);
  });
});

describe("seatValue", () => {
  it("compara el equivalente en API con el precio del seat", () => {
    expect(seatValue({ apiEquivalentUsdMonth: 180, seatUsdMonth: 18 })).toEqual({ ratio: 10, savedUsd: 162 });
  });
  it("si el uso vale menos que el seat, el ahorro es negativo", () => {
    expect(seatValue({ apiEquivalentUsdMonth: 9, seatUsdMonth: 18 })).toEqual({ ratio: 0.5, savedUsd: -9 });
  });
  it("sin precio de seat o sin dato no inventa nada", () => {
    expect(seatValue({ apiEquivalentUsdMonth: 10, seatUsdMonth: 0 })).toEqual({ ratio: null, savedUsd: null });
    expect(seatValue({ apiEquivalentUsdMonth: null, seatUsdMonth: 18 })).toEqual({ ratio: null, savedUsd: null });
  });
});

describe("buildProfile y aggregateProfiles", () => {
  it("une el snapshot, los totales del warehouse y el rendimiento del seat", () => {
    const p = buildProfile({ profile: "trabajo", snapshot: once, entries, now: NOW, seatUsdMonth: 18 });
    expect(p.window5h.usedPct).toBe(26.4);
    expect(p.tokens.month.tokens.total).toBeGreaterThan(0);
    expect(p.seat.ratio).toBeCloseTo(p.tokens.month.costUsd.router / 18, 6);
    expect(p.seat.basis).toBe("router");
  });

  it("sin warehouse no hay totales; el rendimiento sale del histórico local con los precios del monitor", () => {
    const p = buildProfile({ profile: "trabajo", snapshot: once, entries: null, now: NOW, seatUsdMonth: 18 });
    expect(p.tokens).toBeNull();
    expect(p.window5h).not.toBeNull();
    expect(p.seat).toMatchObject({ basis: "history" });
    expect(p.seat.ratio).toBeCloseTo(1885.5169 / 18, 3);
  });

  it("sin warehouse ni histórico no hay rendimiento", () => {
    const j = structuredClone(once);
    delete j.local_history;
    expect(buildProfile({ profile: "t", snapshot: j, entries: null, now: NOW, seatUsdMonth: 18 }).seat).toBeNull();
  });

  it("devuelve null si el monitor no dio snapshot utilizable", () => {
    expect(buildProfile({ profile: "x", snapshot: null, entries: null, now: NOW, seatUsdMonth: 18 })).toBeNull();
  });

  it("suma los perfiles que tienen totales", () => {
    const a = buildProfile({ profile: "a", snapshot: once, entries, now: NOW, seatUsdMonth: 18 });
    const b = buildProfile({ profile: "b", snapshot: once, entries: null, now: NOW, seatUsdMonth: 18 });
    const agg = aggregateProfiles({ a, b });
    expect(agg.month.tokens.total).toBe(a.tokens.month.tokens.total);
    expect(agg.apiEquivalentUsdMonth).toBeCloseTo(a.tokens.month.costUsd.router, 6);
    expect(aggregateProfiles({ b })).toBeNull();
  });
});

describe("provenanceLabel", () => {
  it("dice de dónde sale cada cifra", () => {
    expect(provenanceLabel("official")).toBe("oficial");
    expect(provenanceLabel("local_estimate")).toBe("estimación local");
    expect(provenanceLabel("experimental")).toBe("API experimental");
    expect(provenanceLabel("unknown")).toBe("sin confirmar");
    expect(provenanceLabel(undefined)).toBe("sin confirmar");
    expect(provenanceLabel("otra_cosa")).toBe("otra_cosa");
  });
});

describe("forecastVerdict", () => {
  const win = { resetsAt: 1000 * 60 };
  it("avisa si la ventana se agota antes del reinicio", () => {
    expect(forecastVerdict({ exhaustedAt: 1000, minutesRemaining: 5 }, { resetsAt: 5000 })).toEqual({ kind: "agota", at: 1000 });
  });
  it("si el reinicio llega antes, no se agota", () => {
    expect(forecastVerdict({ exhaustedAt: 9000, minutesRemaining: 600 }, { resetsAt: 5000 })).toEqual({ kind: "no-agota", at: 9000 });
  });
  it("sin hora de reinicio da la previsión tal cual", () => {
    expect(forecastVerdict({ exhaustedAt: 1000, minutesRemaining: 5 }, { resetsAt: null })).toEqual({ kind: "agota", at: 1000 });
  });
  it("sin previsión, null", () => {
    expect(forecastVerdict(null, win)).toBeNull();
    expect(forecastVerdict({ exhaustedAt: null, minutesRemaining: null }, win)).toBeNull();
  });
});

describe("pickWindows: cuota oficial frente a estimación del monitor", () => {
  const mon5 = { usedPct: 8, resetsAt: 9000, confidence: "local_estimate" };
  const mon7 = { usedPct: 3, resetsAt: 99000, confidence: "local_estimate" };
  const quota = { fiveHour: { utilization: 0.23, resetsAt: 8000 }, sevenDay: { utilization: 0.4, resetsAt: 90000 } };
  it("con cuota oficial usa sus valores (fracción a %), etiqueta oficial y sin previsión", () => {
    const r = pickWindows({ window5h: mon5, window7d: mon7 }, quota, 1000);
    expect(r.window5h).toEqual({ usedPct: 23, resetsAt: 8000, confidence: "official" });
    expect(r.window7d).toEqual({ usedPct: 40, resetsAt: 90000, confidence: "official" });
    expect(r.official).toBe(true);
    expect(r.showForecast).toBe(false);
  });
  it("sin cuota oficial deja la estimación del monitor y la previsión", () => {
    const r = pickWindows({ window5h: mon5, window7d: mon7 }, null, 1000);
    expect(r.window5h).toBe(mon5);
    expect(r.window7d).toBe(mon7);
    expect(r.official).toBe(false);
    expect(r.showForecast).toBe(true);
  });
  it("si la oficial solo trae 5 h, no mezcla la de 7 días del monitor", () => {
    const r = pickWindows({ window5h: mon5, window7d: mon7 }, { fiveHour: quota.fiveHour }, 1000);
    expect(r.window5h.confidence).toBe("official");
    expect(r.window7d).toBeNull();
  });
  it("ventana oficial ya reiniciada: 0 % y sin hora", () => {
    const r = pickWindows({ window5h: mon5 }, quota, 8001);
    expect(r.window5h).toEqual({ usedPct: 0, resetsAt: null, confidence: "official" });
  });
  it("cuota sin ventanas útiles cuenta como sin cuota oficial", () => {
    expect(pickWindows({ window5h: mon5 }, { status: "allowed" }, 1).official).toBe(false);
    expect(pickWindows({ window5h: mon5 }, { fiveHour: { utilization: null } }, 1).official).toBe(false);
  });
});

describe("parseP90View: la medición propia del monitor (plan Custom, P90 de los últimos 8 días)", () => {
  it("lee el P90 de tokens, el uso de la sesión actual, el ritmo y la previsión de la fixture real", () => {
    const v = parseP90View(once);
    expect(v).toMatchObject({ plan: "custom", windowHours: 5, sampleHours: 192, available: true, reason: null, active: true, resetAt: 1792051200 });
    expect(v.limits).toEqual({ tokens: 394223, messages: null, costUsd: null });
    expect(v.used.tokens).toBe(104141);
    expect(v.used.messages).toBe(122);
    expect(v.used.costUsd).toBeCloseTo(73.533422, 4);
    expect(v.pct).toEqual({ tokens: 26.4, messages: null, costUsd: null });
    // input+output por minuto = usado / minutos desde session_start hasta generated_at (la base del P90, sin caché)
    expect(v.burnRate.tokensPerMinute).toBeCloseTo(104141 / 238.136, 0);
    expect(v.burnRate.costPerHour).toBeCloseTo(18.5439, 3);
    expect(v.forecast).toEqual({ hitAt: 1792087250, metric: "tokens", beforeReset: false });
    expect(v.provenance).toEqual({ confidence: "local_estimate", source: "claude_code_jsonl", stale: false, plan: "custom" });
  });

  it("parseMonitorSnapshot lo incluye como p90", () => {
    expect(parseMonitorSnapshot(once).p90.limits.tokens).toBe(394223);
  });

  it("la previsión posterior al reinicio no cuenta como alcanzarlo a tiempo", () => {
    const j = structuredClone(once);
    j.forecast.predicted_tokens_exhausted_epoch = 1792050000; // antes del reinicio (1792051200)
    expect(parseP90View(j).forecast).toEqual({ hitAt: 1792050000, metric: "tokens", beforeReset: true });
  });

  it("sin previsión del monitor deja forecast a null", () => {
    const j = structuredClone(once);
    delete j.forecast;
    expect(parseP90View(j).forecast).toBeNull();
  });

  it("con pocos datos el monitor cae a su mínimo (19 000) o a su valor por defecto (44 000): se declara sin P90", () => {
    for (const floor of [19000, 44000]) {
      const j = structuredClone(once);
      j.limits.five_hour.token_limit = floor;
      const v = parseP90View(j);
      expect(v).toMatchObject({ available: false, reason: "pocos-datos" });
      expect(v.limits).toEqual({ tokens: null, messages: null, costUsd: null });
      expect(v.forecast).toBeNull();
    }
  });

  it("si el plan no es Custom, el límite no es un P90 y no se enseña como tal", () => {
    const j = structuredClone(once);
    j.plan = "max5";
    expect(parseP90View(j)).toMatchObject({ plan: "max5", available: false, reason: "plan-no-custom", sampleHours: null });
  });

  it("sin límite en el JSON no hay P90", () => {
    const j = structuredClone(once);
    j.limits.five_hour.token_limit = null;
    expect(parseP90View(j)).toMatchObject({ available: false, reason: "sin-limite" });
  });

  it("sin sesión activa conserva el P90 pero sin uso ni previsión", () => {
    const j = structuredClone(once);
    j.local = { ...j.local, is_active: false, cost_usd: 0, sent_messages: 0, burn_rate_tokens_per_minute: null, burn_rate_cost_per_hour: null };
    j.limits.five_hour = { ...j.limits.five_hour, used_percentage: null, tokens_used: null, resets_at_epoch: null };
    j.forecast = { predicted_tokens_exhausted_epoch: null, minutes_remaining: null };
    const v = parseP90View(j);
    expect(v).toMatchObject({ available: true, active: false, resetAt: null, forecast: null, burnRate: null });
    expect(v.limits.tokens).toBe(394223);
    expect(v.used).toEqual({ tokens: null, messages: null, costUsd: null });
    expect(v.pct.tokens).toBeNull();
  });

  it("una sesión por encima del P90 supera el 100 %", () => {
    const j = structuredClone(once);
    j.limits.five_hour.used_percentage = 131.2;
    expect(parseP90View(j).pct.tokens).toBe(131.2);
  });

  it("tolera basura", () => {
    expect(parseP90View(null)).toBeNull();
    expect(parseP90View("x")).toBeNull();
    expect(parseP90View({})).toMatchObject({ available: false, reason: "sin-limite", plan: null });
  });
});
