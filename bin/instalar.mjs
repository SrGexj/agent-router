#!/usr/bin/env node
// Instala (o con --desinstalar, quita) el alias `co`, los subagentes genéricos, el comando
// `router` y el servidor del dashboard como servicio de usuario (launchd en macOS, systemd --user en Linux).
// Hace copia de lo que modifica y no pisa archivos que no sean suyos.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfigEnv } from "../src/config.mjs";
import { buildCoSettings, layaInstallPlan, layaServiceSpec, pickPython, serverServiceSpec, withZshBlock as withShellBlock, withoutZshBlock as withoutShellBlock } from "../src/core/install.mjs";
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

const paths = {
  settings: join(config.home, "co-settings.json"),
  next: join(config.home, "statusline-next"),
  rc: platform.shellRcPath(),
  layaVenv: join(config.home, "laya-venv"),
  routerBin: join(H, "bin/router"),
  agents: ["asistente", "programador"].map((n) => ({ link: join(H, ".claude/agents", `${n}.md`), target: join(ROOT, "src/agents", `${n}.md`) }))
};

const log = (msg) => console.log(`  ${msg}`);
const isLinkTo = (p, target) => { try { return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target; } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

async function linkSafe(link, target, { backupForeign = false } = {}) {
  if (isLinkTo(link, target)) return log(`ya enlazado: ${link}`);
  if (exists(link)) {
    if (!backupForeign) return log(`OMITIDO (ya existe y no es mío): ${link}`);
    await rename(link, `${link}.bak-${stamp}`);
    log(`copia del anterior: ${link}.bak-${stamp}`);
  }
  await mkdir(join(link, ".."), { recursive: true });
  await symlink(target, link);
  log(`enlazado: ${link} → ${target}`);
}

async function unlinkIfMine(link, target) {
  if (isLinkTo(link, target)) { await unlink(link); log(`quitado: ${link}`); }
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

  if (!existsSync(join(ROOT, "dashboard/dist/index.html"))) {
    log("construyendo el dashboard…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  }

  await writeFile(paths.settings, JSON.stringify(buildCoSettings({ node, root: ROOT }), null, 2) + "\n");
  log(`hooks y statusline de co: ${paths.settings}`);

  try {
    const user = JSON.parse(await readFile(join(H, ".claude/settings.json"), "utf8"));
    const cmd = user.statusLine?.command;
    if (cmd && !cmd.includes("router-statusline")) {
      await writeFile(paths.next, cmd + "\n");
      log(`tu statusline se sigue mostrando en co: ${cmd}`);
    }
  } catch { log("sin statusline propia: co mostrará una mínima con la cuota"); }

  for (const a of paths.agents) await linkSafe(a.link, a.target);
  await linkSafe(paths.routerBin, join(ROOT, "bin/router.mjs"), { backupForeign: true });

  const rc = existsSync(paths.rc) ? await readFile(paths.rc, "utf8") : "";
  if (rc) await copyFile(paths.rc, join(config.home, `${basename(paths.rc).replace(/^\./, "")}.bak-${stamp}`));
  const second = config.profiles.second;
  const block = platform.shellBlock({ node, root: ROOT, home: config.home, port: config.port, profile2: second && existsSync(second.dir) ? { dir: second.dir, alias: second.alias, args: second.args } : null });
  await writeFile(paths.rc, withShellBlock(rc, block));
  log(`alias co en ${paths.rc} (copia en ${config.home}/${basename(paths.rc).replace(/^\./, "")}.bak-${stamp})`);
  if (!platform.shellKnown()) log(`aviso: tu shell (${config.shell || "desconocida"}) no es bash ni zsh; el alias se ha escrito en ${paths.rc}, cárgalo desde tu shell o usa bash/zsh`);

  // El servicio arranca con un PATH mínimo: se le pasa la ruta absoluta de claude-monitor si existe.
  const monitorBin = spawnSync(platform.loginShell(), ["-lc", "command -v claude-monitor"], { encoding: "utf8" }).stdout?.trim().split("\n").pop();
  const env = monitorBin?.startsWith("/") ? { ROUTER_MONITOR_BIN: monitorBin } : {};
  if (!env.ROUTER_MONITOR_BIN) console.log("  aviso: claude-monitor no está en el PATH; el panel Consumo dirá cómo instalarlo");
  const boot = await platform.serviceInstall(serverServiceSpec({ label: LABEL, node, root: ROOT, home: config.home, env }));
  log(boot.ok ? `dashboard siempre activo: http://${config.host}:${config.port}` : `no se pudo cargar el servicio: ${boot.error}`);

  await installLaya();

  console.log(`\nListo. Abre una terminal nueva (o \`source ${paths.rc}\`) y usa: co`);
  if (platform.name === "linux") console.log("Para que los servicios sigan activos sin sesión abierta: loginctl enable-linger $USER");
  console.log(`Si cambias de versión de Node con nvm, vuelve a ejecutar npm run instalar (usa ${node}).`);
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
  for (const a of paths.agents) await unlinkIfMine(a.link, a.target);
  await unlinkIfMine(paths.routerBin, join(ROOT, "bin/router.mjs"));
  for (const p of [paths.settings, paths.next]) if (existsSync(p)) await unlink(p);
  console.log(`\nHecho. Las ejecuciones guardadas siguen en ${config.runsDir}.`);
}

await (uninstall ? remove() : install());
