// Etiquetas de los perfiles de cuenta: las define el servidor (config) y llegan por /api/profiles.
// Sin etiqueta conocida se enseña el id tal cual.
import { createContext, useContext, useEffect, useState } from "react";

export const ProfileLabels = createContext({});

export const profileLabel = (labels, id) => labels?.[id] ?? id;

export function useProfileLabel() {
  const labels = useContext(ProfileLabels);
  return (id) => profileLabel(labels, id);
}

// Pide /api/profiles una vez; un fallo de red deja las etiquetas vacías (se ven los ids).
export function useProfileLabels() {
  const [labels, setLabels] = useState({});
  useEffect(() => {
    let closed = false;
    fetch("/api/profiles")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!closed && json?.labels) setLabels(json.labels); })
      .catch(() => {});
    return () => { closed = true; };
  }, []);
  return labels;
}
