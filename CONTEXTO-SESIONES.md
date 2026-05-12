# Contexto de Sesiones - Smart WhatsApp

## 2026-05-12 — Build inicial del autoresponder CTWA + Inbox

### Objetivo
Plataforma para correr CTWA ads (Click-to-WhatsApp). El lead clickea el ad → escribe al chip → el sistema le manda automáticamente texto + video con delays anti-detección. Multi-chip (5 chips por user).

### Lo que se construyó esta sesión

**Backend nuevo:**
- `lib/evolution.js` → agregadas `sendMedia()` y `sendPresence()` (escribiendo...)
- `jobs/autoresponder.js` → worker que toma items de cola cada 5s y manda
- `routes/autoresponder.js` → CRUD de autoresponders + endpoint de test manual
- `routes/inbox.js` → conversaciones + mensajes + envío manual desde panel
- `routes/stats.js` → métricas para dashboard
- `routes/webhook.js` → modificado: dispara autoresponder en 1er msj inbound, detecta human takeover desde el celu, evita duplicar logs

**Frontend nuevo:**
- `views/autoresponders.ejs` → UI editor de autoresponders con steps drag-able (texto/video/imagen/audio + delays + typing)
- `views/inbox.ejs` → inbox tipo WhatsApp Web con polling 8s
- `views/dashboard.ejs` → stats reales en tiempo real
- `views/partials/nav.ejs` → link a "Autoresponders"

**DB:**
- `migrations/002_autoresponders.sql` → tablas: auto_responders, auto_responder_steps, auto_responder_queue, auto_responder_fired + columnas `human_takeover`/`human_takeover_at` en conversations

**Server:**
- `server.js` → arranca worker autoresponder además del sender outbound. Flag `DISABLE_AUTORESPONDER=true` para desactivar.

### Diseño clave

**Anti-detección del autoresponder:**
- Cada step tiene `delay_min_sec` / `delay_max_sec` → random ANTES de mandar
- `show_typing=true` → manda `composing` presence durante el delay (simula "escribiendo...")
- Cooldown configurable por número (default 24h) → no spamea si re-escribe

**Human takeover (clave):**
- Si Juan/Carlos contestan desde el panel (`/api/inbox/send`) o desde el celu (detectado vía MESSAGES_UPSERT con `fromMe=true` y `evolution_msg_id` no logueado por nuestro sistema) → `conversations.human_takeover = TRUE`
- Worker del autoresponder cancela steps pendientes para esa conversación
- Botón "Reactivar bot" en la inbox para revertir

**Trigger types:**
- `first_message`: solo dispara si el lead nunca tuvo conversación previa con ese chip
- `keyword`: dispara si el msj contiene una palabra clave
- `any`: dispara en cualquier mensaje (cuidado: respeta cooldown)

**Aplicabilidad chip-specific vs global:**
- `auto_responders.instance_id NULL` → aplica a TODOS los chips del user
- `instance_id = X` → solo a ese chip
- Si hay ambos, el chip-specific gana

### Estado deploy

**Ya estaba en Railway:**
- ✅ Postgres
- ✅ Evolution API en `https://evolution-api-production-fb1d.up.railway.app`

**Falta:**
- ⏳ App Node nunca se deployó. Repo en `Onlyloki1/smart-whatsapp.git` con solo el initial commit. Hay que: pushear cambios → crear service Railway desde repo → setear env vars → escanear QR del primer chip.

### Variables de entorno requeridas
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`
- `EVOLUTION_API_URL=https://evolution-api-production-fb1d.up.railway.app`
- `EVOLUTION_API_KEY=<misma que evolution-api service>`
- `WEBHOOK_BASE_URL=${{RAILWAY_PUBLIC_DOMAIN}}`
- `JWT_SECRET=<random 64 hex>`
- `NODE_ENV=production`
- `PORT=3000`

### Gotchas conocidos
- El Dockerfile usa `CMD ["sh", "-c", "node lib/migrate.js && node server.js"]` → respetar el `sh -c` por la nota de memoria de Railway exec form.
- Evolution API webhook eventos usan ambos formatos: `messages.upsert` y `MESSAGES_UPSERT` (mayúscula o minúscula con punto). El webhook handler matchea los dos.
- `media_url` debe ser **pública** y accesible desde el container Evolution (no localhost ni S3 privado sin signed URL).

### Falta en próximas sesiones
- Subir CSV de leads para campañas outbound (UI)
- Pool de proxies admin (cargar/asignar)
- Webhook outbound para notificar a GHL/Make cuando se dispara un autoresponder
- Plantillas pre-cargadas de autoresponder
- Health score visible por chip
