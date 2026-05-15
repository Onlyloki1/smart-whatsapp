-- ═══════════════════════════════════════════════════════════════════
-- Defaults definitivos del DM: delay 10 min + texto final
-- ═══════════════════════════════════════════════════════════════════

-- Cambiar default a 10 min para futuros users
ALTER TABLE booking_config
  ALTER COLUMN delay_before_dm_minutes SET DEFAULT 10;

-- Update users existentes que tengan el default viejo de 5
UPDATE booking_config
SET delay_before_dm_minutes = 10
WHERE delay_before_dm_minutes = 5;

-- Update users existentes que tengan el texto default viejo
UPDATE booking_config
SET dm_text = 'Como va {lead_name}, vi que agendaste una reu para que te muestre el software que agenda llamadas calificadas, sumate a este grupo que estoy yo y mi equipo, asi te conocemos mejor y te armo que te pueda servir {invite_url}'
WHERE dm_text LIKE 'Como va %ahi vi que te agendaste, sumate a este grupo privado%'
   OR dm_text LIKE 'Como va, te habla Juan Cruz Bernal%';
