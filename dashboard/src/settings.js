// Ajustes del servidor que usa el dashboard (hoy, el umbral de aviso del contexto). Llegan por /api/settings;
// un fallo de red deja los valores por defecto.
import { createContext, useContext, useEffect, useState } from "react";
import { CONTEXT_WARN_TOKENS } from "../../src/core/compaction.mjs";

export const DEFAULT_SETTINGS = { contextWarnTokens: CONTEXT_WARN_TOKENS };
export const Settings = createContext(DEFAULT_SETTINGS);

export const useSettings = () => useContext(Settings);

export function useServerSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  useEffect(() => {
    let closed = false;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!closed && json?.contextWarnTokens > 0) setSettings({ ...DEFAULT_SETTINGS, ...json }); })
      .catch(() => {});
    return () => { closed = true; };
  }, []);
  return settings;
}
