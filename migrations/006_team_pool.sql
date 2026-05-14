-- ═══════════════════════════════════════════════════════════════════
-- Team + pool de chips group-creators + budget_rank
-- ═══════════════════════════════════════════════════════════════════

-- ─── Team members con role (extiende la tabla closers) ────────────
ALTER TABLE closers
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'closer';
-- valores válidos: 'owner' | 'closer' | 'triager' | 'other'

-- ─── booking_config: pool de chips creadores + array de team_members ───
ALTER TABLE booking_config
  ADD COLUMN IF NOT EXISTS group_creator_instance_ids JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS team_member_ids JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS promote_team_to_admin BOOLEAN DEFAULT TRUE;

-- Cambiar template default para incluir budget rank
UPDATE booking_config
SET group_name_template = '{date} - {time} - {lead_name} - ({budget_rank})'
WHERE group_name_template = '{date} {time} - Consultoría Smart Acquisition';

-- ─── booking_events: tracking de chip creador + budget rank + snapshot ───
ALTER TABLE booking_events
  ADD COLUMN IF NOT EXISTS group_creator_instance_id INT REFERENCES instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS budget_rank INT,
  ADD COLUMN IF NOT EXISTS team_member_phones JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_be_creator_date
  ON booking_events(group_creator_instance_id, group_created_at);
