import { describe, it, expect } from "vitest";
import { loadConfig, profileIdFromDir, CONFIG_KEYS } from "../src/config.mjs";

const none = () => false;
const only = (...paths) => (p) => paths.includes(p);
const load = (env, exists = none) => loadConfig({ HOME: "/h", ...env }, { exists });

describe("perfiles", () => {
  it("por defecto: un solo perfil, ~/.claude, etiqueta Principal", () => {
    const c = load({});
    expect(c.profiles.default).toEqual({ id: "trabajo", label: "Principal", dir: "/h/.claude", browserId: null });
    expect(c.profiles.second).toBeNull();
    expect(c.profileLabels).toEqual({ trabajo: "Principal" });
    expect(c.profile).toBe("trabajo");
    expect(c.profileAlias).toBe("co");
  });

  it("segundo perfil por variables: dir, etiqueta, alias y argumentos", () => {
    const c = load({ ROUTER_PROFILE2_DIR: "/h/.claude-cliente", ROUTER_PROFILE2_LABEL: "Cliente", ROUTER_PROFILE2_ALIAS: "coc", ROUTER_PROFILE2_ARGS: "--foo bar", ROUTER_PROFILE_LABEL: "Mío" });
    expect(c.profiles.second).toEqual({ id: "cliente", label: "Cliente", dir: "/h/.claude-cliente", alias: "coc", args: ["--foo", "bar"], browserId: null });
    expect(c.profileLabels).toEqual({ trabajo: "Mío", cliente: "Cliente" });
  });

  it("segundo perfil con valores por defecto genéricos (etiqueta = id, alias cop, sin argumentos)", () => {
    const c = load({ ROUTER_PROFILE2_DIR: "/h/.claude-cliente" });
    expect(c.profiles.second).toMatchObject({ id: "cliente", label: "cliente", alias: "cop", args: [] });
    expect(c.profiles.default.label).toBe("Principal");
  });

  it("el id sale del nombre de la carpeta con la misma regla de siempre", () => {
    expect(profileIdFromDir("/h/.claude")).toBe("trabajo");
    expect(profileIdFromDir("/h/.claude-personal")).toBe("personal");
    expect(profileIdFromDir("/h/.claude-cliente")).toBe("cliente");
    expect(profileIdFromDir("/x/otra")).toBe("otra");
    expect(profileIdFromDir("/x/.otra")).toBe("otra");
  });

  it("compatibilidad: si existe ~/.claude-personal y no hay config, se comporta como antes", () => {
    const c = load({}, only("/h/.claude-personal"));
    expect(c.profiles.default.label).toBe("Trabajo");
    expect(c.profiles.second).toEqual({ id: "personal", label: "Personal", dir: "/h/.claude-personal", alias: "cop", args: ["--channels", "plugin:telegram@claude-plugins-official"], browserId: null });
    expect(c.profileLabels).toEqual({ trabajo: "Trabajo", personal: "Personal" });
  });

  it("compatibilidad: las variables mandan sobre lo heredado (p. ej. quitar los argumentos de Telegram)", () => {
    const c = load({ ROUTER_PROFILE2_ARGS: "", ROUTER_PROFILE2_LABEL: "Casa" }, only("/h/.claude-personal"));
    expect(c.profiles.second).toMatchObject({ label: "Casa", args: [], alias: "cop" });
  });

  it("si se define ROUTER_PROFILE2_DIR no se hereda nada del perfil personal antiguo", () => {
    const c = load({ ROUTER_PROFILE2_DIR: "/h/.claude-x" }, only("/h/.claude-personal"));
    expect(c.profiles.second).toMatchObject({ id: "x", args: [] });
    expect(c.profiles.default.label).toBe("Principal");
  });

  it("el perfil activo sale de CLAUDE_CONFIG_DIR y el alias, del perfil", () => {
    const env = { ROUTER_PROFILE2_DIR: "/h/.claude-cliente", ROUTER_PROFILE2_ALIAS: "coc" };
    expect(load({ ...env, CLAUDE_CONFIG_DIR: "/h/.claude-cliente" })).toMatchObject({ profile: "cliente", profileAlias: "coc" });
    expect(load({ ...env, CLAUDE_CONFIG_DIR: "/h/.claude" })).toMatchObject({ profile: "trabajo", profileAlias: "co" });
    expect(load({ CLAUDE_CONFIG_DIR: "/h/.claude-otro" })).toMatchObject({ profile: "otro", profileAlias: "cop" });
  });

  it("rechaza alias y argumentos que no sean seguros para el shell", () => {
    expect(() => load({ ROUTER_PROFILE2_DIR: "/h/.claude-x", ROUTER_PROFILE2_ALIAS: "a b" })).toThrow(/ROUTER_PROFILE2_ALIAS/);
    expect(() => load({ ROUTER_PROFILE2_DIR: "/h/.claude-x", ROUTER_PROFILE2_ARGS: "--x; rm -rf ~" })).toThrow(/ROUTER_PROFILE2_ARGS/);
    expect(() => load({ ROUTER_PROFILE2_DIR: "/h/.claude-x", ROUTER_PROFILE2_ALIAS: "co" })).toThrow(/ROUTER_PROFILE2_ALIAS/);
  });
});

