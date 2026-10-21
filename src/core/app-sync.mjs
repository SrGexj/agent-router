// Ejecuta el plan de la copia estable. La E/S entra inyectada: run(cmd, args, cwd) → { status, stdout, stderr } y exists(path).
import { join } from "node:path";
import { planAppSync } from "./app-copy.mjs";

export function syncApp({ appRoot, repoRoot, run, exists, log = () => {} }) {
  const out = (cwd, ...args) => { const r = run("git", ["-C", cwd, ...args]); return r.status === 0 ? String(r.stdout ?? "").trim() : null; };
  const appExists = exists(join(appRoot, ".git"));
  if (!appExists && exists(appRoot)) return { ok: false, reason: `${appRoot} existe y no es un worktree de git: muévelo o bórralo y vuelve a ejecutarlo.` };
  const mainHead = out(repoRoot, "rev-parse", "main");
  if (!mainHead) return { ok: false, reason: `No encuentro la rama main en ${repoRoot}.` };
  const plan = planAppSync({
    appRoot, repoRoot, appExists, mainHead,
    appHead: appExists ? out(appRoot, "rev-parse", "HEAD") : null,
    appClean: !appExists || out(appRoot, "status", "--porcelain") === "",
    distExists: exists(join(appRoot, "dashboard/dist/index.html"))
  });
  if (!plan.ok) return plan;
  for (const { cmd, args, cwd } of plan.steps) {
    log(`${cmd} ${args.join(" ")}`);
    const r = run(cmd, args, cwd);
    if (r.status !== 0) return { ok: false, reason: `falló ${cmd} ${args.join(" ")}: ${String(r.stderr ?? "").trim().split("\n").pop()}` };
  }
  return { ok: true, changed: plan.changed };
}
