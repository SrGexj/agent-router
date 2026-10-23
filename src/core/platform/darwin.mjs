// macOS: servicios con launchd (LaunchAgents de usuario) y shell zsh.
import { dirname, join } from "node:path";
import { shellBlockFor } from "./shell.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// spec: { label, argv: [bin, ...args], cwd?, env?, logFile, startInterval? (s: tarea periódica, sin KeepAlive) }. Función pura.
export function servicePlist({ label, argv, cwd = null, env = {}, logFile, startInterval = null }) {
  const vars = Object.entries(env).map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
${cwd ? `  <key>WorkingDirectory</key><string>${esc(cwd)}</string>\n` : ""}  <key>EnvironmentVariables</key>
  <dict>${vars}</dict>
  <key>RunAtLoad</key><true/>
${startInterval ? `  <key>StartInterval</key><integer>${Number(startInterval)}</integer>` : "  <key>KeepAlive</key><true/>"}
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

export function createDarwin({ home, uid, run, fs, sleep }) {
  const target = `gui/${uid}`;
  const plistPath = (label) => join(home, "Library/LaunchAgents", `${label}.plist`);
  const launchctl = (...args) => run("launchctl", args);

  return {
    name: "darwin",
    serviceKind: "LaunchAgent",
    serviceFile: plistPath,
    shellRcPath: () => join(home, ".zshrc"),
    shellKnown: () => true,
    loginShell: () => "/bin/zsh",
    openCommand: "open",
    restartHint: (label) => `launchctl kickstart -k gui/$(id -u)/${label}`,
    shellBlock: (opts) => shellBlockFor(opts, `open "http://127.0.0.1:${opts.port ?? 4317}"`),

    // bootout es asíncrono: si se hace bootstrap antes de que el servicio anterior desaparezca,
    // launchctl devuelve "5: Input/output error". Se espera y se reintenta.
    async serviceInstall(spec) {
      const file = plistPath(spec.label);
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(file, servicePlist(spec));
      launchctl("bootout", `${target}/${spec.label}`);
      for (let i = 0; i < 25 && launchctl("print", `${target}/${spec.label}`).status === 0; i++) await sleep(200);
      let boot;
      for (let i = 0; i < 5; i++) {
        boot = launchctl("bootstrap", target, file);
        if (boot.status === 0) break;
        await sleep(500);
      }
      return boot.status === 0 ? { ok: true } : { ok: false, error: (boot.stderr || boot.error?.message || "").trim() };
    },

    async serviceUninstall(label) {
      launchctl("bootout", `${target}/${label}`);
      const file = plistPath(label);
      if (!fs.exists(file)) return { removed: false };
      await fs.unlink(file);
      return { removed: true };
    },

    async serviceRestart(label) {
      const r = launchctl("kickstart", "-k", `${target}/${label}`);
      return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.error?.message || "").trim() };
    },

    async openUrl(url) { return run("open", [url]); }
  };
}
