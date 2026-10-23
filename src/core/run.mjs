// Lanza Claude Code, traduce su stream a eventos y los guarda. spawn, store, reloj y salida
// se inyectan para poder probarlo sin llamar a Claude de verdad.
import { createInterface } from "node:readline";
import { createParser } from "./parser.mjs";
import { buildOrchestratorPrompt } from "./prompt.mjs";
import { buildClaudeArgs } from "./cli.mjs";
import { quotaSnapshot } from "./hooks.mjs";

const pad = (n) => String(n).padStart(2, "0");

export function makeRunId(nowMs, pid, rand) {
  const d = new Date(nowMs);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `${stamp}-${pid}-${rand}`;
}

function fmtReset(resetsAt) {
  if (!resetsAt) return "";
  const d = new Date(resetsAt * 1000);
  return ` (se reinicia a las ${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

function terminalLine(ev, names) {
  switch (ev.type) {
    case "task_start":
      names.set(ev.taskId, `${ev.agent} · ${ev.description}`);
      return `→ ${ev.agent} · ${ev.description}\n`;
    case "task_end": {
      const name = names.get(ev.taskId) ?? ev.taskId;
      const secs = ev.durationMs != null ? ` (${Math.round(ev.durationMs / 1000)} s)` : "";
      return ev.status === "completed" ? `✓ ${name}${secs}\n` : `✗ ${name}${secs}: ${ev.summary}\n`;
    }
    case "thinking":
      return ev.text ? `${ev.text}\n` : "";
    case "error":
      return ev.kind === "limit" ? `! Límite de uso alcanzado${fmtReset(ev.resetsAt)}\n` : `! ${ev.message}\n`;
    default:
      return "";
  }
}

export async function runTask({ task, mode, model, effort = null, agents = null, config, store, spawn, now, out, cwd = undefined, runId, signal = undefined, profile = "trabajo", browser = null }) {
  const quota = mode === "orquestado" ? await store.latestQuota(profile) : null;
  // Cuota conocida al empezar (cualquier modo): referencia para medir cuánto gasta el run.
  const startQuota = quotaSnapshot(mode === "orquestado" ? quota : await store.latestQuota(profile));
  const systemPrompt = mode === "orquestado" ? buildOrchestratorPrompt({ agents, quota, now: now(), browser }) : null;
  const args = buildClaudeArgs({ mode, model, systemPrompt, agents, config, effort });

  const writes = [];
  // La cuota es de la cuenta (perfil) con la que corre claude.
  const emit = (ev) => { writes.push(store.append(runId, ev.type === "quota" ? { ...ev, profile } : ev)); };
  emit({ type: "run_start", runId, task, mode, model, cwd: cwd ?? null, profile, quota: startQuota, t: now() });

  const parser = createParser();
  const names = new Map();
  let stderrTail = "";
  let sawError = false;
  let cancelled = false;

  const exitCode = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.claudeBin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      emit({ type: "error", kind: "api", message: e.message, t: now() });
      resolve(1);
      return;
    }

    const cancel = () => { cancelled = true; child.kill("SIGINT"); };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });

    child.on("error", (e) => {
      const message = e.code === "ENOENT" ? `${config.claudeBin} no está en el PATH` : e.message;
      emit({ type: "error", kind: "api", message, t: now() });
      sawError = true;
      resolve(127);
    });

    child.stdin?.on?.("error", () => {});
    child.stdin?.end(task);

    child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const ev of parser.pushLine(line, now())) {
        if (ev.type === "error") sawError = true;
        emit(ev);
        out.write(terminalLine(ev, names));
      }
    });

    child.on("close", (code) => {
      rl.close();
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0 && !sawError && !cancelled && stderrTail.trim()) {
    emit({ type: "error", kind: "api", message: stderrTail.trim(), t: now() });
  }

  await Promise.all(writes); // la cuota del cierre incluye los eventos quota de este mismo run
  const endEvent = { type: "run_end", exitCode, quota: quotaSnapshot(await store.latestQuota(profile)), mainModel: model, t: now() };
  if (cancelled) endEvent.status = "cancelled";
  emit(endEvent);
  await Promise.all(writes);

  const events = await store.readRun(runId);
  const limited = events.some((e) => e.type === "error" && e.kind === "limit");
  const status = cancelled ? "cancelled" : limited ? "limited" : exitCode === 0 ? "completed" : "failed";
  return { runId, exitCode, status };
}
