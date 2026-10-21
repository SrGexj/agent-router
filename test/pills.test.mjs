import { describe, expect, it } from "vitest";
import { pillStatus } from "../dashboard/src/pills.js";

describe("pillStatus", () => {
  it("pregunta pendiente: espera respuesta, punto ámbar con pulso", () => {
    expect(pillStatus({ waiting: { kind: "question" }, phase: "ejecuta" })).toEqual({ text: "espera respuesta", dot: "wait pulse", tone: "wait" });
  });
  it("la espera gana a cualquier otro estado", () => {
    expect(pillStatus({ waiting: { kind: "permission" }, alert: true, phase: "fallo" }).tone).toBe("wait");
  });
  it.each(["recibe", "analiza", "delega", "ejecuta", "revisa"])("%s: verde", (phase) => {
    expect(pillStatus({ phase }).dot).toBe("ok");
  });
  it("ejecutando se lee 'ejecutando'", () => {
    expect(pillStatus({ phase: "ejecuta" }).text).toBe("ejecutando");
  });
  it("fallo, límite y aviso: rojo", () => {
    expect(pillStatus({ phase: "fallo" }).tone).toBe("err");
    expect(pillStatus({ phase: "limitado" }).tone).toBe("err");
    expect(pillStatus({ phase: "ejecuta", alert: true }).tone).toBe("err");
  });
  it("sin fase de trabajo: gris", () => {
    expect(pillStatus({ phase: "espera" })).toMatchObject({ dot: "idle", tone: "idle" });
    expect(pillStatus({ phase: undefined }).text).toBe("inactiva");
  });
});
