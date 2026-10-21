import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Scene from "./scene/Scene.jsx";
import Timeline from "./Timeline.jsx";
import { QuotaPanel, HistoryPanel, DetailPanel } from "./Panels.jsx";
import Consumo from "./Consumo.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import { aggregateSavingsByProfile, aggregateShadowByProfile } from "../../src/core/details.mjs";
import { useLive } from "./live.js";
import { ProfileLabels, useProfileLabel, useProfileLabels } from "./profiles.js";
import { Settings, useServerSettings } from "./settings.js";
import { createEngine } from "./engine.js";
import { DEMO_EVENTS, DEMO_LENGTH } from "./demo.js";
import { createAlertNotifier, loadAlertPrefs, saveAlertPrefs } from "./alerts.js";
import { createWebAudioSound, createBrowserNotify, notificationsSupported, requestNotificationPermission, safeStorage } from "./browserAlerts.js";

import { pillStatus } from "./pills.js";

const ICONS = {
  volumeOn: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>,
  volumeOff: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m22 9-6 6M16 9l6 6" /></>,
  bellOn: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  bellOff: <><path d="M8.7 3A6 6 0 0 1 18 8c0 2.7.4 4.6.9 6M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 9-3 9h14M10.3 21a1.9 1.9 0 0 0 3.4 0" /><path d="m2 2 20 20" /></>
};
const Icon = ({ name }) => <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;

