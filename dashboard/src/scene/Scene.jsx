import { useEffect, useRef } from "react";
import { barSegments, legendItems, contextTone, contextValue } from "../gauge.js";
import { boxFaces, isoCircle, iso, bezierPoint, bezierPath, easeInOut, shadowLink, LAYA } from "./geometry.js";
import { workerView } from "../../../src/core/view.mjs";
import { spendShare, tokenShare, isWaiting, costBreakdown } from "../../../src/core/details.mjs";
import { runContext, runBusy, contextAdvice } from "../../../src/core/compaction.mjs";
import { fmtDuration, fmtCost, fmtTokens, usageTitle, layaNode, orchestratorSub, ownSubagentsLine, spendPending, workerSub } from "../captions.js";

export const VB = { w: 960, h: 548 };

const N = {
  tu: { x: 205, y: 300 },
  orq: { x: 430, y: 300 },
  asistente: { x: 712, y: 226 },
  programador: { x: 712, y: 402 }
};

const EDGES = {
  in: [[N.tu.x + 22, N.tu.y - 16], [N.tu.x + 85, N.tu.y - 64], [N.orq.x - 80, N.orq.y - 64], [N.orq.x - 18, N.orq.y - 24]],
  asistente: [[N.orq.x + 10, N.orq.y - 26], [N.orq.x + 70, N.orq.y - 100], [N.asistente.x - 150, N.asistente.y - 14], [N.asistente.x - 62, N.asistente.y - 6]],
  programador: [[N.orq.x + 40, N.orq.y - 10], [N.orq.x + 120, N.orq.y + 2], [N.programador.x - 120, N.programador.y - 44], [N.programador.x - 44, N.programador.y - 20]]
};

const LINK = shadowLink(EDGES.in);

const CUBES = [[-30, -28], [4, -32], [34, -20], [-34, 10], [0, 6], [32, 18]];
const CUBE_ORDER = CUBES.map((c, i) => [c, i]).sort((a, b) => a[0][0] + a[0][1] - (b[0][0] + b[0][1]));

const pctX = (x) => `${(x / VB.w) * 100}%`;
const pctY = (y) => `${(y / VB.h) * 100}%`;

function Box({ origin, box, className }) {
  const f = boxFaces(origin, box);
  return (
    <g className={className}>
      <polygon className="face-l" points={f.left} />
      <polygon className="face-r" points={f.right} />
      <polygon className="face-t" points={f.top} />
    </g>
  );
}

function Slab({ origin, w, d, h }) {
  return <Box origin={origin} box={{ x: -w / 2, y: -d / 2, z: -h, w, d, h }} className="slab" />;
}

function Cube({ origin, center, state }) {
  const s = 15;
  return <Box origin={origin} box={{ x: center[0] - s / 2, y: center[1] - s / 2, z: 0, w: s, d: s, h: 13 }} className={`cube ${state}`} />;
}

function Worker({ id, slots }) {
  const o = N[id];
  return (
    <g>
      <Slab origin={o} w={116} d={100} h={14} />
      {CUBE_ORDER.map(([c, i]) => <Cube key={i} origin={o} center={c} state={slots[i]} />)}
    </g>
  );
}

function Orchestrator({ spin }) {
  const o = N.orq;
  const [cx, cy] = iso(o, 0, 0, 10);
  const ring = isoCircle(15);
  return (
    <g>
      <Slab origin={o} w={84} d={84} h={14} />
      <Box origin={o} box={{ x: -25, y: -25, z: 0, w: 50, d: 50, h: 10 }} className="slab raised" />
      <ellipse className="ring" cx={cx} cy={cy} rx={ring.rx} ry={ring.ry} />
      <ellipse className={`ring-spin ${spin}`} cx={cx} cy={cy} rx={ring.rx} ry={ring.ry} pathLength="100" />
    </g>
  );
}

function You({ active }) {
  const o = N.tu;
  const r = isoCircle(4.2);
  const holes = [[-14, -14], [14, -14], [-14, 14], [14, 14]];
  return (
    <g>
      <Slab origin={o} w={64} d={64} h={10} />
      {holes.map(([x, y], i) => {
        const [hx, hy] = iso(o, x, y, 0);
        return (
          <g key={i}>
            <ellipse className="hole" cx={hx} cy={hy} rx={r.rx} ry={r.ry} />
            {active && i === 1 && <circle className="hole-dot" cx={hx} cy={hy} r={1.8} />}
          </g>
        );
      })}
    </g>
  );
}

