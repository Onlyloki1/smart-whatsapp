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
    instance_id,                       // chip captación / admin (DM sender)
    group_creator_instance_ids = [],   // pool de 3 chips que crean grupos (round-robin)
    team_member_ids = [],              // ids de la tabla closers (= equipo) a agregar al grupo
    delay_before_dm_minutes, post_join_delay_seconds,
    group_name_template, dm_text, post_join_text, post_join_audio_url,
    contact_name_template,
    dm_channel,                       // 'callbell' | 'evolution'
    callbell_channel_uuid,
    contact_only_mode = false,        // si true: solo guarda contacto + aplica label, no manda mensajes
    label_mapping,                    // { "1": "500 a 990", "2": "1.000 a 2.000", ... }
    promote_team_to_admin = true,
    timezone, enabled,
  } = req.body || {};

  await exec(
    `INSERT INTO booking_config (user_id, webhook_token)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [req.user.id, crypto.randomBytes(24).toString("hex")]
  );

  // Validar pertenencia: admin chip
  if (instance_id) {
    const ok = await queryOne(`SELECT id FROM instances WHERE id = $1 AND user_id = $2`, [instance_id, req.user.id]);
    if (!ok) return res.status(400).json({ error: "Admin chip inválido" });
  }
  // Validar pool de group-creators
  const creatorIds = Array.isArray(group_creator_instance_ids) ? group_creator_instance_ids.map(Number).filter(Boolean) : [];
  if (creatorIds.length > 0) {
    const owned = await query(
      `SELECT id FROM instances WHERE user_id = $1 AND id = ANY($2::int[])`,
      [req.user.id, creatorIds]
    );
    if (owned.length !== creatorIds.length) return res.status(400).json({ error: "Algún chip group-creator no es tuyo" });
  }
  // Validar team
  const teamIds = Array.isArray(team_member_ids) ? team_member_ids.map(Number).filter(Boolean) : [];
  if (teamIds.length > 0) {
    const owned = await query(
      `SELECT id FROM closers WHERE user_id = $1 AND id = ANY($2::int[])`,
      [req.user.id, teamIds]
    );
    if (owned.length !== teamIds.length) return res.status(400).json({ error: "Algún team member no es tuyo" });
  }

  const channel = (dm_channel === "evolution" || dm_channel === "callbell")
    ? dm_channel : "callbell";

  const safeLabelMapping = (() => {
    if (!label_mapping || typeof label_mapping !== "object") return null;
    const out = {};
    for (const k of ["1","2","3","4"]) {
      if (label_mapping[k] != null && String(label_mapping[k]).trim()) {
        out[k] = String(label_mapping[k]).trim();
      }
    }
    return out;
  })();

  await exec(
    `UPDATE booking_config SET
       instance_id = $1,
       group_creator_instance_ids = $2::jsonb,
       team_member_ids = $3::jsonb,
       delay_before_dm_minutes = $4,
       post_join_delay_seconds = $5,
       group_name_template = $6,
       dm_text = $7,
       post_join_text = $8,
       post_join_audio_url = $9,
       contact_name_template = $10,
       promote_team_to_admin = $11,
       timezone = $12,
       enabled = $13,
       dm_channel = $14,
       callbell_channel_uuid = $15,
       contact_only_mode = $16,
       label_mapping = COALESCE($17::jsonb, label_mapping)
     WHERE user_id = $18`,
    [
      instance_id || null,
      JSON.stringify(creatorIds),
      JSON.stringify(teamIds),
      delay_before_dm_minutes ?? 5,
      post_join_delay_seconds ?? 60,
      group_name_template || '{date} - {time} - {lead_name} - ({budget_rank})',
      dm_text || '',
      post_join_text || '',
      post_join_audio_url || null,
      contact_name_template || '{lead_name}',
      promote_team_to_admin !== false,
      timezone || 'America/Argentina/Buenos_Aires',
      enabled !== false,
      channel,
      callbell_channel_uuid || null,
      !!contact_only_mode,
      safeLabelMapping ? JSON.stringify(safeLabelMapping) : null,
      req.user.id,
    ]
  );

  res.json({ ok: true });
});

// Endpoint útil: listar labels actuales del admin chip (para verificar que existan)
router.get("/labels", async (req, res) => {
  const cfg = await queryOne(`SELECT instance_id FROM booking_config WHERE user_id = $1`, [req.user.id]);
  if (!cfg?.instance_id) return res.json({ labels: [], error: "No hay admin chip configurado" });
  const inst = await queryOne(`SELECT * FROM instances WHERE id = $1 AND user_id = $2`, [cfg.instance_id, req.user.id]);
  if (!inst) return res.json({ labels: [], error: "Admin chip no encontrado" });
  if (inst.status !== "connected") return res.json({ labels: [], error: `Admin chip status: ${inst.status}` });
  try {
    const evo = require("../lib/evolution");
    const labels = await evo.findLabels(inst.evolution_instance);
    res.json({ labels });
  } catch (e) {
    res.json({ labels: [], error: e.message });
  }
});

// Regenerar webhook token
router.post("/regenerate-token", async (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  await exec(`UPDATE booking_config SET webhook_token = $1 WHERE user_id = $2`, [token, req.user.id]);
  res.json({ webhook_token: token });
});

// Trigger manual de prueba (simula webhook GHL)
router.post("/test-fire", async (req, res) => {
  const { phone, name, scheduled_at, budget_rank } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });

  const cfg = await queryOne(`SELECT * FROM booking_config WHERE user_id = $1`, [req.user.id]);
  if (!cfg) return res.status(400).json({ error: "No hay config de booking" });

  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  const dt = scheduled_at ? new Date(scheduled_at) : new Date(Date.now() + 24 * 3600 * 1000);

  // ─── MODO contact_only ───────────────────────────────
  if (cfg.contact_only_mode) {
    if (!cfg.instance_id) return res.status(400).json({ error: "Falta admin chip" });
    const inst = await queryOne(`SELECT * FROM instances WHERE id = $1 AND user_id = $2`, [cfg.instance_id, req.user.id]);
    if (!inst || inst.status !== "connected") return res.status(400).json({ error: "Admin chip no conectado" });

    const { processContactOnly } = require("../lib/booking-helpers");
    const out = await processContactOnly({
      cfg, instance: inst,
      phone: cleanPhone, name,
      scheduledAt: dt, budgetRank: budget_rank || null,
    });

    await exec(
      `INSERT INTO booking_events
         (user_id, instance_id, lead_phone, lead_name, scheduled_at, budget_rank,
          status, raw_webhook_payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.user.id, cfg.instance_id, cleanPhone, name || null, dt, budget_rank || null,
        out.contact_saved ? "completed" : "failed",
        JSON.stringify({ _test: true, ...req.body, _mode: "contact_only" }),
        out.contact_save_error || out.label_error || out.hour_label_error || null,
      ]
    );
    return res.json(out);
  }

  // ─── MODO full flow ──────────────────────────────────
  const channel = cfg.dm_channel || "callbell";
  if (channel === "evolution" && !cfg.instance_id) {
    return res.status(400).json({ error: "Canal Evolution: falta admin chip" });
  }
  if (channel === "callbell" && !cfg.callbell_channel_uuid) {
    return res.status(400).json({ error: "Canal Callbell: falta channel UUID" });
  }
  const creators = Array.isArray(cfg.group_creator_instance_ids) ? cfg.group_creator_instance_ids : [];
  if (!creators.length) return res.status(400).json({ error: "No hay chips group-creator configurados" });
  const team = Array.isArray(cfg.team_member_ids) ? cfg.team_member_ids : [];
  if (!team.length) return res.status(400).json({ error: "No hay team members configurados" });

  const delayMin = cfg.delay_before_dm_minutes ?? 5;
  const ev = await queryOne(
    `INSERT INTO booking_events
       (user_id, instance_id, lead_phone, lead_name, scheduled_at, budget_rank,
        status, dm_scheduled_at, raw_webhook_payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending',
             NOW() + ($7 || ' minutes')::interval,
             $8)
     RETURNING id`,
    [
      req.user.id, cfg.instance_id,
      cleanPhone, name || null, dt, budget_rank || null,
      delayMin, JSON.stringify({ _test: true, ...req.body }),
    ]
  );

  res.json({ ok: true, booking_id: ev.id, dm_in_minutes: delayMin });
});

