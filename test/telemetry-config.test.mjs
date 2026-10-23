import { describe, it, expect } from "vitest";
import { loadConfig, CONFIG_KEYS } from "../src/config.mjs";

const load = (env = {}) => loadConfig({ HOME: "/h", ROUTER_HOME: "/h/.ar", ...env }, { exists: () => false, readFile: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; }, warn: () => {} });
const TOKEN = "tok-placeholder-0123456789";

describe("config de telemetría", () => {
  it("las claves se aceptan en config.env", () => {
    expect(CONFIG_KEYS).toContain("ROUTER_TELEMETRY_URL");
    expect(CONFIG_KEYS).toContain("ROUTER_TELEMETRY_TOKEN");
  });

  it("sin claves o con solo una: desactivada", () => {
    expect(load().telemetry.enabled).toBe(false);
    expect(load({ ROUTER_TELEMETRY_URL: "https://t.example.com" }).telemetry.enabled).toBe(false);
    expect(load({ ROUTER_TELEMETRY_TOKEN: TOKEN }).telemetry.enabled).toBe(false);
  });

  it("con las dos y https: activa, con rutas dentro de ROUTER_HOME", () => {
    const t = load({ ROUTER_TELEMETRY_URL: "https://t.example.com", ROUTER_TELEMETRY_TOKEN: TOKEN }).telemetry;
    expect(t.enabled).toBe(true);
    expect(t.endpoint).toBe("https://t.example.com/v1/runs");
    expect(t.sentFile).toBe("/h/.ar/telemetry-sent.json");
    expect(t.errorsFile).toBe("/h/.ar/telemetry-errors.log");
  });

  it("http solo para localhost, 127.0.0.1 y ::1", () => {
    const on = (url) => load({ ROUTER_TELEMETRY_URL: url, ROUTER_TELEMETRY_TOKEN: TOKEN }).telemetry.enabled;
    expect(on("http://t.example.com")).toBe(false);
    expect(on("http://192.168.1.5:3000")).toBe(false);
    expect(on("http://localhost:3000")).toBe(true);
    expect(on("http://127.0.0.1:3000")).toBe(true);
    expect(on("http://[::1]:3000")).toBe(true);
    expect(on("ftp://t.example.com")).toBe(false);
    expect(on("no es url")).toBe(false);
  });

  it("la barra final y un prefijo de ruta no rompen el endpoint", () => {
    const t = load({ ROUTER_TELEMETRY_URL: "https://t.example.com/api/", ROUTER_TELEMETRY_TOKEN: TOKEN }).telemetry;
    expect(t.endpoint).toBe("https://t.example.com/api/v1/runs");
  });
});
