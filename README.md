# Smart WhatsApp

Plataforma multi-tenant para automatizar respuestas y outbound de WhatsApp.

**Caso principal:** Click-to-WhatsApp Ads (CTWA). El lead clickea tu anuncio de Meta → abre WhatsApp con tu número → te escribe → autoresponder le manda texto + video automáticamente con delays anti-detección.

## Stack

- Node.js + Express + EJS
- PostgreSQL (Railway)
- Evolution API (Baileys bajo el capó, Docker en Railway)
- node-cron para 2 workers: outbound sender + autoresponder queue
- JWT cookie auth + bcrypt

## Features

### ✅ Autoresponder CTWA
- Multi-chip (hasta 5 chips por user, configurable)
- Trigger por *primer mensaje*, *keyword*, o *cualquier mensaje*
- Secuencia ordenada de steps: texto + video + imagen + audio
- Delays random por step (con "escribiendo..." simulado)
- Cooldown configurable por número (no re-spamea)
- Human takeover automático: si contestás manualmente desde la inbox o desde el celu, el bot deja de disparar

### ✅ Inbox unificado
- Lista de todas las conversaciones de todos los chips
- Buscar por nombre / teléfono / texto
- Filtrar por chip o solo no leídos
- Responder manualmente desde el panel (marca human_takeover)
- Indicador visual de chats en modo manual

### ✅ Outbound (campañas)
- Subir CSV de leads → asignar a chips → mandar con anti-detection
- Ventana horaria, daily limit, delay random, batch pause

### ✅ Anti-detection
- Proxy por chip (residential / mobile)
- Delays random simulando humano
- "Escribiendo..." durante el delay
- Cooldown / pausa de batch
- Health score por chip

## Variables de entorno

Ver `.env.example`. Críticas:

- `DATABASE_URL` — Postgres de Railway
- `EVOLUTION_API_URL` — URL del servicio Evolution
- `EVOLUTION_API_KEY` — apikey del Evolution
- `WEBHOOK_BASE_URL` — URL pública de la app (para que Evolution te llame)
- `JWT_SECRET` — random string, mín 32 chars

## Deploy en Railway

### Pre-requisitos en el proyecto Railway
- ✅ Postgres
- ✅ Evolution API (`evoapicloud/evolution-api:latest`)

### Pasos para deployar la app

```bash
# 1. Pushear los cambios
git add -A
git commit -m "feat: CTWA autoresponder + inbox + stats"
git push
```

```
# 2. En Railway → proyecto smart-whatsapp → "+ Add → GitHub Repo"
#    Seleccionar: Onlyloki1/smart-whatsapp

# 3. Variables del nuevo servicio (Raw Editor):
DATABASE_URL=${{Postgres.DATABASE_URL}}
EVOLUTION_API_URL=https://evolution-api-production-fb1d.up.railway.app
EVOLUTION_API_KEY=<misma key que el service evolution-api>
WEBHOOK_BASE_URL=${{RAILWAY_PUBLIC_DOMAIN}}
JWT_SECRET=<random 64 hex chars>
NODE_ENV=production
PORT=3000

# 4. Networking → Generate Domain
# 5. Settings → Build → Start Command:
node lib/migrate.js && node server.js
```

## Setup paso a paso (primera vez)

1. **Abrir la URL pública** que te dio Railway → registrarte (primer user queda como admin).
2. **Conectar el primer chip**:
   - `/instances` → "+ Agregar Número" → ponele un apodo (ej: "Chip 1 - AR").
   - Escaneá el QR con el WhatsApp del chip → esperá que pase a "connected".
3. **Crear el autoresponder**:
   - `/autoresponders` → "+ Nuevo autoresponder".
   - Trigger: `Primer mensaje del lead`.
   - Steps: paso 1 texto de bienvenida, paso 2 video con la URL pública del video.
   - Cooldown: 24h (no le va a re-mandar al mismo número en 24h).
   - Guardar.
4. **Probar antes de gastar plata en ads**:
   - En el editor del autoresponder, botón "▶ Probar a mi número" → poné tu número personal.
   - Deberías recibir la secuencia en unos segundos con delays naturales.
5. **Lanzar ads**:
   - Crear CTWA en Meta apuntando al número del chip.
   - Cuando el lead te escriba, el autoresponder dispara y queda en `/inbox`.

## Arquitectura

```
[Cliente browser]
      ↓
[App Node/Express]  ──→ [Postgres]
   │                    (users, instances, conversations,
   │                     messages_log, auto_responders, …)
   │
   ├──→ [Evolution API]  (envío + webhooks)
   │
   ├──→ [Pool de proxies] (1:1 con chips)
   │
   ├── cron: outbound sender (cada 30s)
   └── cron: autoresponder queue (cada 5s)
```

### Flujo del autoresponder

1. Lead clickea CTWA → escribe al WhatsApp del chip
2. Evolution dispara webhook `MESSAGES_UPSERT` → `routes/webhook.js`
3. Si la conversación es nueva (o no ha tenido takeover):
   - `maybeFireAutoresponder()` encuentra el autoresponder aplicable
   - `enqueueAutoresponder()` inserta cada step en `auto_responder_queue` con `scheduled_at` random
   - Marca el número en `auto_responder_fired` (para el cooldown)
4. Worker `jobs/autoresponder.js` corre cada 5s:
   - Toma items con `scheduled_at <= NOW()`
   - Simula "escribiendo..." (`sendPresence`)
   - Manda texto (`sendText`) o video (`sendMedia`)
   - Loguea en `messages_log` + actualiza `conversations`
5. Si en el medio Juan/Carlos contesta desde el panel o desde el celu:
   - `conversations.human_takeover = TRUE`
   - Los siguientes items pendientes del autoresponder se cancelan

### Schemas

- `001_initial.sql` — users, instances, proxies, campaigns, leads, messages_log, conversations
- `002_autoresponders.sql` — auto_responders, auto_responder_steps, auto_responder_queue, auto_responder_fired + columnas `human_takeover` en conversations

## Local dev

```bash
npm install
cp .env.example .env  # llenar DATABASE_URL, etc
npm run migrate
npm start
```

## TODO siguiente fase

- [ ] Subir CSV de leads desde panel (UI de campañas)
- [ ] Pool de proxies: UI admin para cargar/asignar
- [ ] Warmup helper: unirse a grupos masivamente
- [ ] Dashboard de salud de chips (health score visible)
- [ ] Webhook outbound: notificar a GHL/Make cuando se dispara un autoresponder
- [ ] Plantillas de autoresponder pre-cargadas para clonar