describe("seat", () => {
  it("sin ROUTER_SEAT_USD no hay precio (la línea no se muestra)", () => {
    expect(load({}).consumo.seatUsdMonth).toBeNull();
    expect(load({ ROUTER_SEAT_USD: "nada" }).consumo.seatUsdMonth).toBeNull();
    expect(load({ ROUTER_SEAT_USD: "0" }).consumo.seatUsdMonth).toBeNull();
    expect(load({ ROUTER_SEAT_USD: "30" }).consumo.seatUsdMonth).toBe(30);
  });
});

describe("modo sombra", () => {
  const laya = "/h/.agent-router/laya-venv/bin/laya-serve";
  it("desactivado por defecto: sin Laya no se llama a 127.0.0.1:4318", () => {
    expect(load({}).shadow.enabled).toBe(false);
  });
  it("activado si Laya está instalada (existe laya-serve en su venv)", () => {
    expect(load({}, only(laya)).shadow.enabled).toBe(true);
    expect(load({ ROUTER_LAYA_VENV: "/v" }, only("/v/bin/laya-serve")).shadow.enabled).toBe(true);
  });
  it("ROUTER_SHADOW=1 lo fuerza y =0 lo apaga aunque haya Laya", () => {
    expect(load({ ROUTER_SHADOW: "1" }).shadow.enabled).toBe(true);
    expect(load({ ROUTER_SHADOW: "0" }, only(laya)).shadow.enabled).toBe(false);
  });
});

describe("python de Laya", () => {
  it("sin override es null; con ROUTER_LAYA_PYTHON se usa tal cual", () => {
    expect(load({}).laya.python).toBeNull();
    expect(load({ ROUTER_LAYA_PYTHON: "/usr/bin/python3.13" }).laya.python).toBe("/usr/bin/python3.13");
  });
});

describe("shell y plataforma", () => {
  it("la config expone $SHELL (único sitio que lee el entorno)", () => {
    expect(load({ SHELL: "/bin/bash" }).shell).toBe("/bin/bash");
    expect(load({}).shell).toBe("");
  });
});

describe("navegador por perfil", () => {
  const ID1 = "11111111-2222-3333-4444-555555555555";
  const ID2 = "AAAAAAAA-bbbb-CCCC-dddd-eeeeeeeeeeee";

  it("sin claves, nada cambia", () => {
    const c = load({ ROUTER_PROFILE2_DIR: "/h/.claude-x" });
    expect(c.profiles.default.browserId).toBeNull();
    expect(c.profiles.second.browserId).toBeNull();
    expect(c.browser).toBeNull();
  });

  it("cada perfil lleva su propio id y config.browser es el del perfil activo", () => {
    const env = { ROUTER_PROFILE_BROWSER_ID: ID1, ROUTER_PROFILE2_BROWSER_ID: ID2, ROUTER_PROFILE2_DIR: "/h/.claude-x", ROUTER_PROFILE_LABEL: "Uno", ROUTER_PROFILE2_LABEL: "Dos" };
    const co = load(env);
    expect(co.profiles.default.browserId).toBe(ID1);
    expect(co.profiles.second.browserId).toBe(ID2);
    expect(co.browser).toEqual({ id: ID1, label: "Uno" });
    expect(load({ ...env, CLAUDE_CONFIG_DIR: "/h/.claude-x" }).browser).toEqual({ id: ID2, label: "Dos" });
  });

  it("el segundo id sin segundo perfil se ignora", () => {
    expect(load({ ROUTER_PROFILE2_BROWSER_ID: ID2 }).browser).toBeNull();
  });

  it("rechaza ids que no son UUID", () => {
    expect(() => load({ ROUTER_PROFILE_BROWSER_ID: "no-uuid" })).toThrow(/ROUTER_PROFILE_BROWSER_ID/);
    expect(() => load({ ROUTER_PROFILE2_DIR: "/h/.claude-x", ROUTER_PROFILE2_BROWSER_ID: ID1 + "0" })).toThrow(/ROUTER_PROFILE2_BROWSER_ID/);
  });

  it("las claves se aceptan en config.env", () => {
    expect(CONFIG_KEYS).toContain("ROUTER_PROFILE_BROWSER_ID");
    expect(CONFIG_KEYS).toContain("ROUTER_PROFILE2_BROWSER_ID");
  });
});
