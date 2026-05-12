-- ═══════════════════════════════════════════════════════════════════
-- Anti-detection mejorado
-- ═══════════════════════════════════════════════════════════════════
-- 1) Variantes de texto por step (random pick)
-- 2) Ventana horaria por autoresponder
-- 3) Burst smoothing (min gap entre fires del mismo chip)

ALTER TABLE auto_responder_steps
  ADD COLUMN IF NOT EXISTS text_variants JSONB,
  ADD COLUMN IF NOT EXISTS append_utm BOOLEAN DEFAULT TRUE;

ALTER TABLE auto_responders
  ADD COLUMN IF NOT EXISTS quiet_hours_start INT DEFAULT 9,
  ADD COLUMN IF NOT EXISTS quiet_hours_end INT DEFAULT 22,
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Argentina/Buenos_Aires',
  ADD COLUMN IF NOT EXISTS min_gap_seconds_between_fires INT DEFAULT 45,
  ADD COLUMN IF NOT EXISTS skip_rate_pct INT DEFAULT 0;  -- 0-100, % de inbounds que NO respondemos

-- Migrar text existente a text_variants (1-element array) si está vacío
UPDATE auto_responder_steps
SET text_variants = jsonb_build_array(text)
WHERE text_variants IS NULL AND text IS NOT NULL AND text != '';
