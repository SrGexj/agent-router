// Copia estable de la app: un `git worktree` de main (HEAD desatado) en <home>/app. Hooks, statusline, server y
// enlaces apuntan ahí y no al repo de desarrollo, así que cambiar de rama o dejar un merge a medias no rompe las
// sesiones co/cop en marcha. Todo puro: el instalador ejecuta los pasos y aporta los hechos del disco.

export const MAIN_BRANCH = "main";

export const appRootFor = (home) => `${home}/app`;

// Rutas de lo que arranca el router, todas colgando de la raíz de la app que se le pase.
export function appPaths(appRoot) {
  return {
    hook: `${appRoot}/bin/router-hook.mjs`,
    statusline: `${appRoot}/bin/router-statusline.mjs`,
    server: `${appRoot}/server/index.mjs`,
    router: `${appRoot}/bin/router.mjs`,
    agent: (name) => `${appRoot}/src/agents/${name}.md`
  };
}

const step = (cmd, args, cwd) => ({ cmd, args, ...(cwd && { cwd }) });

// Pasos para dejar la copia en la punta de main. Hechos de entrada (los lee el instalador):
//   appExists, appClean (git status vacío), appHead, mainHead (SHAs), distExists (dashboard/dist/index.html).
// Si hay que mover el HEAD o falta el dist: npm ci completo (vite es devDependency), build y poda a producción.
export function planAppSync({ appRoot, repoRoot, appExists, appClean, appHead, mainHead, distExists }) {
  if (appExists && !appClean) {
    return { ok: false, steps: [], reason: `La copia estable ${appRoot} tiene cambios sin confirmar. No toques ahí: descártalos o confírmalos y vuelve a ejecutarlo.` };
  }
  const moves = !appExists || appHead !== mainHead;
  if (!moves && distExists) return { ok: true, steps: [], changed: false };
  const steps = [];
  if (!appExists) steps.push(step("git", ["-C", repoRoot, "worktree", "add", "--detach", appRoot, MAIN_BRANCH]));
  else if (moves) steps.push(step("git", ["-C", appRoot, "checkout", "--detach", MAIN_BRANCH]));
  steps.push(
    step("npm", ["ci", "--no-audit", "--no-fund"], appRoot),
    step("npm", ["run", "build"], appRoot),
    step("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], appRoot)
  );
  return { ok: true, steps, changed: true };
}

// Qué hacer con un enlace simbólico que debería apuntar a `target`. current: null si no existe, o { symlink, target }.
// legacyTargets: destinos antiguos (el repo de desarrollo) que se migran a la copia.
export function planLink({ current, target, legacyTargets = [], backupForeign = false }) {
  if (!current) return "create";
  if (current.symlink && current.target === target) return "keep";
  if (current.symlink && legacyTargets.includes(current.target)) return "replace";
  return backupForeign ? "backup" : "skip";
}

// Quitar la copia al desinstalar: `git worktree remove` sin --force (se niega si hay cambios sin confirmar, y se avisa).
export function planAppRemove({ appRoot, repoRoot, appExists, appClean }) {
  if (!appExists) return { ok: true, steps: [] };
  if (!appClean) return { ok: false, steps: [], reason: `La copia estable ${appRoot} tiene cambios sin confirmar; no la quito. Descártalos o bórrala a mano (git worktree remove --force).` };
  return { ok: true, steps: [step("git", ["-C", repoRoot, "worktree", "remove", appRoot])] };
}
