const express = require("express");
const crypto = require("crypto");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

// Get config (crea uno default si no existe)
router.get("/", async (req, res) => {
  let cfg = await queryOne(`SELECT * FROM booking_config WHERE user_id = $1`, [req.user.id]);
  if (!cfg) {
    const token = crypto.randomBytes(24).toString("hex");
    cfg = await queryOne(
      `INSERT INTO booking_config (user_id, webhook_token) VALUES ($1, $2) RETURNING *`,
      [req.user.id, token]
    );
  }
  // También devolver lista de chips y closers para el form
  const instances = await query(
    `SELECT id, name, status, phone_number FROM instances WHERE user_id = $1 ORDER BY id ASC`,
    [req.user.id]
  );
  const closers = await query(
    `SELECT id, name, phone, active FROM closers WHERE user_id = $1 ORDER BY active DESC, id ASC`,
    [req.user.id]
  );
  res.json({ ...cfg, _instances: instances, _closers: closers });
});

router.put("/", async (req, res) => {
  const {
    instance_id, closer_id,
    delay_before_dm_minutes, post_join_delay_seconds,
    group_name_template, dm_text, post_join_text, post_join_audio_url,
    timezone, enabled,
  } = req.body || {};

  // Asegurar que existe
  await exec(
    `INSERT INTO booking_config (user_id, webhook_token)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [req.user.id, crypto.randomBytes(24).toString("hex")]
  );

  // Validar pertenencia
  if (instance_id) {
    const ok = await queryOne(`SELECT id FROM instances WHERE id = $1 AND user_id = $2`, [instance_id, req.user.id]);
    if (!ok) return res.status(400).json({ error: "Chip inválido" });
  }
  if (closer_id) {
    const ok = await queryOne(`SELECT id FROM closers WHERE id = $1 AND user_id = $2`, [closer_id, req.user.id]);
    if (!ok) return res.status(400).json({ error: "Closer inválido" });
  }

  await exec(
    `UPDATE booking_config SET
       instance_id = $1,
       closer_id = $2,
       delay_before_dm_minutes = $3,
       post_join_delay_seconds = $4,
       group_name_template = $5,
       dm_text = $6,
       post_join_text = $7,
       post_join_audio_url = $8,
       timezone = $9,
       enabled = $10
     WHERE user_id = $11`,
    [
      instance_id || null,
      closer_id || null,
      delay_before_dm_minutes ?? 5,
      post_join_delay_seconds ?? 60,
      group_name_template || '{date} {time} - Consultoría Smart Acquisition',
      dm_text || '',
      post_join_text || '',
      post_join_audio_url || null,
      timezone || 'America/Argentina/Buenos_Aires',
      enabled !== false,
      req.user.id,
    ]
  );

  res.json({ ok: true });
});

// Regenerar webhook token
router.post("/regenerate-token", async (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  await exec(`UPDATE booking_config SET webhook_token = $1 WHERE user_id = $2`, [token, req.user.id]);
  res.json({ webhook_token: token });
});

// Trigger manual de prueba (simula webhook GHL)
router.post("/test-fire", async (req, res) => {
  const { phone, name, scheduled_at } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });

  const cfg = await queryOne(`SELECT * FROM booking_config WHERE user_id = $1`, [req.user.id]);
  if (!cfg) return res.status(400).json({ error: "No hay config de booking" });
  if (!cfg.instance_id) return res.status(400).json({ error: "No hay chip configurado" });
  if (!cfg.closer_id) return res.status(400).json({ error: "No hay closer configurado" });

  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  const dt = scheduled_at ? new Date(scheduled_at) : new Date(Date.now() + 24 * 3600 * 1000);

  const delayMin = cfg.delay_before_dm_minutes ?? 5;
  const ev = await queryOne(
    `INSERT INTO booking_events
       (user_id, instance_id, closer_id, lead_phone, lead_name, scheduled_at,
        status, dm_scheduled_at, raw_webhook_payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending',
             NOW() + ($7 || ' minutes')::interval,
             $8)
     RETURNING id`,
    [
      req.user.id, cfg.instance_id, cfg.closer_id,
      cleanPhone, name || null, dt,
      delayMin, JSON.stringify({ _test: true, ...req.body }),
    ]
  );

  res.json({ ok: true, booking_id: ev.id, dm_in_minutes: delayMin });
});

// Listar bookings recientes (para ver historial)
router.get("/events", async (req, res) => {
  const rows = await query(
    `SELECT be.*, c.name AS closer_name, i.name AS instance_name
     FROM booking_events be
     LEFT JOIN closers c ON c.id = be.closer_id
     LEFT JOIN instances i ON i.id = be.instance_id
     WHERE be.user_id = $1
     ORDER BY be.id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

module.exports = router;
