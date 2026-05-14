-- ═══════════════════════════════════════════════════════════════════
-- Callbell como canal de DM del invite (alternativo a Evolution admin chip)
-- ═══════════════════════════════════════════════════════════════════
-- El lead vive en Callbell (CTWA → Callbell). Cuando reserva, Smart WhatsApp
-- crea el grupo via Evolution group-creators, pero el mensaje con el invite
-- lo manda DESDE CALLBELL (continuidad del thread del lead).

ALTER TABLE booking_config
  ADD COLUMN IF NOT EXISTS dm_channel TEXT DEFAULT 'callbell',  -- 'callbell' | 'evolution'
  ADD COLUMN IF NOT EXISTS callbell_channel_uuid TEXT;

-- Nuevo texto default con placeholders {lead_name} y {invite_url}
UPDATE booking_config
SET dm_text = 'Como va {lead_name}, ahi vi que te agendaste, sumate a este grupo privado que estoy yo y mi equipo, asi terminas de confirmar la reunión y te mando valor que te va a servir {invite_url} sumate lo antes posible'
WHERE dm_text LIKE 'Como va, te habla Juan Cruz%';
