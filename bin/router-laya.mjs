// Subcomandos `router laya-datos | laya-entrenar | laya-usar` (los despacha bin/router.mjs).
// Aquí está la E/S real: el store, el reloj y la ejecución de procesos que las funciones de src/core/laya-tools.mjs reciben inyectados.
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/core/store.mjs";
import { parseLayaArgs } from "../src/core/cli.mjs";
import { layaDatos, layaEntrenar, layaUsar } from "../src/core/laya-tools.mjs";

// Lanza un proceso con la salida a la terminal (laya-train imprime su progreso).
const exec = (cmd, args, { env }) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { env, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => resolve({ code: code ?? 1 }));
});

export async function main(argv) {
  let opts;
  try {
    opts = parseLayaArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const config = loadConfig();
  const store = createStore({ runsDir: config.runsDir });
  const log = (m) => console.log(m);
  try {
    if (opts.command === "laya-datos") await layaDatos({ store, opts, log });
    else if (opts.command === "laya-entrenar") {
      const res = await layaEntrenar({ store, config, exec, now: Date.now(), opts, log });
      return res.refused || res.failed ? 1 : 0;
    } else {
      const res = await layaUsar({ config, opts, log });
      return res.ok ? 0 : 1;
    }
    return 0;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return 1;
  }
}
