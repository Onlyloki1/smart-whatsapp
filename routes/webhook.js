const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");

const router = express.Router();

// Evolution API webhook — eventos de cada instancia
router.post("/evolution/:evolutionInstance", async (req, res) => {
  // Responder rápido para que Evolution no reintente
  res.json({ ok: true });

  try {
    const { evolutionInstance } = req.params;
    const { event, data } = req.body || {};

    const inst = await queryOne(
      "SELECT * FROM instances WHERE evolution_instance = $1",
      [evolutionInstance]
    );
    if (!inst) {
      console.warn(`[WEBHOOK] Instancia desconocida: ${evolutionInstance}`);
      return;
    }

    await logEvent(inst.user_id, inst.id, `evo_${event}`, data || {});

    switch (event) {
      case "connection.update":
      case "CONNECTION_UPDATE": {
        const state = data?.state;
        if (state === "open") {
          await exec(
            "UPDATE instances SET status = 'connected', phone_number = COALESCE($1, phone_number) WHERE id = $2",
            [data?.wuid || data?.user?.id || null, inst.id]
          );
        } else if (state === "close") {
          await exec("UPDATE instances SET status = 'disconnected' WHERE id = $1", [inst.id]);
        } else if (state === "connecting") {
          await exec("UPDATE instances SET status = 'connecting' WHERE id = $1", [inst.id]);
        }
        break;
      }

      case "messages.upsert":
      case "MESSAGES_UPSERT": {
        await handleIncomingMessage(inst, data);
        break;
      }

      case "qrcode.updated":
      case "QRCODE_UPDATED": {
        // QR refresco (cliente puede pedir nuevo via /qr)
        break;
      }
    }
  } catch (err) {
    console.error("[WEBHOOK ERR]", err.message);
  }
});

async function handleIncomingMessage(inst, data) {
  // Evolution puede mandar uno o un array
  const messages = Array.isArray(data) ? data : data?.messages ? data.messages : [data];

  for (const msg of messages) {
    if (!msg) continue;

    // Filtrar grupos (warmup) — solo procesar DMs 1-a-1
    const remoteJid = msg.key?.remoteJid || "";
    if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) continue;

    const fromMe = !!msg.key?.fromMe;
    const phone = remoteJid.replace(/@s\.whatsapp\.net$/, "").replace(/@c\.us$/, "");
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";
    const direction = fromMe ? "out" : "in";
    const evoMsgId = msg.key?.id || null;
    const contactName = msg.pushName || null;

    // Guardar en log
    await exec(
      `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inst.user_id, inst.id, phone, direction, text, evoMsgId]
    );

    // Upsert conversación
    await exec(
      `INSERT INTO conversations (user_id, instance_id, phone, contact_name, last_msg_text, last_msg_at, last_direction, unread_count)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
       ON CONFLICT (instance_id, phone) DO UPDATE SET
         contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
         last_msg_text = EXCLUDED.last_msg_text,
         last_msg_at = NOW(),
         last_direction = EXCLUDED.last_direction,
         unread_count = CASE WHEN EXCLUDED.last_direction = 'in' THEN conversations.unread_count + 1 ELSE conversations.unread_count END`,
      [inst.user_id, inst.id, phone, contactName, text, direction, direction === "in" ? 1 : 0]
    );

    // Si era inbound, marcar lead como replied
    if (direction === "in") {
      await exec(
        `UPDATE leads SET status = 'replied', replied_at = NOW()
         WHERE instance_id = $1 AND phone = $2 AND status IN ('sent', 'pending')`,
        [inst.id, phone]
      );
    }
  }
}

module.exports = router;
