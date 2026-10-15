import { useEffect, useState } from "react";
import { fmtClock, fmtCost, fmtModel, fmtTokens } from "./captions.js";
import { forecastVerdict, pickWindows } from "../../src/core/consumo.mjs";
import WindowLine from "./WindowLine.jsx";
import { useProfileLabel } from "./profiles.js";
import { windowLine, toneOf, p90Lines, p90ForecastLine, sourcesLines } from "./compact.js";

const FAMILY_NAME = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", other: "Otros" };
const DEFAULT_REFRESH_MS = 60_000;

// Pide /api/consumo al cargar y cada refreshMs (el que dice el servidor). Un fallo de red no rompe el panel.
export function useConsumo() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let timer;
    let closed = false;
    const load = async () => {
      let wait = DEFAULT_REFRESH_MS;
      try {
        const res = await fetch("/api/consumo");
        if (res.ok) {
          const json = await res.json();
          if (!closed) setData(json);
          if (Number.isFinite(json.refreshMs) && json.refreshMs >= 5000) wait = json.refreshMs;
          if (json.error) wait = Math.min(wait, 15_000);
        }
      } catch { wait = 15_000; }
      if (!closed) timer = setTimeout(load, wait);
    };
    load();
    return () => { closed = true; clearTimeout(timer); };
  }, []);
  return data;
}

const fmtRatio = (r) => `${(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10).toString().replace(".", ",")}×`;

// La estimación del monitor no conoce el plan del usuario: el aviso va al tooltip y a la nota de fuentes.
function Window({ kind, w }) {
  if (!w) return null;
  return <WindowLine line={windowLine(kind, w.usedPct, w.resetsAt, { estimate: w.confidence !== "official", note: w.confidence === "local_estimate" ? "estimación local (puede no reflejar tu plan)" : undefined })} />;
}

function PeriodRow({ label, bucket, mixedNote }) {
  const c = bucket.costUsd;
  return (
    <div className="crow">
      <span>{label}</span>
      <b title={`entrada ${fmtTokens(bucket.tokens.input)} · salida ${fmtTokens(bucket.tokens.output)} · caché ${fmtTokens(bucket.tokens.cacheCreation + bucket.tokens.cacheRead)}`}>{fmtTokens(bucket.tokens.total)} tok</b>
      <em title={mixedNote}>≈ {fmtCost(c.router)}{c.mixed ? "*" : ""}</em>
    </div>
  );
}

function ByModel({ bucket }) {
  if (!bucket.byModel.length) return null;
  return (
    <details className="cmodels">
      <summary>Por modelo (este mes)</summary>
      {bucket.byModel.map((m) => (
        <div key={m.model} className="crow sub">
          <span>{fmtModel(m.model)}</span><b>{fmtTokens(m.tokens.total)} tok</b><em>≈ {fmtCost(m.costUsd.router)}</em>
        </div>
      ))}
    </details>
  );
}

function SeatLine({ seat, seatUsdMonth }) {
  if (!seat || seat.ratio == null) return null;
  const api = seat.savedUsd + seatUsdMonth;
  const where = seat.basis === "router" ? "este mes" : "en el histórico local (~30 días)";
  return (
    <p className="cseat">
      <b>Rendimiento del seat:</b> {where} ~{fmtCost(api)} de API frente a {fmtCost(seatUsdMonth)} del seat → <b className="cratio">{fmtRatio(seat.ratio)}</b>
    </p>
  );
}

function Forecast({ p }) {
  const v = forecastVerdict(p.forecast, p.window5h);
  if (!v) return null;
  const text = v.kind === "agota" ? `A este ritmo la ventana de 5 h se agota a las ${fmtClock(v.at)}` : "A este ritmo no agotas la ventana antes de que se reinicie";
  return <div className="qmeta">{text}</div>;
}

// Medición propia del monitor (plan Custom): la sesión actual frente al P90 de sus sesiones de 5 h de los últimos 8 días.
// No es el límite del plan (va en el tooltip del título). Solo los tokens tienen P90 en la salida del monitor.
function P90Block({ p90 }) {
  const l = p90Lines(p90);
  if (!l) return null;
  const title = <h4 title={l.hint} tabIndex={0}>{l.title}</h4>;
  if (l.unavailable) return <div className="cp90">{title}<div className="qmeta">{l.unavailable}</div></div>;
  const forecast = p90ForecastLine(p90);
  return (
    <div className="cp90">
      {title}
      <div className="qwin">
        <div className="qrow"><b>{l.tokens}</b></div>
        {l.pct != null && <div className={`qbar ${toneOf(l.pct)}`}><span style={{ transform: `scaleX(${Math.min(l.pct, 100) / 100})` }} /></div>}
      </div>
      {l.detail && <div className="qmeta cp90-detail" title={l.detailTitle}>{l.detail}</div>}
      {p90.active ? (forecast && <div className="qmeta cp90-forecast">{forecast}</div>) : <div className="qmeta">Sin sesión activa ahora mismo.</div>}
    </div>
  );
}

