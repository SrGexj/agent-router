# Agent Router

Router y orquestador para Claude Code que reparte los encargos entre Opus (orquestador), Sonnet (programador) y Haiku (asistente), con un dashboard en vivo (escena, gasto por modelo, cuota, contexto y compactaciones, sonidos y avisos, tema claro u oscuro) y un clasificador en sombra opcional (Laya).

> **Aviso.** Proyecto experimental. Depende de formatos internos de Claude Code (hooks, transcripts, statusline, `stream-json`) que pueden cambiar sin previo aviso.

## Requisitos

Comunes:

- Node 24 con npm.
- Claude Code (`claude`) en el PATH.

Opcionales:

- `claude-monitor` 4.x (`pip install --user claude-monitor`) para el panel Consumo.
- Python 3.12 o superior y unos 1 GB libres para Laya.

Por sistema:

- **macOS**: usa launchd y zsh. Para Laya, `brew install python@3.12`.
- **Linux**: usa servicios de usuario de systemd (`systemctl --user`) y bash o zsh. `xdg-open` es opcional (abre el dashboard). Para que el servicio siga activo sin sesión abierta, `loginctl enable-linger $USER`.
- **WSL**: activa systemd en `/etc/wsl.conf` (`[boot]` con `systemd=true`) y reinicia WSL. Después, sigue los pasos de Linux.
- **Windows nativo**: no soportado. Usa WSL.

## Instalación

```bash
git clone https://github.com/SrGexj/agent-router.git
cd agent-router
npm install
npm run instalar
```

Después abre una terminal nueva y usa `co`.

El instalador:

- Crea la copia estable `~/.agent-router/app` (ver "Copia estable") y deja ahí el dashboard construido.
- Escribe los hooks y la statusline de `co` en `~/.agent-router/co-settings.json`.
- Mantiene tu statusline: su comando se guarda en `~/.agent-router/statusline-next` y se sigue mostrando en `co`.
- Enlaza `asistente.md`, `programador.md` y `consultor.md` en `~/.claude/agents`. No pisa los que ya existan.
- Enlaza `~/bin/router` (debe estar en tu PATH).
- Añade la función `co` al rc del shell (`~/.zshrc` en macOS; `~/.zshrc` o `~/.bashrc` en Linux). Antes guarda una copia en `~/.agent-router/`.
- Instala el dashboard como servicio (`com.agent-router.server`) en http://127.0.0.1:4317, siempre activo.
- Si hay Python 3.12 o superior, instala Laya como servicio local (`com.agent-router.laya`, en 127.0.0.1:4318). Si falla, avisa y el resto de la instalación sigue.

Avisos:

- Reinstalar reinicia el servicio del dashboard y corta las sesiones `co` que estén en curso.
- Si cambias de versión de Node con nvm, vuelve a ejecutar `npm run instalar`: el servicio usa la ruta del Node con el que se instaló.

## Copia estable

Los hooks, la statusline, el servicio del dashboard, los enlaces de los agentes y `~/bin/router` no apuntan a este repo sino a `~/.agent-router/app`: un `git worktree` de `main` en HEAD desatado, con sus `node_modules` de producción y el `dashboard/dist` ya construido. Así, cambiar de rama o dejar un merge a medias aquí no rompe las sesiones `co` y `cop` en marcha (las dos usan el mismo `co-settings.json` y la misma copia).

- Actualizar a `origin/main` (hace `git fetch origin`; sin red usa el `main` local y avisa): `router actualizar` (o `npm run instalar -- --actualizar`). Mueve la copia, reconstruye y reinicia el dashboard.
- No edites nada dentro de `~/.agent-router/app`: si tiene cambios sin confirmar, la actualización y la desinstalación paran y avisan.
- Las sesiones `co` ya abiertas siguen con la copia anterior hasta que las cierres.

## Desinstalación

```bash
npm run desinstalar                   # o: npm run instalar -- --desinstalar
```

Quita:

- El bloque de `co` del rc (con copia previa).
- Los servicios del dashboard y de Laya.
- Los enlaces de los agentes y `~/bin/router`, solo si apuntan a este proyecto o a la copia estable.
- La copia estable `~/.agent-router/app` (`git worktree remove`; si tiene cambios sin confirmar, avisa y la deja).
- `co-settings.json` y `statusline-next`.

No borra:

- `~/.agent-router` (ejecuciones, sesiones, logs, histórico de claude-monitor). El instalador lo indica al final.
- `~/.agent-router/laya-venv` y `~/.agent-router/hf`. Bórralos a mano si no los quieres.

