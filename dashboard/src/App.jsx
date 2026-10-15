import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const BADGE = { idle: "EN ESPERA", demo: "DEMO", live: "EN VIVO", historial: "HISTORIAL" };
const PHASE_LABEL = { recibe: "recibiendo", analiza: "analizando", delega: "delegando", ejecuta: "ejecutando", revisa: "revisando", limitado: "límite", fallo: "falló" };

function ActiveRuns({ active, onSelect }) {
  const labelOf = useProfileLabel();
  if (active.length === 0) return null;
  return (
    <div className="active-runs" role="group" aria-label="Ejecuciones en curso">
      {active.map((p) => (
        <button key={p.id} className={`run-pill ${p.shown ? "on" : ""} ${p.alert ? "alert" : ""} ${p.waiting ? "waiting" : ""}`} onClick={() => onSelect(p.id)} title={p.id}>
          <span className={`pdot ${p.waiting ? "wait pulse" : p.alert ? "err pulse" : "ok"}`} />
          <b>{p.project}</b>
          {p.profile !== "trabajo" && <em className="run-profile">{labelOf(p.profile)}</em>}
          <span>{p.waiting ? "pregunta" : p.alert ? "aviso" : PHASE_LABEL[p.phase] ?? p.phase}</span>
        </button>
      ))}
    </div>
  );
}

function AlertControls({ prefs, onToggleSound, onToggleNotifications, denied }) {
  return (
    <div className="seg-ctl alert-ctl" role="group" aria-label="Avisos">
      <button className={prefs.sound ? "on" : ""} onClick={onToggleSound} aria-pressed={prefs.sound} title={prefs.sound ? "Silenciar sonidos" : "Activar sonidos"}>
        {prefs.sound ? "Sonido" : "Silencio"}
      </button>
      {notificationsSupported() && (
        <button className={prefs.notifications ? "on" : ""} onClick={onToggleNotifications} aria-pressed={prefs.notifications}
          title={denied ? "Permiso denegado en el navegador" : "Notificaciones con la pestaña en segundo plano"}>
          {denied ? "Avisos bloqueados" : "Avisos"}
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
  const detailRun = (mode === "demo" ? null : run) ?? runList[0] ?? null;

  return (
    <ProfileLabels.Provider value={profileLabels}>
    <Settings.Provider value={settings}>
    <main className="page">
      <section className="card">
        <div className="card-top">
          <span className={`badge ${mode}`}><span className="pdot" />{BADGE[mode]}{run && mode !== "demo" ? <em>{run.id}</em> : null}</span>
          <AlertControls prefs={alertPrefs} denied={notifDenied} onToggleSound={() => updatePrefs({ sound: !alertPrefs.sound })} onToggleNotifications={toggleNotifications} />
          <ThemeToggle />
          <div className="seg-ctl" role="group" aria-label="Vista">
            <button className={view === "auto" ? "on" : ""} onClick={() => setView("auto")}>En vivo</button>
            <button className={view === "demo" ? "on" : ""} onClick={() => setView("demo")}>Demo</button>
          </div>
        </div>
        <ActiveRuns active={snap.active} onSelect={setView} />
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
