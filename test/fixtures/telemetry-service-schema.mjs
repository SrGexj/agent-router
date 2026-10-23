import { z } from "zod";

// Copia del contrato del servicio agent-router-telemetry (src/schema.mjs, schema 1). Solo para validar en tests el documento del cliente; sincronizar a mano si el servicio cambia.
// Etiquetas que acaban en HTML/CSV/SQL: charset cerrado y longitud corta.
const label = z.string().regex(/^[A-Za-z0-9._:@/-]{1,64}$/);
const runId = z.string().regex(/^[A-Za-z0-9._:@/-]{1,100}$/); // cliente: 20261023T100000Z-<pid>-<rand>
const nat = z.number().int().nonnegative();
// Rango razonable en ms (el cliente guarda Date.now()): 2024-01-01 .. 2100-01-01.
const MIN_MS = Date.UTC(2024, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const inRange = (ms) => Number.isFinite(ms) && ms >= MIN_MS && ms < MAX_MS;
const time = z.union([z.iso.datetime({ offset: true }), nat]).refine((t) => inRange(new Date(t).getTime()), "fecha fuera de rango");
// Reset de cuota: epoch en segundos (resets_at del statusline de Claude Code), mismo rango que `time`.
const resetAt = z.number().int().refine((s) => inRange(s * 1000), "reset fuera de rango").nullable();
const STATUS = z.enum(["completed", "failed", "limited", "cancelled"]);
const TASK_STATUS = z.enum(["completed", "failed", "limited", "cancelled", "running"]);

const usageRow = z.strictObject({ model: label, input: nat, output: nat, cacheRead: nat, cacheWrite5m: nat, cacheWrite1h: nat });
const usageList = z.array(usageRow).max(20).refine((a) => new Set(a.map((u) => u.model)).size === a.length, "modelo repetido");

// Porcentaje de cuota en escala 0..100 (el cliente convierte antes de enviar).
const pct = z.number().min(0).max(100).nullable();

const quota = z.strictObject({
  fiveHourPct: pct,
  fiveHourResetsAt: resetAt,
  sevenDayPct: pct,
  sevenDayResetsAt: resetAt
});

const task = z.strictObject({
  idx: nat,
  agent: label.nullable(),
  model: label.nullable(),
  status: TASK_STATUS.nullable(),
  durationMs: nat.nullable(),
  toolUses: nat.nullable(),
  attempt: nat.nullable(),
  usage: usageList.nullable()
});

export const runSchema = z.strictObject({
  schema: z.literal(1),
  runId,
  rev: nat,
  profile: label,
  mode: z.enum(["sesion", "orquestado", "directo"]),
  orchestratorModel: label.nullable(),
  status: STATUS.nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: time,
  endedAt: time.nullable(),
  durationMs: nat.nullable(),
  quotaStart: quota.nullable(),
  quotaEnd: quota.nullable(),
  orchestratorUsage: usageList.nullable(),
  directEdits: nat,
  errorKinds: z.strictObject({ limit: nat, api: nat, permission: nat }),
  tasks: z.array(task).max(500).refine((a) => new Set(a.map((t) => t.idx)).size === a.length, "idx repetido")
});

export const MAX_BATCH = 50;

// Devuelve { ok:true, runs } o { ok:false, error }.
export function parseBatch(body) {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && !Array.isArray(body) ? body.runs : undefined;
  if (body && !Array.isArray(body) && typeof body === "object") {
    const extra = Object.keys(body).filter((k) => k !== "runs");
    if (extra.length) return { ok: false, error: `campo desconocido: ${extra[0]}` };
  }
  if (!Array.isArray(list)) return { ok: false, error: "se espera { runs: [...] } o un array" };
  if (list.length > MAX_BATCH) return { ok: false, error: `máximo ${MAX_BATCH} runs por lote` };
  const runs = [];
  for (const [i, item] of list.entries()) {
    const r = runSchema.safeParse(item);
    if (!r.success) {
      const issue = r.error.issues[0];
      return { ok: false, error: `runs[${i}].${issue.path.join(".")}: ${issue.message}` };
    }
    runs.push(r.data);
  }
  return { ok: true, runs };
}