## Uso

### Orquestador desde la línea de comandos: `router`

```bash
router "Añade validación al formulario de registro y actualiza el changelog"
router --model haiku "Corrige las erratas del README"   # un solo modelo, sin orquestador
router --effort high "Revisa la arquitectura de autenticación"
router --agentes-usuario "…"                            # usa tus agentes de ~/.claude/agents
```

Sin `--model`, Opus orquesta. Con `--model` se usa un único modelo (`haiku`, `sonnet` u `opus`).

### Cuota por ejecución: `router cuota`

Compara cuánta cuota (5 h y 7 d) gasta cada orquestador (Sonnet frente a Opus, etc.). Cada ejecución guarda la cuota conocida de su cuenta al empezar (`run_start.quota`) y al terminar (`run_end.quota`, junto con `mainModel` y `byModel`, los tokens por modelo y tipo), tomada de la última lectura de la statusline; sin dato guarda `null`. Sirve igual para `co` y `cop` (el perfil va en el evento y el informe agrupa por perfil, porque cada cuenta tiene su propia cuota).

```bash
router cuota                       # todos los días
router cuota --dias 7 --perfil trabajo
router cuota --detalle             # lista cada run no fiable con su motivo
router cuota --aprox               # incluye runs anteriores al registro (cuota aproximada)
```

Tabla por día, orquestador y perfil: nº de runs, runs con delta completo, puntos porcentuales por run (fin menos inicio) y sumados, tokens del orquestador y de subagentes, encargos y puntos por encargo. Se ignoran los runs que cruzan un reset, abiertos o sin dato, y se cuentan como NO FIABLES. Límites: la statusline da la cuota en puntos enteros, y si usas la misma cuenta en otra sesión a la vez, sus gastos también suman al delta.

### Sesiones interactivas: `co`

`co` es `claude` en modo orquestador y acepta sus mismas opciones:

```bash
co                    # en cualquier proyecto
```

Cada mensaje tuyo es una ejecución en el dashboard, desde el mensaje hasta `Stop`. Las sesiones normales de `claude` no cambian: los hooks y la statusline van solo por `--settings` en `co`.

En un proyecto con su propio `.claude/agents/asistente.md`, `programador.md` o `consultor.md`, Claude Code usa esos en lugar de los genéricos.

**Segundo perfil (opcional).** Si defines `ROUTER_PROFILE2_DIR` con la carpeta de config de otra cuenta antes de ejecutar `npm run instalar` (si la carpeta existe), el instalador añade el alias `cop` (o el que indiques en `ROUTER_PROFILE2_ALIAS`). `cop` ejecuta `co` con `CLAUDE_CONFIG_DIR` apuntando a esa carpeta y con los argumentos de `ROUTER_PROFILE2_ARGS`.

### Dashboard

El dashboard corre como servicio en http://127.0.0.1:4317. La primera sesión `co` lo abre en el navegador.

Sin ejecuciones activas, reproduce una demo. Durante una ejecución pasa a **EN VIVO** y, al terminar, deja el resultado un minuto en pantalla. El historial permite volver a cualquier ejecución.

Para desarrollar el dashboard: `npm start` (o el servicio) en una terminal y `npm run dev` en otra. Vite hace proxy de `/api` y `/ws` al puerto 4317.

Coste por modelo: `router` lo calcula con exactitud. En `co`, los hooks no lo dan y el reparto se aproxima por número de encargos hasta que llega cada `result`.

### Modo sombra (Laya)

Un clasificador anota qué modelo habría elegido para cada encargo, sin cambiar nada. Con Laya instalada se activa solo (`ROUTER_SHADOW=auto`). Proveedores: `laya` (local) o `jev` (vía OpenRouter, con la clave en `~/.agent-router/openrouter.key`).

```bash
router laya-datos [--out archivo.csv] [--perfil <id>|todos]   # exporta las ejecuciones etiquetadas
router laya-entrenar [--perfil P] [--forzar] [--simular]      # ajusta Laya con laya-train y compara con el base
router laya-usar CARPETA | --quitar                           # anota qué checkpoint usar
```

## Configuración

Solo `src/config.mjs` lee variables de entorno. El resto del código recibe la configuración ya resuelta.

