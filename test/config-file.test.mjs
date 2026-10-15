import { describe, it, expect } from "vitest";
import { loadConfig, parseConfigEnv, mergeConfigEnv, serializeConfigEnv, pickSupportedEnv, saveConfigEnv, CONFIG_KEYS } from "../src/config.mjs";

const none = () => false;
const fileAt = (path, text) => ({ exists: none, readFile: (p) => { if (p === path) return text; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, warn: () => {} });
const load = (env, file) => loadConfig({ HOME: "/h", ...env }, file);

describe("parseConfigEnv", () => {
  it("lee KEY=VALUE, ignora comentarios y líneas en blanco", () => {
    const r = parseConfigEnv("# hola\n\nROUTER_SEAT_USD=20\n  # otro\nROUTER_PORT=5000\n");
    expect(r.values).toEqual({ ROUTER_SEAT_USD: "20", ROUTER_PORT: "5000" });
    expect(r.warnings).toEqual([]);
  });

  it("quita comillas simples o dobles envolventes y deja el valor literal (sin expansión)", () => {
    const r = parseConfigEnv(`ROUTER_PROFILE_LABEL="Mi cuenta"\nROUTER_PROFILE2_LABEL='Otra'\nCLAUDE_BIN=$HOME/bin/claude\nROUTER_PROFILE2_ARGS=--a "b" $(x)`);
    expect(r.values.ROUTER_PROFILE_LABEL).toBe("Mi cuenta");
    expect(r.values.ROUTER_PROFILE2_LABEL).toBe("Otra");
    expect(r.values.CLAUDE_BIN).toBe("$HOME/bin/claude");
    expect(r.values.ROUTER_PROFILE2_ARGS).toBe('--a "b" $(x)');
  });

  it("permite valor vacío explícito", () => {
    expect(parseConfigEnv("ROUTER_PROFILE2_ARGS=\nROUTER_EFFORT=\"\"").values).toEqual({ ROUTER_PROFILE2_ARGS: "", ROUTER_EFFORT: "" });
  });

  it("avisa de líneas inválidas y las ignora", () => {
    const r = parseConfigEnv("sin igual\nrouter_port=1\nROUTER-X=1\n=3\nROUTER_PORT=4000\nexport ROUTER_EFFORT=high");
    expect(r.values).toEqual({ ROUTER_PORT: "4000" });
    expect(r.warnings).toHaveLength(5);
    expect(r.warnings[0]).toMatch(/línea 1/);
  });

  it("avisa de claves fuera de la lista blanca y las ignora", () => {
    const r = parseConfigEnv("PATH=/x\nNODE_OPTIONS=--inspect\nROUTER_HOME=/otro\nROUTER_SEAT_USD=20");
    expect(r.values).toEqual({ ROUTER_SEAT_USD: "20" });
    expect(r.warnings.map((w) => w.match(/PATH|NODE_OPTIONS|ROUTER_HOME/)[0])).toEqual(["PATH", "NODE_OPTIONS", "ROUTER_HOME"]);
  });

  it("la lista blanca es ROUTER_* conocidas + CLAUDE_BIN, sin ROUTER_HOME", () => {
    expect(CONFIG_KEYS).toContain("CLAUDE_BIN");
    expect(CONFIG_KEYS).toContain("ROUTER_PROFILE2_DIR");
    expect(CONFIG_KEYS).not.toContain("ROUTER_HOME");
    expect(CONFIG_KEYS.every((k) => /^[A-Z0-9_]+$/.test(k))).toBe(true);
  });
});

describe("loadConfig con config.env", () => {
  const path = "/h/.agent-router/config.env";

  it("el archivo aporta valores que el entorno no tiene", () => {
    const c = load({}, fileAt(path, "ROUTER_SEAT_USD=20\nROUTER_PORT=5000\nROUTER_PROFILE2_DIR=/h/.claude-x"));
    expect(c.consumo.seatUsdMonth).toBe(20);
    expect(c.port).toBe(5000);
    expect(c.profiles.second.id).toBe("x");
  });

  it("precedencia: process.env > config.env > defaults", () => {
    const f = fileAt(path, "ROUTER_PORT=5000\nROUTER_SEAT_USD=20");
    const c = load({ ROUTER_PORT: "6000" }, f);
    expect(c.port).toBe(6000);
    expect(c.consumo.seatUsdMonth).toBe(20);
    expect(load({}, fileAt(path, "")).port).toBe(4317);
  });

  it("un vacío explícito en el entorno gana al archivo", () => {
    const c = load({ ROUTER_PROFILE2_ARGS: "" }, fileAt(path, "ROUTER_PROFILE2_DIR=/h/.claude-x\nROUTER_PROFILE2_ARGS=--foo"));
    expect(c.profiles.second.args).toEqual([]);
  });

  it("ROUTER_HOME en el archivo se ignora (con aviso) y el archivo se busca en ROUTER_HOME del entorno", () => {
    const warns = [];
    const f = { ...fileAt("/datos/config.env", "ROUTER_HOME=/otro\nROUTER_PORT=5001"), warn: (m) => warns.push(m) };
    const c = load({ ROUTER_HOME: "/datos" }, f);
    expect(c.home).toBe("/datos");
    expect(c.port).toBe(5001);
    expect(warns.join("\n")).toMatch(/ROUTER_HOME/);
  });

  it("sin archivo se comporta como antes", () => {
    expect(load({}, fileAt(path, "x")).port).toBe(4317);
    expect(load({}, { exists: none, readFile: () => { throw new Error("ENOENT"); }, warn: () => {} }).port).toBe(4317);
  });

  it("los avisos del archivo salen por warn", () => {
    const warns = [];
    load({}, { ...fileAt(path, "PATH=/x"), warn: (m) => warns.push(m) });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(path);
  });
});

describe("fusión del instalador", () => {
  it("pickSupportedEnv toma solo las claves de la lista definidas (incluido vacío)", () => {
    expect(pickSupportedEnv({ ROUTER_SEAT_USD: "20", ROUTER_PROFILE2_ARGS: "", PATH: "/x", ROUTER_HOME: "/h", CLAUDE_BIN: "c" }))
      .toEqual({ ROUTER_SEAT_USD: "20", ROUTER_PROFILE2_ARGS: "", CLAUDE_BIN: "c" });
  });

  it("conserva lo existente, el entorno sobrescribe, y vacío explícito se escribe vacío", () => {
    const merged = mergeConfigEnv({ ROUTER_PORT: "5000", ROUTER_PROFILE2_ARGS: "--x", ROUTER_SEAT_USD: "10" }, { ROUTER_SEAT_USD: "20", ROUTER_PROFILE2_ARGS: "" });
    expect(merged).toEqual({ ROUTER_PORT: "5000", ROUTER_PROFILE2_ARGS: "", ROUTER_SEAT_USD: "20" });
  });

  it("serializa y vuelve a parsear lo mismo", () => {
    const vals = { ROUTER_SEAT_USD: "20", ROUTER_PROFILE2_ARGS: "", ROUTER_PROFILE_LABEL: "Mi cuenta" };
    expect(parseConfigEnv(serializeConfigEnv(vals)).values).toEqual(vals);
  });

  it("saveConfigEnv escribe con 0600, crea la carpeta y devuelve las claves", () => {
    const calls = [];
    const fs = {
      readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      writeFile: (p, t, o) => calls.push(["write", p, t, o]),
      mkdir: (p, o) => calls.push(["mkdir", p, o]),
      chmod: (p, m) => calls.push(["chmod", p, m])
    };
    const r = saveConfigEnv({ home: "/h/.agent-router", env: { ROUTER_SEAT_USD: "20", PATH: "/x" }, fs });
    expect(r).toEqual({ path: "/h/.agent-router/config.env", keys: ["ROUTER_SEAT_USD"], changed: true });
    const w = calls.find((c) => c[0] === "write");
    expect(w[2]).toContain("ROUTER_SEAT_USD=20");
    expect(w[3].mode).toBe(0o600);
    expect(calls).toContainEqual(["chmod", "/h/.agent-router/config.env", 0o600]);
  });

  it("saveConfigEnv sin variables en el entorno y sin archivo no crea nada", () => {
    const fs = { readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, writeFile: () => { throw new Error("no"); }, mkdir: () => {}, chmod: () => {} };
    expect(saveConfigEnv({ home: "/h", env: { PATH: "/x" }, fs })).toEqual({ path: "/h/config.env", keys: [], changed: false });
  });

  it("saveConfigEnv conserva lo existente", () => {
    let written;
    const fs = { readFile: () => "ROUTER_PORT=5000\n", writeFile: (_p, t) => { written = t; }, mkdir: () => {}, chmod: () => {} };
    const r = saveConfigEnv({ home: "/h", env: { ROUTER_SEAT_USD: "20" }, fs });
    expect(parseConfigEnv(written).values).toEqual({ ROUTER_PORT: "5000", ROUTER_SEAT_USD: "20" });
    expect(r.keys).toEqual(["ROUTER_PORT", "ROUTER_SEAT_USD"]);
  });
});
