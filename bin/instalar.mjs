#!/usr/bin/env node
// Instala (o con --desinstalar, quita) el alias `co`, los subagentes genéricos, el comando
// `router` y el servidor del dashboard como servicio de usuario (launchd en macOS, systemd --user en Linux).
// Hooks, statusline, server y enlaces apuntan a la copia estable <home>/app (worktree de main), no a este repo.
// --actualizar: pasa la copia a la punta de main y reinicia el server (`router actualizar`). Hace copia de lo que
// modifica y no pisa archivos que no sean suyos.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfigEnv } from "../src/config.mjs";
import { buildCoSettings, planStatuslineChain, layaInstallPlan, layaServiceSpec, pickPython, serverServiceSpec, withZshBlock as withShellBlock, withoutZshBlock as withoutShellBlock } from "../src/core/install.mjs";
import { appPaths, appRootFor, planAppRemove, planLink } from "../src/core/app-copy.mjs";
import { syncApp } from "../src/core/app-sync.mjs";
import { realDeps, selectPlatform } from "../src/core/platform/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const LABEL = "com.agent-router.server";
const LAYA_LABEL = "com.agent-router.laya";
const LAYA_HOST = "127.0.0.1";
const LAYA_PORT = 4318;
const config = loadConfig();
const H = config.userHome;
const selected = selectPlatform(process.platform, realDeps({ home: H, shell: config.shell }));
if (!selected.ok) { console.error(selected.message); process.exit(1); }
const platform = selected.platform;
const node = process.execPath;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const uninstall = process.argv.includes("--desinstalar");
const update = process.argv.includes("--actualizar");
const reapply = process.argv.includes("--reaplicar"); // interno: segunda fase de --actualizar, ya con el código nuevo
const APP = appRootFor(config.home);
const appFiles = appPaths(APP);
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8" });

const paths = {
  settings: join(config.home, "co-settings.json"),
  next: join(config.home, "statusline-next"),
  rc: platform.shellRcPath(),
  layaVenv: join(config.home, "laya-venv"),
  routerBin: join(H, "bin/router"),
  agents: ["asistente", "programador", "consultor"].map((n) => ({ link: join(H, ".claude/agents", `${n}.md`), target: appFiles.agent(n), legacy: [join(ROOT, "src/agents", `${n}.md`)] }))
};
// Destinos antiguos (el repo de desarrollo) que se migran a la copia al reinstalar y que el desinstalador también reconoce.
const legacyRouter = [join(ROOT, "bin/router.mjs")];

const log = (msg) => console.log(`  ${msg}`);
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

const currentLink = (p) => { try { return lstatSync(p).isSymbolicLink() ? { symlink: true, target: readlinkSync(p) } : { symlink: false }; } catch { return null; } };

async function linkSafe(link, target, { backupForeign = false, legacyTargets = [] } = {}) {
  const action = planLink({ current: currentLink(link), target, legacyTargets, backupForeign });
  if (action === "keep") return log(`ya enlazado: ${link}`);
  if (action === "skip") return log(`OMITIDO (ya existe y no es mío): ${link}`);
  if (action === "replace") await unlink(link);
  if (action === "backup") {
    await rename(link, `${link}.bak-${stamp}`);
    log(`copia del anterior: ${link}.bak-${stamp}`);
  }
  await mkdir(join(link, ".."), { recursive: true });
  await symlink(target, link);
  log(`${action === "replace" ? "migrado a la copia estable" : "enlazado"}: ${link} → ${target}`);
}

async function unlinkIfMine(link, targets) {
  const cur = currentLink(link);
  if (cur?.symlink && targets.includes(cur.target)) { await unlink(link); log(`quitado: ${link}`); }
}