| Variable | Por defecto | Efecto |
|---|---|---|
| `HOME` | tu carpeta personal | Base de `~/.agent-router`, `~/.claude` y los rc del shell. |
| `SHELL` | vacío | En Linux decide el rc del instalador: `zsh` → `.zshrc`; cualquier otro valor (o vacío) → `.bashrc`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Perfil activo de Claude Code. Determina la etiqueta del perfil en el dashboard. |
| `ROUTER_HOME` | `~/.agent-router` | Datos, logs y ejecuciones (`runs/`). |
| `ROUTER_HOST` | `127.0.0.1` | Host del servidor. Un valor no local exige `ROUTER_ALLOW_REMOTE=1`. |
| `ROUTER_PORT` | `4317` | Puerto del dashboard. |
| `ROUTER_ALLOW_REMOTE` | sin definir | `1` permite un host no local. |
| `ROUTER_ACCESS_TOKEN` | sin definir | Token de 32 caracteres o más para exponer el dashboard por un túnel (Cloudflare). Sin definir, o si es más corto, no hay autenticación (aviso en stderr). Con él, todo acceso que no sea local directo exige la cookie `router_token`; abre una vez `https://tu-túnel/?token=<valor>` y se guarda 30 días. |
| `ROUTER_PERMISSION_MODE` | `auto` | `acceptEdits`, `auto`, `manual`, `dontAsk` o `plan`. `bypassPermissions` no está permitido. |
| `ROUTER_EFFORT` | sin definir | Esfuerzo por defecto: `low`, `medium`, `high`, `xhigh` o `max`. |
| `ROUTER_FALLBACK_MODEL` | `sonnet` | Modelo de respaldo si Opus está saturado. |
| `ROUTER_MAX_BUDGET_USD` | sin tope | Tope de gasto por ejecución. |
| `CLAUDE_BIN` | `claude` | Binario de Claude Code. |
| `ROUTER_RELEVO_TOKENS` | `150000` | Contexto (tokens) de la sesión principal a partir del cual el orquestador escribe un archivo de relevo en `<ROUTER_HOME>/relevo/<perfil>/<proyecto>.md` y te pide abrir un `co`/`cop` nuevo, que lo recibe al arrancar. La statusline y el dashboard muestran «relevo». |
| `ROUTER_SEAT_USD` | sin definir | Precio mensual de tu plan. Sin él no se muestra «Rendimiento del seat». |
| `ROUTER_MONITOR_BIN` | `claude-monitor` | Ruta de claude-monitor. El instalador fija la ruta absoluta si la encuentra. |
| `ROUTER_MONITOR_WAREHOUSE` | activo | `0` apaga el histórico de claude-monitor (sin totales por día, semana y mes). |
| `ROUTER_SHADOW` | `auto` | `auto`: activo si Laya está instalada. `1` lo fuerza; `0` lo apaga. |
| `ROUTER_SHADOW_PROVIDER` | `laya` | `laya` (local) o `jev` (OpenRouter). |
| `ROUTER_SHADOW_MODEL` | `typesafe/jev-1.13` | Solo con `jev`, vía OpenRouter. |
| `ROUTER_LAYA_URL` | `http://127.0.0.1:4318/v1/systemone` | Endpoint de Laya. |
| `ROUTER_LAYA_VENV` | `~/.agent-router/laya-venv` | Entorno Python de Laya. |
| `ROUTER_LAYA_HF_HOME` | `~/.agent-router/hf` | Caché de modelos de Hugging Face de Laya. |
| `ROUTER_LAYA_PYTHON` | sin definir | Intérprete Python 3.12 o superior para crear el venv. Sin él, busca `python3.12` y luego `python3`. |
| `ROUTER_PROFILE_LABEL` | `Principal` | Etiqueta del perfil principal. |
| `ROUTER_PROFILE2_DIR` | sin definir | Carpeta de config de un segundo perfil de Claude Code (otra cuenta). |
| `ROUTER_PROFILE2_LABEL` | derivada de la carpeta (`~/.claude-X` → `X`) | Etiqueta del segundo perfil. |
| `ROUTER_PROFILE2_ALIAS` | `cop` | Nombre del alias del segundo perfil. Letras, números, `-` y `_`; distinto de `co`. |
| `ROUTER_PROFILE2_ARGS` | vacío | Argumentos extra para `claude` en ese perfil (por ejemplo, canales). |
| `ROUTER_PROFILE_BROWSER_ID` | sin definir | `deviceId` (UUID) del navegador de Claude in Chrome del perfil principal. Si se define, el prompt del orquestador le manda ejecutar `select_browser` con ese id antes de usar el navegador. |
| `ROUTER_PROFILE2_BROWSER_ID` | sin definir | Lo mismo para el segundo perfil (`cop`). Cada perfil usa solo su id. |

