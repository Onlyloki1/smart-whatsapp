-- ═══════════════════════════════════════════════════════════════════
-- Smart WhatsApp - Autoresponders para CTWA
-- ═══════════════════════════════════════════════════════════════════
-- Cuando entra un mensaje inbound de un número que nunca te escribió,
-- el sistema dispara un autoresponder configurado por el usuario.
-- Cada autoresponder es una secuencia de "steps" (texto o media) con delays.

-- ─── Config de autoresponder por usuario ──────────────────────────
CREATE TABLE IF NOT EXISTS auto_responders (
  id              SERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                          -- "CTWA principal", "Reactivación", etc.
  enabled         BOOLEAN DEFAULT TRUE,
  instance_id     INT REFERENCES instances(id) ON DELETE CASCADE,  -- NULL = aplica a TODOS los chips
  trigger_type    TEXT DEFAULT 'first_message',           -- 'first_message' | 'keyword' | 'any'
  trigger_keyword TEXT,                                   -- si trigger_type='keyword'
  cooldown_hours  INT DEFAULT 24,                         -- no re-disparar al mismo número en este lapso
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_user ON auto_responders(user_id);
CREATE INDEX IF NOT EXISTS idx_ar_instance ON auto_responders(instance_id);

-- ─── Steps (los mensajes que se mandan en orden) ───────────────────
CREATE TABLE IF NOT EXISTS auto_responder_steps (
  id               SERIAL PRIMARY KEY,
  auto_responder_id INT NOT NULL REFERENCES auto_responders(id) ON DELETE CASCADE,
  order_idx        INT NOT NULL DEFAULT 0,                -- orden de ejecución
  step_type        TEXT NOT NULL,                         -- 'text' | 'image' | 'video' | 'audio' | 'document'
  text             TEXT,                                  -- texto del mensaje o caption del media
  media_url        TEXT,                                  -- URL pública del archivo
  mime_type        TEXT,
  file_name        TEXT,
  delay_min_sec    INT DEFAULT 8,                         -- delay random ANTES de mandar este step
  delay_max_sec    INT DEFAULT 25,
  show_typing      BOOLEAN DEFAULT TRUE,                  -- mostrar "escribiendo..." durante el delay
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_steps_ar ON auto_responder_steps(auto_responder_id, order_idx);

-- ─── Cola de envíos pendientes del autoresponder ──────────────────
-- Cuando se dispara, se enquean los steps con su tiempo de envío
-- (para respetar delays sin bloquear el webhook)
CREATE TABLE IF NOT EXISTS auto_responder_queue (
  id                SERIAL PRIMARY KEY,
  user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id       INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  phone             TEXT NOT NULL,
  step_id           INT NOT NULL REFERENCES auto_responder_steps(id) ON DELETE CASCADE,
  scheduled_at      TIMESTAMPTZ NOT NULL,                 -- cuándo se debe mandar
  status            TEXT DEFAULT 'pending',               -- 'pending' | 'sent' | 'failed' | 'cancelled'
  attempt_count     INT DEFAULT 0,
  error_message     TEXT,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_queue_pending ON auto_responder_queue(scheduled_at, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ar_queue_phone ON auto_responder_queue(instance_id, phone);

-- ─── Tracking de qué números ya recibieron el autoresponder ───────
-- Sirve para no re-dispararlo si la persona escribe otra vez
CREATE TABLE IF NOT EXISTS auto_responder_fired (
  id                 SERIAL PRIMARY KEY,
  auto_responder_id  INT NOT NULL REFERENCES auto_responders(id) ON DELETE CASCADE,
  instance_id        INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  phone              TEXT NOT NULL,
  fired_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(auto_responder_id, instance_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_ar_fired_lookup ON auto_responder_fired(instance_id, phone, fired_at);

-- ─── Permitir tomar control manual de una conversación ────────────
-- Si un humano contesta desde la inbox, no queremos que el autoresponder
-- siga disparando. Marcamos la conversación con take_over=true.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS human_takeover BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS human_takeover_at TIMESTAMPTZ;
