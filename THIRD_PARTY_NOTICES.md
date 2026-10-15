# Avisos de terceros

Este proyecto se distribuye bajo licencia MIT (ver `LICENSE`). Este documento recoge las licencias de las dependencias y de los componentes de terceros que usa el proyecto.

Las licencias de las dependencias npm se han leído del campo `license` de cada `package.json` instalado en `node_modules` (270 paquetes en total). No se ha encontrado ninguna dependencia con licencia GPL o AGPL.

## 1. Dependencias npm directas

### Ejecución (`dependencies`)

| Paquete | Versión | Licencia |
|---|---|---|
| chokidar | 4.0.3 | MIT |
| express | 5.3.0 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| ws | 8.22.0 | MIT |

### Desarrollo y pruebas (`devDependencies`)

| Paquete | Versión | Licencia |
|---|---|---|
| @eslint/js | 10.0.1 | MIT |
| @vitejs/plugin-react | 6.1.2 | MIT |
| @vitest/coverage-v8 | 5.0.4 | MIT |
| eslint | 10.12.0 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| globals | 17.13.0 | MIT |
| puppeteer-core | 25.13.0 | Apache-2.0 |
| supertest | 7.3.1 | MIT |
| vite | 8.3.4 | MIT |
| vitest | 5.0.4 | MIT |

Estas dependencias solo se usan en desarrollo y no forman parte del código fuente distribuido.

## 2. Dependencias transitivas

Resumen por tipo de licencia de las 270 dependencias instaladas:

| Licencia | Nº de paquetes | Observaciones |
|---|---|---|
| MIT | 219 | Permisiva. |
| Apache-2.0 | 19 | Permisiva. Incluye `puppeteer-core` y `@puppeteer/browsers`, entre otros. |
| ISC | 18 | Permisiva. |
| BSD-2-Clause | 6 | Permisiva. |
| BSD-3-Clause | 4 | Permisiva. Incluye `devtools-protocol`, `esquery`, `qs` y `source-map-js`. |
| BlueOak-1.0.0 | 1 | Permisiva. Solo `minimatch`. |
| MPL-2.0 | 2 | Copyleft a nivel de archivo. Ver abajo. |
| CC-BY-4.0 | 1 | Datos con atribución. Ver abajo. |

**MPL-2.0 (copyleft a nivel de archivo).** Lo usan `lightningcss` y `lightningcss-darwin-arm64`, dependencias transitivas de Vite (`lightningcss` 1.33.0). El proyecto no modifica esos archivos. Su código fuente está publicado en npm y en su repositorio público.

**CC-BY-4.0.** Lo usa `caniuse-lite` 1.0.30001816 (datos de compatibilidad de navegadores, dependencia transitiva de herramientas de build). Requiere atribución, que se da con este aviso.

## 3. Componentes opcionales (no incluidos en el repositorio)

Se descargan o instalan solo si el usuario activa la funcionalidad correspondiente (`npm run instalar`). No se distribuyen en este repositorio.

- **laya** (paquete Python), Apache-2.0, Convai Innovations.
- **Modelo `convaiinnovations/laya-multilingual`** (Hugging Face). Licencia: consultar la ficha del modelo en Hugging Face. La licencia no consta en la copia local, así que no se ha verificado.
- **PyTorch**, licencia de tipo BSD.
- **transformers** (Hugging Face), Apache-2.0.

## 4. Herramientas externas

Se usan solo si están instaladas o configuradas en el equipo del usuario. No se distribuyen con el proyecto.

- **Claude Code** (Anthropic). Se rige por los términos de Anthropic.
- **claude-monitor** (paquete pip). Ver su licencia en su repositorio o en PyPI.
- **OpenRouter** y el modelo `typesafe/jev-1.13`. Servicios externos. Se rigen por sus propios términos de uso.

## 5. Tipografías

El dashboard carga desde Google Fonts (CDN):

- **Inter**, SIL Open Font License 1.1.
- **JetBrains Mono**, SIL Open Font License 1.1.

Las tipografías no se incluyen en el repositorio. Se sirven desde el CDN de Google.

## 6. Sonidos

Los sonidos del dashboard se generan por código con la Web Audio API. No hay ficheros de audio de terceros.
