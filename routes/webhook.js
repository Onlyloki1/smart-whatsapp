const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

const router = express.Router();

// Debounce ANTES de disparar el autoresponder: si el lead manda 3 mensajes
// seguidos, esperamos a que pase X segundos sin nuevos inbounds para disparar.
// Eso simula humano que lee TODO antes de contestar.
const DEBOUNCE_MIN_SEC = 15;
const DEBOUNCE_MAX_SEC = 30;
function debounceSeconds() {
  return DEBOUNCE_MIN_SEC + Math.floor(Math.random() * (DEBOUNCE_MAX_SEC - DEBOUNCE_MIN_SEC + 1));
}

// Genera un nombre amigable para "agendar" el lead en la libreta del chip
function genCustomName(pushName, phone) {
  const last4 = (phone || "").slice(-4);
  if (pushName && pushName.trim()) return `${pushName.trim().slice(0, 20)} (Lead ${last4})`;
  const d = new Date();
  return `Lead-${d.toISOString().slice(0,10)}-${last4}`;
}

router.post("/evolution/:evolutionInstance", async (req, res) => {
  res.json({ ok: true }); // responder rápido

  try {
    const { evolutionInstance } = req.params;
    const { event, data } = req.body || {};

    const inst = await queryOne(
      "SELECT * FROM instances WHERE evolution_instance = $1",
      [evolutionInstance]
    );
    if (!inst) return console.warn(`[WEBHOOK] Instancia desconocida: ${evolutionInstance}`);

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
      case "MESSAGES_UPSERT":
        await handleIncomingMessage(inst, data);
        break;
    }
  } catch (err) {
    console.error("[WEBHOOK ERR]", err.message);
  }
});

async function handleIncomingMessage(inst, data) {
  const messages = Array.isArray(data) ? data : data?.messages ? data.messages : [data];

  for (const msg of messages) {
    if (!msg) continue;

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
    const evoMsgId = msg.key?.id || null;
    const contactName = msg.pushName || null;

    const prevConvo = await queryOne(
      `SELECT id, human_takeover, custom_name, autoresponder_pending_was_new
       FROM conversations WHERE instance_id = $1 AND phone = $2`,
      [inst.id, phone]
    );
    const isNewConversation = !prevConvo;

    // ─── OUTBOUND fromMe=true ──────────────────────────────────────
    if (fromMe) {
      const alreadyLogged = evoMsgId
        ? await queryOne(
            `SELECT id FROM messages_log WHERE instance_id = $1 AND evolution_msg_id = $2 LIMIT 1`,
            [inst.id, evoMsgId]
          )
        : null;
      if (alreadyLogged) continue; // ya logueado por nuestro sistema

      // Outbound NO loguead = vino del celu del humano → takeover
      await exec(
        `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
         VALUES ($1, $2, $3, 'out', $4, $5)`,
        [inst.user_id, inst.id, phone, text, evoMsgId]
      );
      await exec(
        `INSERT INTO conversations
           (user_id, instance_id, phone, contact_name, last_msg_text, last_msg_at, last_direction, unread_count, human_takeover, human_takeover_at)
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
      // Tomar control humano = cancelar autoresponder pendiente de esta conversación
      await exec(
        `UPDATE conversations SET autoresponder_pending_at = NULL WHERE instance_id = $1 AND phone = $2`,
        [inst.id, phone]
      );
      continue;
    }

    // ─── INBOUND ──────────────────────────────────────────────────
    await exec(
      `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
       VALUES ($1, $2, $3, 'in', $4, $5)`,
      [inst.user_id, inst.id, phone, text, evoMsgId]
    );

    // Insert / update conversation + setear debounce + tracking del último inbound
    // Si ya hay un debounce activo, lo EXTENDEMOS (sliding window) — preserva
    // was_new del primer inbound del burst.
    const debounceSec = debounceSeconds();
    const customName = prevConvo?.custom_name || genCustomName(contactName, phone);

    await exec(
      `INSERT INTO conversations
         (user_id, instance_id, phone, contact_name, custom_name,
          last_msg_text, last_msg_at, last_direction, unread_count,
          last_inbound_at, last_inbound_msg_id,
          autoresponder_pending_at, autoresponder_pending_was_new)
       VALUES ($1, $2, $3, $4, $5,
               $6, NOW(), 'in', 1,
               NOW(), $7,
               NOW() + ($8 || ' seconds')::interval, $9)
       ON CONFLICT (instance_id, phone) DO UPDATE SET
         contact_name = COALESCE(EXCLUDED.contact_name, conversations.contact_name),
         custom_name = COALESCE(conversations.custom_name, EXCLUDED.custom_name),
         last_msg_text = EXCLUDED.last_msg_text,
         last_msg_at = NOW(),
         last_direction = 'in',
         unread_count = conversations.unread_count + 1,
         last_inbound_at = NOW(),
         last_inbound_msg_id = EXCLUDED.last_inbound_msg_id,
         autoresponder_pending_at = CASE
           WHEN conversations.human_takeover THEN NULL
           ELSE NOW() + ($8 || ' seconds')::interval
         END,
         autoresponder_pending_was_new = COALESCE(conversations.autoresponder_pending_was_new, EXCLUDED.autoresponder_pending_was_new)`,
      [
        inst.user_id, inst.id, phone, contactName, customName,
        text, evoMsgId,
        debounceSec, isNewConversation,
      ]
    );

    // Marcar lead como replied (para campañas outbound)
    await exec(
      `UPDATE leads SET status = 'replied', replied_at = NOW()
       WHERE instance_id = $1 AND phone = $2 AND status IN ('sent', 'pending')`,
      [inst.id, phone]
    );

    // Best-effort: "agendar" el contacto en la libreta del chip (Evolution side)
    // Solo lo hacemos UNA VEZ por conversación. No bloquea nada si falla.
    if (!prevConvo) {
      evo.updateContactName(inst.evolution_instance, phone, customName)
        .then(() => exec(`UPDATE conversations SET contact_saved_at = NOW() WHERE instance_id = $1 AND phone = $2`, [inst.id, phone]))
        .catch(() => {});
    }
  }
}

module.exports = router;
