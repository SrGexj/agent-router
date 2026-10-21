import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPlatform, selectPlatform, unsupportedMessage } from "../src/core/platform/index.mjs";
import { servicePlist } from "../src/core/platform/darwin.mjs";
import { systemdUnit } from "../src/core/platform/linux.mjs";
import { coFunction } from "../src/core/platform/shell.mjs";

// Dobles: nada toca el disco ni lanza comandos reales.
function fakeDeps(overrides = {}) {
  const calls = [];
  const files = new Map();
  const removed = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return (overrides.runResult ?? (() => ({ status: 0, stdout: "", stderr: "" })))(cmd, args, calls); };
  const fs = {
    mkdir: async () => {},
    writeFile: async (p, c) => { files.set(p, c); },
    unlink: async (p) => { removed.push(p); files.delete(p); },
    exists: (p) => files.has(p)
  };
  return { home: "/home/u", uid: 501, shell: "/bin/zsh", run, fs, sleep: async () => {}, calls, files, removed };
}

const spec = { label: "com.agent-router.server", argv: ["/usr/local/bin/node", "/repo/server/index.mjs"], cwd: "/repo", env: { ROUTER_HOME: "/home/u/.agent-router" }, logFile: "/home/u/.agent-router/server.log" };

describe("selección de plataforma", () => {
  it("darwin y linux están soportadas", () => {
    expect(selectPlatform("darwin", fakeDeps())).toMatchObject({ ok: true, platform: { name: "darwin" } });
    expect(selectPlatform("linux", fakeDeps())).toMatchObject({ ok: true, platform: { name: "linux" } });
  });
  it("win32 devuelve el mensaje de WSL", () => {
    const r = selectPlatform("win32", fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Windows no soportado; usa WSL (funciona como Linux).");
    expect(unsupportedMessage("win32")).toBe(r.message);
  });
  it("otra plataforma también se rechaza con mensaje claro", () => {
    const r = selectPlatform("freebsd", fakeDeps());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/freebsd/);
  });
  it("createPlatform lanza con una plataforma no soportada", () => {
    expect(() => createPlatform("win32", fakeDeps())).toThrow(/WSL/);
  });
});

describe("macOS (launchd)", () => {
  it("el plist lleva etiqueta, argumentos, entorno, KeepAlive y logs", () => {
    const plist = servicePlist(spec);
    expect(plist).toContain("<key>Label</key><string>com.agent-router.server</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/repo/server/index.mjs</string>");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/repo</string>");
    expect(plist).toContain("<key>ROUTER_HOME</key><string>/home/u/.agent-router</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>StandardOutPath</key><string>/home/u/.agent-router/server.log</string>");
  });
  it("escapa XML y omite WorkingDirectory si no hay", () => {
    const plist = servicePlist({ ...spec, cwd: null, env: { A: "a&b<c>" } });
    expect(plist).toContain("a&amp;b&lt;c&gt;");
    expect(plist).not.toContain("WorkingDirectory");
  });
  it("rutas: LaunchAgents y .zshrc", () => {
    const p = createPlatform("darwin", fakeDeps());
    expect(p.serviceFile("x.y")).toBe("/home/u/Library/LaunchAgents/x.y.plist");
    expect(p.shellRcPath()).toBe("/home/u/.zshrc");
  });
  it("serviceInstall escribe el plist, hace bootout y bootstrap (con reintento)", async () => {
    let boots = 0;
    const d = fakeDeps({ runResult: (cmd, args) => {
      if (args[0] === "print") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "bootstrap" && ++boots < 2) return { status: 5, stdout: "", stderr: "Input/output error" };
      return { status: 0, stdout: "", stderr: "" };
    } });
    const p = createPlatform("darwin", d);
    const r = await p.serviceInstall(spec);
    expect(r.ok).toBe(true);
    expect(d.files.get("/home/u/Library/LaunchAgents/com.agent-router.server.plist")).toContain("KeepAlive");
    expect(d.calls[0]).toEqual(["launchctl", "bootout", "gui/501/com.agent-router.server"]);
    expect(d.calls.filter((c) => c[1] === "bootstrap")).toHaveLength(2);
    expect(d.calls.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", "/home/u/Library/LaunchAgents/com.agent-router.server.plist"]);
  });
  it("serviceInstall devuelve el error de launchctl si no consigue cargar", async () => {
    const d = fakeDeps({ runResult: (cmd, args) => (args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: " boom \n" } : { status: 1, stdout: "", stderr: "" }) });
    const r = await createPlatform("darwin", d).serviceInstall(spec);
    expect(r).toEqual({ ok: false, error: "boom" });
  });
  it("serviceUninstall: bootout y borra el plist solo si existe", async () => {
    const d = fakeDeps();
    d.files.set("/home/u/Library/LaunchAgents/a.plist", "x");
    const p = createPlatform("darwin", d);
    expect(await p.serviceUninstall("a")).toEqual({ removed: true });
    expect(d.calls[0]).toEqual(["launchctl", "bootout", "gui/501/a"]);
    expect(await p.serviceUninstall("b")).toEqual({ removed: false });
  });
  it("serviceRestart usa kickstart -k", async () => {
    const d = fakeDeps();
    await createPlatform("darwin", d).serviceRestart("a");
    expect(d.calls).toEqual([["launchctl", "kickstart", "-k", "gui/501/a"]]);
  });
  it("la función co abre con `open`", () => {
    const body = createPlatform("darwin", fakeDeps()).shellBlock({ node: "/n", appRoot: "/r", home: "/h", port: 4317 });
    expect(body).toContain('pgrep -qf "agent-router/co-settings.json" || open "http://127.0.0.1:4317"');
  });
});

