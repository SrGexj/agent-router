import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitorSource, discoverProfiles, execRun } from "../server/monitor.mjs";
import { createApp } from "../server/app.mjs";
import { createStore } from "../src/core/store.mjs";

const read = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const ONCE = read("monitor-once.json");
const ENTRIES = read("monitor-entries.json");
const NOW = new Date(2026, 9, 15, 10, 0, 0).getTime();
const PROFILES = { trabajo: "/h/.claude/projects", personal: "/h/.claude-personal/projects" };

// Doble de claude-monitor: responde según los argumentos y apunta cada llamada.
function fakeRun({ onceFor = () => ONCE, entries = ENTRIES, fail } = {}) {
  const calls = [];
  const run = vi.fn(async (bin, args) => {
    calls.push({ bin, args });
    if (fail) return fail(bin, args);
    if (args.includes("entries")) return { stdout: entries, stderr: "", code: 0 };
    const path = args[args.indexOf("--data-paths") + 1];
    return { stdout: onceFor(path), stderr: "", code: 0 };
  });
  return { run, calls };
}
const mk = (o = {}) => {
  const clock = { t: NOW };
  const f = o.run ? { run: o.run, calls: [] } : fakeRun(o);
  const src = createMonitorSource({ run: f.run, now: () => clock.t, bin: "claude-monitor", profiles: PROFILES, refreshMs: 60_000, seatUsdMonth: 18, ...o.opts });
  return { src, clock, ...f };
};

