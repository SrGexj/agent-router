// Recorrido E2E: router → JSONL → servidor → WebSocket → dashboard.
//
// Arranque:
//   npm run build            (el servidor sirve dashboard/dist)
//   npm run e2e              (o: node pruebas/e2e-dashboard.mjs)
//   E2E_SHOT=/ruta/detalle.png npm run e2e   (además guarda una captura del panel Detalle)
//   E2E_SHOT_SCENE=/ruta/terminada.png npm run e2e   (captura de la escena de una ejecución terminada)
//   E2E_SHOT_LAYA=/ruta/escena-laya.png E2E_SHOT_LAYA_390=/ruta/escena-laya-390.png npm run e2e   (escena en curso con el nodo Laya, a 1280 y a 390 px)
//   E2E_SHOT_PERFILES=/ruta/perfiles.png npm run e2e   (captura del panel Cuota con ahorro y sombra por cuenta, a 390 px)
//   E2E_SHOT_SHADOW=/ruta/sombra.png npm run e2e   (captura de la página con el modo sombra)
//   E2E_SHOT_RUNS=/ruta/ejecuciones.png E2E_SHOT_TASKS=/ruta/encargos.png  (capturas con filtros aplicados)
//   E2E_SHOT_CONSUMO=/ruta/consumo.png npm run e2e   (captura del panel Consumo con el warehouse del monitor activado)
//   E2E_SHOT_CONSUMO_P90=/ruta/consumo-p90.png npm run e2e   (panel Consumo a 390 px con el bloque P90, con el doble del monitor)
//   E2E_SHOT_CONSUMO_OFICIAL=/ruta/consumo-oficial.png npm run e2e   (paneles Consumo y Cuota a 390 px con la cuota oficial de un perfil; el de Cuota va en consumo-oficial-cuota.png)
//
// No llama a Claude ni a claude-monitor: usa pruebas/fake-claude.mjs y pruebas/fake-monitor.mjs, que reproducen salidas reales.
// Necesita el Chrome de ~/.cache/puppeteer (o CHROME_PATH). Sale con 0 si todo va bien.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 4300 + Math.floor(Math.random() * 600);

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
const home = await mkdtemp(join(tmpdir(), "router-e2e-"));
// HOME apunta a una carpeta de mentira con los dos perfiles de cuenta, para que el panel Consumo los encuentre.
const fakeHome = join(home, "home");
const env = {
  ...process.env, ROUTER_HOME: home, ROUTER_PORT: String(PORT), CLAUDE_BIN: join(ROOT, "pruebas/fake-claude.mjs"),
  HOME: fakeHome, ROUTER_MONITOR_BIN: join(ROOT, "pruebas/fake-monitor.mjs"),
  // Configuración explícita (no depende de los valores por defecto ni de lo que haya en el HOME real): dos perfiles con
  // sus etiquetas y el precio del seat, para que existan las cabeceras de perfil y la línea de rendimiento.
  ROUTER_PROFILE_LABEL: "Trabajo", ROUTER_PROFILE2_DIR: join(fakeHome, ".claude-personal"), ROUTER_PROFILE2_LABEL: "Personal",
  ROUTER_SEAT_USD: "18",
  // La config activa el warehouse del monitor por defecto; el recorrido base comprueba el panel sin él (los extras lo activan aparte).
  ROUTER_MONITOR_WAREHOUSE: "0"
};

// Servidores extra (otro puerto y otro ROUTER_HOME) para probar variantes del panel Consumo.
async function startExtra(script, extraEnv, port) {
  const child = spawn("node", [script], { cwd: ROOT, env: { ...env, ROUTER_PORT: String(port), ROUTER_HOME: join(home, `extra-${port}`), ...extraEnv }, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (d.toString().includes("Agent Router")) resolve(); });
    child.on("exit", (c) => reject(new Error(`El servidor extra salió con ${c}`)));
  });
  return `http://127.0.0.1:${port}/`;
}
const children = [];
let browser;
let ok = false;

