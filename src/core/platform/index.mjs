// Selección de plataforma: macOS (launchd + zsh) o Linux (systemd --user + bash/zsh). Windows: usar WSL.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createDarwin } from "./darwin.mjs";
import { createLinux } from "./linux.mjs";

export function unsupportedMessage(name) {
  return name === "win32"
    ? "Windows no soportado; usa WSL (funciona como Linux)."
    : `Plataforma ${name} no soportada: solo macOS y Linux (en Windows, usa WSL).`;
}

const FACTORIES = { darwin: createDarwin, linux: createLinux };

// deps: { home, uid, shell, run, fs, sleep }. Lanza si la plataforma no está soportada.
export function createPlatform(name, deps) {
  const make = FACTORIES[name];
  if (!make) throw new Error(unsupportedMessage(name));
  return make(deps);
}

export function selectPlatform(name, deps) {
  return FACTORIES[name] ? { ok: true, platform: createPlatform(name, deps) } : { ok: false, message: unsupportedMessage(name) };
}

// Dependencias reales: lo único con E/S de verdad.
export function realDeps({ home, shell = "" }) {
  return {
    home,
    shell,
    uid: process.getuid?.() ?? 0,
    run: (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }),
    fs: { mkdir, writeFile, unlink, exists: existsSync },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  };
}

// Plataforma del sistema actual (para mensajes cuando el llamante no inyecta una). En una no soportada, usa Linux.
export function defaultPlatform({ home, shell = "" }) {
  return createPlatform(FACTORIES[process.platform] ? process.platform : "linux", realDeps({ home, shell }));
}
