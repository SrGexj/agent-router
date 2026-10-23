// Subcomando `router telemetry flush|status` (lo despacha bin/router.mjs). Nunca imprime el token ni sale con error por fallos de red.
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { parseTelemetryArgs } from "../src/core/cli.mjs";
import { flushTelemetry, telemetryStatus } from "../src/core/telemetry-flush.mjs";

export async function main(argv, { now = Date.now, fetch = globalThis.fetch } = {}) {
  let opts;
  try {
    opts = parseTelemetryArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  try {
    const config = loadConfig();
    const store = createStore({ runsDir: config.runsDir });
    if (opts.action === "flush") {
      const r = await flushTelemetry({ config, store, fetch, now });
      if (r.skipped) console.log(`Telemetría: ${r.skipped === "desactivada" ? "desactivada, nada que enviar" : "ya hay un envío en curso"}.`);
      else console.log(`Telemetría: enviados ${r.sent}, rechazados ${r.rejected}${r.stopped ? `, parado (${r.stopped}; ver telemetry-errors.log)` : ""}.`);
      return 0;
    }
    const s = await telemetryStatus({ config, store, now });
    if (!s.enabled) {
      console.log("Telemetría: desactivada. Se activa con ROUTER_TELEMETRY_URL (https) y ROUTER_TELEMETRY_TOKEN.");
      return 0;
    }
    console.log([
      `Telemetría: activada (${s.url})`,
      `  pendientes: ${s.pending}`,
      `  enviados: ${s.sent}`,
      `  rechazados: ${s.rejected}`,
      ...(s.lastErrors.length ? ["  últimos errores:", ...s.lastErrors.map((l) => `    ${l}`)] : [])
    ].join("\n"));
    return 0;
  } catch (e) {
    console.error(`Telemetría: ${e.message}`);
    return 0; // la telemetría nunca debe romper nada
  }
}
