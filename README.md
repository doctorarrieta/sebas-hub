# sebas-hub

Hub privado de conectores de Dr. Sebastián Arrieta para Claude (servidor MCP en Cloudflare Workers).

- **Worker:** `sebas-salud` → https://sebas-salud.sebastianarrietam.workers.dev
- **Conector en Claude:** "Salud Sebastián"
- **Origen:** código fuente original recuperado del mapa de código del Worker en producción el 18 de octubre de 2026 (verificado byte por byte).

## Qué hay

| Archivo | Para qué |
|---|---|
| `src/index.js` | Entrada: login con contraseña del hub, servidor MCP, `hub_estado`, `hub_historial_alertas`, revisión diaria (cron) |
| `src/whoop.js` | WHOOP: conexión y herramientas (diario, resumen, alerta de desvío, sueño, ciclos, entrenamientos, perfil) |
| `src/withings.js` | Withings: composición corporal y actividad |
| `src/apple.js` | Recibe los envíos de Health Auto Export (Apple Salud) |
| `schema.sql` | Tablas de la base D1 |
| `wrangler.toml` | Configuración del Worker (base de datos, KV, cron) |

## Secretos

Nunca se guardan en este repositorio. Viven solo en Cloudflare:
`HUB_PASSPHRASE`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`, `APPLE_INGEST_KEY`.

## Espacio contenido (Worker `sebas-contenido`)

Por ahora trabaja **solo con la marca @doctorarrieta**.

Worker y base de datos **separados** del de salud: la salud nunca se mezcla con el contenido.

- **Conector en Claude:** "Contenido Dr. Arrieta" → `https://sebas-contenido.sebastianarrietam.workers.dev/mcp`
- **Código:** `src/contenido.js` · **Tablas:** `migrations-contenido/`
- **Ciclo de una idea:** `nueva → verificando → verificada → en_produccion → usada` (o `descartada`)
- **Ciclo de una pieza:** `borrador → por_aprobar → aprobada → programada → publicada` (o `rechazada`)
- **Formatos:** radio, reel, reel_herida, linkedin, threads, facebook, x, carrusel, youtube

### Herramientas para Claude
`contenido_registrar_idea`, `contenido_listar_ideas`, `contenido_ver_idea`, `contenido_actualizar_idea`,
`contenido_registrar_pieza`, `contenido_listar_piezas`, `contenido_actualizar_pieza`, `contenido_resumen`.

### Entradas para Make
Todas con el encabezado `Authorization: Bearer <CONTENIDO_API_KEY>`.

| Método y ruta | Para qué |
|---|---|
| `POST /contenido/ideas` | Registrar una idea o una lista (`fuente`, `enlace`, `texto`, `autor`, `tema`). No duplica enlaces. |
| `GET /contenido/ideas?estado=nueva` | Leer ideas |
| `GET /contenido/piezas?estado=aprobada&formato=linkedin` | Leer piezas aprobadas para publicarlas o pasarlas al equipo |
| `POST /contenido/piezas/{id}` | Marcar `programada` / `publicada` con `enlace_publicado` y `metricas` |
| `GET /contenido/excel?carril=agencia` | Carruseles para las diseñadoras (32 al mes), para su Excel "CONTENT RRSS - SEBAS ARRIETA", hoja del mes. Va la materia prima **sin gancho**: ellas proponen el gancho y la idea visual. |
| `GET /contenido/excel?carril=creador` | Carruseles completos de El Creador para la hoja "CARRUSELES EL CREADOR — doctorarrieta" (Drive `11t0sewhYDO8ve0uc9hOtOx26uxcOTeGl8_NO28bmDYw`): gancho, láminas, copy, fuente y referencia. |

Después de escribir la fila, Make marca la pieza `enviada_equipo` para no repetirla. El campo `carril` permite comparar más adelante qué ganchos rinden más: los de las diseñadoras o los de El Creador.
| `GET /contenido/resumen` | Conteo por estado |

### Secretos de este Worker
`HUB_PASSPHRASE` (la misma contraseña del hub) y `CONTENIDO_API_KEY` (llave para Make).

### Publicación automática (X, Threads, LinkedIn) — `src/publicar.js`
Directo por la API oficial de cada red, con apps de desarrollador propias. Sin intermediarios.

