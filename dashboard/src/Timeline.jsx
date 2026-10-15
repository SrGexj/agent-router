import { PHASES } from "../../src/core/view.mjs";

const NAMES = { recibe: "Recibe", analiza: "Analiza", delega: "Delega", ejecuta: "Ejecuta", revisa: "Revisa", entrega: "Entrega" };

// fills: 0..1 por paso. errorAt: índice del paso donde se paró por fallo o límite.
export default function Timeline({ fills, current, errorAt, paused, onTogglePause, caption }) {
  return (
    <div className="timeline">
      <div className="steps">
        <button className="pause" onClick={onTogglePause} aria-label={paused ? "Reanudar animación" : "Pausar animación"}>
          {paused
            ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L9.6 6z" /></svg>
            : <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="2.5" width="2" height="7" rx="0.6" /><rect x="7" y="2.5" width="2" height="7" rx="0.6" /></svg>}
        </button>
        {PHASES.map((p, i) => (
          <div key={p} className={`step ${i === current ? "on" : ""} ${i === errorAt ? "err" : ""}`}>
            <div className="track"><span style={{ width: `${Math.round((fills[i] ?? 0) * 100)}%` }} /></div>
            <span className="step-name">{NAMES[p]}</span>
          </div>
        ))}
      </div>
      <div className={`caption ${caption.tone}`} aria-live="polite">
        <strong>{caption.title}</strong>
        <p>{caption.text}</p>
      </div>
    </div>
  );
}
