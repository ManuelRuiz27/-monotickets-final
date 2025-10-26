# Servicio Delivery

El servicio Delivery centraliza los envíos de invitaciones y recordatorios vía WhatsApp o correo electrónico. Se expone desde el backend HTTP y delega el trabajo pesado a las colas basadas en Redis.

## Endpoints

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/deliver/send` | Crea envíos individuales o por lote. El cuerpo debe incluir `eventId`, `channel` (`whatsapp`/`email`) y `template`, además de al menos uno de `guestId`, `guestIds[]` o `phone`. El servicio buscará el invitado por `eventId+phone` si no se envía `guestId`. |
| `POST` | `/deliver/webhook` | Recibe webhooks de 360dialog. Responde `200 OK` inmediatamente y encola el payload para procesamiento asíncrono. |
| `GET` | `/deliver/:id/status` | Consulta el estado del envío usando el `id` de `delivery_logs` o el `provider_ref`. |

Los endpoints legados (`POST /events/:eventId/guests/:guestId/send`, `POST /wa/webhook`, `GET /wa/session/:phone`) siguen disponibles para compatibilidad.

## Colas y workers

- `wa_outbound` (configurable con `DELIVERY_QUEUE_NAME` o `WA_OUTBOUND_QUEUE_NAME`): recibe jobs `send` con los datos del invitado y del template. Implementa la secuencia de reintentos `1s → 5s → 20s → 60s` con un máximo de 5 intentos antes de pasar a la DLQ.
- `wa_inbound`: procesa los webhooks de 360dialog, deduplica por `message.id` y actualiza sesiones de 24 h tanto en Redis como en PostgreSQL (`wa_sessions`). Utiliza la misma secuencia de reintentos para asegurar idempotencia en los inbound events.

Ambas colas registran cada transición en `delivery_logs` (`queued → processing → sent|delivered|failed`). Los fallos definitivos se envían a `delivery_failed` para análisis manual.

## Idempotencia, dedupe y caché

- **Outbound**: antes de encolar se calcula una clave `delivery:dedupe:{eventId}:{guest|phone}:{template}`. Si existe dentro de la ventana configurada (`DELIVERY_DEDUPE_WINDOW_MIN`, minutos), el job se marca como `duplicate`. Esto evita reenvíos dentro de las 24 h.
- **Inbound**: cada mensaje entrante de WhatsApp verifica `provider_ref` y `message.id`. Los duplicados se descartan y se conserva la primera transición registrada.
- **Estados**: las respuestas de `GET /deliver/:id/status` se guardan en Redis con TTL de 30–60 s (`DELIVERY_STATUS_CACHE_TTL_SECONDS`). Cada intento exitoso/erróneo invalida la caché para mantener los dashboards sincronizados.

## delivery_logs y wa_sessions

Todos los cambios de estado (queued, sent, delivered, failed) se guardan en `delivery_logs`. La tabla está particionada mensualmente por `created_at` para mantener consultas rápidas y ahora enlaza con las sesiones activas:

- `channel`, `template`, `status`.
- `is_free` indica si el mensaje salió dentro de la ventana gratuita de 24 h (solo aplica para WhatsApp).
- `session_id` referencia a `wa_sessions.id` cuando hay sesión abierta.
- `provider_ref` (referencia del proveedor, usada para idempotencia y tracking).
- `metadata` y `error` (JSON con detalle del intento y el fallo, cuando aplica).

Las sesiones vivas se registran en `wa_sessions` con `started_at`, `expires_at`, `metadata` y `last_message_at`. Cada webhook renueva la ventana y marca la sesión como activa también en Redis (`wa:session:{phone}`) para respuestas rápidas.

## Estado de invitados y regla de 24 h

Cuando se recibe un mensaje válido dentro de la ventana de 24 h (`WA_SESSION_TTL_SECONDS`) se registra/renueva la sesión tanto en Redis (`wa:session:{phone}`) como en `wa_sessions`. Si el cuerpo contiene afirmaciones de confirmación (por ejemplo “confirmo”, “sí voy”, “asistir”), se actualiza al invitado de `pending` → `confirmed`, se anota el `sessionId` en `confirmation_payload` y se limpia la caché `landing:*`. Posteriormente, los jobs de envío marcan `is_free=true` cuando detectan una sesión abierta y las vistas del dashboard reflejan el cambio.

## Variables de entorno relevantes

| Variable | Descripción |
| --- | --- |
| `WA_API_BASE` | Base URL del API de 360dialog. Se usa cuando hay credenciales reales. |
| `WA_API_TOKEN` | Token Bearer para 360dialog. Si falta, los envíos se simulan (`simulated=true`). |
| `RESEND_API_KEY` | API key de Resend para correos. |
| `DELIVERY_MAX_RETRIES` | Máximo de reintentos por job en `wa_outbound`/`wa_inbound`. |
| `DELIVERY_BACKOFF_SEQUENCE_MS` | Secuencia de backoff separada por comas (por defecto `1000,5000,20000,60000`). |
| `DELIVERY_STATUS_CACHE_TTL_SECONDS` | TTL en segundos para el caché de `GET /deliver/:id/status`. |
| `DELIVERY_DEDUPE_WINDOW_MIN` | Ventana (minutos) para evitar envíos duplicados. Predeterminado 24 h. |
| `REDIS_URL` | Conexión a Redis para colas, dedupe, locks y cachés. |

## Pruebas rápidas

```bash
# Envío outbound
curl -sS -X POST http://localhost:8080/deliver/send \
  -H "Content-Type: application/json" \
  -d '{"eventId":"ev_demo","phone":"+5215550011223","channel":"whatsapp","template":"invite"}'

# Webhook inbound (se encola y responde 200)
curl -sS -X POST http://localhost:8080/deliver/webhook \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"id":"msg_123","from":"+5215550000000","text":"confirm"}]}'

# Consulta de estado
curl -sS http://localhost:8080/deliver/123/status
```

Todos los comandos deben responder `2xx` y generar entradas en `delivery_logs` con los estados correspondientes.