function ProfileBlock({ name, p, seatUsdMonth, single, quota, now }) {
  const labelOf = useProfileLabel();
  const win = pickWindows(p, quota, (now ?? 0) / 1000);
  const tk = p.tokens;
  const cur = p.current;
  // "Ritmo actual" sale una sola vez: dentro del bloque P90 si lo trae, y si no, aquí.
  const p90Rate = p.p90?.available && p.p90.active && p.p90.burnRate?.tokensPerMinute != null;
  return (
    <div className="cprofile">
      {!single && <h3>{labelOf(name)}</h3>}
      <WindowsPair win={win} />
      {win.showForecast && <Forecast p={p} />}
      {p.burnRate && !p90Rate && (
        <div className="qmeta">
          Ritmo actual: {p.burnRate.tokensPerMinute != null ? `${fmtTokens(Math.round(p.burnRate.tokensPerMinute))} tok/min` : "—"}
          {p.burnRate.costPerHour != null ? ` · ≈ ${fmtCost(p.burnRate.costPerHour)}/h en API` : ""}
        </div>
      )}

      <P90Block p90={p.p90} />

      <div className="cperiods">
        {tk ? (
          <>
            <PeriodRow label="Hoy" bucket={tk.today} mixedNote="* incluye modelos sin precio propio: se usa el del monitor" />
            <PeriodRow label="Últimos 7 días" bucket={tk.week} mixedNote="* incluye modelos sin precio propio: se usa el del monitor" />
            <PeriodRow label="Este mes" bucket={tk.month} mixedNote="* incluye modelos sin precio propio: se usa el del monitor" />
            <ByModel bucket={tk.month} />
          </>
        ) : (
          <>
            {cur?.tokens && (
              <div className="crow"><span>Sesión de 5 h</span><b>{fmtTokens(cur.tokens.total)} tok</b><em>{cur.costUsd != null ? `≈ ${fmtCost(cur.costUsd)}` : "—"}</em></div>
            )}
            {p.history?.tokens != null && (
              <div className="crow"><span>Histórico local (~30 días)</span><b>{fmtTokens(p.history.tokens)} tok</b><em>{p.history.costUsd != null ? `≈ ${fmtCost(p.history.costUsd)}` : "—"}</em></div>
            )}
            {cur?.byModel?.length > 0 && (
              <details className="cmodels">
                <summary>Por modelo (sesión de 5 h)</summary>
                {cur.byModel.map((m) => (
                  <div key={m.family} className="crow sub"><span>{FAMILY_NAME[m.family] ?? m.family}</span><b>{m.pct != null ? `${m.pct} %` : "—"}</b><em>{m.costUsd != null ? `≈ ${fmtCost(m.costUsd)}` : "—"}</em></div>
                ))}
              </details>
            )}
          </>
        )}
      </div>

      <SeatLine seat={p.seat} seatUsdMonth={seatUsdMonth} />
    </div>
  );
}

function WindowsPair({ win }) {
  return (
    <div className="wlines">
      <Window kind="5h" w={win.window5h} />
      <Window kind="7d" w={win.window7d} />
    </div>
  );
}

// Toda la letra pequeña de fuentes, plegada y una sola vez al final del panel.
function Sources({ entries, quotas, now, seat }) {
  const labelOf = useProfileLabel();
  return (
    <details className="csources">
      <summary>ⓘ De dónde salen los datos</summary>
      {entries.map(([name, p]) => (
        <div key={name} className="qmeta cwhere">
          {entries.length > 1 && <b>{labelOf(name)}: </b>}
          {sourcesLines(p, pickWindows(p, quotas?.[name], (now ?? 0) / 1000)).join(" · ")}
        </div>
      ))}
      <div className="qmeta cwhere">
        {seat != null
          ? <>Precio del seat aproximado ({fmtCost(seat)} al mes), configurable con <code>ROUTER_SEAT_USD</code>. </>
          : <>Sin precio del seat: define <code>ROUTER_SEAT_USD</code> (dólares al mes) para ver el rendimiento frente a la API. </>}
        El equivalente en API es lo que costaría pagar por token; con suscripción no lo pagas.
      </div>
    </details>
  );
}

export function ConsumoPanel({ data, quotas, now }) {
  const entries = Object.entries(data?.profiles ?? {}).sort(([a], [b]) => (a === "trabajo" ? -1 : b === "trabajo" ? 1 : a.localeCompare(b)));
  const seat = data?.seatUsdMonth;
  return (
    <section className="panel consumo" aria-labelledby="consumo-h">
      <header><h2 id="consumo-h">Consumo</h2>{data?.updatedAt && <span className="count">medido {fmtClock(Date.parse(data.updatedAt) / 1000)}</span>}</header>
      {!data && <p className="note">Midiendo con claude-monitor…</p>}
      {data && data.error && entries.length === 0 && <p className="note cerror">Consumo no disponible. {data.error.message}</p>}
      {data && !data.error && entries.length === 0 && <p className="note">Aún no hay datos de uso en las carpetas de Claude Code.</p>}
      {entries.length > 0 && (
        <div className="cgrid">
          {entries.map(([name, p]) => <ProfileBlock key={name} name={name} p={p} seatUsdMonth={seat} single={entries.length === 1} quota={quotas?.[name]} now={now} />)}
        </div>
      )}
      {entries.length > 0 && <Sources entries={entries} quotas={quotas} now={now} seat={seat} />}
    </section>
  );
}

export default function Consumo({ quotas, now }) {
  return <ConsumoPanel data={useConsumo()} quotas={quotas} now={now} />;
}
