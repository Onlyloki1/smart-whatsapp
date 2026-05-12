-- ═══════════════════════════════════════════════════════════════════
-- Humanización del flujo: debounce, mark-as-read, sustained presence
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS autoresponder_pending_at TIMESTAMPTZ,   -- cuándo debe firearse (debounce)
  ADD COLUMN IF NOT EXISTS autoresponder_pending_was_new BOOLEAN,  -- estado al primer inbound del burst
  ADD COLUMN IF NOT EXISTS last_inbound_msg_id TEXT,               -- evolution_msg_id del último inbound (para markRead)
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ,            -- timestamp del último inbound (para debounce)
  ADD COLUMN IF NOT EXISTS custom_name TEXT,                       -- nombre que le ponemos nosotros (panel-only)
  ADD COLUMN IF NOT EXISTS contact_saved_at TIMESTAMPTZ;           -- cuándo lo "agendamos" en Evolution

CREATE INDEX IF NOT EXISTS idx_conv_pending_fire
  ON conversations(autoresponder_pending_at)
  WHERE autoresponder_pending_at IS NOT NULL;
