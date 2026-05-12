const express = require("express");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

// Helper: normalizar variantes (string single → array)
function normalizeVariants(input) {
  if (Array.isArray(input)) return input.map(s => String(s || "").trim()).filter(Boolean);
  if (typeof input === "string") {
    return input.split("\n").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

async function insertSteps(arId, steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const variants = normalizeVariants(s.text_variants ?? s.text);
    const legacyText = variants[0] || null; // primer variant también va al campo text para legacy
    await exec(
      `INSERT INTO auto_responder_steps
         (auto_responder_id, order_idx, step_type, text, text_variants,
          media_url, mime_type, file_name,
          delay_min_sec, delay_max_sec, show_typing, append_utm)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [
        arId,
        i,
        s.step_type || "text",
        legacyText,
        JSON.stringify(variants),
        s.media_url || null,
        s.mime_type || null,
        s.file_name || null,
        s.delay_min_sec ?? 8,
        s.delay_max_sec ?? 25,
        s.show_typing !== false,
        s.append_utm !== false,
      ]
    );
  }
}

// ─── List my autoresponders ────────────────────────────
router.get("/", async (req, res) => {
  const rows = await query(
    `SELECT ar.*,
            i.name AS instance_name,
            (SELECT COUNT(*) FROM auto_responder_steps s WHERE s.auto_responder_id = ar.id) AS step_count,
            (SELECT COUNT(*) FROM auto_responder_fired f WHERE f.auto_responder_id = ar.id) AS fired_count
     FROM auto_responders ar
     LEFT JOIN instances i ON i.id = ar.instance_id
     WHERE ar.user_id = $1
     ORDER BY ar.id DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// ─── Get one with steps ────────────────────────────────
router.get("/:id", async (req, res) => {
  const ar = await queryOne(
    `SELECT * FROM auto_responders WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!ar) return res.status(404).json({ error: "No encontrado" });

  const steps = await query(
    `SELECT * FROM auto_responder_steps WHERE auto_responder_id = $1 ORDER BY order_idx ASC, id ASC`,
    [ar.id]
  );
  res.json({ ...ar, steps });
});

// ─── Create ────────────────────────────────────────────
router.post("/", async (req, res) => {
  const {
    name,
    instance_id = null,
    enabled = true,
    trigger_type = "first_message",
    trigger_keyword = null,
    cooldown_hours = 24,
    quiet_hours_start = 9,
    quiet_hours_end = 22,
    timezone = "America/Argentina/Buenos_Aires",
    min_gap_seconds_between_fires = 45,
    skip_rate_pct = 0,
    steps = [],
  } = req.body || {};

  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  if (instance_id) {
    const ok = await queryOne(`SELECT id FROM instances WHERE id = $1 AND user_id = $2`, [
      instance_id,
      req.user.id,
    ]);
    if (!ok) return res.status(400).json({ error: "Chip inválido" });
  }

  const ar = await queryOne(
    `INSERT INTO auto_responders
       (user_id, name, instance_id, enabled, trigger_type, trigger_keyword, cooldown_hours,
        quiet_hours_start, quiet_hours_end, timezone, min_gap_seconds_between_fires, skip_rate_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      req.user.id, name, instance_id, !!enabled, trigger_type, trigger_keyword, cooldown_hours,
      quiet_hours_start, quiet_hours_end, timezone, min_gap_seconds_between_fires, skip_rate_pct
    ]
  );

  await insertSteps(ar.id, steps);
  res.json(ar);
});

// ─── Update (full replace including steps) ─────────────
router.put("/:id", async (req, res) => {
  const ar = await queryOne(`SELECT id FROM auto_responders WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!ar) return res.status(404).json({ error: "No encontrado" });

  const {
    name,
    instance_id = null,
    enabled = true,
    trigger_type = "first_message",
    trigger_keyword = null,
    cooldown_hours = 24,
    quiet_hours_start = 9,
    quiet_hours_end = 22,
    timezone = "America/Argentina/Buenos_Aires",
    min_gap_seconds_between_fires = 45,
    skip_rate_pct = 0,
    steps = [],
  } = req.body || {};

  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  if (instance_id) {
    const ok = await queryOne(`SELECT id FROM instances WHERE id = $1 AND user_id = $2`, [
      instance_id,
      req.user.id,
    ]);
    if (!ok) return res.status(400).json({ error: "Chip inválido" });
  }

  await exec(
    `UPDATE auto_responders
     SET name = $1, instance_id = $2, enabled = $3, trigger_type = $4, trigger_keyword = $5,
         cooldown_hours = $6, quiet_hours_start = $7, quiet_hours_end = $8, timezone = $9,
         min_gap_seconds_between_fires = $10, skip_rate_pct = $11
     WHERE id = $12`,
    [
      name, instance_id, !!enabled, trigger_type, trigger_keyword,
      cooldown_hours, quiet_hours_start, quiet_hours_end, timezone,
      min_gap_seconds_between_fires, skip_rate_pct, ar.id
    ]
  );

  await exec(`DELETE FROM auto_responder_steps WHERE auto_responder_id = $1`, [ar.id]);
  await insertSteps(ar.id, steps);
  res.json({ ok: true });
});

// ─── Toggle enabled ────────────────────────────────────
router.post("/:id/toggle", async (req, res) => {
  const ar = await queryOne(`SELECT id, enabled FROM auto_responders WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!ar) return res.status(404).json({ error: "No encontrado" });

  await exec(`UPDATE auto_responders SET enabled = NOT enabled WHERE id = $1`, [ar.id]);
  res.json({ ok: true, enabled: !ar.enabled });
});

// ─── Delete ────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const ar = await queryOne(`SELECT id FROM auto_responders WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!ar) return res.status(404).json({ error: "No encontrado" });

  await exec(`DELETE FROM auto_responders WHERE id = $1`, [ar.id]);
  res.json({ ok: true });
});

// ─── Test: disparar manualmente a un número ────────────
router.post("/:id/test", async (req, res) => {
  const { phone, instance_id } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });

  const ar = await queryOne(`SELECT * FROM auto_responders WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.id,
  ]);
  if (!ar) return res.status(404).json({ error: "No encontrado" });

  let targetInstanceId = ar.instance_id || instance_id;
  if (!targetInstanceId) {
    const first = await queryOne(
      `SELECT id FROM instances WHERE user_id = $1 AND status = 'connected' LIMIT 1`,
      [req.user.id]
    );
    if (!first) return res.status(400).json({ error: "No tenés ningún chip conectado" });
    targetInstanceId = first.id;
  }

  const { enqueueAutoresponder } = require("../jobs/autoresponder");
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  const count = await enqueueAutoresponder(ar.id, req.user.id, targetInstanceId, cleanPhone);
  res.json({ ok: true, steps_enqueued: count });
});

module.exports = router;
