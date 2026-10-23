// Semillas versionadas para el entrenamiento de Laya. Compensan que el histórico real casi no trae algunas clases:
// opus (planificar, diseñar, valorar riesgos, revisión delicada), asistente (encargos acotados con criterio claro de
// bien/mal) y programador (código ya decidido). Texto sin rutas, correos ni claves.
// `origin`: "manual" (escrito a mano) o "historico" (extraído del histórico real y anonimizado; revisar antes de añadir).
// `label`: asistente | programador | opus. Una semilla sin etiqueta cuenta como opus.
const manual = (label) => (text) => ({ text, label, origin: "manual" });

const OPUS = [
  // Planificar (más de 3 pasos)
  "Planifica la migración de la API de Express 4 a Express 5: inventario de rutas y middlewares, orden de cambios, estrategia de pruebas y plan de vuelta atrás. Sin escribir código todavía.",
  "Necesito un plan por fases para pasar el backend de JavaScript a TypeScript sin parar las entregas. Define fases, criterios de salida de cada una y qué módulos van primero.",
  "Prepara el plan de lanzamiento de la v2 de la app: cambios de base de datos, feature flags, comunicación a usuarios, monitorización y checklist de despliegue. Ordena los pasos y las dependencias.",
  "Diseña el plan para dividir el monolito en módulos independientes: qué se extrae primero, cómo se mantienen los contratos y cómo se prueba cada corte.",
  "Quiero añadir pagos con suscripción. Antes de tocar código, propón el plan completo: modelo de datos, webhooks, reintentos, impagos, pruebas y despliegue por etapas.",
  "Hay que unificar tres repositorios en uno. Elabora el plan paso a paso: historial, CI, dependencias compartidas, orden de migración de los equipos y riesgos.",
  "Planifica cómo añadir soporte multi idioma a toda la aplicación: extracción de textos, formato de fechas y números, rutas, SEO y qué se traduce a mano o automáticamente.",
  // Diseño y arquitectura
  "Decide la arquitectura de notificaciones en tiempo real: websockets, SSE o polling. Compara coste, escalado y complejidad operativa y recomienda una con sus razones.",
  "Diseña el modelo de datos para un sistema de reservas con aforo limitado, listas de espera y cancelaciones. Explica cómo evitar sobreventa con peticiones simultáneas.",
  "¿Cómo estructuramos los permisos de la aplicación: roles fijos, permisos por recurso o políticas? Propón un diseño y sus límites antes de implementar nada.",
  "Propón el diseño de una caché para el listado de productos: qué se cachea, cómo se invalida, qué pasa con datos obsoletos y cómo se mide el beneficio.",
  "Define la arquitectura para sincronizar datos offline en la app móvil y resolver conflictos entre dispositivos. Valora alternativas y elige.",
  "Tenemos que elegir entre una cola de trabajos en base de datos o un broker externo para los envíos de correo. Analiza pros y contras con nuestro volumen y recomienda.",
  "Diseña la estrategia de versionado de la API pública para no romper a los clientes existentes: cabeceras o rutas, política de deprecación y comunicación.",
  "Rediseña la estructura de carpetas y capas del proyecto, que ha crecido sin orden. Propón la organización objetivo, las reglas de dependencia y cómo llegar sin parar el desarrollo.",
  // Valorar riesgos
  "Valora los riesgos de seguridad del flujo de login y recuperación de contraseña actual: fuerza bruta, enumeración de usuarios, caducidad de tokens y almacenamiento de sesiones.",
  "Antes de ejecutar la migración que cambia el tipo de la columna de importes a decimal en una tabla de millones de filas, analiza riesgos de bloqueo, pérdida de precisión y plan de reversión.",
  "Revisa si es seguro borrar en cascada los pedidos al eliminar un usuario. Qué datos legales y de facturación se podrían perder y qué alternativa recomiendas.",
  "Evalúa el impacto en rendimiento de añadir búsqueda por texto completo en la tabla principal: índices, tamaño, escrituras y alternativa con un motor externo.",
  "Haz un análisis de riesgos del cifrado de datos personales en reposo que proponemos: gestión de claves, rotación, copias de seguridad y qué ocurre si se pierde una clave.",
  "Qué riesgos tiene subir ficheros de usuarios directamente al almacenamiento desde el navegador con URLs firmadas. Considera tipos de fichero, tamaños, caducidad y abuso.",
  "Valora si conviene activar la ejecución automática de migraciones al arrancar el servicio en producción con varias réplicas. Riesgos de datos y alternativas.",
  // Revisión delicada
  "Revisa con criterio el cambio que reescribe el middleware de autenticación: busca fallos de autorización, condiciones de carrera y casos límite que los tests no cubren. Solo recomendaciones, no edites.",
  "Revisa el script de migración de datos de clientes antes de lanzarlo en producción: idempotencia, transacciones, orden de operaciones y qué pasa si se corta a la mitad.",
  "Revisa críticamente el diseño del proceso de borrado de cuentas y exportación de datos para cumplir el RGPD. Señala huecos y riesgos legales y técnicos.",
  "Revisa esta propuesta de gestión de secretos y variables de entorno en CI y producción. ¿Hay fugas posibles, permisos excesivos o rotación sin cubrir?",
  "Haz una revisión a fondo del cálculo de precios y descuentos: redondeos, acumulación de cupones, impuestos y casos que podrían cobrar de menos o de más.",
  // Tareas ambiguas o abiertas
  "Los usuarios dicen que la app va lenta, pero no sabemos dónde. Plantea cómo investigarlo: qué medir, en qué orden y cómo decidir qué arreglar primero.",
  "Queremos que el producto se sienta más profesional, sin más detalle. Interpreta qué puede significar, propón líneas de actuación priorizadas y qué preguntarías al equipo.",
  "No tenemos claro si merece la pena reescribir el módulo de facturación o seguir parcheándolo. Reúne criterios, estima esfuerzo y riesgo de cada opción y recomienda.",
  "Tenemos tres propuestas distintas para el flujo de registro de nuevos usuarios y no hay acuerdo. Compáralas por conversión, seguridad y coste de mantenimiento, y decide una."
].map(manual("opus"));