### Dónde se definen

Pásalas al instalar y quedan guardadas:

```bash
ROUTER_SEAT_USD=20 npm run instalar
```

El instalador las escribe en `~/.agent-router/config.env` (permisos `0600`; una línea `CLAVE=valor`, `#` para comentarios, sin expansión de variables). Las claves ya guardadas se conservan salvo que las vuelvas a pasar; un valor vacío (`ROUTER_PROFILE2_ARGS=""`) se guarda vacío. Servidor, hooks, statusline, `co` y `router` leen ese mismo archivo, así que todos ven la misma configuración.

También puedes editar `config.env` a mano; reinicia con `npm run instalar` para que el servicio del dashboard lo recoja. Precedencia: variable del entorno > `config.env` > valor por defecto. `ROUTER_HOME` no se lee del archivo (con él se localiza) y las claves que no estén en la tabla de arriba se ignoran con un aviso. `HOME`, `SHELL` y `CLAUDE_CONFIG_DIR` tampoco: son del entorno de cada proceso. `npm run desinstalar` no borra `config.env`.

## Cómo reparte Opus

El prompt del orquestador (`src/core/prompt.mjs`) le pide:

1. Leer lo justo para entender la tarea.
2. Dividirla en encargos autocontenidos, con un criterio de aceptación comprobable.
3. Hacer él solo lo que exige criterio: arquitectura, autenticación, cifrado, migraciones y borrados.
   Para decisiones de diseño o de riesgo que no quiera resolver en su contexto, puede pedir una recomendación corta al `consultor` (Opus, solo lectura).
4. Lanzar en paralelo lo independiente. Usa `isolation: "worktree"` solo si hay repositorio git y dos programadores van a tocar los mismos archivos.
5. Revisar cada resultado y reintentar o asumir lo que falle.

**Cuota.** El router lee el último `rate_limit_event` guardado y lo incluye en el prompt. Con una ventana (5 h o 7 días) por encima del 70 % el nivel es «alta»; por encima del 90 %, «crítica», y el prompt cambia para repartir más trabajo en Haiku.

Los perfiles de los subagentes están en `src/agents/*.md` (mismo formato que `~/.claude/agents`). `router` los pasa con `--agents` y sustituyen a tus agentes del mismo nombre, salvo con `--agentes-usuario`.

## Estados y límites

- Estados de una ejecución: `running` → `completed`, `failed`, `cancelled` (Ctrl+C) o `limited`.
- `limited`: Claude Code emite `rate_limit_event` con `status: "rejected"`, o el texto de error menciona un límite de uso («usage limit», «limit reached»). El dashboard muestra la ventana agotada y la hora de reinicio.
- Los permisos denegados y los errores de API quedan en el historial.
- El reparto depende del criterio de Opus. Es mejor que las palabras clave, pero no es infalible. Revisa el historial.
- Orquestar con Opus tiene un coste fijo por ejecución (su turno y el contexto inicial). Para tareas triviales, `router --model haiku` sale más barato.
- El coste por modelo solo llega con cada `result` (en `router`). En `co` se aproxima por número de encargos.
- Windows nativo no está soportado; usa WSL.

## Desarrollo y pruebas

```bash
npm test              # Vitest: parser con un stream real, reducer, prompt, store, servidor, motor del dashboard
npm run coverage      # informe en terminal y HTML/lcov en coverage/
npm run lint          # ESLint; process.env solo en src/config.mjs
npm run build && npm run e2e   # puppeteer-core: router → servidor → dashboard con un claude falso
```

El E2E necesita Chrome. Usa el de `~/.cache/puppeteer` o define `CHROME_PATH`. Para instalar el de `~/.cache/puppeteer`:

```bash
npx --yes @puppeteer/browsers install chrome-headless-shell@stable --path "$HOME/.cache/puppeteer"
```

`pruebas/fake-claude.mjs` reproduce `test/fixtures/stream-subagente.jsonl`, un stream capturado de Claude Code 2.1.299. Ningún test llama a Claude.

CI (`.github/workflows/ci.yml`) corre en cada PR y en `main`, en Ubuntu y macOS: lint, coverage y build. El E2E solo corre en Ubuntu.

## Licencia y créditos

Licencia MIT. Copyright (c) 2026 Juan Antonio Jiménez. Ver [LICENSE](LICENSE).

Las dependencias y los componentes de terceros (Laya de Convai Innovations, claude-monitor, Claude Code de Anthropic, las tipografías Inter y JetBrains Mono, entre otros) están listados en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
