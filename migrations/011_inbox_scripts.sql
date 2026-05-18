-- ═══════════════════════════════════════════════════════════════════
-- Inbox: Quick Scripts + dispatch queue + conversation labels
-- ═══════════════════════════════════════════════════════════════════

-- ─── Scripts guardados (templates con steps) ──────────────────────
CREATE TABLE IF NOT EXISTS quick_scripts (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quick_scripts_user ON quick_scripts(user_id);

-- ─── Steps del script (orden, tipo, contenido, delays) ────────────
CREATE TABLE IF NOT EXISTS quick_script_steps (
  id              SERIAL PRIMARY KEY,
  script_id       INT NOT NULL REFERENCES quick_scripts(id) ON DELETE CASCADE,
  order_idx       INT NOT NULL DEFAULT 0,
  step_type       TEXT NOT NULL,                    -- 'text' | 'audio' | 'image' | 'video' | 'delay' | 'tag'
  text_content    TEXT,                             -- texto para 'text', caption para media, label para 'tag'
  media_url       TEXT,                             -- URL para audio/image/video
  delay_seconds   INT DEFAULT 0,                    -- delay ANTES de ejecutar este step (para 'delay' o entre steps)
  show_typing     BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qss_script ON quick_script_steps(script_id, order_idx);

-- ─── Cola de envíos pendientes desde inbox ────────────────────────
-- Cuando el user dispatch un script en una conversación, todos los steps
-- se enquean con scheduled_at calculado según los delays.
CREATE TABLE IF NOT EXISTS inbox_dispatch_queue (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id      INT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  conversation_id  INT REFERENCES conversations(id) ON DELETE CASCADE,
  phone            TEXT NOT NULL,
  script_id        INT REFERENCES quick_scripts(id) ON DELETE SET NULL,
  step_id          INT REFERENCES quick_script_steps(id) ON DELETE SET NULL,
  step_type        TEXT NOT NULL,
  text_content     TEXT,
  media_url        TEXT,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  status           TEXT DEFAULT 'pending',          -- 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  attempt_count    INT DEFAULT 0,
  error_message    TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idq_pending ON inbox_dispatch_queue(scheduled_at, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_idq_convo ON inbox_dispatch_queue(conversation_id);

-- ─── Etiquetas WA Business aplicadas a conversaciones ─────────────
-- Cache local de qué labels tiene cada conversation (para mostrar en inbox sin pegarle a Evolution cada vez)
CREATE TABLE IF NOT EXISTS conversation_labels (
  conversation_id  INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id         TEXT NOT NULL,                   -- id de la label en Evolution
  label_name       TEXT NOT NULL,
  applied_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_convo ON conversation_labels(conversation_id);