const ASISTENTE = [
  // Pasar tests y reportar
  "Ejecuta la batería de tests del proyecto y dime cuáles fallan, con el mensaje de error de cada uno. No arregles nada.",
  "Lanza el linter sobre la carpeta de componentes y haz una lista de los avisos agrupados por regla. Solo informar.",
  "Corre los tests de integración tres veces seguidas y reporta si alguno falla de forma intermitente.",
  "Pasa el build de producción y confirma si termina sin errores. Si falla, copia las últimas veinte líneas de la salida.",
  // Comprobar una salida o un despliegue
  "Comprueba que el despliegue de esta mañana responde con código 200 en la página principal y en la ruta de salud. Informa del resultado.",
  "Mira en los registros del servicio si aparece algún error 500 desde las ocho y cuéntame cuántos hay y de qué ruta.",
  "Verifica que el comando de exportación genera el fichero CSV con la cabecera esperada y al menos una fila de datos.",
  "Confirma si las variables de entorno obligatorias están definidas en el entorno de pruebas. Lista las que faltan, sin mostrar sus valores.",
  // Buscar en la web o leer documentación
  "Busca en la documentación oficial de Vite cómo se configura un alias de rutas y resúmelo en cinco líneas con el enlace.",
  "Averigua cuál es la última versión estable de Node con soporte a largo plazo y cuándo termina su soporte. Cita la fuente.",
  "Lee la guía de migración de la librería de rutas a su nueva versión mayor y haz una lista de los cambios que rompen compatibilidad.",
  "Busca si existe una opción en la API del servicio de correo para limitar el ritmo de envíos y dime qué parámetro es, con el enlace a la página.",
  // Probar una web en navegador
  "Abre la web en el navegador, rellena el formulario de contacto con datos de prueba y dime si aparece el mensaje de confirmación.",
  "Entra en la página de registro en el navegador y comprueba que el botón de enviar queda desactivado con el campo de correo vacío. Haz una captura.",
  "Recorre el menú principal de la web en el navegador y reporta qué enlaces llevan a una página de error.",
  "Prueba la web en una ventana con ancho de móvil y dime si el menú se pliega y si se ve algún elemento cortado.",
  // Editar documentación o memoria
  "Actualiza el apartado de instalación del README: ahora hace falta Node 22 en lugar de Node 20. Cambia solo esa mención.",
  "Añade a la nota de memoria de preferencias una línea que diga que los commits van en inglés y en tiempo presente.",
  "Corrige las erratas del documento de guía de contribución y deja el resto del texto tal cual.",
  "Escribe en el fichero de memoria del proyecto la fecha de hoy y que el reentreno quedó pendiente de revisar.",
  // Cambios de texto
  "Cambia el texto del botón de la portada de «Empieza ya» a «Probar gratis» en el componente de cabecera.",
  "Sustituye en los mensajes de error el tratamiento de usted por tú, sin tocar ninguna otra cadena.",
  "Cambia el título de la pestaña del navegador a «Panel de control» y comprueba que no queda el título antiguo en ningún sitio.",
  // Renombrar y ordenar
  "Renombra el fichero de utilidades de fechas a fechas.mjs y actualiza los imports que lo usan. Pasa los tests después.",
  "Ordena alfabéticamente los scripts del package.json sin cambiar ninguno.",
  "Mueve las capturas de pantalla sueltas de la raíz del repositorio a la carpeta de documentación y ajusta los enlaces del README.",
  "Renombra la variable de configuración de tiempo máximo en todo el código y en el fichero de ejemplo de entorno, y confirma que los tests siguen en verde.",
  // Entradas de changelog
  "Añade al CHANGELOG una entrada de la versión 1.4.0 con estos tres puntos: filtro por fecha, corrección del orden de la tabla y textos revisados.",
  "Redacta la entrada del changelog para la corrección del fallo de paginación, en dos líneas y en el formato que ya usa el fichero.",
  "Pasa al changelog los títulos de los pull requests fusionados esta semana, ordenados por tipo: novedades, correcciones y mantenimiento."
].map(manual("asistente"));

