const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");
const { authMiddleware } = require("../middleware/auth");
const evo = require("../lib/evolution");

const router = express.Router();
router.use(authMiddleware);

// ─── List user instances ───────────────────────────────
router.get("/", async (req, res) => {
  const rows = await query(
    `SELECT i.*, p.host AS proxy_host, p.country AS proxy_country
     FROM instances i
     LEFT JOIN proxies p ON p.id = i.proxy_id
     WHERE i.user_id = $1
     ORDER BY i.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// ─── Create instance (returns QR) ──────────────────────
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Nombre requerido" });

    // Verificar límite
    const count = (await query("SELECT COUNT(*) AS c FROM instances WHERE user_id = $1", [req.user.id]))[0].c;
    const max = parseInt(process.env.MAX_CHIPS_PER_USER || "5", 10);
    if (parseInt(count, 10) >= max) {
      return res.status(403).json({ error: `Límite de ${max} chips alcanzado` });
    }

    // Asignar proxy disponible (opcional)
    const proxy = await queryOne("SELECT * FROM proxies WHERE status = 'available' LIMIT 1");

    const evolutionInstance = `u${req.user.id}-${Date.now()}`;
    const webhookUrl = `${process.env.WEBHOOK_BASE_URL || ""}/api/webhook/evolution/${evolutionInstance}`;

    const evoRes = await evo.createInstance(evolutionInstance, webhookUrl);

    if (proxy) {
      try {
        await evo.setInstanceProxy(evolutionInstance, {
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
        });
        await exec("UPDATE proxies SET status = 'in_use' WHERE id = $1", [proxy.id]);
      } catch (e) {
        console.error("[PROXY SET ERR]", e.message);
      }
    }

    const inst = await queryOne(
      `INSERT INTO instances (user_id, name, evolution_instance, proxy_id, status)
       VALUES ($1, $2, $3, $4, 'connecting') RETURNING *`,
      [req.user.id, name, evolutionInstance, proxy?.id || null]
    );

    await logEvent(req.user.id, inst.id, "instance_created", { evolutionInstance });

    const qr = evoRes?.qrcode?.base64 || evoRes?.qrcode?.code || null;
    res.json({ instance: inst, qr });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── Get QR / connection state ─────────────────────────
router.get("/:id/state", async (req, res) => {
  const inst = await queryOne("SELECT * FROM instances WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (!inst) return res.status(404).json({ error: "No encontrada" });

  try {
    const state = await evo.getConnectionState(inst.evolution_instance);
    res.json({ instance: inst, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/qr", async (req, res) => {
  const inst = await queryOne("SELECT * FROM instances WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (!inst) return res.status(404).json({ error: "No encontrada" });

  try {
    const data = await evo.connectInstance(inst.evolution_instance);
    res.json({ qr: data?.base64 || data?.code, raw: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Logout (chip mantiene historia, solo cierra sesión) ─
router.post("/:id/logout", async (req, res) => {
  const inst = await queryOne("SELECT * FROM instances WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (!inst) return res.status(404).json({ error: "No encontrada" });

  try {
    await evo.logoutInstance(inst.evolution_instance);
    await exec("UPDATE instances SET status = 'disconnected' WHERE id = $1", [inst.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete instance completamente ─────────────────────
router.delete("/:id", async (req, res) => {
  const inst = await queryOne("SELECT * FROM instances WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (!inst) return res.status(404).json({ error: "No encontrada" });

  try {
    try { await evo.deleteInstance(inst.evolution_instance); } catch (e) { console.error("[DELETE EVO]", e.message); }
    if (inst.proxy_id) {
      await exec("UPDATE proxies SET status = 'available' WHERE id = $1", [inst.proxy_id]);
    }
    await exec("DELETE FROM instances WHERE id = $1", [inst.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
