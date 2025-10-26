# Metabase para analistas (servicio opcional)

Metabase es el contenedor de BI ligero del stack de Monotickets. Permite explorar las tablas operativas, las bitácoras de envíos y las vistas materializadas de KPIs sin exponer credenciales en el repositorio.

## Puesta en marcha

1. Asegúrate de tener la base de datos levantada (ver `docs/db/README.md`). Después inicia Metabase:

   ```bash
   docker compose -f infra/docker-compose.yml up -d database metabase
   ```

   - El servicio se expone en [http://localhost:3002](http://localhost:3002).
   - El metastore se guarda en el volumen `metabase_data` (`MB_DB_FILE=/metabase-data/metabase.db`).

2. Onboarding inicial:
   - Crea el usuario administrador cuando Metabase lo solicite.
   - Configura una conexión PostgreSQL apuntando al mismo host que usa el backend (variables de `.env`):
     - **Host**: `database`
     - **Puerto**: `${DB_PORT:-5432}`
     - **Base de datos**: `${DB_NAME:-monotickets}`
     - **Usuario**: `${DB_USER:-postgres}`
     - **Contraseña**: `${DB_PASSWORD}`
   - También puedes omitir la conexión en el onboarding y agregarla después en *Admin settings → Databases*.

## Colecciones y tarjetas de ejemplo

1. Crea la colección **“Monotickets – Operación”**.
2. Publica las primeras tarjetas demo sobre los datos sembrados:
   - **Guests por status (hoy)**: usa la tabla `guests`, filtra por `date_trunc('day', created_at) = current_date` y agrupa por `status`.
   - **Scan logs últimos 7 días por result**: tabla `scan_logs`, filtra por `ts >= now() - interval '7 days'` y agrupa por `result`.
3. Documenta en la descripción de la colección qué supuestos cubren las tarjetas (e.g., la semilla incluye eventos standard y premium con show-up del 60–80%).

## Buenas prácticas de dashboard

- **Foco diario**: aplica filtros rápidos (hoy, últimos 7 días) para validar confirmaciones y show-up recientes.
- **Drill-down**: enlaza tablas detalladas que permitan auditar invitados, invitaciones y delivery logs directamente desde los indicadores.
- **WhatsApp gratuito**: usa directamente la columna `is_free` de `delivery_logs` (expone la sesión activa en `wa_sessions`). El ratio diario vive en `mv_wa_free_ratio_daily`.
- **Rendimiento**: las vistas materializadas (`mv_*`) se refrescan con `REFRESH MATERIALIZED VIEW CONCURRENTLY`; evita consultas pesadas directamente sobre `scan_logs` históricos.

## Próximos pasos

- Automatiza la creación de dashboards mediante la API de Metabase cuando las tarjetas cambien con frecuencia.
- Para análisis ejecutivos considera compartir vistas de `mv_event_mix_90d` y `mv_organizer_debt` en dashboards dedicados (ver `docs/bi/metabase-dashboards.md`).
