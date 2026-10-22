// Bloque de shell con la función `co` (y el alias del segundo perfil). Una sola sintaxis válida para bash y zsh.
export const SHELL_START = "# >>> agent-router (co) >>>";
export const SHELL_END = "# <<< agent-router (co) <<<";

// Dentro de comillas dobles de shell: solo \ " $ ` son especiales.
export const dq = (s) => String(s).replace(/[\\"$`]/g, "\\$&");

// openLine: la orden que abre el dashboard (la aporta cada plataforma). profile2: { dir, alias, args }.
export function coFunction({ node, appRoot, home, port = 4317, personalDir = null, alias = "cop", personalArgs = [], openLine = null }) {
  const open = openLine ?? `open "http://127.0.0.1:${port}"`;
  const co = `# Claude Code en modo orquestador: el orquestador reparte entre asistente (Haiku) y programador (Sonnet).
# La primera sesión co abre el dashboard; las siguientes no repiten pestaña.
co() {
  pgrep -qf "agent-router/co-settings.json" || ${open}
  command claude --append-system-prompt "$("${node}" "${appRoot}/bin/router.mjs" --prompt)" --settings "${home}/co-settings.json" "$@"
}`;
  if (!personalDir) return co;
  return `${co}
# Igual que co, con el segundo perfil (CLAUDE_CONFIG_DIR) y sus argumentos extra.
# El subshell evita que CLAUDE_CONFIG_DIR se quede exportada en tu terminal.
# --channels admite varios valores: va al final para que no se trague tus argumentos.
${alias}() {
  ( export CLAUDE_CONFIG_DIR="${dq(personalDir)}"; co "$@"${personalArgs.map((a) => ` ${a}`).join("")} )
}`;
}

export function withoutBlock(text) {
  const start = text.indexOf(SHELL_START);
  if (start === -1) return text;
  const end = text.indexOf(SHELL_END, start);
  if (end === -1) return text;
  const before = text.slice(0, start).replace(/\n+$/, "");
  const after = text.slice(end + SHELL_END.length).replace(/^\n/, "");
  return (before ? `${before}\n` : "") + after;
}

export function withBlock(text, body) {
  const clean = withoutBlock(text);
  const sep = clean === "" || clean.endsWith("\n") ? "" : "\n";
  return `${clean}${sep}\n${SHELL_START}\n${body}\n${SHELL_END}\n`;
}

// Cuerpo del bloque a partir de las opciones del instalador: { node, appRoot, home, port, profile2: { dir, alias, args } | null }.
export function shellBlockFor(opts, openLine) {
  const { node, appRoot, home, port = 4317, profile2 = null } = opts;
  return coFunction({ node, appRoot, home, port, openLine, personalDir: profile2?.dir ?? null, alias: profile2?.alias, personalArgs: profile2?.args ?? [] });
}
