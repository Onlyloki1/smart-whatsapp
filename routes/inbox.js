const express = require("express");
const { query, queryOne, exec } = require("../db");
const { authMiddleware } = require("../middleware/auth");
const evo = require("../lib/evolution");

const router = express.Router();
router.use(authMiddleware);

// ─── Lista de conversaciones (todas las del user, filtros opcionales) ──
router.get("/conversations", async (req, res) => {
  const { instance_id, q, unread } = req.query;
  const params = [req.user.id];
  let sql = `
    SELECT c.*, i.name AS instance_name, i.phone_number AS instance_phone
    FROM conversations c
    JOIN instances i ON i.id = c.instance_id
    WHERE c.user_id = $1
  `;
  if (instance_id) {
    params.push(instance_id);
    sql += ` AND c.instance_id = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (c.phone ILIKE $${params.length} OR c.contact_name ILIKE $${params.length} OR c.last_msg_text ILIKE $${params.length})`;
  }
  if (unread === "1") {
    sql += ` AND c.unread_count > 0`;
  }
  sql += ` ORDER BY c.last_msg_at DESC NULLS LAST LIMIT 200`;
  const rows = await query(sql, params);
  res.json(rows);
});

// ─── Mensajes de una conversación ──────────────────────
router.get("/conversations/:id/messages", async (req, res) => {
  const convo = await queryOne(
    `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "Conversación no encontrada" });

  const messages = await query(
    `SELECT id, direction, text, media_url, media_type, created_at
     FROM messages_log
     WHERE instance_id = $1 AND phone = $2
     ORDER BY id ASC
     LIMIT 500`,
    [convo.instance_id, convo.phone]
  );

  // Marcar como leído
  await exec(`UPDATE conversations SET unread_count = 0 WHERE id = $1`, [convo.id]);

  res.json({ conversation: convo, messages });
});

// ─── Mandar mensaje manual (desde panel) ───────────────
// Al responder manualmente, se marca human_takeover = TRUE
// y se cancelan autoresponder steps pendientes
router.post("/conversations/:id/send", async (req, res) => {
  const { text, media_url, media_type } = req.body || {};
  if (!text && !media_url) return res.status(400).json({ error: "Texto o media requerido" });

  const convo = await queryOne(
    `SELECT c.*, i.evolution_instance, i.status AS instance_status
     FROM conversations c
     JOIN instances i ON i.id = c.instance_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "Conversación no encontrada" });
  if (convo.instance_status !== "connected") {
    return res.status(400).json({ error: "El chip no está conectado" });
  }

  try {
    let result;
    if (media_url) {
      result = await evo.sendMedia(
        convo.evolution_instance,
        convo.phone,
        media_type || "image",
        media_url,
        { caption: text || undefined }
      );
    } else {
      result = await evo.sendText(convo.evolution_instance, convo.phone, text);
    }

    await exec(
      `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, media_url, media_type, evolution_msg_id)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`,
      [
        req.user.id,
        convo.instance_id,
        convo.phone,
        text || null,
        media_url || null,
        media_url ? media_type || "image" : null,
        result?.key?.id || null,
      ]
    );

    // Human takeover + cancelar autoresponder pendiente
    await exec(
      `UPDATE conversations
       SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out',
           human_takeover = TRUE,
           human_takeover_at = COALESCE(human_takeover_at, NOW())
       WHERE id = $2`,
      [(text || `[${media_type || "media"}]`).slice(0, 300), convo.id]
    );

    await exec(
      `UPDATE auto_responder_queue
       SET status = 'cancelled'
       WHERE status = 'pending' AND instance_id = $1 AND phone = $2`,
      [convo.instance_id, convo.phone]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── Re-habilitar autoresponder en una conversación ────
router.post("/conversations/:id/release-takeover", async (req, res) => {
  const convo = await queryOne(
    `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "No encontrada" });

  await exec(
    `UPDATE conversations SET human_takeover = FALSE, human_takeover_at = NULL WHERE id = $1`,
    [convo.id]
  );
  res.json({ ok: true });
});

// ─── Borrar conversación + reset (para testing del bot) ────
// Wipea: mensajes, conversación, fired markers (cooldown del autoresponder),
// y cola pendiente. La próxima vez que el número escriba, el autoresponder
// dispara como si fuera primer mensaje.
router.delete("/conversations/:id", async (req, res) => {
  const convo = await queryOne(
    `SELECT id, instance_id, phone FROM conversations WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "No encontrada" });

  await exec(
    `DELETE FROM messages_log WHERE instance_id = $1 AND phone = $2`,
    [convo.instance_id, convo.phone]
  );
  await exec(
    `DELETE FROM auto_responder_fired WHERE instance_id = $1 AND phone = $2`,
    [convo.instance_id, convo.phone]
  );
  await exec(
    `DELETE FROM auto_responder_queue WHERE instance_id = $1 AND phone = $2`,
    [convo.instance_id, convo.phone]
  );
  await exec(`DELETE FROM conversations WHERE id = $1`, [convo.id]);

  res.json({ ok: true });
});

// ─── Dispatch un script a la conversación ──────────────
// Encola todos los steps del script con scheduled_at calculado según delays.
router.post("/conversations/:id/dispatch-script", async (req, res) => {
  const { script_id } = req.body || {};
  if (!script_id) return res.status(400).json({ error: "script_id requerido" });

  const convo = await queryOne(
    `SELECT c.*, i.evolution_instance, i.status AS instance_status
     FROM conversations c JOIN instances i ON i.id = c.instance_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "Conversación no encontrada" });
  if (convo.instance_status !== "connected") {
    return res.status(400).json({ error: "Chip no conectado" });
  }

  const script = await queryOne(
    `SELECT * FROM quick_scripts WHERE id = $1 AND user_id = $2 AND enabled = TRUE`,
    [script_id, req.user.id]
  );
  if (!script) return res.status(404).json({ error: "Script no encontrado o desactivado" });

  const { dispatchScript } = require("../jobs/inbox-dispatcher");
  const count = await dispatchScript({
    userId: req.user.id,
    instanceId: convo.instance_id,
    conversationId: convo.id,
    phone: convo.phone,
    scriptId: script.id,
  });

  // Marcar takeover (humano dispatched = takeover)
  await exec(
    `UPDATE conversations
     SET human_takeover = TRUE, human_takeover_at = COALESCE(human_takeover_at, NOW())
     WHERE id = $1`,
    [convo.id]
  );
  // Cancelar autoresponder pendiente
  await exec(
    `UPDATE auto_responder_queue SET status = 'cancelled'
     WHERE status = 'pending' AND instance_id = $1 AND phone = $2`,
    [convo.instance_id, convo.phone]
  );

  res.json({ ok: true, steps_enqueued: count, script: script.name });
});

// ─── Labels (etiquetas WA Business de una conversación) ────────
// GET: lista de labels actuales de la conversación
router.get("/conversations/:id/labels", async (req, res) => {
  const convo = await queryOne(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!convo) return res.status(404).json({ error: "No encontrada" });
  const rows = await query(
    `SELECT label_id, label_name, applied_at FROM conversation_labels WHERE conversation_id = $1 ORDER BY applied_at DESC`,
    [convo.id]
  );
  res.json(rows);
});

// POST: aplicar una label (matchea por nombre en Evolution)
router.post("/conversations/:id/labels", async (req, res) => {
  const { label_name } = req.body || {};
  if (!label_name) return res.status(400).json({ error: "label_name requerido" });

  const convo = await queryOne(
    `SELECT c.*, i.evolution_instance, i.status AS instance_status
     FROM conversations c JOIN instances i ON i.id = c.instance_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "Conversación no encontrada" });
  if (convo.instance_status !== "connected") return res.status(400).json({ error: "Chip no conectado" });

  try {
    const labels = await evo.findLabels(convo.evolution_instance);
    const wanted = String(label_name).trim();
    const found = labels.find(l => String(l?.name || "").trim() === wanted);
    if (!found) return res.status(404).json({ error: `Etiqueta "${wanted}" no existe en el chip` });
    const labelId = found.id || found.labelId;
    const remoteJid = `${convo.phone}@s.whatsapp.net`;
    await evo.handleLabel(convo.evolution_instance, remoteJid, labelId, "add");
    await exec(
      `INSERT INTO conversation_labels (conversation_id, label_id, label_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, label_id) DO NOTHING`,
      [convo.id, String(labelId), wanted]
    );
    res.json({ ok: true, label_id: labelId, label_name: wanted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE: quitar label
router.delete("/conversations/:id/labels/:labelId", async (req, res) => {
  const convo = await queryOne(
    `SELECT c.*, i.evolution_instance, i.status AS instance_status
     FROM conversations c JOIN instances i ON i.id = c.instance_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!convo) return res.status(404).json({ error: "Conversación no encontrada" });
  if (convo.instance_status !== "connected") return res.status(400).json({ error: "Chip no conectado" });

  try {
    const remoteJid = `${convo.phone}@s.whatsapp.net`;
    await evo.handleLabel(convo.evolution_instance, remoteJid, req.params.labelId, "remove");
    await exec(
      `DELETE FROM conversation_labels WHERE conversation_id = $1 AND label_id = $2`,
      [convo.id, req.params.labelId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listar labels disponibles del chip (para el dropdown)
router.get("/instances/:id/labels", async (req, res) => {
  const inst = await queryOne(`SELECT * FROM instances WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  if (!inst) return res.status(404).json({ error: "No encontrada" });
  if (inst.status !== "connected") return res.json({ labels: [], error: "Chip no conectado" });
  try {
    const labels = await evo.findLabels(inst.evolution_instance);
    res.json({ labels });
  } catch (e) {
    res.json({ labels: [], error: e.message });
  }
});

module.exports = router;
