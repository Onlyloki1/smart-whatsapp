const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query, queryOne, exec } = require("../db");
const { authMiddleware, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y password requeridos" });
  if (password.length < 8) return res.status(400).json({ error: "Password mínimo 8 caracteres" });

  try {
    const existing = await queryOne("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (existing) return res.status(409).json({ error: "Ese email ya está registrado" });

    const hash = bcrypt.hashSync(password, 10);
    const totalUsers = (await query("SELECT COUNT(*) as c FROM users"))[0].c;
    const role = parseInt(totalUsers, 10) === 0 ? "admin" : "client";

    const user = await queryOne(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role",
      [email.toLowerCase().trim(), hash, name || null, role]
    );

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: "lax" });
    res.json(user);
  } catch (err) {
    console.error("[REGISTER ERR]", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y password requeridos" });

  try {
    const user = await queryOne("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: "lax" });
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/me", authMiddleware, (req, res) => {
  res.json(req.user);
});

module.exports = router;
