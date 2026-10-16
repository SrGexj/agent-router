import { useMemo, useState } from "react";
import { fmtClock, fmtCost, fmtCostFine, fmtDuration, fmtTokens, fmtModel, fmtTokenTypes } from "./captions.js";
import { truncate } from "./packets.js";
import WindowLine from "./WindowLine.jsx";
import { useProfileLabel } from "./profiles.js";
import { useSettings } from "./settings.js";
import { windowLine, savingsLines, shadowLines, quotaBadge } from "./compact.js";
import { isStale } from "../../src/core/view.mjs";
import { runContext, runBusy, contextAdvice, contextWatch, CONTEXT_HELP } from "../../src/core/compaction.mjs";
import { runTitle, promptParts, costBreakdown, shadowVerdict, trainingLabel, taskRows, isWaiting, groupRuns, filterRuns, filterTasks, classifierName } from "../../src/core/details.mjs";

function Window({ kind, w, nowSec }) {
  if (!w) return null;
  const expired = w.resetsAt != null && w.resetsAt <= nowSec;
  return <WindowLine line={windowLine(kind, (w.utilization ?? 0) * 100, w.resetsAt, { expired })} />;
}

function SavingsBlock({ savings }) {
  const s = savingsLines(savings);
  if (!s) return null;
  return (
    <div className="savings">
      <div className="qrow" title={s.title}><span>Ahorro vs solo Opus</span><b>{s.pct}</b></div>
      <div className="qmeta" title={s.title}>{s.detail}</div>
    </div>
  );
}

const ROUTE_NAME = { asistente: "Asistente", programador: "Programador", opus: "Opus" };
const ROUTES = ["asistente", "programador", "opus"];