- **Solo publica lo aprobado y programado:** `aprobada → programada → publicada`. No se puede programar algo que no esté aprobado.
- **Cron cada 5 minutos** publica lo que ya llegó a su hora.
- **Nunca publica dos veces:** si una red falla, la pieza vuelve a `aprobada` con el error. Solo reintenta sola cuando la red pide esperar (límite de uso) o cuando falló antes de publicar.
- **Freno de emergencia:** herramienta `contenido_pausar_publicacion`.
- **Conectar Threads o LinkedIn:** `contenido_conectar_red` da un enlace de un solo uso (15 min). Los tokens quedan en KV, nunca en el repositorio.
- **Duración:** Threads se renueva solo. LinkedIn dura 60 días y hay que reconectarlo; `contenido_publicacion_estado` avisa 7 días antes.
- **Direcciones de retorno:** `https://sebas-contenido.sebastianarrietam.workers.dev/contenido/callback/threads` y `/contenido/callback/linkedin`.

Secretos: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `THREADS_APP_ID`, `THREADS_APP_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.

Pruebas: `node test/publicar.test.mjs`.

### Facebook + Instagram (Meta) — `src/instagram.js`
App propia "Contenido Dr Arrieta" (ID 1118070657790166) con Facebook Login for Business (configuración de token de usuario 1649486460107140).
`contenido_conectar_red` con red `instagram`: un enlace conecta a la vez las páginas de Facebook elegidas y sus Instagram vinculados. Los tokens de página no vencen.
- Facebook: publica en la página (formato `facebook`, mismo flujo que X: aprobada → programada → publicada; la referencia va al final). `META_PAGINA_ID` opcional para elegir la página.
- Instagram: `contenido_metricas_instagram` (solo lectura): vistas, alcance, interacciones, tiempo promedio de reels y retención a 3 s (1 − `reels_skip_rate` cuando está disponible).
Retorno: `/contenido/callback/instagram`. Secretos: `META_APP_ID`, `META_APP_SECRET`. Pruebas: `node test/instagram.test.mjs`.

### TikTok: métricas (solo lectura) — `src/tiktok.js`
API de TikTok for Developers (Login Kit + Display API), funciona con cuenta de creador. `contenido_conectar_red` con red `tiktok` (una cuenta por enlace) y `contenido_metricas_tiktok`: vistas, me gusta, cantidad de comentarios, compartidos. No da tiempo promedio ni texto de comentarios (eso requiere cuenta de empresa + API for Business). Token de 24 h renovado solo por el cron (refresh de 365 días).
Retorno: `/contenido/callback/tiktok`. Secretos: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. Pruebas: `node test/tiktok.test.mjs`.

### YouTube: métricas y curva de retención (solo lectura) — `src/youtube.js`
Proyecto de Google Cloud `contenido-dr-arrieta` (YouTube Data API v3 + YouTube Analytics API). `contenido_conectar_red` con red `youtube` (un canal por enlace), `contenido_metricas_youtube` (vistas, tiempo promedio, % visto, suscriptores ganados; `curva=true` agrega la curva) y `contenido_retencion_youtube` (curva completa de un video con segundos y comparación con videos similares).
Retorno: `/contenido/callback/youtube`. Secretos: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`. Pruebas: `node test/youtube.test.mjs`.

### Pruebas
`node test/contenido.test.mjs` (base local, no toca producción).

## A futuro

- Herramientas de diseño que llenan plantillas solas a partir de una fila (Canva, Placid, Bannerbear u otras), para que los carruseles del carril creador salgan diseñados.
- Cuando haya métricas suficientes: que el sistema elija la ruta de gancho según lo que más rindió.

### Tablero del equipo (público, solo lectura) — `src/equipo.js`
Página para Yazaida, Gabriel, Rubén y editores: resumen, curvas de retención, recomendaciones diarias y aprendizajes. Se abre con un enlace secreto (`/equipo/<código>`), sin cuenta ni contraseña; no permite aprobar ni publicar. Datos en la tabla `rendimiento` (los guarda la revisión diaria con `contenido_guardar_rendimiento`). `contenido_enlace_equipo` da el enlace; con `renovar: true` crea uno nuevo y anula el anterior.
La página se edita en `src/equipo.html` y luego se ejecuta `node scripts/pagina-equipo.mjs`. Pruebas: `node test/equipo.test.mjs`.
