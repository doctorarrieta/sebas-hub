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

## Siguiente fase

Espacio **contenido**: tablas de ideas y piezas, herramientas para registrar, listar y aprobar, y escenarios de Make.
