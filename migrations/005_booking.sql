-- ═══════════════════════════════════════════════════════════════════
-- Booking flow: webhook GHL → grupo + DM + welcome on join
-- ═══════════════════════════════════════════════════════════════════

-- ─── Closers (sales team que se agrega al grupo) ──────────────────
CREATE TABLE IF NOT EXISTS closers (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,          -- E.164 sin +
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_closers_user ON closers(user_id);

-- ─── Config global del booking flow (1 por user) ──────────────────
CREATE TABLE IF NOT EXISTS booking_config (
  id                          SERIAL PRIMARY KEY,
  user_id                     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  instance_id                 INT REFERENCES instances(id) ON DELETE SET NULL,  -- chip que crea grupos
  closer_id                   INT REFERENCES closers(id) ON DELETE SET NULL,    -- closer default
  delay_before_dm_minutes     INT DEFAULT 5,
  post_join_delay_seconds     INT DEFAULT 60,
  group_name_template         TEXT DEFAULT '{date} {time} - Consultoría Smart Acquisition',
  dm_text                     TEXT NOT NULL DEFAULT 'Como va, te habla Juan Cruz Bernal, vi que te agendaste para {date} a las {time}, te voy a invitar a un grupo de whatsapp con mi equipo, es unicamente para coordinar la reunión, entender sobre tu situación actual y como te podemos ayudar. Te dejo el link del grupo, apenas puedas sumate y charlamos {invite_url}',
  post_join_text              TEXT NOT NULL DEFAULT '¡Hola {lead_name}! Bienvenido/a al grupo. Acá estamos para coordinar tu consultoría 🙌',
  post_join_audio_url         TEXT,                                              -- URL pública del audio (voz)
  webhook_token               TEXT,                                              -- secret en la query del webhook público
  timezone                    TEXT DEFAULT 'America/Argentina/Buenos_Aires',
  enabled                     BOOLEAN DEFAULT TRUE,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_config_user ON booking_config(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_config_token ON booking_config(webhook_token);

-- ─── Eventos de agenda (uno por cada reserva del lead) ────────────
CREATE TABLE IF NOT EXISTS booking_events (
  id                       SERIAL PRIMARY KEY,
  user_id                  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id              INT REFERENCES instances(id) ON DELETE SET NULL,
  closer_id                INT REFERENCES closers(id) ON DELETE SET NULL,
  lead_phone               TEXT NOT NULL,
  lead_name                TEXT,
  scheduled_at             TIMESTAMPTZ,                           -- fecha/hora de la call
  status                   TEXT DEFAULT 'pending',                -- pending | dm_sent | joined | completed | failed
  group_jid                TEXT,                                  -- jid del grupo creado en WhatsApp
  group_subject            TEXT,
  invite_url               TEXT,
  dm_scheduled_at          TIMESTAMPTZ,                           -- cuándo mandar el DM (NOW + 5min)
  dm_sent_at               TIMESTAMPTZ,
  group_created_at         TIMESTAMPTZ,
  lead_joined_at           TIMESTAMPTZ,
  post_join_scheduled_at   TIMESTAMPTZ,                           -- cuándo mandar el texto+audio (lead_joined + 60s)
  post_join_sent_at        TIMESTAMPTZ,
  error_message            TEXT,
  raw_webhook_payload      JSONB,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_user ON booking_events(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_events_status ON booking_events(status);
CREATE INDEX IF NOT EXISTS idx_booking_events_dm_due
  ON booking_events(dm_scheduled_at) WHERE status = 'pending' AND dm_scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_events_post_join_due
  ON booking_events(post_join_scheduled_at) WHERE status = 'joined' AND post_join_scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_events_group ON booking_events(group_jid);
