import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import WebSocket from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/core/store.mjs";
import { createApp, startServer } from "../server/app.mjs";
import { decideAccess, safeEqual } from "../server/acceso.mjs";
import { loadConfig } from "../src/config.mjs";

const TOKEN = "t".repeat(40);
const PUB = "router.ejemplo.com";
const req = (o = {}) => ({ method: "GET", url: "/", headers: { host: PUB }, ...o });

describe("safeEqual", () => {
  it("compara en tiempo constante sin lanzar con longitudes distintas", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(null, "abc")).toBe(false);
    expect(safeEqual("abc", undefined)).toBe(false);
  });
});

describe("decideAccess", () => {
  it("sin token configurado, todo pasa", () => {
    expect(decideAccess(req(), null).action).toBe("allow");
  });
  it("acceso local directo exento", () => {
    expect(decideAccess(req({ headers: { host: "127.0.0.1:4317" } }), TOKEN).action).toBe("allow");
    expect(decideAccess(req({ headers: { host: "localhost:4317" } }), TOKEN).action).toBe("allow");
  });
  it("con cf-connecting-ip o x-forwarded-for deja de ser local aunque el Host lo sea", () => {
    expect(decideAccess(req({ headers: { host: "127.0.0.1:4317", "cf-connecting-ip": "1.2.3.4" } }), TOKEN).action).toBe("deny");
    expect(decideAccess(req({ headers: { host: "localhost:4317", "x-forwarded-for": "1.2.3.4" } }), TOKEN).action).toBe("deny");
  });
  it("Host público sin credenciales: deny", () => {
    expect(decideAccess(req(), TOKEN).action).toBe("deny");
  });
  it("cookie correcta pasa; incorrecta o de otra longitud no", () => {
    expect(decideAccess(req({ headers: { host: PUB, cookie: `a=1; router_token=${TOKEN}` } }), TOKEN).action).toBe("allow");
    expect(decideAccess(req({ headers: { host: PUB, cookie: `router_token=${"x".repeat(40)}` } }), TOKEN).action).toBe("deny");
    expect(decideAccess(req({ headers: { host: PUB, cookie: "router_token=corto" } }), TOKEN).action).toBe("deny");
  });
  it("GET con ?token correcto: cookie segura y redirect sin el token, conservando el resto", () => {
    const d = decideAccess(req({ url: `/runs?a=1&token=${TOKEN}&b=2` }), TOKEN);
    expect(d.action).toBe("redirect");
    expect(d.location).toBe("/runs?a=1&b=2");
    expect(d.cookie).toBe(`router_token=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
    expect(decideAccess(req({ url: `/?token=${TOKEN}` }), TOKEN).location).toBe("/");
  });
  it("el redirect nunca sale del origen (//host)", () => {
    expect(decideAccess(req({ url: `//malo.example/x?token=${TOKEN}` }), TOKEN).location).toMatch(/^\/(?!\/)/);
  });
  it("token por URL incorrecto, o en POST/UPGRADE: deny", () => {
    expect(decideAccess(req({ url: "/?token=nope" }), TOKEN).action).toBe("deny");
    expect(decideAccess(req({ method: "POST", url: `/?token=${TOKEN}` }), TOKEN).action).toBe("deny");
    expect(decideAccess(req({ method: "UPGRADE", url: `/ws?token=${TOKEN}` }), TOKEN).action).toBe("deny");
  });
});

describe("config ROUTER_ACCESS_TOKEN", () => {
  const load = (env) => {
    const warnings = [];
    const c = loadConfig({ HOME: "/h", ...env }, { exists: () => false, readFile: () => { const e = new Error(); e.code = "ENOENT"; throw e; }, warn: (m) => warnings.push(m) });
    return { c, warnings };
  };
  it("sin definir: sin auth", () => { expect(load({}).c.accessToken).toBeNull(); });
  it("válido: se usa", () => { expect(load({ ROUTER_ACCESS_TOKEN: TOKEN }).c.accessToken).toBe(TOKEN); });
  it("corto: se ignora con aviso que no incluye el valor", () => {
    const { c, warnings } = load({ ROUTER_ACCESS_TOKEN: "secreto-corto" });
    expect(c.accessToken).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("secreto-corto");
  });
});

describe("middleware HTTP", () => {
  let dir, app;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "router-acc-"));
    const store = createStore({ runsDir: dir });
    await store.append("r1", { type: "run_start", runId: "r1", task: "t", mode: "orquestado", model: "opus", cwd: "/", t: 1 });
    app = createApp({ store, accessToken: TOKEN, now: () => 5 });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("sin token: 401 de texto plano que no filtra nada", async () => {
    const res = await request(app).get("/api/runs").set("Host", PUB).expect(401);
    expect(res.text).toBe("No autorizado");
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    await request(app).get("/health").set("Host", PUB).expect(401);
    await request(app).get("/").set("Host", PUB).expect(401);
  });
  it("local directo pasa; con cf-connecting-ip exige token aunque el Host sea 127.0.0.1", async () => {
    await request(app).get("/api/profiles").set("Host", "127.0.0.1:4317").expect(200);
    await request(app).get("/api/profiles").set("Host", "127.0.0.1:4317").set("Cf-Connecting-Ip", "1.2.3.4").expect(401);
  });
  it("?token fija la cookie y redirige quitándolo y conservando otros parámetros", async () => {
    const res = await request(app).get(`/api/runs?limit=1&token=${TOKEN}`).set("Host", PUB).expect(302);
    expect(res.headers.location).toBe("/api/runs?limit=1");
    expect(res.headers["set-cookie"][0]).toContain(`router_token=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/`);
    expect(res.headers.location).not.toContain(TOKEN);
  });
  it("con la cookie pasa", async () => {
    const res = await request(app).get("/api/runs").set("Host", PUB).set("Cookie", `router_token=${TOKEN}`).expect(200);
    expect(res.body.runs).toHaveLength(1);
  });
  it("token incorrecto: 401", async () => {
    await request(app).get("/api/runs?token=otro").set("Host", PUB).expect(401);
  });

  describe("POST de etiquetas a través del túnel", () => {
    const post = (headers) => request(app).post("/api/runs/r1/label").set({ Host: PUB, Cookie: `router_token=${TOKEN}`, ...headers }).send({ label: "opus" });
    it("con cookie y Origin igual al host público: 200", async () => {
      await post({ Origin: `https://${PUB}` }).expect(200);
    });
    it("Origin ajeno, ausente o null: 403 aunque haya cookie", async () => {
      await post({ Origin: "https://malo.example" }).expect(403);
      await post({ Origin: "null" }).expect(403);
      await post({}).expect(403);
    });
    it("sin cookie: 401 antes de llegar al guard", async () => {
      await request(app).post("/api/runs/r1/label").set({ Host: PUB, Origin: `https://${PUB}` }).send({ label: "opus" }).expect(401);
    });
    it("el acceso local sigue funcionando como antes", async () => {
      await request(app).post("/api/runs/r1/label").set({ Host: "127.0.0.1:4317", Origin: "http://127.0.0.1:4317" }).send({ label: "opus" }).expect(200);
    });
  });

  it("sin token configurado el Host público sigue rechazado en el POST (comportamiento actual)", async () => {
    const open = createApp({ store: createStore({ runsDir: dir }) });
    await request(open).post("/api/runs/r1/label").set({ Host: PUB, Origin: `https://${PUB}` }).send({ label: "opus" }).expect(403);
  });
});

describe("upgrade de WebSocket", () => {
  let dir, srv;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "router-ws-"));
    srv = await startServer({ store: createStore({ runsDir: dir }), host: "127.0.0.1", port: 0, accessToken: TOKEN });
  });
  afterEach(async () => { await srv.close(); await rm(dir, { recursive: true, force: true }); });

  const connect = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers });
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    ws.on("error", () => {});
  });

  it("sin cookie desde el túnel: 401", async () => {
    expect(await connect({ Host: PUB })).toBe(401);
  });
  it("con cf-connecting-ip aunque el Host sea local: 401", async () => {
    expect(await connect({ "Cf-Connecting-Ip": "1.2.3.4" })).toBe(401);
  });
  it("con cookie desde el túnel: acepta", async () => {
    expect(await connect({ Host: PUB, Cookie: `router_token=${TOKEN}` })).toBe("open");
  });
  it("local directo: acepta", async () => {
    expect(await connect({})).toBe("open");
  });
});