describe("createMonitorSource", () => {
  it("ejecuta el monitor una vez por perfil, apuntando a su carpeta, sin tocar otra cuenta", async () => {
    const { src, calls } = mk();
    const out = await src.get();
    expect(Object.keys(out.profiles).sort()).toEqual(["personal", "trabajo"]);
    expect(calls).toHaveLength(2);
    const paths = calls.map((c) => c.args[c.args.indexOf("--data-paths") + 1]).sort();
    expect(paths).toEqual(["/h/.claude-personal/projects", "/h/.claude/projects"]);
    for (const c of calls) {
      expect(c.bin).toBe("claude-monitor");
      expect(c.args).toEqual(expect.arrayContaining(["--view", "realtime", "--once", "--output", "json"]));
      expect(c.args).not.toContain("--warehouse"); // el warehouse persistente va apagado por defecto
    }
    expect(out).toMatchObject({ seatUsdMonth: 18, refreshMs: 60_000, updatedAt: new Date(NOW).toISOString() });
    expect(out.error).toBeUndefined();
    expect(out.profiles.trabajo.window5h.usedPct).toBe(26.4);
    expect(out.profiles.trabajo.tokens).toBeNull();
  });

  it("pide el snapshot con el plan Custom (P90 propio) aunque el monitor recuerde otro, y expone p90 sin llamadas extra", async () => {
    const { src, calls } = mk();
    const out = await src.get();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.args.slice(c.args.indexOf("--plan"), c.args.indexOf("--plan") + 2)).toEqual(["--plan", "custom"]);
    expect(out.profiles.trabajo.p90).toMatchObject({ available: true, sampleHours: 192, limits: { tokens: 394223 } });
  });

  it("con warehouse, el plan Custom va solo en las llamadas realtime y no se añaden llamadas", async () => {
    const { src, calls } = mk({ opts: { warehouseDir: "/w" } });
    await src.get();
    const rt = calls.filter((c) => c.args.includes("realtime"));
    expect(rt.length).toBeGreaterThan(0);
    for (const c of rt) expect(c.args).toEqual(expect.arrayContaining(["--plan", "custom"]));
    expect(calls.filter((c) => c.args.includes("entries")).every((c) => !c.args.includes("--plan"))).toBe(true);
    expect(calls).toHaveLength(2 * 3); // calentamiento + entries + realtime por perfil, igual que antes
  });

  it("guarda en caché refreshMs y la renueva después", async () => {
    const { src, clock, run } = mk();
    await src.get();
    await src.get();
    expect(run).toHaveBeenCalledTimes(2);
    clock.t += 59_000;
    await src.get();
    expect(run).toHaveBeenCalledTimes(2);
    clock.t += 2_000;
    await src.get();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("no solapa ejecuciones: las peticiones simultáneas comparten una", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const run = vi.fn(async () => { await gate; return { stdout: ONCE, stderr: "", code: 0 }; });
    const { src } = mk({ run });
    const a = src.get();
    const b = src.get();
    const c = src.get();
    await Promise.resolve();
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
  });

  it("si el monitor no está instalado devuelve error y no lanza", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("spawn claude-monitor ENOENT"), { code: "ENOENT" }); });
    const { src } = mk({ run });
    const out = await src.get();
    expect(out.profiles).toEqual({});
    expect(out.error.code).toBe("no-instalado");
    expect(out.error.message).toMatch(/pip install|claude-monitor/);
  });

  it("detecta un monitor anterior a la 4.0 (sin --once)", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "claude-monitor: error: unrecognized arguments: --once --output json", code: 2 }));
    const out = await mk({ run }).src.get();
    expect(out.error.code).toBe("version");
    expect(out.error.message).toMatch(/4\./);
  });

  it("un timeout se informa como error", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }); });
    expect((await mk({ run }).src.get()).error.code).toBe("timeout");
  });

  it("una salida que no es JSON no tumba nada", async () => {
    const run = vi.fn(async () => ({ stdout: "<<basura>>", stderr: "", code: 0 }));
    const out = await mk({ run }).src.get();
    expect(out.error.code).toBe("fallo");
    expect(out.profiles).toEqual({});
  });

  it("un perfil sin datos (código 30) se oculta sin error", async () => {
    const f = fakeRun();
    const run = vi.fn(async (bin, args) => {
      const path = args[args.indexOf("--data-paths") + 1];
      if (path.includes("personal")) return { stdout: "", stderr: "No usage data available yet.", code: 30 };
      return f.run(bin, args);
    });
    const out = await mk({ run }).src.get();
    expect(Object.keys(out.profiles)).toEqual(["trabajo"]);
    expect(out.error).toBeUndefined();
  });

  it("acepta los códigos de salida 10, 11 y 20 con JSON válido", async () => {
    const run = vi.fn(async () => ({ stdout: ONCE, stderr: "", code: 11 }));
    const out = await mk({ run }).src.get();
    expect(Object.keys(out.profiles)).toHaveLength(2);
  });

  it("si falla un perfil y otro no, devuelve el bueno y anota el fallo", async () => {
    const f = fakeRun();
    const run = vi.fn(async (bin, args) => {
      if (args.includes("/h/.claude-personal/projects")) throw Object.assign(new Error("boom"), { code: "EACCES" });
      return f.run(bin, args);
    });
    const out = await mk({ run }).src.get();
    expect(Object.keys(out.profiles)).toEqual(["trabajo"]);
    expect(out.error).toBeUndefined();
    expect(out.profileErrors.personal.code).toBe("fallo");
  });

  it("el error no se queda cacheado todo el minuto: reintenta antes", async () => {
    let n = 0;
    const run = vi.fn(async () => {
      if (n++ < 2) throw Object.assign(new Error("x"), { code: "ENOENT" });
      return { stdout: ONCE, stderr: "", code: 0 };
    });
    const { src, clock } = mk({ run });
    expect((await src.get()).error).toBeDefined();
    clock.t += 11_000;
    const out = await src.get();
    expect(out.error).toBeUndefined();
  });

  it("sin perfiles configurados informa del motivo", async () => {
    const out = await createMonitorSource({ run: vi.fn(), now: () => NOW, bin: "x", profiles: {}, refreshMs: 1000, seatUsdMonth: 18 }).get();
    expect(out.error.code).toBe("sin-perfiles");
  });

  describe("con el warehouse activado", () => {
    const opts = { warehouseDir: "/w" };
    it("la primera vez escribe el warehouse y lo lee, y deja la vista del monitor en realtime", async () => {
      const { src, calls } = mk({ opts });
      const out = await src.get();
      const mine = calls.filter((c) => c.args.includes("/h/.claude/projects") || c.args.includes("/w/trabajo.json"));
      const kinds = mine.map((c) => (c.args.includes("entries") ? "entries" : c.args.includes("--warehouse") ? "snapshot+wh" : "snapshot"));
      expect(kinds).toEqual(["snapshot+wh", "entries", "snapshot+wh"]);
      expect(mine.find((c) => c.args.includes("--warehouse")).args).toEqual(expect.arrayContaining(["--warehouse-file", "/w/trabajo.json"]));
      expect(out.profiles.trabajo.tokens.month.tokens.total).toBeGreaterThan(0);
      expect(out.profiles.trabajo.seat.ratio).toBeGreaterThan(0);
      expect(out.warehouse).toBe(true);
      expect(out.aggregate.apiEquivalentUsdMonth).toBeGreaterThan(0);
    });

    it("después lee el warehouse antes de actualizarlo y termina siempre en realtime", async () => {
      const { src, clock, calls } = mk({ opts });
      await src.get();
      calls.length = 0;
      clock.t += 61_000;
      await src.get();
      const kinds = calls.filter((c) => c.args.includes("/w/trabajo.json") || c.args.includes("/h/.claude/projects"))
        .map((c) => (c.args.includes("entries") ? "entries" : c.args.includes("--warehouse") ? "snapshot+wh" : "snapshot"));
      expect(kinds).toEqual(["entries", "snapshot+wh"]);
    });

    it("si falla el informe de entradas, el perfil sigue con sus ventanas", async () => {
      const f = fakeRun();
      const run = vi.fn(async (bin, args) => {
        if (args.includes("entries")) return { stdout: "no json", stderr: "", code: 30 };
        return f.run(bin, args);
      });
      const out = await mk({ run, opts }).src.get();
      expect(out.profiles.trabajo.window5h).not.toBeNull();
      expect(out.profiles.trabajo.tokens).toBeNull();
    });
  });
});