try {
  if (!existsSync(join(ROOT, "dashboard/dist/index.html"))) fail("Falta dashboard/dist: ejecuta npm run build.");

  await mkdir(join(fakeHome, ".claude/projects"), { recursive: true });
  await mkdir(join(fakeHome, ".claude-personal/projects"), { recursive: true });

  const server = spawn("node", ["server/index.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
  children.push(server);
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => { if (d.toString().includes("Agent Router")) resolve(); });
    server.on("exit", (c) => reject(new Error(`El servidor salió con ${c}`)));
  });

  browser = await puppeteer.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: 1000, height: 1100 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle0" });

  const text = () => page.evaluate(() => document.body.innerText);
  const waitText = async (needle, ms = 10_000) => {
    await page.waitForFunction((n) => document.body.innerText.includes(n), { timeout: ms }, needle)
      .catch(async () => fail(`No aparece "${needle}". Texto actual:\n${await text()}`));
  };

  // 1. Sin ejecuciones: en espera, con la red completa y quieta.
  await waitText("Aún no hay ejecuciones");
  for (const t of ["Tú", "Orquestador", "Asistente", "Programador", "Recibe", "Entrega", "En espera", "Aún no hay ejecuciones"]) await waitText(t);
  console.log("✓ en espera");

  // 2. Una ejecución real del router (con claude falso) aparece en vivo.
  const router = spawn("node", [join(ROOT, "bin/router.mjs"), "Tarea de prueba e2e"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(router);
  await waitText("Tarea de prueba e2e");
  await page.waitForSelector(".run-pill.on", { timeout: 5000 }).catch(() => fail("No aparece la pastilla de la ejecución en curso"));
  console.log("✓ ejecución en vivo con su pastilla");

  // 3. El encargo del subagente se refleja en el nodo Asistente (Haiku por el modelo del stream).
  await waitText("Haiku 5.5 · 1 encargo");
  console.log("✓ encargo en el nodo asistente");

  // 4. Termina: entrega, coste y cuota reales del stream.
  const code = await new Promise((r) => router.on("exit", r));
  if (code !== 0) fail(`router salió con ${code}`);
  await waitText("Terminada");
  await waitText("0,21 $");
  await page.waitForSelector(".qprofile .wline, section.panel .wline", { timeout: 10_000 }).catch(() => fail("No aparece la ventana de 5 h compacta en Cuota"));
  await waitText("completada");
  console.log("✓ entrega, coste y cuota");

  // 4b. La escena no se borra: con el reloj de la página 10 minutos adelantado sigue mostrando la ejecución terminada.
  await page.evaluate(() => { window.__now = Date.now; Date.now = () => window.__now() + 600_000; });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const kept = await page.$eval(".card", (el) => el.innerText);
  for (const t of ["historial", "Terminada", "Haiku 5.5 · 1 encargo", "0,21 $"]) {
    if (!kept.includes(t)) fail(`La escena terminada pierde "${t}" pasado el tiempo:\n${kept}`);
  }
  if (kept.includes("EN ESPERA") || kept.includes("Libre")) fail(`La escena terminada vuelve a reposo:\n${kept}`);
  const cubes = await page.$$eval(".scene .cube.done", (els) => els.length);
  if (cubes < 1) fail("Los huecos del trabajador pierden su estado final (done)");
  await page.evaluate(() => { Date.now = window.__now; });
  console.log("✓ escena terminada persistente (sin desvanecerse)");

  // 5. Pausa accesible.
  await page.click("button[aria-label='Pausar animación']");
  await page.waitForSelector("button[aria-label='Reanudar animación']");
  console.log("✓ pausa");

  // 6. Ejecución sintética con pregunta pendiente, uso por modelo y resultado de los encargos.
  const t0 = Date.now() - 20_000;
  const M = 1_000_000;
  const pasted = '<pasted_content id="ce0e">\n\nRetoma el trabajo de ayer en el módulo de pagos\ny revisa los tests\n</pasted_content>';
  const synthetic = [
    { type: "run_start", runId: "synt-1", task: pasted, mode: "sesion", model: "opus", cwd: "/tmp/proyecto-demo", t: t0 },
    { type: "task_start", taskId: "a", agent: "programador", description: "Arreglar el cálculo de IVA", prompt: "Corrige el redondeo en pagos/iva.js", t: t0 + 1000 },
    { type: "task_model", taskId: "a", model: "claude-sonnet-5-5", t: t0 + 1100 },
    { type: "task_usage", taskId: "a", byModel: { "claude-sonnet-5-5": { input: M, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t0 + 5000 },
    { type: "task_end", taskId: "a", status: "completed", summary: "IVA corregido", result: "Redondeo corregido en pagos/iva.js y test añadido.", t: t0 + 6000 },
    { type: "task_start", taskId: "b", agent: "asistente", description: "Pasar los tests", prompt: "Ejecuta npm test", t: t0 + 6500 },
    { type: "task_model", taskId: "b", model: "claude-haiku-5-5", t: t0 + 6600 },
    { type: "task_usage", taskId: "b", byModel: { "claude-haiku-5-5": { input: M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t0 + 8000 },
    { type: "task_end", taskId: "b", status: "completed", summary: "", result: "Todos los tests pasan.", t: t0 + 9000 },
    { type: "orchestrator_usage", byModel: { "claude-opus-5-5": { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t0 + 9500 },
    { type: "waiting", kind: "question", text: "¿Aplico el cambio en producción?", t: t0 + 10_000,
      questions: [{ question: "¿Aplico el cambio en producción?", header: "Despliegue", multiSelect: false, options: [{ label: "Sí, ahora", description: "Despliega y avisa al equipo" }, { label: "Esperar", description: "Deja el cambio en una rama" }] }] }
  ];
  await mkdir(join(home, "runs"), { recursive: true });
  await writeFile(join(home, "runs", "synt-1.jsonl"), synthetic.map((e) => JSON.stringify(e)).join("\n") + "\n");

  await waitText("Esperando tu respuesta en la terminal");
  await waitText("2 de 2 completados");
  await waitText("Si todo fuera Opus");
  const detail = await page.$eval(".detail", (el) => el.innerText);
  for (const t of ["Retoma el trabajo de ayer en el módulo de pagos", "Orquestador (Opus)", "Programador (Sonnet)", "Asistente (Haiku)", "Sí, ahora", "Despliega y avisa al equipo", "Arreglar el cálculo de IVA", "Tokens por tipo"]) {
    if (!detail.includes(t)) fail(`Falta "${t}" en el panel Detalle:\n${detail}`);
  }
  const page0 = await text();
  if (page0.includes("<pasted_content")) fail("El título deja ver la etiqueta <pasted_content");
  const runsText = await page.$eval(".runs", (el) => el.innerText);
  if (!runsText.includes("[texto pegado] Retoma el trabajo de ayer")) fail(`Título de la lista sin limpiar:\n${runsText}`);
  if (!/espera respuesta/.test(runsText)) fail("La lista no marca la ejecución como pregunta");
  await page.waitForFunction(() => document.querySelector(".run-pill.waiting, .run-pill.on")?.innerText.includes("espera respuesta"), { timeout: 5000 }).catch(() => fail("La pastilla no avisa de la pregunta"));
  const share = await page.$eval(".split", (el) => el.innerText);
  if (!/gasto/i.test(share) || /—/.test(share)) fail(`La barra de gasto no refleja los datos de uso:\n${share}`);
  console.log("✓ detalle: título limpio, pregunta, encargos y gasto");

  // 7. Los encargos se despliegan con el encargo y el resultado; el pegado, con su contenido.
  await page.$$eval(".dtasks details, .dpasted", (els) => els.forEach((e) => { e.open = true; }));
  const open = await page.$eval(".detail", (el) => el.innerText);
  for (const t of ["Corrige el redondeo en pagos/iva.js", "Redondeo corregido en pagos/iva.js y test añadido.", "revisa los tests"]) {
    if (!open.includes(t)) fail(`Falta "${t}" al desplegar:\n${open}`);
  }
  if (process.env.E2E_SHOT) {
    await page.setViewport({ width: 1000, height: 1100 });
    await (await page.$(".detail")).screenshot({ path: process.env.E2E_SHOT });
  }
  console.log("✓ encargos desplegables");

  // 7b. Panel Ejecuciones: grupos, orden, scroll interno y filtros. Panel Detalle: filtros de encargos.
  const now0 = Date.now();
  const mkRun = (id, task, { ago, profile, status, tasks = 0, endedAgo, lastAgo = ago }) => {
    const t = now0 - ago;
    const ev = [{ type: "run_start", runId: id, task, mode: "sesion", model: "opus", cwd: "/tmp/p", ...(profile ? { profile } : {}), t }];
    for (let i = 0; i < tasks; i++) {
      const agent = i % 2 ? "asistente" : "programador";
      const ok = i % 4 !== 3;
      ev.push({ type: "task_start", taskId: `${id}-${i}`, agent, description: `Encargo número ${i + 1}`, prompt: `Haz la parte ${i + 1}`, t: t + 100 + i * 10 });
      ev.push({ type: "task_model", taskId: `${id}-${i}`, model: agent === "asistente" ? "claude-haiku-5-5" : "claude-sonnet-5-5", t: t + 105 + i * 10 });
      ev.push({ type: "task_end", taskId: `${id}-${i}`, status: ok ? "completed" : "failed", summary: "", result: i === 4 ? "Ñandú encontrado en el módulo" : ok ? "Hecho" : "Falló el paso", t: t + 108 + i * 10 });
    }
    if (status === "stale") ev.push({ type: "thinking", t: now0 - lastAgo });
    else if (status === "running") ev.push({ type: "thinking", t: now0 - lastAgo });
    else if (status) ev.push({ type: "run_end", status: status === "cancelled" ? "cancelled" : "done", exitCode: status === "failed" ? 1 : 0, t: now0 - (endedAgo ?? ago - 5000) });
    return ev;
  };
  const defs = [
    ["live-1", "Tarea en curso reciente", { ago: 8_000, status: "running", lastAgo: 1_000 }],
    ["stale-1", "Tarea abandonada sin señal", { ago: 40 * 60_000, status: "stale", lastAgo: 30 * 60_000 }],
    ["fin-pagos", "Revisión del módulo de pagos", { ago: 300_000, status: "completed", profile: "personal" }],
    ["fin-fail", "Despliegue que falló", { ago: 310_000, status: "failed" }],
    ["fin-cancel", "Migración cancelada", { ago: 320_000, status: "cancelled" }],
    ["big", "Refactor grande con muchos encargos", { ago: 330_000, status: "completed", tasks: 12 }],
    ...Array.from({ length: 8 }, (_, i) => [`fin-x${i}`, `Ejecución de relleno ${i + 1}`, { ago: 400_000 + i * 10_000, status: "completed" }])
  ];
  for (const [id, task, o] of defs) await writeFile(join(home, "runs", `${id}.jsonl`), mkRun(id, task, o).map((e) => JSON.stringify(e)).join("\n") + "\n");
  await waitText("Ejecución de relleno 8");
  await waitText("Refactor grande con muchos encargos");

  const titles = (gid) => page.$$eval(`[aria-labelledby=${gid}] .rtask`, (els) => els.map((e) => e.textContent));
  const groupCount = (gid) => page.$eval(`[aria-labelledby=${gid}] .count`, (e) => e.textContent);
  const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 120)));
  const chip = async (group, name) => {
    await page.$$eval(`[aria-label="${group}"] button`, (bs, n) => bs.find((b) => b.textContent === n).click(), name);
    await settle();
  };
  const setText = async (sel, v) => {
    await page.focus(sel);
    const len = await page.$eval(sel, (el) => el.value.length);
    await page.$eval(sel, (el) => el.setSelectionRange(el.value.length, el.value.length));
    for (let i = 0; i < len; i++) await page.keyboard.press("Backspace");
    if (v) await page.type(sel, v);
    await settle();
  };
  const same = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: esperaba ${JSON.stringify(b)} y hay ${JSON.stringify(a)}`); };

  const running = await titles("rg-running");
  same(running.map((t) => t.slice(0, 20)), ["[texto pegado] Retom", "Tarea en curso recie"], "grupo En curso (esperando primero)");
  const finished = await titles("rg-finished");
  if (finished.length !== 14) fail(`Terminadas: esperaba 14 y hay ${finished.length}`);
  same(finished.slice(0, 5), ["Tarea de prueba e2e", "Revisión del módulo de pagos", "Despliegue que falló", "Migración cancelada", "Refactor grande con muchos encargos"], "orden de Terminadas");
  same(finished.at(-1), "Tarea abandonada sin señal", "la ejecución sin señal va al final de Terminadas");
  same([await groupCount("rg-running"), await groupCount("rg-finished")], ["2", "14"], "contadores de grupo");
  const stale = await page.$eval("[aria-labelledby=rg-finished] li:last-child", (e) => e.innerText);
  if (!stale.includes("sin señal")) fail(`La ejecución abandonada pierde su etiqueta:\n${stale}`);
  const scroll = await page.$eval(".runlist", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  if (!(scroll.sh > scroll.ch) || scroll.ch > 430) fail(`La lista de ejecuciones no hace scroll interno: ${JSON.stringify(scroll)}`);
  const total = (await page.$eval("section.panel:has(.runlist) header .count", (e) => e.textContent));
  same(total, "16", "contador de la cabecera sin filtro");
  console.log("✓ ejecuciones: grupos, orden y scroll interno");

  await setText("[aria-label='Buscar ejecuciones']", "REVISION");
  same(await titles("rg-finished"), ["Revisión del módulo de pagos"], "búsqueda sin tildes ni mayúsculas");
  same(await titles("rg-running"), [], "búsqueda vacía en curso");
  await page.waitForFunction(() => document.querySelector(".rempty")?.textContent === "Nada en curso", { timeout: 3000 }).catch(() => fail("Falta la línea \"Nada en curso\""));
  same(await page.$eval("section.panel:has(.runlist) header .count", (e) => e.textContent), "1/16", "contador filtrado");
  await setText("[aria-label='Buscar ejecuciones']", "");
  await chip("Estado de las terminadas", "Fallidas");
  same(await titles("rg-finished"), ["Despliegue que falló"], "chip Fallidas");
  same((await titles("rg-running")).length, 2, "el chip de estado no toca En curso");
  await chip("Estado de las terminadas", "Canceladas");
  same(await titles("rg-finished"), ["Migración cancelada"], "chip Canceladas");
  await chip("Estado de las terminadas", "Todas");
  await chip("Perfil", "Personal");
  const personal = await titles("rg-finished");
  if (!personal.includes("Revisión del módulo de pagos") || personal.includes("Despliegue que falló")) fail(`filtro de perfil: ${JSON.stringify(personal)}`);
  await chip("Perfil", "Todos");
  console.log("✓ ejecuciones: filtros de texto, estado y perfil");

  if (process.env.E2E_SHOT_RUNS) {
    await chip("Estado de las terminadas", "Completadas");
    await setText("[aria-label='Buscar ejecuciones']", "re");
    await (await page.$("section.panel:has(.runlist)")).screenshot({ path: process.env.E2E_SHOT_RUNS });
    await setText("[aria-label='Buscar ejecuciones']", "");
    await chip("Estado de las terminadas", "Todas");
  }

  // Filtros de encargos en la ejecución larga; se reinician al cambiar de ejecución.
  await page.$$eval("[aria-labelledby=rg-finished] .rtask", (els) => els.find((e) => e.textContent.startsWith("Refactor grande")).closest("button").click());
  await waitText("9 de 12 completados");
  const tasksCount = () => page.$$eval(".dtasks > li", (l) => l.length);
  const tscroll = await page.$eval(".dtasks", (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  if (!(tscroll.sh > tscroll.ch)) fail(`La lista de encargos no hace scroll interno: ${JSON.stringify(tscroll)}`);
  await chip("Estado del encargo", "Fallidos");
  same(await tasksCount(), 3, "encargos fallidos");
  await waitText("9 de 12 completados · mostrando 3");
  await chip("Agente", "Asistente");
  same(await tasksCount(), 3, "fallidos del asistente");
  await chip("Agente", "Programador");
  same(await tasksCount(), 0, "fallidos del programador");
  await chip("Agente", "Todos");
  await chip("Estado del encargo", "Todos");
  await setText("[aria-label='Buscar encargos']", "NANDU");
  same(await tasksCount(), 1, "búsqueda de encargos sobre el resultado");
  if (process.env.E2E_SHOT_TASKS) {
    await setText("[aria-label='Buscar encargos']", "");
    await chip("Estado del encargo", "Completados");
    await chip("Agente", "Asistente");
    await (await page.$(".detail .dtasks")).evaluate((el) => el.closest(".dblock").scrollIntoView());
    await (await page.$(".detail .dtasks")).evaluate((el) => el.closest(".dblock").setAttribute("data-shot", "1"));
    await (await page.$("[data-shot]")).screenshot({ path: process.env.E2E_SHOT_TASKS });
    await chip("Estado del encargo", "Todos");
    await chip("Agente", "Todos");
    await setText("[aria-label='Buscar encargos']", "NANDU");
  }
  await page.$$eval("[aria-labelledby=rg-finished] .rtask", (els) => els.find((e) => e.textContent.startsWith("Revisión")).closest("button").click());
  await page.waitForFunction(() => document.querySelector(".detail .dtitle")?.textContent.startsWith("Revisión"), { timeout: 5000 });
  const reset = await page.$$eval(".detail .filters", (fs) => fs.map((f) => f.querySelector("input")?.value ?? ""));
  if (reset.some((v) => v) ) fail(`Los filtros de encargos no se reinician al cambiar de ejecución: ${reset}`);
  await page.$$eval("[aria-labelledby=rg-finished] .rtask", (els) => els.find((e) => e.textContent.startsWith("Refactor grande")).closest("button").click());
  await waitText("9 de 12 completados");
  same(await tasksCount(), 12, "encargos sin filtro tras volver");
  console.log("✓ detalle: scroll y filtros de encargos, con reinicio");

  // 7c. Modo sombra: Jev coincide, no coincide y falla; bloque en Detalle, punto en la lista y línea agregada.
  {
    const MODEL = "typesafe/jev-1.13";
    const usage = (id, t) => [{ type: "orchestrator_usage", byModel: { "claude-opus-5-5": { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t }];
    const shadowRuns = [
      ["sh-ok", "Sombra coincide", { ago: 200_000, status: "completed" }, { type: "shadow_route", model: MODEL, choice: "opus", confidence: 0.92, reason: "Trabajo de diseño que requiere criterio", latencyMs: 850, costUsd: 0.0004 }],
      ["sh-no", "Sombra no coincide", { ago: 210_000, status: "completed", tasks: 1 }, { type: "shadow_route", model: MODEL, choice: "asistente", confidence: 0.85, reason: "Cambio mecánico de texto", latencyMs: 640, costUsd: 0.0003 }],
      ["sh-err", "Sombra con error", { ago: 220_000, status: "completed" }, { type: "shadow_route", model: MODEL, choice: null, error: "timeout", latencyMs: 8000 }]
    ];
    for (const [id, task, o, sh] of shadowRuns) {
      const ev = mkRun(id, task, o);
      const t = now0 - o.ago;
      ev.splice(1, 0, { ...sh, t: t + 50 }, ...usage(id, t + 60));
      await writeFile(join(home, "runs", `${id}.jsonl`), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    await waitText("Sombra con error");
    const open = async (title) => {
      await page.$$eval("[aria-labelledby=rg-finished] .rtask", (els, t) => els.find((e) => e.textContent === t).closest("button").click(), title);
      await page.waitForFunction((t) => document.querySelector(".detail .dtitle")?.textContent === t, { timeout: 5000 }, title);
    };
    await open("Sombra no coincide");
    const noMatch = await page.$eval(".detail", (el) => el.innerText);
    for (const t of ["Clasificador en sombra (Jev)", "Jev eligió: Asistente (85 %)", "Opus hizo: Programador", "no coincide", "Cambio mecánico de texto", "Latencia 0,6 s", "Si se le hubiera hecho caso", "ahorro", "estimación"]) {
      if (!noMatch.includes(t)) fail(`Falta "${t}" en el bloque de sombra:\n${noMatch}`);
    }
    await open("Sombra coincide");
    const match = await page.$eval(".detail", (el) => el.innerText);
    if (!match.includes("Jev eligió: Opus (92 %)") || !/Opus hizo: Opus\s*→\s*coincide/.test(match)) fail(`Bloque de sombra sin coincidencia:\n${match}`);
    await open("Sombra con error");
    const err = await page.$eval(".detail", (el) => el.innerText);
    if (!err.includes("timeout") || err.includes("Jev eligió")) fail(`Bloque de sombra con error incorrecto:\n${err}`);
    await open("Revisión del módulo de pagos");
    if ((await page.$eval(".detail", (el) => el.innerText)).includes("Clasificador en sombra")) fail("Una ejecución sin shadow no debe mostrar el bloque");
    const dots = await page.$$eval(".runs .sdot", (els) => els.map((e) => e.title).sort());
    if (dots.join() !== "Jev coincide,Jev no coincide") fail(`Puntos de la lista: ${dots.join(" | ")}`);
    await page.waitForSelector(".shadow-sum");
    await page.$eval(".shadow-sum details", (e) => { e.open = true; });
    const agg = await page.$eval(".shadow-sum", (el) => `${el.querySelector(".qrow").title}\n${el.innerText}`);
    if (!agg.includes("Jev en sombra: acierta 1 de 2") || !agg.includes("50 %") || !agg.includes("ahorraría") || !agg.includes("coste Jev") || !agg.includes("1 fallo")) fail(`Línea agregada incorrecta:\n${agg}`);
    await page.$eval(".shadow-sum details", (e) => { e.open = true; });
    const cells = await page.$$eval(".smatrix tbody tr", (rows) => rows.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent).join(",")));
    if (cells.join("|") !== "0,1,0|0,0,0|0,0,1") fail(`Matriz Jev/real: ${cells.join("|")}`);
    if (process.env.E2E_SHOT_SHADOW) {
      await open("Sombra no coincide");
      await page.setViewport({ width: 1000, height: 1500 });
      await page.screenshot({ path: process.env.E2E_SHOT_SHADOW, fullPage: true });
      await page.setViewport({ width: 1000, height: 1100 });
    }
    console.log("✓ modo sombra: bloque en Detalle, puntos en la lista y línea agregada");
  }

  // 7c2. Ahorro y modo sombra por cuenta: trabajo y personal no se suman, cada bloque lleva sus cifras.
  {
    const base = Date.now() - 500_000;
    const opus = { "claude-opus-5-5": { input: 500_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
    const shadowEv = (choice, t) => ({ type: "shadow_route", model: "typesafe/jev-1.13", choice, confidence: 0.9, reason: "Prueba", latencyMs: 500, costUsd: 0.0002, t });
    const personalRun = (id, task, t, { withTask, choice }) => [
      { type: "run_start", runId: id, task, mode: "sesion", model: "opus", cwd: "/tmp/p", profile: "personal", t },
      shadowEv(choice, t + 50),
      ...(withTask ? [
        { type: "task_start", taskId: `${id}-a`, agent: "programador", description: "Parte personal", prompt: "", t: t + 100 },
        { type: "task_model", taskId: `${id}-a`, model: "claude-sonnet-5-5", t: t + 110 },
        { type: "task_usage", taskId: `${id}-a`, byModel: { "claude-sonnet-5-5": { input: 2 * M, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t + 200 },
        { type: "task_end", taskId: `${id}-a`, status: "completed", summary: "", t: t + 300 }
      ] : []),
      { type: "orchestrator_usage", byModel: opus, t: t + 400 },
      { type: "run_end", status: "done", exitCode: 0, t: t + 500 }
    ];
    const runs = [
      ["pers-1", "Personal con encargo", base, { withTask: true, choice: "programador" }],
      ["pers-2", "Personal en solitario", base + 1000, { withTask: false, choice: "opus" }]
    ];
    for (const [id, task, t, o] of runs) await writeFile(join(home, "runs", `${id}.jsonl`), personalRun(id, task, t, o).map((e) => JSON.stringify(e)).join("\n") + "\n");
    await waitText("Personal en solitario");
    await page.waitForSelector(".qprofile[data-profile=personal] .shadow-sum", { timeout: 10_000 }).catch(() => fail("No aparece el clasificador en sombra dentro del perfil personal"));
    const block = (name, sel) => page.$eval(`.qprofile[data-profile=${name}] ${sel}`, (el) => el.innerText).catch(() => fail(`Falta ${sel} en el perfil ${name}`));
    const heads = await page.$$eval(".qprofile .qhead > h3", (els) => els.map((e) => e.textContent));
    same(heads, ["Trabajo", "Personal"], "cabeceras de perfil en Cuota (trabajo primero)");
    await page.$$eval(".qprofile details", (els) => els.forEach((e) => { e.open = true; }));
    const [sTrab, sPers] = [await block("trabajo", ".savings:not(.shadow-sum)"), await block("personal", ".savings:not(.shadow-sum)")];
    const [shTrab, shPers] = [await block("trabajo", ".shadow-sum"), await block("personal", ".shadow-sum")];
    if (!/· 1 ejec\.$/m.test(sPers) || !sPers.includes("6,00 $ de 10,00 $") || !sPers.includes("Ahorro vs solo Opus")) fail(`Ahorro personal incorrecto:\n${sPers}`);
    if (sTrab.includes("6,00 $ de 10,00 $")) fail(`El ahorro de trabajo ha absorbido el personal:\n${sTrab}`);
    if (sTrab === sPers) fail("Ahorro idéntico en las dos cuentas: no están separados");
    if (!shPers.includes("(2/2)") || !shPers.includes("100 %")) fail(`Sombra personal incorrecta:\n${shPers}`);
    if (!shTrab.includes("(1/2)") || !shTrab.includes("50 %") || !shTrab.includes("1 fallo")) fail(`Sombra de trabajo incorrecta:\n${shTrab}`);
    if (shTrab.includes("no incluye") || shPers.includes("no incluye")) fail("La nota de otros clasificadores no debe salir si todo es de Jev");
    if (await page.$eval(".qprofile[data-profile=personal]", (el) => el.innerText.includes("1 fallo"))) fail("El fallo de Jev de trabajo aparece en personal");
    const matrices = await page.$$eval(".qprofile .smatrix tbody", (els) => els.map((b) => [...b.querySelectorAll("td")].map((c) => c.textContent).join(",")));
    same(matrices, ["0,1,0,0,0,0,0,0,1", "0,0,0,0,1,0,0,0,1"], "matrices Jev/real por cuenta");
    if (process.env.E2E_SHOT_PERFILES) {
      await page.$$eval(".qprofile details", (els) => els.forEach((e) => { e.open = true; }));
      await page.setViewport({ width: 390, height: 1500 });
      await (await page.$("section.panel:has(.qprofile)")).screenshot({ path: process.env.E2E_SHOT_PERFILES });
      await page.setViewport({ width: 1000, height: 1100 });
    }
    console.log("✓ ahorro y sombra separados por cuenta");
  }

  // 7d. Escena de una ejecución terminada con uso completo: nodos con coste y tokens, y caption final.
  {
    const t = Date.now() - 400_000;
    const Mi = 1_000_000;
    const ev = [
      { type: "run_start", runId: "final-1", task: "Resumen final de gasto", mode: "sesion", model: "opus", cwd: "/tmp/p", t },
      { type: "task_start", taskId: "a", agent: "programador", description: "Parte A", prompt: "", t: t + 1000 },
      { type: "task_model", taskId: "a", model: "claude-sonnet-5-5", t: t + 1100 },
      { type: "task_usage", taskId: "a", byModel: { "claude-sonnet-5-5": { input: Mi, output: 100_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t + 2000 },
      { type: "task_end", taskId: "a", status: "completed", summary: "", t: t + 3000 },
      { type: "task_start", taskId: "b", agent: "asistente", description: "Parte B", prompt: "", t: t + 3100 },
      { type: "task_model", taskId: "b", model: "claude-haiku-5-5", t: t + 3200 },
      { type: "task_usage", taskId: "b", byModel: { "claude-haiku-5-5": { input: Mi, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t + 3300 },
      { type: "task_end", taskId: "b", status: "failed", summary: "", t: t + 4000 },
      { type: "orchestrator_usage", byModel: { "claude-opus-5-5": { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t + 5000 },
      { type: "context", tokens: 189_300, model: "claude-opus-5-5", window: Mi, t: t + 5100 },
      { type: "run_end", status: "done", exitCode: 0, t: t + 190_000 }
    ];
    await writeFile(join(home, "runs", "final-1.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await waitText("Resumen final de gasto");
    // La ejecución llega por el socket en cuanto el servidor lee el archivo: puede aparecer en la lista a medias y recolocarse
    // (En curso -> Terminadas) al llegar el resto. Se repite el clic hasta que la vista cambie, en vez de fiarlo a un solo clic.
    await page.waitForFunction(() => {
      if (document.querySelector(".runs button.sel .rtask")?.textContent === "Resumen final de gasto") return true;
      [...document.querySelectorAll(".runs .rtask")].find((e) => e.textContent === "Resumen final de gasto")?.closest("button").click();
      return false;
    }, { timeout: 10_000, polling: 250 }).catch(async () => fail(`No se selecciona final-1. sel=${await page.$$eval(".runs button.sel .rtask", (e) => e.map((x) => x.textContent))}`));
    // Y a que el archivo se haya leído entero (si se eligió a medias, la escena aún no trae el resumen).
    await page.waitForFunction(() => document.querySelector(".card")?.innerText.includes("2 encargos · 4,50 $"), { timeout: 10_000 }).catch(() => {});
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    const card = await page.$eval(".card", (el) => el.innerText);
    for (const x of ["Sonnet 5.5 · 1 encargo · 3,00 $ · 1,1 M tok", "Haiku 5.5 · 1 encargo · 0,10 $ · 1 M tok", "2 encargos · 4,50 $ · 2,3 M tok · 3 min 10 s", "GASTO", "USO", "CONTEXTO", "75 % · 189,3 k / 250 k"]) {
      if (!card.includes(x)) fail(`Falta "${x}" en la escena terminada:\n${card}`);
    }
    if (process.env.E2E_SHOT_SCENE) await (await page.$(".card")).screenshot({ path: process.env.E2E_SHOT_SCENE });
    console.log("✓ resumen final en la escena: nodos y caption");
  }

  // 7d2. Gasto del orquestador en vivo y nodo Laya: en curso sin uso, con instantánea intermedia y ya terminada.
  {
    const t = Date.now() - 2000;
    const jsonl = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const file = join(home, "runs", "laya-1.jsonl");
    await writeFile(file, jsonl([
      { type: "run_start", runId: "laya-1", task: "Escena con Laya en vivo", mode: "sesion", model: "opus", cwd: "/tmp/p", t },
      { type: "thinking", taskId: null, text: "", t: t + 100 }
    ]));
    await waitText("Escena con Laya en vivo");
    await page.setViewport({ width: 1280, height: 1100 });
    await page.$$eval(".runs .rtask", (els) => els.find((e) => e.textContent === "Escena con Laya en vivo").closest("button").click());
    await page.waitForFunction(() => document.querySelector(".runs button.sel .rtask")?.textContent === "Escena con Laya en vivo", { timeout: 5000 });
    const scene = () => page.$eval(".scene", (el) => el.innerText);
    const waitScene = (needle) => page.waitForFunction((n) => document.querySelector(".scene")?.innerText.includes(n), { timeout: 8000 }, needle)
      .catch(async () => fail(`No aparece "${needle}" en la escena:\n${await scene()}`));
    await waitScene("Consultando…");
    await waitScene("se calcula en vivo");
    if (/—/.test(await page.$eval(".split", (el) => el.innerText))) fail("La barra de gasto en curso sin datos no debe mostrar guiones sueltos");

    // Llega el veredicto de Laya y una instantánea intermedia del gasto del orquestador (la ejecución sigue en curso).
    await appendFile(file, jsonl([
      { type: "shadow_route", model: "laya", choice: "programador", confidence: 0.63, reason: "Cambio de código", latencyMs: 40, costUsd: 0, t: t + 300 },
      { type: "orchestrator_usage", byModel: { "claude-opus-5-5": { input: 100_000, output: 50_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, t: t + 500 }
    ]));
    await waitScene("Programador 63 %");
    await waitScene("100%");
    const live = await scene();
    if (live.includes("se calcula en vivo") || live.includes("Consultando")) fail(`Con datos la escena no debe seguir pidiendo espera:\n${live}`);
    for (const x of ["Laya", "sombra", "Opus 100%"]) if (!live.replace(/\s+/g, " ").toLowerCase().includes(x.toLowerCase())) fail(`Falta "${x}" en la escena en curso:\n${live}`);
    if (live.includes("coincide")) fail("Mientras la ejecución sigue en curso no hay veredicto");
    // Ediciones directas del orquestador: fila discreta al final de la tarjeta, oculta con 0.
    if ((await page.$eval(".split", (el) => el.innerText)).includes("ediciones directas")) fail("Sin ediciones directas no debe haber fila");
    await appendFile(file, jsonl([{ type: "direct_edit", n: 2, t: t + 600 }]));
    await page.waitForFunction(() => document.querySelector(".split .gauge-direct")?.textContent === "ediciones directas: 2", { timeout: 8000 })
      .catch(async () => fail(`Falta "ediciones directas: 2" dentro de la tarjeta:\n${await scene()}`));
    const snap = async (path, width) => {
      await page.setViewport({ width, height: 1100 });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));
      await (await page.$(".card")).screenshot({ path });
    };
    if (process.env.E2E_SHOT_LAYA) await snap(process.env.E2E_SHOT_LAYA, 1280);
    if (process.env.E2E_SHOT_LAYA_390) await snap(process.env.E2E_SHOT_LAYA_390, 390);
    await page.setViewport({ width: 1000, height: 1100 });

    // Termina sin encargos (Opus lo hizo solo) y Laya había elegido programador: no coincide.
    await appendFile(file, jsonl([{ type: "run_end", status: "done", exitCode: 0, t: t + 3000 }]));
    await waitScene("no coincide");
    console.log("✓ escena: gasto en vivo, nodo Laya con elección y veredicto");
  }

  // 7e. Panel Consumo (claude-monitor): perfiles, ventanas con procedencia, ritmo, previsión y rendimiento del seat.
  {
    await waitText("Rendimiento del seat");
    // Cuota oficial de trabajo (statusline): manda sobre la estimación del monitor, que dice 26 %. Personal no tiene.
    const quotaFile = join(home, "runs", "quota-oficial.jsonl");
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(quotaFile, JSON.stringify({ type: "quota", status: "allowed", limitType: null, fiveHour: { utilization: 0.23, resetsAt }, sevenDay: { utilization: 0.31, resetsAt: resetsAt + 86_400 }, profile: "trabajo", t: Date.now() + 3_600_000 }) + "\n");
    await page.waitForFunction(() => document.querySelector(".consumo .cprofile")?.innerText.includes("23 %"), { timeout: 10_000 })
      .catch(async () => fail(`Consumo no usa la cuota oficial de trabajo:\n${await page.$eval(".consumo", (e) => e.innerText)}`));
    await page.$$eval(".consumo .csources", (els) => els.forEach((e) => { e.open = true; }));
    const panel = await page.$eval(".consumo", (el) => el.innerText);
    for (const t of ["Consumo", "Trabajo", "Personal", "5 h", "23 %", "31 %", "7 d", "↻", "Ventanas: oficial", "Sesión de 5 h", "Histórico local (~30 días)", "Rendimiento del seat: en el histórico local", "frente a 18,00 $ del seat",
      "ROUTER_SEAT_USD", "warehouse del monitor apagado", "precios del monitor"]) {
      if (!panel.includes(t)) fail(`Falta "${t}" en el panel Consumo:\n${panel}`);
    }
    if (!/→\s*\d+×/.test(panel)) fail(`El rendimiento del seat no muestra la proporción:\n${panel}`);
    const [trab, pers] = await page.$$eval(".consumo .cprofile", (els) => els.map((e) => e.innerText));
    // Por encima del bloque P90 (que es la medición propia del monitor, aparte) solo cuenta la cuota oficial.
    const P90_TITLE = "Tu sesión vs tu P90";
    const [trabTop, trabP90 = ""] = trab.split(P90_TITLE);
    const [persTop] = pers.split(P90_TITLE);
    if (trabTop.includes("26 %") || trabTop.includes("A este ritmo") || trabTop.includes("estimación local (puede")) fail(`Trabajo mezcla la estimación del monitor con la cuota oficial:\n${trab}`);
    // Personal no tiene cuota oficial (el statusline solo escribió la de trabajo): enseña lo que mide el monitor para su cuenta,
    // la 5 h como estimación local (con "~") y la 7 d oficial del monitor, sin colarse los 23 %/31 % de Trabajo.
    if (!/5 h\s+~55 %/.test(persTop) || !/7 d\s+12 %/.test(persTop)) fail(`Personal no muestra las ventanas de su cuenta (5 h estimada con ~, 7 d del monitor):\n${pers}`);
    if (persTop.includes("23 %") || persTop.includes("31 %")) fail(`Personal usa la cuota oficial de Trabajo:\n${pers}`);
    if (!persTop.includes("A este ritmo")) fail(`Personal, sin cuota oficial, pierde la previsión del monitor:\n${pers}`);
    if (trabTop.includes("55 %") || trabTop.includes("~")) fail(`Trabajo (oficial) enseña datos de la estimación de Personal:\n${trab}`);
    // La procedencia va a los tooltips y a la nota de fuentes: Personal avisa de la estimación local, Trabajo no.
    const winTitles = await page.$$eval(".consumo .cprofile", (els) => els.map((e) => [...e.querySelectorAll(".wline")].map((w) => w.title)));
    if (!winTitles[1][0].includes("estimación local") || !winTitles[1][0].includes("~55 %")) fail(`El tooltip de la 5 h de Personal no avisa de la estimación: ${winTitles[1][0]}`);
    if (winTitles[0].some((t) => t.includes("estimación") || t.includes("~"))) fail(`Los tooltips de Trabajo (oficial) hablan de estimación: ${winTitles[0].join(" | ")}`);
    const wheres = await page.$$eval(".consumo .cwhere", (els) => els.map((e) => e.innerText));
    if (!wheres.some((w) => /^Trabajo: .*Ventanas: oficial(?! \/)/.test(w))) fail(`La nota de fuentes de Trabajo no dice "Ventanas: oficial":\n${wheres.join("\n")}`);
    if (!wheres.some((w) => /^Personal: .*Ventanas: estimación local \(puede no reflejar tu plan\) \/ oficial/.test(w))) fail(`La nota de fuentes de Personal no distingue estimación y oficial:\n${wheres.join("\n")}`);
    if (!trab.includes(P90_TITLE) || !pers.includes(P90_TITLE)) fail(`Falta el bloque del P90 del monitor en algún perfil:\n${panel}`);
    for (const t of ["26 %", "104,1 k / 394,2 k", "mensajes", "tok/min"]) {
      if (!trabP90.includes(t)) fail(`Falta "${t}" en el bloque P90 de Trabajo:\n${trabP90}`);
    }
    // La fixture del doble tiene fechas fijas: según la hora, la previsión cae antes o después del reinicio.
    if (!/A este ritmo (llegarías a tu P90 a las \d\d:\d\d|no llegas a tu P90 antes del reinicio)/.test(trabP90)) fail(`Falta la previsión del monitor frente al P90:\n${trabP90}`);
    const hint = await page.$eval(".consumo .cp90 h4", (e) => e.title);
    if (!hint.includes("no es el límite de tu plan") || !hint.includes("8 días")) fail(`Falta el subtítulo del P90 en el tooltip: ${hint}`);
    if (/límite/i.test(trabP90)) fail(`El bloque P90 llama "límite" a su referencia:\n${trabP90}`);
    const blocks = await page.$$eval(".consumo .cprofile", (els) => els.map((e) => e.querySelector("h3")?.textContent));
    same(blocks, ["Trabajo", "Personal"], "perfiles del panel Consumo");
    if (process.env.E2E_SHOT_CONSUMO_OFICIAL) {
      await page.setViewport({ width: 390, height: 1400 });
      await (await page.$("section.panel:has(.qprofile)")).screenshot({ path: process.env.E2E_SHOT_CONSUMO_OFICIAL.replace(/\.png$/, "-cuota.png") });
      await (await page.$(".consumo")).screenshot({ path: process.env.E2E_SHOT_CONSUMO_OFICIAL });
      await page.setViewport({ width: 1000, height: 1100 });
    }
    await rm(quotaFile, { force: true });
    console.log("✓ consumo: perfiles, ventanas, ritmo y rendimiento del seat");

    // Con el warehouse del monitor activado salen hoy / 7 días / mes y el desglose por modelo.
    const url = await startExtra(join(ROOT, "pruebas/servidor-consumo.mjs"), { CONSUMO_WAREHOUSE_DIR: join(home, "wh") }, PORT + 1);
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1000, height: 1100 });
    await p2.goto(url, { waitUntil: "networkidle0" });
    await p2.waitForFunction(() => document.querySelector(".consumo")?.innerText.includes("Este mes"), { timeout: 15_000 })
      .catch(async () => fail(`Sin totales con el warehouse activado:\n${await p2.$eval(".consumo", (e) => e.innerText)}`));
    await p2.$$eval(".consumo details", (els) => els.forEach((e) => { e.open = true; }));
    const full = await p2.$eval(".consumo", (el) => el.innerText);
    for (const t of ["Hoy", "Últimos 7 días", "Este mes", "Por modelo (este mes)", "Opus 5.5", "Sonnet 5.5", "Rendimiento del seat: este mes", "precios del router"]) {
      if (!full.includes(t)) fail(`Falta "${t}" con el warehouse activado:\n${full}`);
    }
    // Este servidor no tiene cuota oficial de ningún perfil: sale la estimación del monitor, avisada, con su previsión.
    for (const t of ["~55 %", "estimación local (puede no reflejar tu plan)", "A este ritmo"]) if (!full.includes(t)) fail(`Sin cuota oficial falta "${t}":\n${full}`);
    if (full.includes("warehouse del monitor apagado")) fail("El aviso de warehouse apagado no debe salir con el warehouse activo");
    if (process.env.E2E_SHOT_CONSUMO) await (await p2.$(".consumo")).screenshot({ path: process.env.E2E_SHOT_CONSUMO });
    await p2.setViewport({ width: 390, height: 900 });
    // Toda la página (cabecera incluida). Lo que queda dentro del scroll propio de la escena no cuenta: no ensancha la página.
    const ov2 = await p2.evaluate(() => [...document.querySelectorAll("*")].filter((e) => !e.closest(".scene-scroll") && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length);
    if (ov2 > 0) fail(`Desborde horizontal de ${ov2} elementos a 390 px en el panel Consumo con totales`);
    const ovP90 = await p2.$$eval(".consumo .cp90", (els) => els.filter((e) => e.scrollWidth > e.clientWidth).length);
    if (ovP90 > 0) fail("El bloque P90 desborda su caja a 390 px");
    if (!(await p2.$eval(".consumo", (e) => e.innerText)).includes("Tu sesión vs tu P90")) fail("Falta el bloque P90 en el panel Consumo a 390 px");
    if (process.env.E2E_SHOT_CONSUMO_P90) await (await p2.$(".consumo")).screenshot({ path: process.env.E2E_SHOT_CONSUMO_P90 });
    await p2.close();
    console.log("✓ consumo con warehouse: hoy, semana, mes y por modelo");

    // Sin claude-monitor el panel avisa con discreción y cómo instalarlo; el servidor sigue vivo.
    const url3 = await startExtra(join(ROOT, "server/index.mjs"), { ROUTER_MONITOR_BIN: "/no/existe/claude-monitor" }, PORT + 2);
    const p3 = await browser.newPage();
    await p3.goto(url3, { waitUntil: "networkidle0" });
    await p3.waitForFunction(() => document.querySelector(".consumo")?.innerText.includes("Consumo no disponible"), { timeout: 15_000 })
      .catch(async () => fail(`Sin aviso con el monitor ausente:\n${await p3.$eval(".consumo", (e) => e.innerText)}`));
    const missing = await p3.$eval(".consumo", (el) => el.innerText);
    if (!missing.includes("pip install")) fail(`El aviso no dice cómo instalarlo:\n${missing}`);
    if (missing.includes("Rendimiento del seat")) fail("Sin monitor no debe haber rendimiento del seat");
    await p3.close();
    console.log("✓ consumo sin claude-monitor: aviso discreto");
  }

  // 8. A 390 px el detalle no desborda la página.
  await page.setViewport({ width: 390, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) fail(`Desborde horizontal de ${overflow}px a 390 px`);
  console.log("✓ sin desborde a 390 px");

  if (errors.length) fail(`Errores en la página: ${errors.join("\n")}`);
  ok = true;
  console.log("E2E OK");
} catch (e) {
  console.error(`E2E FALLÓ: ${e.stack ?? e.message}`);
} finally {
  await browser?.close();
  for (const c of children) c.kill();
  await rm(home, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
