// Perfiles de subagente en markdown con frontmatter (mismo formato que ~/.claude/agents)
// convertidos al objeto que acepta `claude --agents`.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function unquote(v) {
  const s = v.trim();
  return (s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;
}

export function parseAgentMarkdown(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("Perfil de agente sin frontmatter (--- ... ---)");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = unquote(line.slice(i + 1));
  }
  if (!meta.name) throw new Error("Perfil de agente sin name");
  if (!meta.description) throw new Error(`Perfil ${meta.name} sin description`);

  const agent = { name: meta.name, description: meta.description };
  if (meta.model) agent.model = meta.model;
  if (meta.tools) agent.tools = meta.tools.split(",").map((t) => t.trim()).filter(Boolean);
  agent.prompt = m[2].trim();
  return agent;
}

export function agentsFromFiles(texts) {
  const out = {};
  for (const text of texts) {
    const { name, ...rest } = parseAgentMarkdown(text);
    out[name] = rest;
  }
  return out;
}

export async function loadAgents(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const texts = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
  return agentsFromFiles(texts);
}
