// Team members del booking flow (renombrado mentalmente desde "closers")
// La tabla se llama closers por compat, pero ahora soporta multiple roles.
const express = require("express");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

const VALID_ROLES = ["owner", "closer", "triager", "other"];

router.get("/", async (req, res) => {
  const rows = await query(
    `SELECT * FROM closers WHERE user_id = $1 ORDER BY active DESC, role, id`,
    [req.user.id]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name, phone, role = "closer", active = true } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name y phone requeridos" });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "role inválido" });
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.length < 8) return res.status(400).json({ error: "Teléfono inválido (incluir código país)" });

  const c = await queryOne(
    `INSERT INTO closers (user_id, name, phone, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user.id, name.trim(), cleanPhone, role, !!active]
  );
  res.json(c);
});

router.put("/:id", async (req, res) => {
  const c = await queryOne(`SELECT id FROM closers WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!c) return res.status(404).json({ error: "No encontrado" });

  const { name, phone, role = "closer", active } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name y phone requeridos" });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "role inválido" });
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");

  await exec(
    `UPDATE closers SET name = $1, phone = $2, role = $3, active = $4 WHERE id = $5`,
    [name.trim(), cleanPhone, role, !!active, c.id]
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
