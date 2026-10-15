// Avisos del dashboard: detección pura de eventos (estado anterior vs nuevo) y un notificador
// con sonido y notificación del navegador detrás de interfaces inyectables.

export const ALERT_ORDER = ["limit", "error", "delivered", "task_done"];
export const DEFAULT_PREFS = { sound: true, notifications: false };
export const PREFS_KEY = "router.alerts";
export const ANTISPAM_MS = 1000;

const TITLES = {
  task_done: "Encargo terminado",
  delivered: "Tarea entregada",
  error: "Error en una ejecución",
  limit: "Límite de uso alcanzado"
};

const projectOf = (run) => (run.cwd ? run.cwd.split("/").filter(Boolean).pop() : null) ?? run.id;
const ended = (s) => s && s !== "running";

// Devuelve avisos agrupados por tipo: [{ type, count, runId, title, body }].
// Sin estado anterior (carga inicial) no hay transiciones, así que no avisa de nada.
export function detectAlerts(prevRuns, nextRuns) {
  if (!prevRuns || !nextRuns) return [];
  const found = [];
  for (const [id, next] of Object.entries(nextRuns)) {
    const prev = prevRuns[id];
    if (!prev || prev === next) continue; // una ejecución nueva arranca en "running": nada que avisar
    const body = projectOf(next);
    const push = (type, detail) => found.push({ type, runId: id, body: detail ? `${body} · ${detail}` : body });
    const cancelled = next.status === "cancelled";

    if (next.limit && !prev.limit) push("limit");
    if ((next.errors?.length ?? 0) > (prev.errors?.length ?? 0)) {
      const fresh = next.errors.slice(prev.errors?.length ?? 0).filter((e) => e.kind !== "limit");
      if (fresh.length && !cancelled) push("error", fresh[fresh.length - 1].message);
    }
    for (const tid of next.taskOrder ?? []) {
      const t = next.tasks[tid];
      const was = prev.tasks?.[tid]?.status;
      if (!ended(t.status) || ended(was)) continue;
      if (t.status === "completed") push("task_done", t.description || t.agent);
      else if (!cancelled) push("error", t.description || t.agent);
    }
    if (prev.status === "running" && ended(next.status)) {
      if (next.status === "completed") push("delivered", (next.task ?? "").slice(0, 80));
      else if (next.status === "failed") push("error");
      else if (next.status === "limited" && !prev.limit && !next.limit) push("limit");
    }
  }

  const groups = new Map();
  for (const a of found) {
    const g = groups.get(a.type);
    if (g) { g.count += 1; g.runId = a.runId; if (a.body) g.body = a.body; } else groups.set(a.type, { ...a, count: 1 });
  }
  return ALERT_ORDER.filter((t) => groups.has(t)).map((t) => {
    const g = groups.get(t);
    return { type: t, count: g.count, runId: g.runId, title: g.count > 1 ? `${TITLES[t]} (${g.count})` : TITLES[t], body: g.body };
  });
}

// sound: { play(type) } · notify: { show(title, body) } · now(): ms · isHidden(): boolean
export function createAlertNotifier({ sound, notify, now = Date.now, isHidden = () => false, prefs = DEFAULT_PREFS }) {
  let current = { ...DEFAULT_PREFS, ...prefs };
  let prev = null;
  let epoch = null;
  const lastPlayed = {};

  return {
    setPrefs(p) { current = { ...current, ...p }; },
    // runs: mapa id → ejecución; epoch cambia en cada "hello" del servidor (carga o reconexión).
    sync(runs, nextEpoch) {
      const baseline = prev === null || nextEpoch !== epoch;
      const before = prev;
      prev = runs;
      epoch = nextEpoch;
      if (baseline) return [];
      const alerts = detectAlerts(before, runs);
      const t = now();
      const fresh = alerts.filter((a) => lastPlayed[a.type] === undefined || t - lastPlayed[a.type] >= ANTISPAM_MS);
      for (const a of fresh) lastPlayed[a.type] = t;
      if (fresh.length === 0) return alerts;
      if (current.sound) sound?.play(fresh[0].type);
      if (current.notifications && isHidden()) for (const a of fresh) notify?.show(a.title, a.body);
      return alerts;
    }
  };
}

export function loadAlertPrefs(storage) {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw);
    return {
      sound: typeof p.sound === "boolean" ? p.sound : DEFAULT_PREFS.sound,
      notifications: typeof p.notifications === "boolean" ? p.notifications : DEFAULT_PREFS.notifications
    };
  } catch { return { ...DEFAULT_PREFS }; }
}

export function saveAlertPrefs(prefs, storage) {
  try { storage?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* sin almacenamiento: se ignora */ }
}
