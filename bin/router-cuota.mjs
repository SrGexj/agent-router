// Subcomando `router cuota` (lo despacha bin/router.mjs): lee las ejecuciones guardadas, solo lectura, y pinta la tabla.
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { parseCuotaArgs } from "../src/core/cli.mjs";
import { analyzeRun, formatCuotaReport } from "../src/core/cuota.mjs";

export async function main(argv, { now = Date.now() } = {}) {
  let opts;
  try {
    opts = parseCuotaArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const config = loadConfig();
  const store = createStore({ runsDir: config.runsDir });
  try {
    const since = opts.days ? now - opts.days * 86_400_000 : 0;
    const analyses = [];
    for (const id of (await store.listRunIds()).reverse()) {
      const a = analyzeRun(await store.readRun(id));
      if (!a.day || (opts.profile !== "todos" && a.profile !== opts.profile)) continue;
      if (a.startedAt >= since) analyses.push(a);
    }
    console.log(formatCuotaReport(analyses, { verbose: opts.verbose, approx: opts.approx }));
    return 0;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return 1;
  }
}