function ActiveRuns({ active, onSelect }) {
  const labelOf = useProfileLabel();
  const ref = useRef(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((e) => (e.l === l && e.r === r ? e : { l, r }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, active]);
  const shownId = active.find((p) => p.shown)?.id;
  useEffect(() => {
    const el = ref.current?.querySelector(".run-pill.on");
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [shownId]);
  return (
    <div ref={ref} onScroll={measure} className={`active-runs ${edge.l ? "fade-l" : ""} ${edge.r ? "fade-r" : ""}`} role="group" aria-label="Ejecuciones en curso">
      {active.map((p) => {
        const st = pillStatus(p);
        return (
          <button key={p.id} className={`run-pill ${p.shown ? "on" : ""} ${st.tone}`} aria-pressed={p.shown} onClick={() => onSelect(p.id)} title={p.id}>
            <span className={`pdot ${st.dot}`} />
            <b data-t={p.project}>{p.project}</b>
            {p.profile !== "trabajo" && <em className="run-profile">{labelOf(p.profile)}</em>}
            <span className="run-state">{st.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function AlertControls({ prefs, onToggleSound, onToggleNotifications, denied }) {
  const notifTitle = denied ? "Avisos bloqueados: permiso denegado en el navegador" : prefs.notifications ? "Desactivar avisos del navegador" : "Activar avisos del navegador con la pestaña en segundo plano";
  const soundTitle = prefs.sound ? "Silenciar sonidos" : "Activar sonidos";
  return (
    <div className="seg-ctl alert-ctl" role="group" aria-label="Avisos">
      <button className={`icon-btn ${prefs.sound ? "on" : "off"}`} onClick={onToggleSound} aria-pressed={prefs.sound} aria-label={soundTitle} title={soundTitle}>
        <Icon name={prefs.sound ? "volumeOn" : "volumeOff"} />
      </button>
      {notificationsSupported() && (
        <button className={`icon-btn ${prefs.notifications ? "on" : "off"}`} onClick={onToggleNotifications} aria-pressed={prefs.notifications} aria-label={notifTitle} title={notifTitle}>
          <Icon name={prefs.notifications ? "bellOn" : "bellOff"} />
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [paused, setPaused] = useState(false);
  const [view, setView] = useState("auto"); // auto | demo | <runId>
  const [engine] = useState(() => createEngine({ demoEvents: DEMO_EVENTS, demoLength: DEMO_LENGTH }));

  const onEvent = useCallback((runId, event, run) => engine.onLiveEvent(runId, event, run, Date.now()), [engine]);
  const { runs, quotas, connection, epoch } = useLive(onEvent);
  const profileLabels = useProfileLabels();
  const settings = useServerSettings();

  const [alertPrefs, setAlertPrefs] = useState(() => {
    const p = loadAlertPrefs(safeStorage());
    // Sin permiso concedido no puede haber notificaciones activas.
    return typeof Notification !== "undefined" && Notification.permission !== "granted" ? { ...p, notifications: false } : p;
  });
  const [notifDenied, setNotifDenied] = useState(false);
  const [notifier] = useState(() => createAlertNotifier({
    sound: createWebAudioSound(), notify: createBrowserNotify(), isHidden: () => document.hidden, prefs: alertPrefs
  }));
  useEffect(() => { notifier.setPrefs(alertPrefs); }, [notifier, alertPrefs]);
  useEffect(() => { if (epoch > 0) notifier.sync(runs, epoch); }, [notifier, runs, epoch]);
  const updatePrefs = (patch) => setAlertPrefs((p) => { const n = { ...p, ...patch }; saveAlertPrefs(n, safeStorage()); return n; });
  const toggleNotifications = async () => {
    if (alertPrefs.notifications) { updatePrefs({ notifications: false }); return; }
    const ok = await requestNotificationPermission(); // solo tras un clic del usuario
    setNotifDenied(!ok);
    updatePrefs({ notifications: ok });
  };

  const inputs = useRef({ view, runs, paused });
  useEffect(() => { inputs.current = { view, runs, paused }; }, [view, runs, paused]);

  const [snap, setSnap] = useState(null);
  useEffect(() => {
    let id;
    const loop = () => {
      setSnap(engine.frame({ perfNow: performance.now(), wallNow: Date.now(), ...inputs.current }));
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [engine]);

  const runList = useMemo(() => Object.values(runs).sort((a, b) => b.startedAt - a.startedAt), [runs]);
  const savingsByProfile = useMemo(() => aggregateSavingsByProfile(runList), [runList]);
  const shadowByProfile = useMemo(() => aggregateShadowByProfile(runList), [runList]);
  if (!snap) return null;
  const { mode, run } = snap;
  const live = mode !== "demo" && mode !== "historial";
  const detailRun = (mode === "demo" ? null : run) ?? runList[0] ?? null;

  return (
    <ProfileLabels.Provider value={profileLabels}>
    <Settings.Provider value={settings}>
    <main className="page">
      <section className="card">
        <div className="card-top">
          <ActiveRuns active={snap.active} onSelect={setView} />
          <div className="top-controls">
            {mode === "historial" && <span className="hist-chip">historial</span>}
            <AlertControls prefs={alertPrefs} denied={notifDenied} onToggleSound={() => updatePrefs({ sound: !alertPrefs.sound })} onToggleNotifications={toggleNotifications} />
            <ThemeToggle />
            <div className="seg-ctl" role="group" aria-label="Vista">
              <button className={live ? "on" : ""} aria-pressed={live} onClick={() => setView("auto")}>En vivo</button>
              <button className={view === "demo" ? "on" : ""} aria-pressed={view === "demo"} onClick={() => setView("demo")}>Demo</button>
            </div>
          </div>
        </div>
        <Scene run={run} phase={snap.phase} now={snap.now} packets={snap.packets} />
        <Timeline
          fills={snap.fills} current={snap.current} errorAt={snap.errorAt}
          paused={paused} onTogglePause={() => setPaused((p) => !p)} caption={snap.caption}
        />
      </section>

      <div className="panels">
        <QuotaPanel quotas={quotas} now={snap.wallNow} savingsByProfile={savingsByProfile} shadowByProfile={shadowByProfile} />
        <HistoryPanel runs={runList} selectedId={mode === "demo" ? null : run?.id ?? null} onSelect={setView} now={snap.wallNow} />
      </div>

      <Consumo quotas={quotas} now={snap.wallNow} />

      <DetailPanel run={detailRun} now={snap.wallNow} />

      <footer className="foot">
        <span className={`conn ${connection}`} />
        {connection === "connected" ? `Conectado a ${location.host}` : connection === "connecting" ? "Conectando…" : "Sin conexión con el servidor · reintentando"}
      </footer>
    </main>
    </Settings.Provider>
    </ProfileLabels.Provider>
  );
}
