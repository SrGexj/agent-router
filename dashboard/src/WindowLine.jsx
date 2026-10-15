// Ventana de cuota en una línea: etiqueta corta, barra fina, % y hora de reinicio. La comparten Cuota y Consumo.
export default function WindowLine({ line }) {
  return (
    <div className="wline" title={line.title}>
      <abbr className="wl-name" title={line.title}>{line.label}</abbr>
      <div className={`qbar ${line.tone}`}><span style={{ transform: `scaleX(${Math.min(line.pct, 100) / 100})` }} /></div>
      <b className="wl-pct">{line.pctText}</b>
      <span className="wl-reset">{line.reset}</span>
    </div>
  );
}
