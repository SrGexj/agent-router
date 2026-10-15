// Linux (y WSL con systemd): servicios con systemd --user y shell bash o zsh.
import { basename, dirname, join } from "node:path";
import { shellBlockFor } from "./shell.mjs";

// Un argumento de ExecStart: systemd interpreta %x y $x, y separa por espacios salvo entre comillas.
const execArg = (a) => {
  const s = String(a).replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\]/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
};
const envLine = (k, v) => `Environment="${`${k}=${String(v).replace(/%/g, "%%")}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// spec: { label, argv: [bin, ...args], cwd?, env?, logFile }. Función pura.
export function systemdUnit({ label, argv, cwd = null, env = {}, logFile }) {
  return `[Unit]
Description=Agent Router (${label})
After=network.target

[Service]
Type=simple
ExecStart=${argv.map(execArg).join(" ")}
${cwd ? `WorkingDirectory=${cwd}\n` : ""}${Object.entries(env).map(([k, v]) => `${envLine(k, v)}\n`).join("")}Restart=on-failure
RestartSec=2
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

const KNOWN_SHELLS = new Set(["bash", "zsh"]);

export function createLinux({ home, shell = "", run, fs }) {
  const unitName = (label) => `${label}.service`;
  const unitPath = (label) => join(home, ".config/systemd/user", unitName(label));
  const ctl = (...args) => run("systemctl", ["--user", ...args]);
  const shellName = basename(shell || "");
  const fail = (r, what) => ({ ok: false, error: `systemctl --user ${what} falló: ${(r.stderr || r.error?.message || `código ${r.status}`).trim()} (hace falta systemd con sesión de usuario; en WSL activa systemd)` });

  return {
    name: "linux",
    serviceKind: "servicio systemd (usuario)",
    serviceFile: unitPath,
    shellRcPath: () => join(home, shellName === "zsh" ? ".zshrc" : ".bashrc"),
    shellKnown: () => KNOWN_SHELLS.has(shellName),
    loginShell: () => (shell.startsWith("/") ? shell : "/bin/bash"),
    openCommand: "xdg-open",
    restartHint: (label) => `systemctl --user restart ${unitName(label)}`,
    // Sin xdg-open (servidor sin escritorio) no abre nada y no falla.
    shellBlock: (opts) => shellBlockFor(opts, `{ command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:${opts.port ?? 4317}" >/dev/null 2>&1; }`),

    async serviceInstall(spec) {
      const file = unitPath(spec.label);
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(file, systemdUnit(spec));
      const steps = [["daemon-reload"], ["enable", "--now", unitName(spec.label)], ["restart", unitName(spec.label)]];
      for (const step of steps) {
        const r = ctl(...step);
        if (r.status !== 0) return fail(r, step[0]);
      }
      return { ok: true };
    },

    async serviceUninstall(label) {
      const file = unitPath(label);
      if (!fs.exists(file)) return { removed: false };
      ctl("disable", "--now", unitName(label));
      await fs.unlink(file);
      ctl("daemon-reload");
      return { removed: true };
    },

    async serviceRestart(label) {
      const r = ctl("restart", unitName(label));
      return r.status === 0 ? { ok: true } : fail(r, "restart");
    },

    async openUrl(url) { return run("xdg-open", [url]); }
  };
}