// Laya (clasificador en sombra): más pequeño y tenue que los nodos principales.
function Laya() {
  const o = { x: LINK.node.x, y: LINK.node.y };
  const [cx, cy] = iso(o, 0, 0, 6);
  const ring = isoCircle(7);
  return (
    <g className="laya">
      <Slab origin={o} w={34} d={34} h={8} />
      <Box origin={o} box={{ x: -10, y: -10, z: 0, w: 20, d: 20, h: 6 }} className="slab raised" />
      <ellipse className="ring" cx={cx} cy={cy} rx={ring.rx} ry={ring.ry} />
    </g>
  );
}

function Pill({ dot, children }) {
  return <span className="pill"><span className={`pdot ${dot}`} />{children}</span>;
}

function Label({ x, y, children, className = "" }) {
  return <div className={`lbl ${className}`} style={{ left: pctX(x), top: pctY(y) }}>{children}</div>;
}

function Spark() {
  return (
    <svg className="spark" viewBox="0 0 16 16" aria-hidden="true">
      {[0, 45, 90, 135].map((a) => <rect key={a} x="7.1" y="1" width="1.8" height="14" rx="0.9" transform={`rotate(${a} 8 8)`} />)}
    </svg>
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function modelName(model, fallback) {
  const m = /(haiku|sonnet|opus|fable)-(\d+)-(\d+)/i.exec(model ?? "");
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : fallback;
}

function workerPill(v, finished) {
  if (v.total === 0) return { dot: "idle", text: finished ? "Sin encargos" : "Libre" };
  if (v.running > 0 && v.failed > 0) return { dot: "warn", text: `${v.running} en curso · ${v.failed} fallo` };
  if (v.running > 0) return { dot: "ok", text: v.running === 1 ? "Trabajando" : `Trabajando · ${v.running}` };
  if (v.last?.status === "failed" || v.last?.status === "killed") return { dot: "err", text: `Falló ${v.failed}/${v.total}` };
  return { dot: "ok", text: `OK ${v.done}/${v.total}` };
}

function orchestratorPill(phase, run) {
  const tasks = run ? run.taskOrder.map((id) => run.tasks[id]) : [];
  const running = tasks.filter((t) => t.status === "running").length;
  if (isWaiting(run) && !["fallo", "limitado", "entrega"].includes(phase)) return { dot: "warn", text: "Esperándote" };
  switch (phase) {
    case "reposo": return { dot: "idle", text: "En espera" };
    case "recibe": return { dot: "ok", text: "Recibiendo" };
    case "analiza": return { dot: "ok", text: "Analizando" };
    case "delega": return { dot: "ok", text: `Delegando ${tasks.length}` };
    case "ejecuta": return { dot: "ok", text: `Esperando ${running} ${running === 1 ? "encargo" : "encargos"}` };
    case "revisa": return { dot: "ok", text: "Revisando" };
    case "entrega": return run.errors.length ? { dot: "warn", text: plural(run.errors.length, "aviso", "avisos") } : { dot: "ok", text: "Sin errores" };
    case "limitado": return { dot: "err", text: "Límite de uso" };
    case "fallo": return { dot: "err", text: run.status === "cancelled" ? "Cancelado" : "Falló" };
    default: return { dot: "idle", text: "" };
  }
}

function ambientDots(edge, now, active, period = 2600, count = 2) {
  if (!active) return [];
  return Array.from({ length: count }, (_, k) => {
    const t = ((now / period) + k / count) % 1;
    return { key: `${edge}-amb-${k}`, p: bezierPoint(EDGES[edge], t), o: Math.min(1, t * 8, (1 - t) * 8) };
  });
}

function packetPoint(pk, now) {
  const raw = (now - pk.born) / pk.dur;
  if (raw < 0 || raw > 1) return null;
  const t = easeInOut(raw);
  const p = bezierPoint(EDGES[pk.edge], pk.dir === 1 ? t : 1 - t);
  return { p, o: Math.min(1, raw * 10, (1 - raw) * 10) };
}

// Barra de 6 px segmentada por familia de modelo; vacía (solo la pista) sin datos.
function Bar({ share }) {
  return (
    <div className="bar">
      {barSegments(share).map((s) => <span key={s.key} className={`seg ${s.key}`} style={{ width: `${s.pct}%` }} />)}
    </div>
  );
}

// Leyenda en una línea con un punto de color por modelo; los modelos al 0 % no salen y sin datos queda «—».
function Legend({ share }) {
  const items = legendItems(share);
  return (
    <div className="legend">
      {items.length === 0 ? <span>—</span> : items.map((i) => <span key={i.key}><i className={`ldot ${i.key}`} />{i.name} <b>{i.pct}%</b></span>)}
    </div>
  );
}

export default function Scene({ run, phase, now, packets }) {
  // En ventanas estrechas la escena se desplaza: empieza centrada en el orquestador.
  const scroller = useRef(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);
  const live = run && !["entrega", "fallo", "limitado", "reposo"].includes(phase);
  const asis = workerView(run, "asistente", now);
  const prog = workerView(run, "programador", now);
  const share = spendShare(run);
  const uso = tokenShare(run);
  const spend = costBreakdown(run).hasData ? costBreakdown(run).total : null;
  const usoTotal = uso ? uso.tokens.opus + uso.tokens.sonnet + uso.tokens.haiku : 0;
  const ctx = runContext(run);
  const advice = ctx ? contextAdvice(ctx.pct, runBusy(run, now)) : null;
  const manual = run?.mode === "manual";

  const spin = !live ? "off" : ["recibe", "analiza", "delega", "revisa"].includes(phase) ? "fast" : "slow";
  const edgeClass = {
    in: phase === "fallo" || phase === "limitado" ? "edge err" : "edge",
    asistente: asis.running === 0 && (asis.last?.status === "failed") && live ? "edge err" : "edge",
    programador: prog.running === 0 && (prog.last?.status === "failed") && live ? "edge err" : "edge"
  };

  const dots = [
    ...ambientDots("in", now, live && ["recibe", "analiza", "revisa"].includes(phase), 2200),
    ...ambientDots("asistente", now, live && asis.running > 0),
    ...ambientDots("programador", now, live && prog.running > 0)
  ];

  const pk = packets.map((p) => ({ ...p, pos: packetPoint(p, now) })).filter((p) => p.pos);
  const orqPill = orchestratorPill(phase, run);
  const youPill = live
    ? { dot: "ok", text: `1 tarea · ${fmtDuration(now - run.startedAt)}` }
    : { dot: "idle", text: !run ? "Sin tareas" : run.mode === "manual" ? `manual · ${run.model}` : run.mode === "sesion" ? "sesión co" : "router CLI" };

  const A = { pill: workerPill(asis, run?.endedAt != null), sub: workerSub(run, "asistente", "Haiku") };
  const P = { pill: workerPill(prog, run?.endedAt != null), sub: workerSub(run, "programador", "Sonnet") };
  const orqSub = orchestratorSub(run);
  const ownLine = ownSubagentsLine(run);
  const laya = layaNode(run, now);
  const spendNote = spendPending(run, share);

  return (
    <div className={`scene-scroll${share || uso || ctx ? " with-gauge" : ""}`} ref={scroller}>
    <div className="scene">
      <svg viewBox={`0 0 ${VB.w} ${VB.h}`} role="img" aria-label="Red de agentes: tú, orquestador, asistente y programador, con Laya en sombra">
        <You active={live} />
        <Orchestrator spin={spin} />
        <Worker id="asistente" slots={asis.slots} />
        <Worker id="programador" slots={prog.slots} />

        {Object.entries(EDGES).map(([id, c]) => <path key={id} className={edgeClass[id]} d={bezierPath(c)} />)}
        {laya && (
          <>
            <Laya />
            <line className="shadow-link" x1={LINK.from[0]} y1={LINK.from[1]} x2={LINK.to[0]} y2={LINK.to[1]} />
            <circle className="shadow-join" cx={LINK.to[0]} cy={LINK.to[1]} r={2.4} />
          </>
        )}

        {dots.map((d) => <circle key={d.key} className="dot" cx={d.p[0]} cy={d.p[1]} r={2.3} opacity={d.o} />)}
        {pk.map((p) => p.kind === "dot"
          ? <circle key={p.id} className="dot hot" cx={p.pos.p[0]} cy={p.pos.p[1]} r={2.8} opacity={p.pos.o} />
          : <circle key={p.id} className={`pk ${p.kind}`} cx={p.pos.p[0]} cy={p.pos.p[1]} r={4.4} opacity={p.pos.o} />)}
      </svg>

      <div className="overlay">
        {pk.filter((p) => p.kind !== "dot").map((p) => (
          <div key={p.id} className={`chip ${p.kind}`} style={{ left: pctX(p.pos.p[0]), top: pctY(p.pos.p[1] + (p.dir === 1 ? -20 : 20)), opacity: p.pos.o }}>{p.label}</div>
        ))}

        {laya && (
          <>
            <Label x={LINK.node.x} y={LAYA.y + LAYA.title} className="laya-title">Laya</Label>
            <Label x={LINK.node.x} y={LAYA.y + LAYA.pill} className="laya-lbl"><span title={laya.title}><Pill dot={laya.dot}>{laya.text}</Pill></span></Label>
            {laya.verdict && <Label x={LINK.node.x} y={LAYA.y + LAYA.verdict} className={`laya-lbl laya-verdict ${laya.verdict.tone}`}>{laya.verdict.text}</Label>}
            <div className="lbl shadow-tag" style={{ left: pctX(LINK.node.x + 8), top: pctY((LINK.from[1] + LINK.to[1]) / 2) }}>sombra</div>
          </>
        )}

        <Label x={N.tu.x} y={N.tu.y + 44} className="title">Tú</Label>
        <Label x={N.tu.x} y={N.tu.y + 68}><Pill dot={youPill.dot}>{youPill.text}</Pill></Label>

        <Label x={N.orq.x} y={N.orq.y + 52} className="title">{manual ? <>Directo · {modelName(run.mainModel, run.model)}</> : <><Spark />Orquestador</>}</Label>
        <Label x={N.orq.x} y={N.orq.y + 76}><Pill dot={orqPill.dot}>{orqPill.text}</Pill></Label>
        {orqSub && <Label x={N.orq.x} y={N.orq.y + 98} className="sub orq-sub">{orqSub}</Label>}
        {ownLine && <Label x={N.orq.x} y={N.orq.y + (orqSub ? 118 : 98)} className="sub orq-own">{ownLine}</Label>}
        <div className="split" style={{ left: pctX(N.orq.x), top: pctY(N.orq.y + 98 + (orqSub ? 22 : 0) + (ownLine ? 20 : 0)) }}>
          <div className="gauge" title={share ? "Reparto del gasto real en dólares (precios API), orquestador incluido" : "Sin datos de uso todavía"}>
            <div className="gauge-head"><span className="gauge-cap">gasto</span><b>{spend != null ? fmtCost(spend) : spendNote ? "…" : "—"}</b></div>
            <Bar share={share} />
            {spendNote ? <div className="gauge-note">{spendNote}</div> : <Legend share={share} />}
          </div>
          {uso && (
            <div className="gauge" title={usageTitle(uso)}>
              <div className="gauge-head"><span className="gauge-cap">uso</span><b>{fmtTokens(usoTotal)}</b></div>
              <Bar share={uso} />
              <Legend share={uso} />
            </div>
          )}
          {ctx && (
            <div className={`gauge gauge-ctx ${contextTone(ctx.pct)}`} title={`Contexto actual: ${ctx.tokens.toLocaleString("es-ES")} tokens de ${(ctx.limit ?? ctx.window).toLocaleString("es-ES")}`}>
              <div className="gauge-head"><span className="gauge-cap">contexto</span><b>{contextValue(ctx)}</b></div>
              <div className="bar"><span className="seg" style={{ width: `${Math.min(100, ctx.pct)}%` }} /></div>
              {advice.text && <div className={`gauge-note ctx-warn ${advice.level}`}>{advice.text}</div>}
            </div>
          )}
        </div>

        <Label x={N.asistente.x} y={98} className="title">Asistente</Label>
        <Label x={N.asistente.x} y={122}><Pill dot={A.pill.dot}>{A.pill.text}</Pill></Label>
        <Label x={N.asistente.x} y={146} className="sub">{A.sub}</Label>

        <Label x={N.programador.x} y={478} className="title">Programador</Label>
        <Label x={N.programador.x} y={502}><Pill dot={P.pill.dot}>{P.pill.text}</Pill></Label>
        <Label x={N.programador.x} y={526} className="sub">{P.sub}</Label>
      </div>
    </div>
    </div>
  );
}
