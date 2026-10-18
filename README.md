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

### Pruebas
`node test/contenido.test.mjs` (base local, no toca producción).

## A futuro

- Herramientas de diseño que llenan plantillas solas a partir de una fila (Canva, Placid, Bannerbear u otras), para que los carruseles del carril creador salgan diseñados.
- Cuando haya métricas suficientes: que el sistema elija la ruta de gancho según lo que más rindió.
