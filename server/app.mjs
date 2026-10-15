import express from "express";
import { WebSocketServer } from "ws";
import chokidar from "chokidar";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "../src/core/reducer.mjs";
import { parseJsonl } from "../src/core/store.mjs";
import { accessMiddleware, decideAccess, LOCAL_HOST } from "./acceso.mjs";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const LABELS = new Set(["asistente", "programador", "opus"]);
const DIST = fileURLToPath(new URL("../dashboard/dist", import.meta.url));

// Lee solo lo nuevo de cada archivo, por bytes, y solo líneas completas.
export function createTailer() {
  const offsets = new Map();
  async function read(path) {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      let offset = offsets.get(path) ?? 0;
      if (size < offset) offset = 0;
      if (size === offset) return [];
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) return [];
      offsets.set(path, offset + lastNl + 1);
      return parseJsonl(buf.subarray(0, lastNl + 1).toString("utf8"));
    } finally {
      await fh.close();
    }
  }
  return { read };
}

async function reducedRuns(store, limit) {
  const ids = (await store.listRunIds()).slice(0, limit);
  const runs = await Promise.all(ids.map(async (id) => reduceEvents(await store.readRun(id))));
  return runs.filter(Boolean);
}

// Solo desde el propio dashboard, contra DNS rebinding y CSRF.
// Sin token: Host local y, si hay Origin, el mismo que el Host.
// Con token (túnel): el middleware de acceso ya exigió la cookie a todo lo que no es local; aquí el Host público vale,
// pero el Origin es obligatorio y debe ser el propio Host (http o https), así que otro sitio no puede disparar el POST.
const sameOriginGuard = (accessToken) => (req, res, next) => {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  const ok = accessToken && !LOCAL_HOST.test(host)
    ? origin === `https://${host}` || origin === `http://${host}`
    : LOCAL_HOST.test(host) && (origin === undefined || origin === `http://${host}`);
  if (!ok) return res.status(403).json({ error: "origen no permitido" });
  next();
};

export function createApp({ store, monitor = null, profileLabels = {}, now = Date.now, accessToken = null }) {
  const app = express();
  if (accessToken) app.use(accessMiddleware(accessToken));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/runs", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    res.json({ runs: await reducedRuns(store, limit) });
  });

  app.get("/api/runs/:id", async (req, res) => {
    if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "id no válido" });
    const events = await store.readRun(req.params.id);
    if (events.length === 0) return res.status(404).json({ error: "no existe" });
    res.json({ run: reduceEvents(events), events });
  });

  // Corrección manual de quién debía llevar la tarea (dato de entrenamiento). label null la quita.
  app.post("/api/runs/:id/label", sameOriginGuard(accessToken), express.json({ limit: "1kb" }), async (req, res) => {
    if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "id no válido" });
    const label = req.body?.label;
    if (label !== null && !LABELS.has(label)) return res.status(400).json({ error: "etiqueta no válida" });
    if ((await store.readRun(req.params.id)).length === 0) return res.status(404).json({ error: "no existe" });
    await store.append(req.params.id, { type: "route_label", label, source: "usuario", t: now() });
    res.json({ ok: true });
  });

  // Etiquetas de los perfiles de cuenta (id → texto), definidas en la configuración del servidor.
  app.get("/api/profiles", (_req, res) => res.json({ labels: profileLabels }));

  app.get("/api/quota", async (_req, res) => {
    res.json({ quotas: await store.latestQuotas() });
  });

  // Consumo del seat vía claude-monitor. Un fallo del monitor se devuelve como dato, nunca como 500.
  app.get("/api/consumo", async (_req, res) => {
    if (!monitor) return res.json({ profiles: {}, seatUsdMonth: null, updatedAt: null, error: { code: "desactivado", message: "El panel de consumo no está configurado." } });
    try {
      res.json(await monitor.get());
    } catch (err) {
      res.json({ profiles: {}, seatUsdMonth: null, updatedAt: null, error: { code: "fallo", message: String(err?.message ?? err).slice(0, 200) } });
    }
  });

  if (existsSync(DIST)) {
    app.use(express.static(DIST));
    app.get("/{*splat}", (_req, res) => res.sendFile(join(DIST, "index.html")));
  }
  return app;
}

export async function startServer({ store, host, port, monitor = null, profileLabels = {}, now = Date.now, accessToken = null }) {
  await mkdir(store.runsDir, { recursive: true });
  const app = createApp({ store, monitor, profileLabels, now, accessToken });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  // El upgrade no pasa por Express: se aplica aquí la misma comprobación (cookie o acceso local).
  server.on("upgrade", (req, socket, head) => {
    const allowed = decideAccess({ method: "UPGRADE", url: req.url, headers: req.headers }, accessToken).action === "allow";
    if (!allowed) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 13\r\n\r\nNo autorizado");
      return socket.destroy();
    }
    if (new URL(req.url, "http://x").pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const tail = createTailer();

  // Marca lo que ya existe como leído: el hello lo manda entero.
  for (const f of await readdir(store.runsDir)) {
    if (f.endsWith(".jsonl")) await tail.read(join(store.runsDir, f));
  }

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };

  // Serializa lecturas por archivo para no emitir eventos duplicados ni desordenados.
  const chains = new Map();
  const readOnce = (path, runId) => {
    const next = (chains.get(path) ?? Promise.resolve())
      .then(() => tail.read(path))
      .then((events) => { for (const event of events) broadcast({ kind: "event", runId, event }); })
      .catch(() => {});
    chains.set(path, next);
  };
  // chokidar descarta los "change" que llegan a menos de 50 ms del anterior del mismo archivo, y la escritura
  // descartada podía ser la última de una racha (p. ej. run_end): la ejecución se quedaba "en curso" hasta la siguiente
  // escritura. Una segunda lectura pasada esa ventana recoge lo que se perdió (el tailer ignora lo ya leído).
  const RECHECK_MS = 120;
  const timers = new Set();
  const onFile = (path) => {
    if (!path.endsWith(".jsonl")) return;
    const runId = basename(path, ".jsonl");
    if (!SAFE_ID.test(runId)) return;
    readOnce(path, runId);
    const timer = setTimeout(() => { timers.delete(timer); readOnce(path, runId); }, RECHECK_MS);
    timers.add(timer);
  };

  const watcher = chokidar.watch(store.runsDir, { ignoreInitial: true, depth: 0 });
  watcher.on("add", onFile).on("change", onFile);
  await new Promise((r) => watcher.on("ready", r));

  wss.on("connection", async (socket) => {
    const [runs, quotas] = await Promise.all([reducedRuns(store, 30), store.latestQuotas()]);
    if (socket.readyState === 1) socket.send(JSON.stringify({ kind: "hello", runs, quotas }));
  });

  await new Promise((r) => server.listen(port, host, r));
  return {
    port: server.address().port,
    async close() {
      await watcher.close();
      for (const t of timers) clearTimeout(t);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
    }
  };
}
