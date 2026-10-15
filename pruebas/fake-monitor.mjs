#!/usr/bin/env node
// Doble de claude-monitor 4.x para las pruebas E2E: imprime la salida real guardada en test/fixtures.
// Con --view entries devuelve el informe del warehouse con los días desplazados para que acaben en hoy.
// El perfil personal (--data-paths con ".claude-personal") sale con otro porcentaje, para distinguirlos.
import { readFileSync } from "node:fs";

const fx = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8"));
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const pad = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

if (args.includes("--version")) {
  console.log("claude-monitor 4.0.0");
} else if (arg("--view") === "entries") {
  const report = fx("monitor-entries.json");
  const days = [...new Set(report.entries.map((e) => e.day))].sort();
  const last = new Date(`${days.at(-1)}T12:00:00`);
  const today = new Date();
  const shift = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12) - last) / 86_400_000);
  for (const e of report.entries) {
    const d = new Date(`${e.day}T12:00:00`);
    d.setDate(d.getDate() + shift);
    e.day = key(d);
  }
  console.log(JSON.stringify(report));
} else {
  const snap = fx("monitor-once.json");
  if (String(arg("--data-paths")).includes(".claude-personal")) {
    snap.limits.five_hour.used_percentage = 55;
    snap.limits.seven_day = { used_percentage: 12, tokens_used: null, token_limit: null, resets_at_epoch: Math.floor(Date.now() / 1000) + 3 * 86_400, source: { kind: "statusline" }, confidence: "official" };
  }
  console.log(JSON.stringify(snap));
}