// Listar bookings recientes (para ver historial)
router.get("/events", async (req, res) => {
  const rows = await query(
    `SELECT be.*, i.name AS instance_name
     FROM booking_events be
     LEFT JOIN instances i ON i.id = be.group_creator_instance_id
     WHERE be.user_id = $1
     ORDER BY be.id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});

// Debug: ver system_events de un booking específico (para diagnosticar)
router.get("/events/:id/trace", async (req, res) => {
  const be = await queryOne(
    `SELECT * FROM booking_events WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!be) return res.status(404).json({ error: "No encontrado" });

  // Eventos del sistema relacionados a este user en una ventana de tiempo del booking
  // (desde 1 min antes de created_at hasta ahora)
  const since = new Date(new Date(be.created_at).getTime() - 60000).toISOString();
  const sysevents = await query(
    `SELECT event_type, payload, created_at, instance_id
     FROM system_events
     WHERE user_id = $1 AND created_at >= $2
     ORDER BY created_at ASC LIMIT 200`,
    [req.user.id, since]
  );
  // Filtrar los más relevantes al booking
  const related = sysevents.filter(e => {
    if (/booking_/.test(e.event_type)) {
      if (e.payload?.booking_id && e.payload.booking_id !== be.id) return false;
      return true;
    }
    if (e.event_type === "evo_group_participants_raw") return true;
    return false;
  });

  res.json({ booking: be, events: related });
});

module.exports = router;