// Repo que aloja el worktree de la copia: este repo, o (si se ejecuta desde la propia copia) el que indica su .git común.
function repoRoot() {
  if (ROOT !== APP) return ROOT;
  const r = run("git", ["-C", APP, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.status === 0 ? join(r.stdout.trim(), "..") : ROOT;
}

// Deja <home>/app en la punta de main (la crea si falta). Devuelve false y avisa si no se puede.
function ensureApp() {
  log("copia estable: " + APP);
  const res = syncApp({ appRoot: APP, repoRoot: repoRoot(), run, exists, log: (m) => log(`  ${m}`) });
  if (!res.ok) { console.error(`\nERROR: ${res.reason}`); return false; }
  if (!res.changed) log("copia estable al día");
  return true;
}

// Piezas que dependen de la copia: settings de co, enlaces y servicio del dashboard. Las comparten co y cop.
async function applyApp({ restart }) {
  await writeFile(paths.settings, JSON.stringify(buildCoSettings({ node, appRoot: APP }), null, 2) + "\n");
  log(`hooks y statusline de co: ${paths.settings}`);
  for (const a of paths.agents) await linkSafe(a.link, a.target, { legacyTargets: a.legacy });
  await linkSafe(paths.routerBin, appFiles.router, { backupForeign: true, legacyTargets: legacyRouter });
  if (!restart) return;
  const boot = await platform.serviceInstall(serverServiceSpec({ label: LABEL, node, appRoot: APP, home: config.home, env: serverEnv() }));
  log(boot.ok ? `dashboard siempre activo: http://${config.host}:${config.port}` : `no se pudo cargar el servicio: ${boot.error}`);
}

// El servicio arranca con un PATH mínimo: se le pasa la ruta absoluta de claude-monitor si existe.
function serverEnv() {
  const monitorBin = spawnSync(platform.loginShell(), ["-lc", "command -v claude-monitor"], { encoding: "utf8" }).stdout?.trim().split("\n").pop();
  const env = monitorBin?.startsWith("/") ? { ROUTER_MONITOR_BIN: monitorBin } : {};
  if (!env.ROUTER_MONITOR_BIN) console.log("  aviso: claude-monitor no está en el PATH; el panel Consumo dirá cómo instalarlo");
  return env;
}

// Laya local (modelo de decisión del modo sombra). Si algo falla avisa y sigue: el resto de la instalación no depende de él.
async function installLaya() {
  try {
    const probe = (cmd) => { const r = spawnSync(cmd, ["--version"], { encoding: "utf8" }); return r.status === 0 ? `${r.stdout}${r.stderr}` : null; };
    const python = pickPython({ override: config.laya.python, probe });
    if (!python) {
      return log(config.laya.python
        ? `Laya OMITIDO: ROUTER_LAYA_PYTHON=${config.laya.python} no es un Python 3.12 o superior`
        : "Laya OMITIDO: no encuentro python3.12 (ni python3 ≥ 3.12) en el PATH; instálalo (macOS: brew install python@3.12) o define ROUTER_LAYA_PYTHON y vuelve a ejecutar npm run instalar");
    }
    log("Laya: preparando el entorno Python (la primera vez descarga ~1 GB, tarda unos minutos)…");
    for (const { cmd, args } of layaInstallPlan({ python, venv: paths.layaVenv, venvExists: existsSync(join(paths.layaVenv, "bin/pip")) })) {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      if (r.status !== 0) return log(`Laya OMITIDO: falló ${cmd} ${args[0]} (${(r.stderr || r.error?.message || "").trim().split("\n").pop()})`);
    }
    const res = await platform.serviceInstall(layaServiceSpec({ label: LAYA_LABEL, serveBin: join(paths.layaVenv, "bin/laya-serve"), home: config.home, host: LAYA_HOST, port: LAYA_PORT, extraModels: config.layaExtraModels }));
    log(res.ok ? `Laya activo en http://${LAYA_HOST}:${LAYA_PORT} (solo local; log en ${config.home}/laya.log; el modo sombra queda activado)` : `Laya OMITIDO: no se pudo cargar el servicio: ${res.error}`);
  } catch (e) { log(`Laya OMITIDO: ${e.message}`); }
}

async function install() {
  console.log("Instalando agent-router (co)…");
  await mkdir(config.home, { recursive: true });

  // Las variables soportadas que haya en este entorno quedan en config.env: servidor, hooks y statusline las leen de ahí.
  const saved = saveConfigEnv({ home: config.home });
  if (saved.keys.length) log(`configuración en ${saved.path}${saved.changed ? "" : " (sin cambios)"}: ${saved.keys.join(", ")}`);

  if (!ensureApp()) process.exit(1);

  let userCmd;
  try {
    userCmd = JSON.parse(await readFile(join(H, ".claude/settings.json"), "utf8")).statusLine?.command;
  } catch { /* sin settings legibles */ }
  const existingNext = existsSync(paths.next) ? await readFile(paths.next, "utf8") : null;
  const chain = planStatuslineChain({ userCmd, existingNext });
  if (chain.write) await writeFile(paths.next, chain.chained + "\n");
  log(chain.chained ? `Statusline encadenada: ${chain.chained}` : "sin statusline propia: co mostrará una mínima con la cuota");

  await applyApp({ restart: false });

  const rc = existsSync(paths.rc) ? await readFile(paths.rc, "utf8") : "";
  if (rc) await copyFile(paths.rc, join(config.home, `${basename(paths.rc).replace(/^\./, "")}.bak-${stamp}`));
  const second = config.profiles.second;
  const block = platform.shellBlock({ node, appRoot: APP, home: config.home, port: config.port, profile2: second && existsSync(second.dir) ? { dir: second.dir, alias: second.alias, args: second.args } : null });
  await writeFile(paths.rc, withShellBlock(rc, block));
  log(`alias co en ${paths.rc} (copia en ${config.home}/${basename(paths.rc).replace(/^\./, "")}.bak-${stamp})`);
  if (!platform.shellKnown()) log(`aviso: tu shell (${config.shell || "desconocida"}) no es bash ni zsh; el alias se ha escrito en ${paths.rc}, cárgalo desde tu shell o usa bash/zsh`);

  const boot = await platform.serviceInstall(serverServiceSpec({ label: LABEL, node, appRoot: APP, home: config.home, env: serverEnv() }));
  log(boot.ok ? `dashboard siempre activo: http://${config.host}:${config.port}` : `no se pudo cargar el servicio: ${boot.error}`);

  await installLaya();

  console.log(`\nListo. Abre una terminal nueva (o \`source ${paths.rc}\`) y usa: co`);
  if (platform.name === "linux") console.log("Para que los servicios sigan activos sin sesión abierta: loginctl enable-linger $USER");
  console.log(`Si cambias de versión de Node con nvm, vuelve a ejecutar npm run instalar (usa ${node}).`);
  console.log("Para llevar la copia estable a la última main sin reinstalar: router actualizar");
}

// Fase 1: mueve la copia a main. Fase 2 (proceso nuevo, con el código ya actualizado): settings, enlaces y reinicio.
async function updateApp() {
  console.log("Actualizando la copia estable…");
  if (!ensureApp()) process.exit(1);
  const r = spawnSync(node, [join(APP, "bin/instalar.mjs"), "--reaplicar"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function reapplyAndRestart() {
  await applyApp({ restart: false });
  const res = await platform.serviceRestart(LABEL);
  log(res.ok ? "dashboard reiniciado con la copia nueva (las sesiones co en curso siguen con la anterior hasta que las cierres)" : `no se pudo reiniciar el dashboard (${res.error}); si no está instalado: npm run instalar`);
}

async function remove() {
  console.log("Desinstalando agent-router (co)…");
  if (existsSync(paths.rc)) {
    const rc = await readFile(paths.rc, "utf8");
    const clean = withoutShellBlock(rc);
    if (clean !== rc) {
      await copyFile(paths.rc, join(config.home, `${basename(paths.rc).replace(/^\./, "")}.bak-${stamp}`));
      await writeFile(paths.rc, clean);
      log(`alias co quitado de ${paths.rc}`);
    }
  }
  if ((await platform.serviceUninstall(LABEL)).removed) log("servicio del dashboard quitado");
  if ((await platform.serviceUninstall(LAYA_LABEL)).removed) log("servicio de Laya quitado (el venv y los pesos se quedan: borra a mano ~/.agent-router/laya-venv y ~/.agent-router/hf si no los quieres)");
  for (const a of paths.agents) await unlinkIfMine(a.link, [a.target, ...a.legacy]);
  await unlinkIfMine(paths.routerBin, [appFiles.router, ...legacyRouter]);
  for (const p of [paths.settings, paths.next]) if (existsSync(p)) await unlink(p);
  const appExists = exists(join(APP, ".git"));
  const rm = planAppRemove({ appRoot: APP, repoRoot: repoRoot(), appExists, appClean: !appExists || run("git", ["-C", APP, "status", "--porcelain"]).stdout.trim() === "" });
  if (!rm.ok) log(`AVISO: ${rm.reason}`);
  for (const { cmd, args } of rm.steps) {
    const r = run(cmd, args);
    log(r.status === 0 ? `copia estable quitada: ${APP}` : `no se pudo quitar la copia estable (${r.stderr.trim().split("\n").pop()})`);
  }
  console.log(`\nHecho. Las ejecuciones guardadas siguen en ${config.runsDir}.`);
}

await (uninstall ? remove() : update ? updateApp() : (reapply ? reapplyAndRestart() : install()));