describe("Linux (systemd --user)", () => {
  it("la unit lleva ExecStart con node absoluto, entorno, Restart=on-failure y WantedBy=default.target", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("ExecStart=/usr/local/bin/node /repo/server/index.mjs");
    expect(unit).toContain("WorkingDirectory=/repo");
    expect(unit).toContain('Environment="ROUTER_HOME=/home/u/.agent-router"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("StandardOutput=append:/home/u/.agent-router/server.log");
    expect(unit).toContain("StandardError=append:/home/u/.agent-router/server.log");
    expect(unit).toContain("[Install]\nWantedBy=default.target");
  });
  it("entrecomilla argumentos con espacios y escapa % y $ (systemd los interpreta)", () => {
    const unit = systemdUnit({ ...spec, argv: ["/opt/my node/bin/node", "/r/s 1/index.mjs", "50%", "$HOME"], env: { X: 'a"b' } });
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" "/r/s 1/index.mjs" 50%% $$HOME');
    expect(unit).toContain('Environment="X=a\\"b"');
  });
  it("rutas: unit en ~/.config/systemd/user y rc según $SHELL", () => {
    const mk = (shell) => createPlatform("linux", { ...fakeDeps(), shell });
    expect(mk("/bin/bash").serviceFile("x")).toBe("/home/u/.config/systemd/user/x.service");
    expect(mk("/usr/bin/zsh").shellRcPath()).toBe("/home/u/.zshrc");
    expect(mk("/bin/bash").shellRcPath()).toBe("/home/u/.bashrc");
    expect(mk("").shellRcPath()).toBe("/home/u/.bashrc");
    expect(mk("/usr/bin/fish").shellRcPath()).toBe("/home/u/.bashrc");
    expect(mk("/usr/bin/fish").shellKnown()).toBe(false);
    expect(mk("/bin/bash").shellKnown()).toBe(true);
  });
  it("serviceInstall: escribe la unit, daemon-reload, enable --now y restart", async () => {
    const d = fakeDeps();
    const r = await createPlatform("linux", d).serviceInstall(spec);
    expect(r).toEqual({ ok: true });
    expect(d.files.get("/home/u/.config/systemd/user/com.agent-router.server.service")).toContain("Restart=on-failure");
    expect(d.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "com.agent-router.server.service"],
      ["systemctl", "--user", "restart", "com.agent-router.server.service"]
    ]);
  });
  it("serviceInstall explica qué falta si systemctl --user no responde", async () => {
    const d = fakeDeps({ runResult: () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus" }) });
    const r = await createPlatform("linux", d).serviceInstall(spec);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/systemctl --user/);
    expect(r.error).toMatch(/Failed to connect to bus/);
  });
  it("serviceInstall: systemctl ausente (ENOENT) también da error legible", async () => {
    const d = fakeDeps({ runResult: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn systemctl ENOENT") }) });
    const r = await createPlatform("linux", d).serviceInstall(spec);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
  });
  it("serviceUninstall: disable --now, borra la unit y recarga", async () => {
    const d = fakeDeps();
    d.files.set("/home/u/.config/systemd/user/a.service", "x");
    expect(await createPlatform("linux", d).serviceUninstall("a")).toEqual({ removed: true });
    expect(d.calls).toEqual([["systemctl", "--user", "disable", "--now", "a.service"], ["systemctl", "--user", "daemon-reload"]]);
    expect(d.removed).toEqual(["/home/u/.config/systemd/user/a.service"]);
  });
  it("serviceUninstall sin unit no hace nada", async () => {
    const d = fakeDeps();
    expect(await createPlatform("linux", d).serviceUninstall("a")).toEqual({ removed: false });
    expect(d.calls).toEqual([]);
  });
  it("serviceRestart usa systemctl --user restart", async () => {
    const d = fakeDeps();
    await createPlatform("linux", d).serviceRestart("a");
    expect(d.calls).toEqual([["systemctl", "--user", "restart", "a.service"]]);
  });
  it("la función co abre con xdg-open solo si existe", () => {
    const body = createPlatform("linux", fakeDeps()).shellBlock({ node: "/n", appRoot: "/r", home: "/h", port: 4317 });
    expect(body).toContain("xdg-open");
    expect(body).not.toContain(" open \"http");
  });
  it("openUrl lanza xdg-open / open", async () => {
    const dl = fakeDeps();
    await createPlatform("linux", dl).openUrl("http://x");
    expect(dl.calls).toEqual([["xdg-open", "http://x"]]);
    const dd = fakeDeps();
    await createPlatform("darwin", dd).openUrl("http://x");
    expect(dd.calls).toEqual([["open", "http://x"]]);
  });
});

describe("bloque de shell (función co)", () => {
  const base = { node: "/usr/local/bin/node", appRoot: "/repo", home: "/home/u/.agent-router", port: 4317 };
  const variants = {
    darwin: createPlatform("darwin", fakeDeps()).shellBlock(base),
    linux: createPlatform("linux", fakeDeps()).shellBlock(base),
    "linux con perfil 2": createPlatform("linux", fakeDeps()).shellBlock({ ...base, profile2: { dir: "/home/u/.claude-work", alias: "cow", args: ["--channels", "plugin:x@y"] } })
  };
  const has = (bin) => spawnSync(bin, ["-c", "true"]).status === 0;

  for (const [name, body] of Object.entries(variants)) {
    it(`es sintaxis válida para bash: ${name}`, () => {
      const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
    it.skipIf(!has("zsh"))(`es sintaxis válida para zsh: ${name}`, () => {
      const r = spawnSync("zsh", ["-n"], { input: body, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
  }

  it("el segundo perfil usa su alias y sus argumentos", () => {
    expect(variants["linux con perfil 2"]).toContain("cow() {");
    expect(variants["linux con perfil 2"]).toContain('( export CLAUDE_CONFIG_DIR="/home/u/.claude-work"; co "$@" --channels plugin:x@y )');
  });
  it("sin perfil 2 no hay alias extra", () => {
    expect(variants.linux).not.toContain("cop()");
  });
  it("coFunction escapa comillas, $ y ` en el directorio del perfil", () => {
    const f = coFunction({ ...base, personalDir: '/h/a"b$c`d', openLine: 'open "u"' });
    expect(f).toContain('export CLAUDE_CONFIG_DIR="/h/a\\"b\\$c\\`d"');
  });
});

describe("instalador en una plataforma no soportada", () => {
  it.each(["--desinstalar", ""])("en win32 (%j) termina con código ≠0 y el mensaje de WSL, sin tocar nada", (flag) => {
    const script = fileURLToPath(new URL("../bin/instalar.mjs", import.meta.url));
    const code = `Object.defineProperty(process, "platform", { value: "win32" }); await import(${JSON.stringify(script)});`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", ...(flag ? [flag] : [])], { encoding: "utf8", env: { ...process.env, HOME: "/nonexistent-home-for-test", ROUTER_HOME: "/nonexistent-home-for-test/r" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Windows no soportado; usa WSL (funciona como Linux).");
    expect(r.stdout).not.toContain("Instalando");
  });
});