const PROGRAMADOR = [
  "Implementa la función que normaliza un número de teléfono quitando espacios y guiones y añadiendo el prefijo del país si falta. Con tests para cada caso.",
  "Arregla el fallo en el cálculo de la paginación: la última página devuelve un elemento de más cuando el total es múltiplo del tamaño de página. Añade el test que lo reproduce.",
  "Escribe el endpoint que devuelve los pedidos de un usuario filtrados por estado, con validación del parámetro y sus pruebas.",
  "Extrae la lógica de validación del formulario a una función pura, sin tocar el comportamiento, y cubre los casos límite con tests.",
  "Implementa el componente de selector de fechas según la especificación ya acordada: props, estados vacío y error, y tests de renderizado.",
  "Corrige el bug por el que el contador de carrito no se actualiza al eliminar el último producto. Reproduce con un test y arregla.",
  "Añade la columna de fecha de baja al modelo de usuario con su migración ya definida y actualiza las consultas que listan usuarios activos.",
  "Refactoriza la función de cálculo de descuentos para separar el redondeo en una función aparte, manteniendo los tests existentes en verde.",
  "Convierte el módulo de acceso a la base de datos para recibir la conexión por parámetro en vez de importarla, y adapta los tests a la inyección.",
  "Escribe un hook que recuerde el último filtro elegido en el almacenamiento local, con tests de lectura, escritura y valor corrupto."
].map(manual("programador"));

export const SEEDS = [...OPUS, ...ASISTENTE, ...PROGRAMADOR];
