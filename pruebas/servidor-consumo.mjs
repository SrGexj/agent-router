// Arranca el servidor del dashboard con el warehouse de claude-monitor activado (la opción de producción va apagada).
// Solo para pruebas y capturas. Variables: CONSUMO_WAREHOUSE_DIR (carpeta donde el monitor guarda su warehouse),
// ROUTER_MONITOR_BIN, ROUTER_PORT, ROUTER_HOME, HOME. Imprime la misma línea de arranque que server/index.mjs.
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { startServer } from "../server/app.mjs";
import { createMonitorSource, discoverProfiles, execRun } from "../server/monitor.mjs";

const config = loadConfig();
const monitor = createMonitorSource({
  run: execRun, now: Date.now, bin: config.consumo.monitorBin, refreshMs: config.consumo.refreshMs,
  seatUsdMonth: config.consumo.seatUsdMonth, profiles: discoverProfiles(config.userHome, [config.profiles.second?.dir]),
  warehouseDir: process.env.CONSUMO_WAREHOUSE_DIR, timeoutMs: 60_000
});
const srv = await startServer({ store: createStore({ runsDir: config.runsDir }), host: config.host, port: config.port, monitor, profileLabels: config.profileLabels });
console.log(`Agent Router: http://${config.host}:${srv.port}`);
process.on("SIGTERM", async () => { await srv.close(); process.exit(0); });