// Aciertos del clasificador frente a lo que hizo Opus: una línea y el resto plegado. Oculto sin ejecuciones comparables.
function ShadowBlock({ shadow }) {
  const l = shadowLines(shadow);
  if (!l) return null;
  return (
    <div className="savings shadow-sum">
      <div className="qrow" title={l.title}><span>{l.name} <small className="qsmall">{l.ratio}</small></span><b>{l.pct}</b></div>
      <details className="stypes">
        <summary>{l.summary}</summary>
        {l.detail.map((t, i) => <div key={i} className="qmeta" {...(t.startsWith("(no incluye") ? { "data-others": true } : t.startsWith("Datos para") ? { "data-testid": "training-count" } : {})}>{t}</div>)}
        <table className="smatrix">
          <thead><tr><th>{shadow.name} \ real</th>{ROUTES.map((r) => <th key={r}>{ROUTE_NAME[r]}</th>)}</tr></thead>
          <tbody>
            {ROUTES.map((j) => (
              <tr key={j}>
                <th>{ROUTE_NAME[j]}</th>
                {ROUTES.map((r) => <td key={r} className={j === r ? "diag" : ""}>{shadow.byPair[j]?.[r] ?? 0}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const profileOrder = (a, b) => (a === "trabajo" ? -1 : b === "trabajo" ? 1 : a.localeCompare(b));

// Una cuota por cuenta: trabajo (co) y personal (cop) tienen límites y ahorros distintos, así que cada
// cuenta lleva sus ventanas, su ahorro y su clasificador en sombra. Con una sola cuenta, sin cabecera.
export function QuotaPanel({ quotas, now, savingsByProfile, shadowByProfile }) {
  const labelOf = useProfileLabel();
  const entries = Object.entries(quotas ?? {}).sort(([a], [b]) => profileOrder(a, b));
  const names = [...new Set([...entries.map(([p]) => p), ...Object.keys(savingsByProfile ?? {}), ...Object.keys(shadowByProfile ?? {})])].sort(profileOrder);
  const anySavings = Object.values(savingsByProfile ?? {}).some((s) => s?.runs > 0);
  return (
    <section className="panel">
      <header><h2>Cuota</h2></header>
      {names.map((profile) => {
        const q = quotas?.[profile];
        const badge = quotaBadge(q);
        return (
          <div key={profile} className="qprofile" data-profile={profile}>
            {(names.length > 1 || badge) && (
              <div className="qhead">
                {names.length > 1 && <h3>{labelOf(profile)}</h3>}
                {badge && <span className="pill"><span className={`pdot ${badge.dot}`} />{badge.text}</span>}
              </div>
            )}
            {q && <Window kind="5h" w={q.fiveHour} nowSec={now / 1000} />}
            {q && <Window kind="7d" w={q.sevenDay} nowSec={now / 1000} />}
            <SavingsBlock savings={savingsByProfile?.[profile]} />
            <ShadowBlock shadow={shadowByProfile?.[profile]} />
          </div>
        );
      })}
      {entries.length > 0 ? (
        <p className="note">{anySavings && "Estimado con precios de API; con suscripción no pagas por token. "}Opus delega más cuanto más alta está la cuota de su cuenta.</p>
      ) : (
        <p className="note">Aparece tras la primera respuesta en <code>co</code>, <code>cop</code> o <code>router</code>.</p>
      )}
    </section>
  );
}

const RUN_DOT = { running: "ok pulse", completed: "ok", failed: "err", cancelled: "idle", limited: "err" };
const RUN_TEXT = { running: "en curso", completed: "completada", failed: "falló", cancelled: "cancelada", limited: "límite" };
const WAIT_TEXT = { question: "espera respuesta", permission: "permiso", plan: "plan" };
export const waitText = (run) => WAIT_TEXT[run.waiting?.kind] ?? "espera respuesta";

// "~" marca el coste estimado a partir de los tokens; sin él, es el que informó Claude.
function costMeta(r) {
  const b = costBreakdown(r);
  if (!b.hasData) return null;
  const est = r.usage?.costUsd == null || b.tokens > 0 ? "~" : "";
  return `${est}${fmtCost(b.total)}${b.tokens ? ` · ${fmtTokens(b.tokens)} tok` : ""}`;
}

function RunItem({ r, selectedId, onSelect, now }) {
  const labelOf = useProfileLabel();
  const tasks = r.taskOrder.length;
  const meta = [
    r.profile && r.profile !== "trabajo" ? labelOf(r.profile) : null,
    r.mode === "manual" ? `manual · ${r.model}` : `${tasks} ${tasks === 1 ? "encargo" : "encargos"}`,
    fmtDuration((r.endedAt ?? now) - r.startedAt),
    costMeta(r),
    fmtClock(r.startedAt / 1000)
  ].filter(Boolean).join(" · ");
  const err = r.errors.at(-1);
  const waiting = isWaiting(r);
  const stale = !waiting && isStale(r, now);
  const match = r.status === "running" ? null : shadowVerdict(r).match;
  const name = classifierName(r.shadow?.model);
  return (
    <li>
      <button className={r.id === selectedId ? "sel" : ""} onClick={() => onSelect(r.id)}>
        <span className={`pdot ${waiting ? "wait pulse" : stale ? "warn" : RUN_DOT[r.status] ?? "idle"}`} />
        <span className="rtext">
          <span className="rtask">{truncate(runTitle(r.task), 70)}</span>
          <span className="rmeta">{waiting ? <b className="wait-txt">{waitText(r)}</b> : stale ? "sin señal" : RUN_TEXT[r.status]} · {meta}
            {match != null && <i className={`sdot ${match ? "ok" : "warn"}`} title={match ? `${name} coincide` : `${name} no coincide`} role="img" aria-label={match ? `${name} coincide` : `${name} no coincide`} />}
          </span>
          {err && r.status !== "completed" && <span className="rerr">{truncate(err.message, 90)}</span>}
        </span>
      </button>
    </li>
  );
}

function Chips({ label, value, options, onChange }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map(([k, name]) => (
        <button key={k} type="button" className={value === k ? "on" : ""} aria-pressed={value === k} onClick={() => onChange(k)}>{name}</button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange, label, placeholder }) {
  return <input className="search" type="search" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={placeholder} />;
}

const RUN_STATUS_OPTS = [["all", "Todas"], ["completed", "Completadas"], ["failed", "Fallidas"], ["cancelled", "Canceladas"]];
const NO_RUN_FILTER = { text: "", status: "all", profile: "all" };

function RunGroup({ title, id, items, empty, ...item }) {
  return (
    <div className="rgroup" role="group" aria-labelledby={id}>
      <h3 id={id} className="rghead">{title} <span className="count">{items.length}</span></h3>
      {items.length === 0
        ? (empty ? <p className="rempty">{empty}</p> : null)
        : <ul className="runs">{items.map((r) => <RunItem key={r.id} r={r} {...item} />)}</ul>}
    </div>
  );
}

export function HistoryPanel({ runs, selectedId, onSelect, now }) {
  const labelOf = useProfileLabel();
  const [f, setF] = useState(NO_RUN_FILTER);
  const set = (patch) => setF((cur) => ({ ...cur, ...patch }));
  const profiles = useMemo(() => [...new Set(runs.map((r) => r.profile || "trabajo"))].sort((a, b) => (a === "trabajo" ? -1 : b === "trabajo" ? 1 : a.localeCompare(b))), [runs]);
  const groups = useMemo(() => {
    const g = groupRuns(runs, now);
    return {
      running: filterRuns(g.running, { text: f.text, profile: f.profile }),
      finished: filterRuns(g.finished, f)
    };
  }, [runs, now, f]);
  const filtering = f.text.trim() !== "" || f.status !== "all" || f.profile !== "all";
  const shown = groups.running.length + groups.finished.length;
  const item = { selectedId, onSelect, now };
  return (
    <section className="panel">
      <header><h2>Ejecuciones</h2><span className="count">{filtering ? `${shown}/${runs.length}` : runs.length}</span></header>
      {runs.length === 0 ? (
        <p className="note">Aún no hay ejecuciones. Prueba <code>router "Corrige las erratas del README"</code>.</p>
      ) : (
        <>
          <div className="filters">
            <SearchBox value={f.text} onChange={(text) => set({ text })} label="Buscar ejecuciones" placeholder="Buscar en título y prompt" />
            <Chips label="Estado de las terminadas" value={f.status} options={RUN_STATUS_OPTS} onChange={(status) => set({ status })} />
            {profiles.length > 1 && (
              <Chips label="Perfil" value={f.profile} options={[["all", "Todos"], ...profiles.map((p) => [p, labelOf(p)])]} onChange={(profile) => set({ profile })} />
            )}
          </div>
          <div className="scrolllist runlist">
            <RunGroup title="En curso" id="rg-running" items={groups.running} empty="Nada en curso" {...item} />
            <RunGroup title="Terminadas" id="rg-finished" items={groups.finished} empty={filtering ? "Ninguna coincide con el filtro" : null} {...item} />
          </div>
        </>
      )}
    </section>
  );
}

const TASK_DOT = { running: "ok pulse", completed: "ok", failed: "err", killed: "err" };
const TASK_TEXT = { running: "en curso", completed: "completado", failed: "falló", killed: "falló" };
const ROLES = [
  ["orchestrator", "Orquestador (Opus)"],
  ["programador", "Programador (Sonnet)"],
  ["asistente", "Asistente (Haiku)"],
  ["propio", "Subagentes propios (Explore…)"]
];

function Waiting({ run }) {
  const w = run.waiting;
  const qs = w.questions ?? [];
  return (
    <div className="waiting" role="status">
      <strong><span className="pdot wait pulse" />Esperando tu respuesta en la terminal</strong>
      {qs.length === 0 && w.text ? <p className="wtext">{w.text}</p> : null}
      {qs.map((q, i) => (
        <div key={i} className="wq">
          {q.header && <em>{q.header}</em>}
          <p className="wtext">{q.question}</p>
          <ul>
            {(q.options ?? []).map((o, j) => (
              <li key={j}><b>{o.label}</b>{o.description ? <span>{o.description}</span> : null}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Prompt({ text }) {
  const parts = promptParts(text);
  if (parts.length === 0) return <p className="note">Sin texto.</p>;
  return (
    <div className="dprompt">
      {parts.map((p, i) => p.kind === "text"
        ? <p key={i} className="dtext">{p.text}</p>
        : (
          <details key={i} className="dpasted">
            <summary>Texto pegado · {p.text.split("\n").length} líneas</summary>
            <pre>{p.text}</pre>
          </details>
        ))}
    </div>
  );
}

// Quién debía llevar la tarea: dato de entrenamiento. El cambio llega de vuelta por el WebSocket.
function LabelRow({ run }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const current = trainingLabel(run);
  const send = async (label) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/label`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label })
      });
      if (!res.ok) setError(`No se pudo guardar (${res.status}).`);
    } catch {
      setError("No se pudo guardar: sin conexión con el servidor.");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="labelrow">
      <span className="labelq" id={`label-${run.id}`}>¿Quién debía llevarla?</span>
      <div className="chips" role="group" aria-labelledby={`label-${run.id}`}>
        {ROUTES.map((r) => {
          const on = current?.label === r;
          const auto = on && current.source === "auto";
          return (
            <button key={r} type="button" disabled={sending} aria-pressed={on} data-label={r} className={`${on ? "on" : ""} ${auto ? "auto" : ""}`} onClick={() => send(r)}>
              {ROUTE_NAME[r]}{auto ? " (auto)" : ""}
            </button>
          );
        })}
        {current?.source === "usuario" && <button type="button" className="undo" disabled={sending} onClick={() => send(null)}>Deshacer</button>}
      </div>
      {error && <p className="note shnote labelerr" role="alert">{error}</p>}
    </div>
  );
}

function Shadow({ run }) {
  const v = shadowVerdict(run);
  const finished = run.status !== "running";
  if (!run.shadow && !v.pending && !finished) return null;
  const name = classifierName(run.shadow?.model);
  return (
    <div className="dblock">
      <h4>{run.shadow || v.pending ? `Clasificador en sombra (${name})` : "Etiqueta para entrenar"}</h4>
      {finished && <LabelRow run={run} />}
      {!run.shadow && !v.pending ? null
        : v.na ? <p className="note shnote">No aplica (aviso del sistema)</p>
        : v.pending ? <p className="note shnote">{name === "Clasificador" ? "Consultando al clasificador…" : `Consultando a ${name}…`}</p>
        : v.error && !v.choice ? <p className="note shnote">{name} no pudo clasificar: {v.error}</p>
        : (
          <div className="dshadow">
            <p className="sline">
              {name} eligió: <b>{ROUTE_NAME[v.choice] ?? v.choice}</b>{v.confidence != null ? ` (${Math.round(v.confidence * 100)} %)` : ""}
              {v.actual ? <> · Opus hizo: <b>{ROUTE_NAME[v.actual]}</b>{v.targetSource === "usuario" && v.target !== v.actual ? <> · tu etiqueta: <b>{ROUTE_NAME[v.target]}</b></> : null} → <span className={`stag ${v.match ? "ok" : "warn"}`}>{v.match ? "coincide" : "no coincide"}</span></> : <> · Opus aún no ha terminado</>}
            </p>
            {v.reason && <p className="sreason">{v.reason}</p>}
            <p className="sreason">
              {run.shadow.latencyMs != null ? `Latencia ${(run.shadow.latencyMs / 1000).toFixed(1).replace(".", ",")} s` : ""}
              {run.shadow.costUsd != null ? ` · coste de la llamada ${fmtCostFine(run.shadow.costUsd)}` : ""}
            </p>
            {v.hypotheticalUsd != null && v.savingsUsd != null && (
              <p className="sline">
                Si se le hubiera hecho caso: ~{fmtCostFine(v.hypotheticalUsd)} ({v.savingsUsd >= 0 ? "ahorro" : "sobrecoste"} {fmtCostFine(Math.abs(v.savingsUsd))}) · estimación
              </p>
            )}
            {v.hypotheticalUsd != null && <p className="note shnote">Estimación gruesa: supone los mismos tokens con el modelo elegido; uno más pequeño podría gastar otros o fallar.</p>}
          </div>
        )}
    </div>
  );
}

function Spend({ b }) {
  const roles = ROLES.filter(([k]) => k !== "propio" || b[k].tokens > 0);
  const max = Math.max(...roles.map(([k]) => b[k].costUsd), 0.000001);
  return (
    <div className="dspend">
      {roles.map(([k, name]) => (
        <div key={k} className="srow" title={fmtTokenTypes(b[k].tokenTypes)}>
          <span className="sname">{name}</span>
          <span className="sbar"><span style={{ transform: `scaleX(${b[k].costUsd / max})` }} /></span>
          <b>{fmtCost(b[k].costUsd)}</b>
          <span className="stok">{fmtTokens(b[k].tokens)} tok</span>
        </div>
      ))}
      <div className="srow total" title={fmtTokenTypes(b.tokenTypes)}>
        <span className="sname">Total</span><span />
        <b>{fmtCost(b.total)}</b>
        <span className="stok">{fmtTokens(b.tokens)} tok</span>
      </div>
      <details className="stypes">
        <summary>Tokens por tipo</summary>
        <p>{fmtTokenTypes(b.tokenTypes)}</p>
      </details>
      {b.savingsUsd != null && (
        <p className="ssave">Si todo fuera Opus: {fmtCost(b.opusEquivalentUsd)} · ahorro {Math.round(b.savingsPct)} %</p>
      )}
      <p className="note">
        Estimado con precios de API{b.complete ? "" : " · parcial: faltan datos de uso"}. Con suscripción no pagas por token: es el equivalente en API.
      </p>
    </div>
  );
}

// Contexto actual y compactaciones, aparte del gasto: la llamada que resume no queda en el transcript, es una estimación.
function Context({ run, b, now }) {
  const ctx = runContext(run);
  const watch = contextWatch(run, useSettings().contextWarnTokens);
  const c = b.compactions;
  if (!ctx && !c) return null;
  const advice = ctx ? contextAdvice(ctx.pct, runBusy(run, now)) : null;
  return (
    <div className="dblock">
      <h4>Contexto y compactaciones</h4>
      {ctx && (
        <div className={`ctxrow ${ctx.level}`}>
          <div className="qrow"><span>Contexto actual</span><b>{ctx.pct} %</b></div>
          <div className={`qbar ${ctx.level === "ok" ? "" : ctx.level === "warn" ? "warn" : "err"}`}><span style={{ transform: `scaleX(${Math.min(1, ctx.pct / 100)})` }} /></div>
          <div className="qmeta">
            {fmtTokens(ctx.tokens)} de {fmtTokens(ctx.limit ?? ctx.window)} tok{ctx.limit ? ` (autocompact; ventana ${fmtTokens(ctx.window)})` : ""}
          </div>
          {watch?.over && (
            <p className="ctxwarn over" role="alert">
              Contexto del orquestador por encima del umbral: {fmtTokens(watch.tokens)} de {fmtTokens(watch.warnTokens)} tok. Cada turno relee todo: conviene delegar o compactar.
            </p>
          )}
          {advice.text && <p className="ctxwarn">{advice.text[0].toUpperCase() + advice.text.slice(1)}</p>}
          {advice.text && <p className="note">{CONTEXT_HELP}</p>}
        </div>
      )}
      {c && (
        <div className="dspend">
          <div className="srow total">
            <span className="sname">{c.count} {c.count === 1 ? "compactación" : "compactaciones"} ({c.auto} auto · {c.manual} manual)</span><span />
            <b>{fmtCost(c.costUsd)}</b>
            <span className="stok">{fmtTokens(c.tokens)} tok</span>
          </div>
          {c.pct != null && <p className="note">Suponen un {c.pct < 10 ? c.pct.toFixed(1).replace(".", ",") : Math.round(c.pct)} % del gasto total de la sesión (resto + compactaciones){c.partial ? " · parcial: algún modelo sin precio" : ""}.</p>}
          <ul className="asked">
            {c.items.map((i) => (
              <li key={i.id ?? i.t}>
                <span className="aq">{i.trigger === "manual" ? "Manual" : "Auto"} · {fmtTokens(i.preTokens)} → {fmtTokens(i.postTokens)} tok{i.durationMs != null ? ` · ${fmtDuration(i.durationMs)}` : ""}</span>
                <span className="aa">{i.costUsd != null ? fmtCostFine(i.costUsd) : "sin precio"} · {fmtTokens(i.tokens)} tok</span>
              </li>
            ))}
          </ul>
          <p className="note">Estimado: la llamada que genera el resumen no queda en el transcript. Entrada = contexto previo leído de caché; salida según el tamaño del resumen. No incluido en el gasto de arriba.</p>
        </div>
      )}
    </div>
  );
}

const TASK_STATUS_OPTS = [["all", "Todos"], ["running", "En curso"], ["completed", "Completados"], ["failed", "Fallidos"]];
const TASK_AGENT_OPTS = [["all", "Todos"], ["asistente", "Asistente"], ["programador", "Programador"], ["propio", "Propios"]];
const NO_TASK_FILTER = { text: "", status: "all", agent: "all" };

// Con key={run.id} desde el padre: al cambiar de ejecución los filtros se reinician.
function Tasks({ rows }) {
  const [f, setF] = useState(NO_TASK_FILTER);
  const set = (patch) => setF((cur) => ({ ...cur, ...patch }));
  const done = rows.filter((r) => r.status === "completed").length;
  const shown = useMemo(() => filterTasks(rows, f), [rows, f]);
  const filtering = f.text.trim() !== "" || f.status !== "all" || f.agent !== "all";
  return (
    <div className="dblock">
      <h4>Encargos <span className="count">{done} de {rows.length} completados{filtering ? ` · mostrando ${shown.length}` : ""}</span></h4>
      {rows.length === 0 ? <p className="note">Opus no ha delegado nada todavía.</p> : (
        <>
          <div className="filters">
            <SearchBox value={f.text} onChange={(text) => set({ text })} label="Buscar encargos" placeholder="Buscar en descripción, encargo y resultado" />
            <Chips label="Estado del encargo" value={f.status} options={TASK_STATUS_OPTS} onChange={(status) => set({ status })} />
            <Chips label="Agente" value={f.agent} options={TASK_AGENT_OPTS} onChange={(agent) => set({ agent })} />
          </div>
          {shown.length === 0 ? <p className="rempty">Ningún encargo coincide con el filtro</p> : (
            <ul className="dtasks scrolllist">
              {shown.map((t) => (
                <li key={t.id}>
                  <details>
                    <summary>
                      <span className={`pdot ${TASK_DOT[t.status] ?? "idle"}`} />
                      <span className="tmain">
                        <span className="tdesc">{t.description || t.agent}</span>
                        <span className="tmeta">
                          {TASK_TEXT[t.status] ?? t.status} · {t.agent} · {fmtModel(t.model)}
                          {t.durationMs != null ? ` · ${fmtDuration(t.durationMs)}` : ""}
                          {t.costUsd != null ? ` · ${fmtCost(t.costUsd)}` : ""}
                          {t.tokens ? ` · ${fmtTokens(t.tokens)} tok` : ""}
                        </span>
                      </span>
                    </summary>
                    <div className="tbody">
                      {t.tokenTypes && <p className="note">{fmtTokenTypes(t.tokenTypes)}</p>}
                      <h5>Encargo</h5>
                      <pre>{t.prompt || "—"}</pre>
                      <h5>Resultado</h5>
                      <pre>{t.result || "—"}</pre>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function DetailPanel({ run, now }) {
  const labelOf = useProfileLabel();
  if (!run) return null;
  const b = costBreakdown(run);
  const rows = taskRows(run, now);
  const waiting = isWaiting(run);
  const asked = run.asked ?? [];
  const stale = !waiting && isStale(run, now);
  const meta = [
    run.profile ? labelOf(run.profile) : null,
    fmtDuration((run.endedAt ?? now) - run.startedAt),
    fmtClock(run.startedAt / 1000)
  ].filter(Boolean).join(" · ");
  return (
    <section className="panel detail" aria-label="Detalle de la ejecución">
      <header>
        <h2>Detalle</h2>
        <span className="pill">
          <span className={`pdot ${waiting ? "wait pulse" : stale ? "warn" : RUN_DOT[run.status] ?? "idle"}`} />
          {waiting ? waitText(run) : stale ? "sin señal" : RUN_TEXT[run.status]}
        </span>
      </header>
      <h3 className="dtitle">{runTitle(run.task)}</h3>
      <p className="dmeta">{meta}</p>

      {waiting && <Waiting run={run} />}
      {asked.length > 0 && (
        <div className="dblock">
          <h4>Preguntas anteriores</h4>
          <ul className="asked">
            {asked.map((a, i) => (
              <li key={i}>
                <span className="aq">{truncate(a.text, 160)}</span>
                <span className={`aa ${a.answer ? "" : "none"}`}>{a.answer ? truncate(a.answer, 160) : "sin respuesta"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="dblock">
        <h4>Prompt</h4>
        <Prompt text={run.task} />
      </div>

      <div className="dblock">
        <h4>Gasto</h4>
        {b.hasData ? <Spend b={b} /> : <p className="note">Esta ejecución no tiene datos de uso.</p>}
      </div>

      <Context run={run} b={b} now={now} />

      <Shadow run={run} />

      <Tasks key={run.id} rows={rows} />
    </section>
  );
}
