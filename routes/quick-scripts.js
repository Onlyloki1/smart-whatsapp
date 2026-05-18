const express = require("express");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

const VALID_TYPES = ["text", "audio", "image", "video", "delay", "tag"];

function normalizeVariants(input, fallback) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string") arr = input.split("\n");
  arr = arr.map(s => String(s || "").trim()).filter(Boolean);
  if (arr.length === 0 && fallback) arr = [String(fallback).trim()].filter(Boolean);
  return arr;
}

async function insertSteps(scriptId, steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!VALID_TYPES.includes(s.step_type)) continue;

    // Variantes (solo aplica a text + captions de media)
    const variants = normalizeVariants(s.text_variants, s.text_content);
    const legacyText = variants[0] || null;

    await exec(
      `INSERT INTO quick_script_steps
         (script_id, order_idx, step_type, text_content, text_variants,
          media_url, delay_seconds, show_typing)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        scriptId, i, s.step_type,
        legacyText,
        JSON.stringify(variants),
        s.media_url || null,
        Math.max(0, parseInt(s.delay_seconds || 0, 10) || 0),
        s.show_typing !== false,
      ]
    );
  }
}

// List
router.get("/", async (req, res) => {
  const rows = await query(
    `SELECT qs.*,
            (SELECT COUNT(*) FROM quick_script_steps s WHERE s.script_id = qs.id) AS step_count
     FROM quick_scripts qs
     WHERE qs.user_id = $1
     ORDER BY qs.enabled DESC, qs.id DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// Get one with steps
router.get("/:id", async (req, res) => {
  const qs = await queryOne(`SELECT * FROM quick_scripts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!qs) return res.status(404).json({ error: "No encontrado" });
  const steps = await query(`SELECT * FROM quick_script_steps WHERE script_id = $1 ORDER BY order_idx ASC, id ASC`, [qs.id]);
  res.json({ ...qs, steps });
});

// Create
router.post("/", async (req, res) => {
  const { name, description, enabled = true, steps = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  const qs = await queryOne(
    `INSERT INTO quick_scripts (user_id, name, description, enabled)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, name, description || null, !!enabled]
  );
  await insertSteps(qs.id, steps);
  res.json(qs);
});

// Update (full replace including steps)
router.put("/:id", async (req, res) => {
  const qs = await queryOne(`SELECT id FROM quick_scripts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!qs) return res.status(404).json({ error: "No encontrado" });

  const { name, description, enabled = true, steps = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: "Nombre requerido" });

  await exec(
    `UPDATE quick_scripts SET name = $1, description = $2, enabled = $3 WHERE id = $4`,
    [name, description || null, !!enabled, qs.id]
  );
  await exec(`DELETE FROM quick_script_steps WHERE script_id = $1`, [qs.id]);
  await insertSteps(qs.id, steps);
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const qs = await queryOne(`SELECT id FROM quick_scripts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!qs) return res.status(404).json({ error: "No encontrado" });
  await exec(`DELETE FROM quick_scripts WHERE id = $1`, [qs.id]);
  res.json({ ok: true });
});

module.exports = router;
