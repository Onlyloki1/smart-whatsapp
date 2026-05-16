-- ═══════════════════════════════════════════════════════════════════
-- Modo "solo contacto + etiqueta" (no manda mensajes)
-- ═══════════════════════════════════════════════════════════════════
-- Cuando un lead reserva, en vez de crear grupo + DM, solo:
--  - Guarda el contacto en la libreta del admin chip con su nombre real
--  - Aplica la etiqueta de WA Business correspondiente al budget rank

ALTER TABLE booking_config
  ADD COLUMN IF NOT EXISTS contact_only_mode BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS label_mapping JSONB DEFAULT '{}'::jsonb;

-- Default mapping: budget_rank → nombre de la etiqueta en WA Business
-- (las etiquetas tienen que existir ya en la app del chip; nuestro sistema las matchea por nombre)
UPDATE booking_config
SET label_mapping = '{"1": "500 a 990", "2": "1.000 a 2.000", "3": "2.000 a 3.000"}'::jsonb
WHERE label_mapping = '{}'::jsonb OR label_mapping IS NULL;
