// Worker del autoresponder
// Corre cada 5s. Toma items pendientes de auto_responder_queue cuyo
// scheduled_at ya pasó y los manda por Evolution.
// Si la conversación ya tuvo human_takeover, cancela los pendientes.

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function tick() {
  // 1) Cancelar pendientes de conversaciones con human_takeover
  await exec(`
    UPDATE auto_responder_queue q
    SET status = 'cancelled'
    FROM conversations c
    WHERE q.status = 'pending'
      AND c.instance_id = q.instance_id
      AND c.phone = q.phone
      AND c.human_takeover = TRUE
  `);

  // 2) Tomar items pendientes vencidos
  const items = await query(`
    SELECT q.*, s.step_type, s.text, s.media_url, s.mime_type, s.file_name,
           s.show_typing, s.delay_min_sec, s.delay_max_sec,
           i.evolution_instance, i.status AS instance_status
    FROM auto_responder_queue q
    JOIN auto_responder_steps s ON s.id = q.step_id
    JOIN instances i ON i.id = q.instance_id
    WHERE q.status = 'pending'
      AND q.scheduled_at <= NOW()
    ORDER BY q.scheduled_at ASC
    LIMIT 20
  `);

  for (const item of items) {
    // Si el chip no está conectado, lo dejamos pending un rato
    if (item.instance_status !== "connected") {
      await exec(
        `UPDATE auto_responder_queue SET scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
        [item.id]
      );
      continue;
    }

    // Reclamar el item (evita doble envío si hay overlap del cron)
    const claimed = await queryOne(
      `UPDATE auto_responder_queue
       SET status = 'sending', attempt_count = attempt_count + 1
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [item.id]
    );
    if (!claimed) continue;

    try {
      // "Escribiendo..." opcional
      if (item.show_typing) {
        const typingMs = rand(1500, 4000);
        await evo.sendPresence(item.evolution_instance, item.phone, "composing", typingMs);
      }

      let result;
      if (item.step_type === "text") {
        result = await evo.sendText(item.evolution_instance, item.phone, item.text || "");
      } else {
        // media: image / video / audio / document
        result = await evo.sendMedia(
          item.evolution_instance,
          item.phone,
          item.step_type,
          item.media_url,
          {
            caption: item.text || undefined,
            mimetype: item.mime_type || undefined,
            fileName: item.file_name || undefined,
          }
        );
      }

      // OK: marcar sent + loguear
      await exec(
        `UPDATE auto_responder_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [item.id]
      );

      await exec(
        `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, media_url, media_type, evolution_msg_id)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`,
        [
          item.user_id,
          item.instance_id,
          item.phone,
          item.text || null,
          item.step_type === "text" ? null : item.media_url,
          item.step_type === "text" ? null : item.step_type,
          result?.key?.id || null,
        ]
      );

      // Actualizar conversación
      const previewText =
        item.step_type === "text"
          ? (item.text || "").slice(0, 200)
          : `[${item.step_type}]${item.text ? " " + item.text.slice(0, 150) : ""}`;
      await exec(
        `UPDATE conversations
         SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out'
         WHERE instance_id = $2 AND phone = $3`,
        [previewText, item.instance_id, item.phone]
      );

      await logEvent(item.user_id, item.instance_id, "autoresponder_step_sent", {
        queue_id: item.id,
        step_id: item.step_id,
        step_type: item.step_type,
        phone: item.phone,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      const willRetry = claimed.attempt_count < 3;
      await exec(
        `UPDATE auto_responder_queue
         SET status = $1, error_message = $2, scheduled_at = CASE WHEN $3 THEN NOW() + interval '120 seconds' ELSE scheduled_at END
         WHERE id = $4`,
        [willRetry ? "pending" : "failed", String(errMsg).slice(0, 300), willRetry, item.id]
      );
      await logEvent(item.user_id, item.instance_id, "autoresponder_step_failed", {
        queue_id: item.id,
        error: errMsg,
        will_retry: willRetry,
      });
    }
  }
}

// API pública: encolar todos los steps de un autoresponder para un (instance, phone)
async function enqueueAutoresponder(autoResponderId, userId, instanceId, phone) {
  const steps = await query(
    `SELECT * FROM auto_responder_steps
     WHERE auto_responder_id = $1
     ORDER BY order_idx ASC, id ASC`,
    [autoResponderId]
  );
  if (!steps.length) return 0;

  let cumulative = 0; // segundos acumulados desde "ahora"
  for (const s of steps) {
    const delay = rand(s.delay_min_sec || 0, s.delay_max_sec || 0);
    cumulative += delay;
    await exec(
      `INSERT INTO auto_responder_queue (user_id, instance_id, phone, step_id, scheduled_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [userId, instanceId, phone, s.id, cumulative]
    );
  }

  // Marcar como disparado
  await exec(
    `INSERT INTO auto_responder_fired (auto_responder_id, instance_id, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (auto_responder_id, instance_id, phone) DO UPDATE SET fired_at = NOW()`,
    [autoResponderId, instanceId, phone]
  );

  return steps.length;
}

function start() {
  console.log("[AUTORESPONDER] Worker iniciado (cron: cada 5s)");
  cron.schedule("*/5 * * * * *", () => {
    tick().catch((err) => console.error("[AUTORESPONDER ERR]", err.message));
  });
}

module.exports = { start, tick, enqueueAutoresponder };
