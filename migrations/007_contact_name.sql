-- Template para guardar contacto del lead en la libreta del admin chip
ALTER TABLE booking_config
  ADD COLUMN IF NOT EXISTS contact_name_template TEXT DEFAULT '{lead_name}';
