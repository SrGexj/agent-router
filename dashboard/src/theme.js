// Tema del dashboard: lógica pura (sin DOM). El script inline de index.html
// repite esta resolución mínima para pintar bien antes de cargar React.
export const PREFS = ["system", "light", "dark"];
export const STORAGE_KEY = "router-theme";

export const normalizePref = (v) => (PREFS.includes(v) ? v : "system");

export function resolveTheme(pref, systemDark) {
  const p = normalizePref(pref);
  if (p === "system") return systemDark ? "dark" : "light";
  return p;
}

export function readPref(storage) {
  try { return normalizePref(storage.getItem(STORAGE_KEY)); } catch { return "system"; }
}

export function savePref(storage, pref) {
  try { storage.setItem(STORAGE_KEY, normalizePref(pref)); return true; } catch { return false; }
}
