-- ═══════════════════════════════════════════════════════════════════
-- Smart WhatsApp - Schema inicial
-- ═══════════════════════════════════════════════════════════════════

-- ─── Usuarios (multi-tenant) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT DEFAULT 'client',  -- 'admin' o 'client'
  max_chips     INT DEFAULT 5,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Pool de proxies (asignación 1:1 con instancias) ───────────────
CREATE TABLE IF NOT EXISTS proxies (
  id           SERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,           -- 'iproyal', 'brightdata', 'smartproxy', etc.
  type         TEXT NOT NULL,           -- 'residential', 'mobile', 'datacenter'
  host         TEXT NOT NULL,
  port         INT NOT NULL,
  username     TEXT,
  password     TEXT,
  country      TEXT,                    -- ISO code (AR, MX, US, etc)
  status       TEXT DEFAULT 'available', -- 'available', 'in_use', 'banned', 'disabled'
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Instancias de WhatsApp (1 por chip) ──────────────────────────
CREATE TABLE IF NOT EXISTS instances (
  id                    SERIAL PRIMARY KEY,
  user_id               INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,                     -- apodo del chip ("Chip 1 - Argentina")
  evolution_instance    TEXT UNIQUE NOT NULL,              -- nombre que Evolution usa internamente
  phone_number          TEXT,                              -- se llena cuando escanea QR
  proxy_id              INT REFERENCES proxies(id) ON DELETE SET NULL,
  status                TEXT DEFAULT 'connecting',         -- 'connecting', 'connected', 'disconnected', 'banned'
  daily_sent_count      INT DEFAULT 0,
  total_sent_count      INT DEFAULT 0,
  last_reset_at         DATE DEFAULT CURRENT_DATE,         -- para resetear contador diario
  last_message_at       TIMESTAMPTZ,                       -- último msj enviado (para delay)
  next_send_after       TIMESTAMPTZ,                       -- próximo timestamp posible (delay random)
  in_batch_count        INT DEFAULT 0,                     -- mensajes mandados en el batch actual
  batch_pause_until     TIMESTAMPTZ,                       -- pausa de batch hasta cuándo
  health_score          INT DEFAULT 100,                   -- 0-100, baja con errores
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instances_user ON instances(user_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);

-- ─── Campañas de outbound ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                       SERIAL PRIMARY KEY,
  user_id                  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  message_templates        JSONB NOT NULL,                 -- array de mensajes con variables {{nombre}}
  status                   TEXT DEFAULT 'draft',           -- 'draft', 'active', 'paused', 'completed'
  total_limit              INT,                            -- nullable: si null, manda hasta agotar leads
  daily_limit_per_chip     INT DEFAULT 50,
  hours_start              INT DEFAULT 10,                 -- hora 0-23 inicio de ventana
  hours_end                INT DEFAULT 19,                 -- hora 0-23 fin de ventana
  delay_min_sec            INT DEFAULT 300,                -- 5 min
  delay_max_sec            INT DEFAULT 720,                -- 12 min
  batch_size               INT DEFAULT 10,                 -- msj por batch antes de pausa
  batch_pause_min_sec      INT DEFAULT 1800,               -- 30 min
  batch_pause_max_sec      INT DEFAULT 3600,               -- 60 min
  timezone                 TEXT DEFAULT 'America/Argentina/Buenos_Aires',
  total_sent               INT DEFAULT 0,
  total_replied            INT DEFAULT 0,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- ─── Asignación campaña → instancias (qué chips usa la campaña) ────
CREATE TABLE IF NOT EXISTS campaign_instances (
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  instance_id  INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, instance_id)
);

-- ─── Leads (los contactos a los que se les manda) ─────────────────
CREATE TABLE IF NOT EXISTS leads (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  instance_id   INT REFERENCES instances(id) ON DELETE SET NULL, -- chip asignado (round-robin)
  phone         TEXT NOT NULL,                                   -- E.164 sin '+'
  name          TEXT,
  custom_vars   JSONB DEFAULT '{}',                              -- variables custom para el template
  status        TEXT DEFAULT 'pending',                          -- 'pending', 'sending', 'sent', 'replied', 'failed', 'no_whatsapp'
  attempt_count INT DEFAULT 0,
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_pending_per_instance ON leads(instance_id, status) WHERE status = 'pending';

-- ─── Log completo de mensajes (in y out) ──────────────────────────
CREATE TABLE IF NOT EXISTS messages_log (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id   INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  lead_id       INT REFERENCES leads(id) ON DELETE SET NULL,
  phone         TEXT NOT NULL,
  direction     TEXT NOT NULL,                  -- 'out' (nosotros) | 'in' (el lead)
  text          TEXT,
  media_url     TEXT,
  media_type    TEXT,                           -- 'image', 'audio', 'document', 'video'
  evolution_msg_id TEXT,                        -- id que devuelve Evolution para tracking
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages_log(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages_log(instance_id);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages_log(phone);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages_log(lead_id);

-- ─── Conversaciones (índice rápido para inbox) ────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id     INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  contact_name    TEXT,
  last_msg_text   TEXT,
  last_msg_at     TIMESTAMPTZ,
  last_direction  TEXT,
  unread_count    INT DEFAULT 0,
  is_archived     BOOLEAN DEFAULT FALSE,
  UNIQUE(instance_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations(last_msg_at DESC);

-- ─── Eventos del sistema (para debugging) ─────────────────────────
CREATE TABLE IF NOT EXISTS system_events (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  instance_id INT REFERENCES instances(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,        -- 'instance_connected', 'instance_disconnected', 'message_sent', 'message_failed', 'qr_generated', etc.
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user ON system_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON system_events(created_at DESC);
