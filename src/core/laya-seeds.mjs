// Semillas versionadas para el entrenamiento de Laya: encargos que deben ir a Opus (planificar, diseñar, valorar riesgos,
// revisión delicada). Compensan que el histórico real casi no trae esos casos. Texto sin rutas, correos ni claves.
// `origin`: "manual" (escrito a mano) o "historico" (extraído del histórico real y anonimizado; revisar antes de añadir).
const manual = (text) => ({ text, label: "opus", origin: "manual" });

export const SEEDS = [
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
].map(manual);
