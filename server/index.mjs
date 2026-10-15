import { mkdir } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { startServer } from "./app.mjs";
import { createMonitorSource, discoverProfiles, execRun } from "./monitor.mjs";

const config = loadConfig();
const store = createStore({ runsDir: config.runsDir });
if (config.consumo.warehouseDir) await mkdir(config.consumo.warehouseDir, { recursive: true });
const monitor = createMonitorSource({
  run: execRun, now: Date.now, bin: config.consumo.monitorBin, refreshMs: config.consumo.refreshMs, warehouseDir: config.consumo.warehouseDir,
  seatUsdMonth: config.consumo.seatUsdMonth, profiles: discoverProfiles(config.userHome, [config.profiles.second?.dir])
});
const srv = await startServer({ store, host: config.host, port: config.port, monitor, profileLabels: config.profileLabels, accessToken: config.accessToken });

console.log(`Agent Router: http://${config.host}:${srv.port}`);
console.log(`Ejecuciones: ${config.runsDir}`);

const stop = async () => { await srv.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