describe("execRun", () => {
  it("devuelve stdout y el código de salida aunque sea distinto de 0", async () => {
    const r = await execRun(process.execPath, ["-e", "console.log('hola'); process.exit(10)"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ stdout: "hola\n", code: 10 });
  });
  it("rechaza con ENOENT si el binario no existe", async () => {
    await expect(execRun("/no/existe/claude-monitor-xx", [], { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("mata el proceso al pasar el timeout", async () => {
    await expect(execRun(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 150 })).rejects.toMatchObject({ killed: true });
  });
});

describe("GET /api/consumo", () => {
  it("devuelve el resultado del monitor", async () => {
    const { src } = mk();
    const app = createApp({ store: createStore({ runsDir: "/nada" }), monitor: src });
    const res = await request(app).get("/api/consumo").expect(200);
    expect(Object.keys(res.body.profiles).sort()).toEqual(["personal", "trabajo"]);
    expect(res.body.seatUsdMonth).toBe(18);
    expect(res.body.updatedAt).toBeTypeOf("string");
  });

  it("con el monitor roto responde 200 con error, no 500", async () => {
    const run = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); });
    const app = createApp({ store: createStore({ runsDir: "/nada" }), monitor: mk({ run }).src });
    const res = await request(app).get("/api/consumo").expect(200);
    expect(res.body.error.code).toBe("no-instalado");
    expect(res.body.profiles).toEqual({});
  });

  it("si la fuente lanza por un bug, tampoco tumba el servidor", async () => {
    const app = createApp({ store: createStore({ runsDir: "/nada" }), monitor: { get: async () => { throw new Error("bug"); } } });
    const res = await request(app).get("/api/consumo").expect(200);
    expect(res.body.error.code).toBe("fallo");
  });

  it("sin monitor configurado lo dice", async () => {
    const res = await request(createApp({ store: createStore({ runsDir: "/nada" }) })).get("/api/consumo").expect(200);
    expect(res.body.error.code).toBe("desactivado");
  });
});

describe("discoverProfiles", () => {
  it("encuentra ~/.claude como trabajo y ~/.claude-X como X, solo si tienen projects", async () => {
    const home = await mkdtemp(join(tmpdir(), "router-prof-"));
    try {
      await mkdir(join(home, ".claude/projects"), { recursive: true });
      await mkdir(join(home, ".claude-personal/projects"), { recursive: true });
      await mkdir(join(home, ".claude-vacio"), { recursive: true });
      await mkdir(join(home, ".config"), { recursive: true });
      expect(discoverProfiles(home)).toEqual({
        trabajo: join(home, ".claude/projects"),
        personal: join(home, ".claude-personal/projects")
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("incluye carpetas extra (ROUTER_PROFILE2_DIR) fuera de ~/.claude-*, con su id", async () => {
    const home = await mkdtemp(join(tmpdir(), "router-prof-"));
    try {
      await mkdir(join(home, ".claude/projects"), { recursive: true });
      await mkdir(join(home, "cuentas/trabajo2/projects"), { recursive: true });
      await mkdir(join(home, "cuentas/sin-projects"), { recursive: true });
      expect(discoverProfiles(home, [join(home, "cuentas/trabajo2"), join(home, "cuentas/sin-projects"), null])).toEqual({
        trabajo: join(home, ".claude/projects"),
        trabajo2: join(home, "cuentas/trabajo2/projects")
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("una carpeta inexistente da un objeto vacío", () => {
    expect(discoverProfiles("/no/existe/de/verdad")).toEqual({});
  });
});
