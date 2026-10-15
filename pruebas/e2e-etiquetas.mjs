// Recorrido E2E de las etiquetas de entrenamiento: pulsar un botón en el Detalle → POST → JSONL → WebSocket → contador.
//
// Arranque:
//   npm run build
//   node pruebas/e2e-etiquetas.mjs
//   E2E_SHOT=/ruta/etiquetas.png node pruebas/e2e-etiquetas.mjs   (captura del bloque a 390 px)
//
// Servidor de prueba en un puerto aleatorio y con ROUTER_HOME temporal: no toca el dashboard ni el servicio de Laya reales.
// Necesita el Chrome de ~/.cache/puppeteer (o CHROME_PATH). Sale con 0 si todo va bien.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  for (const v of readdirSync(base).sort().reverse()) {
    for (const sub of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64"]) {
      const p = join(base, v, sub, "chrome-headless-shell");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No encuentro Chrome en ~/.cache/puppeteer; define CHROME_PATH.");
}

const fail = (msg) => { throw new Error(msg); };
const home = await mkdtemp(join(tmpdir(), "router-etiquetas-"));
const RUN = "20260101T000000Z-1-aaaa";
let server;
let browser;
let ok = false;

try {
  if (!existsSync(join(ROOT, "dashboard/dist/index.html"))) fail("Falta dashboard/dist: ejecuta npm run build.");
  const fakeHome = join(home, "home");
  await mkdir(join(fakeHome, ".claude/projects"), { recursive: true });
  await mkdir(join(home, "runs"), { recursive: true });
  // Ejecución terminada: Opus delegó en el programador (etiqueta automática) y Laya dijo "asistente".
  const events = [
    { type: "run_start", runId: RUN, task: "Arregla el test que falla", mode: "orquestado", model: "opus", cwd: "/", t: 1000 },
    { type: "shadow_route", model: "laya", choice: "asistente", confidence: 0.6, costUsd: 0, latencyMs: 80, t: 1100 },
    { type: "task_start", taskId: "a", agent: "programador", description: "d", prompt: "p", t: 1200 },
    { type: "run_end", exitCode: 0, t: 2000 }
  ];
  await writeFile(join(home, "runs", `${RUN}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const env = { ...process.env, ROUTER_HOME: home, ROUTER_PORT: "0", HOME: fakeHome, ROUTER_MONITOR_BIN: join(ROOT, "pruebas/fake-monitor.mjs"),
    // Config explícita de perfiles/seat (como e2e-dashboard): no depende de los valores por defecto.
    ROUTER_PROFILE_LABEL: "Trabajo", ROUTER_PROFILE2_DIR: join(fakeHome, ".claude-personal"), ROUTER_PROFILE2_LABEL: "Personal", ROUTER_SEAT_USD: "18", ROUTER_MONITOR_WAREHOUSE: "0" };
  server = spawn("node", ["server/index.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => { const m = d.toString().match(/http:\/\/\S+/); if (m) resolve(m[0]); });
    server.on("exit", (c) => reject(new Error(`El servidor salió con ${c}`)));
  });

  browser = await puppeteer.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 390, height: 900 });
  await page.goto(url, { waitUntil: "networkidle0" });
  const waitText = (needle) => page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: 10_000 }, needle)
    .catch(async () => fail(`No aparece "${needle}". Texto:\n${await page.evaluate(() => document.body.innerText)}`));

  // El contador vive dentro del <details> "Detalle Laya" (cerrado): se lee su textContent, que no depende de que esté abierto.
  const waitCount = (needle) => page.waitForFunction((n) => document.querySelector('[data-testid="training-count"]')?.textContent.trim() === n, { timeout: 10_000 }, needle)
    .catch(async () => fail(`El contador no es "${needle}". Es: ${await page.evaluate(() => document.querySelector('[data-testid="training-count"]')?.textContent ?? "(no existe)")}`));

  // 1. Etiqueta automática: contador sin correcciones y botón del programador en "(auto)".
  await waitCount("Datos para entrenar: 1 (0 corregidas) · asistente 0 · programador 1 · opus 0");
  await waitText("¿Quién debía llevarla?");
  await waitText("Programador (auto)");
  console.log("✓ etiqueta automática y contador");

  // 2. Pulsar Asistente: el POST añade el evento y el dashboard lo recibe por WebSocket.
  await page.click('button[data-label="asistente"]');
  await waitCount("Datos para entrenar: 1 (1 corregida) · asistente 1 · programador 0 · opus 0");
  const lines = (await readFile(join(home, "runs", `${RUN}.jsonl`), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const ev = lines.at(-1);
  if (ev.type !== "route_label" || ev.label !== "asistente" || ev.source !== "usuario") fail(`Evento inesperado: ${JSON.stringify(ev)}`);
  await page.waitForFunction(() => document.querySelector('button[data-label="asistente"]')?.getAttribute("aria-pressed") === "true", { timeout: 5000 })
    .catch(async () => fail(`El botón Asistente no queda marcado: ${await page.$eval(".labelrow", (n) => n.outerHTML)}`));
  console.log("✓ corrección manual: evento en el JSONL y contador actualizado");

  if (process.env.E2E_SHOT) {
    const el = await page.$(".labelrow");
    await (await el.evaluateHandle((n) => n.closest(".dblock"))).asElement().screenshot({ path: process.env.E2E_SHOT });
  }

  // 3. Deshacer vuelve a la automática.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Deshacer").click());
  await waitCount("Datos para entrenar: 1 (0 corregidas) · asistente 0 · programador 1 · opus 0");
  console.log("✓ deshacer");

  // 4. Sin desbordamiento horizontal a 390 px.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`Desbordamiento horizontal de ${overflow}px a 390 px`);
  if (errors.length) fail(`Errores en la página:\n${errors.join("\n")}`);
  ok = true;
} catch (e) {
  console.error(`✗ ${e.message}`);
} finally {
  await browser?.close().catch(() => {});
  server?.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
