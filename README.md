# Smart WhatsApp

Outbound automatizado de WhatsApp para clientes — multi-tenant, multi-chip, anti-detection.

## Stack

- Node.js + Express + EJS
- PostgreSQL (Railway)
- Evolution API (Docker en Railway, Baileys bajo el capó)
- node-cron para worker de envío
- JWT cookie auth + bcrypt

## Arquitectura

```
[Cliente browser] → [App Node/Express] ──┬→ [Postgres]
                                         ├→ [Evolution API]  (envío + webhooks)
                                         └→ [Pool de proxies]
```

## Variables de entorno

Ver `.env.example`. Críticas:

- `DATABASE_URL` — Postgres de Railway
- `EVOLUTION_API_URL` — URL del servicio Evolution
- `EVOLUTION_API_KEY` — apikey del Evolution
- `WEBHOOK_BASE_URL` — URL pública de la app (para que Evolution te llame)
- `JWT_SECRET` — random string

## Deploy en Railway

Proyecto ya creado con:
- ✅ Postgres
- ✅ Evolution API (`evoapicloud/evolution-api:latest`) en `https://evolution-api-production-fb1d.up.railway.app`
- ⏳ Servicio de la app — conectar este repo

### Pasos:

1. Push del repo a GitHub.
2. En Railway → proyecto smart-whatsapp → **+ Add → GitHub Repo** → seleccionar este repo.
3. Configurar variables (Raw Editor):

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
EVOLUTION_API_URL=${{evolution-api.RAILWAY_PUBLIC_DOMAIN}}
EVOLUTION_API_KEY=<misma key que en evolution-api service>
WEBHOOK_BASE_URL=${{RAILWAY_PUBLIC_DOMAIN}}
JWT_SECRET=<random 64 hex chars>
NODE_ENV=production
PORT=3000
```

4. Generate Domain en Networking.
5. Primer deploy corre la migración SQL automáticamente (`node lib/migrate.js`).

## Local dev

```bash
npm install
cp .env.example .env  # llenar DATABASE_URL, etc
npm run migrate
npm start
```

## Schema

`migrations/001_initial.sql` — usuarios, instances, proxies, campaigns, leads, messages_log, conversations.

## Worker de envío anti-detection

`jobs/sender.js` corre cada 30s. Para cada campaña activa, para cada chip:
- Verifica ventana horaria
- Verifica límite diario y total
- Verifica delay desde último envío
- Verifica pausa de batch
- Si todo ok, manda 1 mensaje, recalcula próximo delay random

## TODO

- [ ] Routes y vistas de campañas (crear, subir leads CSV, asignar a chips)
- [ ] Inbox unificado con respuesta desde panel
- [ ] Pool de proxies: panel de admin para cargar/asignar
- [ ] Warmup helper: unirse a grupos masivamente
- [ ] Métricas y dashboard de salud de chips
