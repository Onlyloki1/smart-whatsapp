-- ═══════════════════════════════════════════════════════════════════
-- Quick script steps: variantes de texto (random pick anti-fingerprint)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE quick_script_steps
  ADD COLUMN IF NOT EXISTS text_variants JSONB;

-- Migrar text_content existente a array de 1 elemento si está vacío
UPDATE quick_script_steps
SET text_variants = jsonb_build_array(text_content)
WHERE text_variants IS NULL AND text_content IS NOT NULL AND text_content != '';
