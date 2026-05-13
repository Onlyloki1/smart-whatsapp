const express = require("express");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

router.get("/", async (req, res) => {
  const rows = await query(
    `SELECT * FROM closers WHERE user_id = $1 ORDER BY active DESC, id DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name, phone, active = true } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name y phone requeridos" });
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.length < 8) return res.status(400).json({ error: "Teléfono inválido (debe incluir código país)" });

  const c = await queryOne(
    `INSERT INTO closers (user_id, name, phone, active) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, name.trim(), cleanPhone, !!active]
  );
  res.json(c);
});

router.put("/:id", async (req, res) => {
  const c = await queryOne(`SELECT id FROM closers WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!c) return res.status(404).json({ error: "No encontrado" });

  const { name, phone, active } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name y phone requeridos" });
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");

  await exec(
    `UPDATE closers SET name = $1, phone = $2, active = $3 WHERE id = $4`,
    [name.trim(), cleanPhone, !!active, c.id]
  );
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const c = await queryOne(`SELECT id FROM closers WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!c) return res.status(404).json({ error: "No encontrado" });
  await exec(`DELETE FROM closers WHERE id = $1`, [c.id]);
  res.json({ ok: true });
});

module.exports = router;
