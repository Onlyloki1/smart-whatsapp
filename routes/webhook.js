const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");
const autoresponder = require("../jobs/autoresponder");

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

    // Estado previo de la conversación (antes de cualquier insert)
    const prevConvo = await queryOne(
      `SELECT id, human_takeover FROM conversations WHERE instance_id = $1 AND phone = $2`,
      [inst.id, phone]
    );
    const isNewConversation = !prevConvo;

    // ─── Outbound (fromMe=true): puede ser nuestro sistema o un humano ───
    if (direction === "out") {
      // Si ya logueamos este evolution_msg_id, fue nuestro sender/autoresponder → ignorar duplicado
      const alreadyLogged = evoMsgId
        ? await queryOne(
            `SELECT id FROM messages_log WHERE instance_id = $1 AND evolution_msg_id = $2 LIMIT 1`,
            [inst.id, evoMsgId]
          )
        : null;

      if (alreadyLogged) {
        continue; // ya está en log, nada que hacer
      }

      // Es outbound NO loguead → vino del celu del humano → take over
      await exec(
        `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
         VALUES ($1, $2, $3, 'out', $4, $5)`,
        [inst.user_id, inst.id, phone, text, evoMsgId]
      );

      await exec(
        `INSERT INTO conversations (user_id, instance_id, phone, contact_name, last_msg_text, last_msg_at, last_direction, unread_count, human_takeover, human_takeover_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), 'out', 0, TRUE, NOW())
         ON CONFLICT (instance_id, phone) DO UPDATE SET
           contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
           last_msg_text = EXCLUDED.last_msg_text,
           last_msg_at = NOW(),
           last_direction = 'out',
           human_takeover = TRUE,
           human_takeover_at = COALESCE(conversations.human_takeover_at, NOW())`,
        [inst.user_id, inst.id, phone, contactName, text]
      );
      continue;
    }

    // ─── Inbound ───
    await exec(
      `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
       VALUES ($1, $2, $3, 'in', $4, $5)`,
      [inst.user_id, inst.id, phone, text, evoMsgId]
    );

    await exec(
      `INSERT INTO conversations (user_id, instance_id, phone, contact_name, last_msg_text, last_msg_at, last_direction, unread_count)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'in', 1)
       ON CONFLICT (instance_id, phone) DO UPDATE SET
         contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
         last_msg_text = EXCLUDED.last_msg_text,
         last_msg_at = NOW(),
         last_direction = 'in',
         unread_count = conversations.unread_count + 1`,
      [inst.user_id, inst.id, phone, contactName, text]
    );

    // Marcar lead como replied (para campañas outbound)
    await exec(
      `UPDATE leads SET status = 'replied', replied_at = NOW()
       WHERE instance_id = $1 AND phone = $2 AND status IN ('sent', 'pending')`,
      [inst.id, phone]
    );

    // ─── Disparar autoresponder ───
    await maybeFireAutoresponder({
      inst,
      phone,
      text,
      wasNewConversation: isNewConversation,
      priorTakeover: !!prevConvo?.human_takeover,
    });
  }
}

async function maybeFireAutoresponder({ inst, phone, text, wasNewConversation, priorTakeover }) {
  // Si un humano ya tomó la conversación, no disparar nunca más
  if (priorTakeover) return;

  // Buscar autoresponders aplicables al chip (específico) o globales (instance_id NULL)
  const responders = await query(
    `SELECT * FROM auto_responders
     WHERE user_id = $1
       AND enabled = TRUE
       AND (instance_id IS NULL OR instance_id = $2)
     ORDER BY (instance_id IS NOT NULL) DESC, id ASC`,
    [inst.user_id, inst.id]
  );

  for (const ar of responders) {
    // Filtrar por trigger
    if (ar.trigger_type === "first_message" && !wasNewConversation) continue;
    if (ar.trigger_type === "keyword") {
      const kw = (ar.trigger_keyword || "").toLowerCase().trim();
      if (!kw || !(text || "").toLowerCase().includes(kw)) continue;
    }
    // 'any' siempre dispara

    // Cooldown: ¿este número ya recibió este autoresponder en las últimas N horas?
    const cooldown = ar.cooldown_hours || 24;
    const fired = await queryOne(
      `SELECT fired_at FROM auto_responder_fired
       WHERE auto_responder_id = $1 AND instance_id = $2 AND phone = $3`,
      [ar.id, inst.id, phone]
    );
    if (fired && cooldown > 0) {
      const hoursAgo = (Date.now() - new Date(fired.fired_at).getTime()) / 3600000;
      if (hoursAgo < cooldown) continue;
    }

    // Encolar
    const count = await autoresponder.enqueueAutoresponder(ar.id, inst.user_id, inst.id, phone);
    await logEvent(inst.user_id, inst.id, "autoresponder_fired", {
      auto_responder_id: ar.id,
      phone,
      steps: count,
    });

    // Solo dispara el PRIMER match (chip-specific gana sobre global gracias al ORDER BY)
    break;
  }
}

module.exports = router;
