import { useEffect, useState } from "react";
import { PREFS, normalizePref, resolveTheme, readPref, savePref } from "./theme.js";

const META = {
  system: { label: "Tema del sistema", icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></> },
  light: { label: "Tema claro", icon: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></> },
  dark: { label: "Tema oscuro", icon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" /> }
};
const THEME_COLOR = { dark: "#141414", light: "#f3f1ec" };

const store = () => { try { return window.localStorage; } catch { return undefined; } };
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function apply(pref) {
  const theme = resolveTheme(pref, systemDark());
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export default function ThemeToggle() {
  const [pref, setPref] = useState(() => readPref(store()));

  useEffect(() => {
    apply(pref);
    if (pref !== "system") return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const choose = (p) => { const n = normalizePref(p); setPref(n); savePref(store(), n); };

  return (
    <div className="seg-ctl theme" role="group" aria-label="Tema de color">
      {PREFS.map((p) => (
        <button key={p} type="button" className={pref === p ? "on" : ""} aria-pressed={pref === p} aria-label={META[p].label} title={META[p].label} onClick={() => choose(p)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{META[p].icon}</svg>
        </button>
      ))}
    </div>
  );
}
