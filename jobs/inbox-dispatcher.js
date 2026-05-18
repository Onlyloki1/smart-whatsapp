// Worker del dispatcher de la inbox.
// Procesa inbox_dispatch_queue cada 5s: cuando un step vence (scheduled_at <= NOW)
// y la conversación NO fue tomada manualmente desde otra vía, lo envía vía Evolution.
//
// Soporta steps: text / audio / image / video / tag (aplica label)
// 'delay' steps no se enquean — solo agregan tiempo al scheduled_at del siguiente step.

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function tick() {
  const items = await query(`
    SELECT q.*, i.evolution_instance, i.status AS instance_status
    FROM inbox_dispatch_queue q
    JOIN instances i ON i.id = q.instance_id
    WHERE q.status = 'pending'
      AND q.scheduled_at <= NOW()
    ORDER BY q.scheduled_at ASC
    LIMIT 10
  `);

  for (const item of items) {
    if (item.instance_status !== "connected") {
      // chip offline: reintentar en 60s
      await exec(
        `UPDATE inbox_dispatch_queue SET scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
        [item.id]
      );
      continue;
    }

    const claimed = await queryOne(
      `UPDATE inbox_dispatch_queue
       SET status = 'sending', attempt_count = attempt_count + 1
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [item.id]
    );
    if (!claimed) continue;

    const cleanPhone = String(item.phone).replace(/[^0-9]/g, "");
    const remoteJid = `${cleanPhone}@s.whatsapp.net`;

    try {
      let result = null;

      if (item.step_type === "text") {
        // Mini typing presence
        await evo.sendPresence(item.evolution_instance, cleanPhone, "composing", rand(1500, 3500)).catch(()=>{});
        result = await evo.sendText(item.evolution_instance, cleanPhone, item.text_content || "");
      } else if (item.step_type === "audio") {
        await evo.sendPresence(item.evolution_instance, cleanPhone, "recording", rand(1500, 3500)).catch(()=>{});
        result = await evo.sendWhatsAppAudio(item.evolution_instance, cleanPhone, item.media_url);
      } else if (item.step_type === "image" || item.step_type === "video") {
        result = await evo.sendMedia(item.evolution_instance, cleanPhone, item.step_type, item.media_url, {
          caption: item.text_content || undefined,
        });
      } else if (item.step_type === "tag") {
        // text_content = label name; resolvemos label_id desde Evolution
        const labels = await evo.findLabels(item.evolution_instance);
        const wanted = String(item.text_content || "").trim();
        const found = labels.find(l => String(l?.name || "").trim() === wanted);
        if (!found) throw new Error(`Etiqueta "${wanted}" no existe en el chip`);
        const labelId = found.id || found.labelId;
        await evo.handleLabel(item.evolution_instance, remoteJid, labelId, "add");
        // Cache local
        if (item.conversation_id) {
          await exec(
            `INSERT INTO conversation_labels (conversation_id, label_id, label_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id, label_id) DO NOTHING`,
            [item.conversation_id, String(labelId), wanted]
          );
        }
        result = { tagged: wanted };
      } else {
        // 'delay' u otro: no debería estar en la queue, lo marcamos sent
        result = { skipped: true };
      }

      await exec(
        `UPDATE inbox_dispatch_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [item.id]
      );

      // Loggear mensaje si fue text/media
      if (item.step_type === "text" || item.step_type === "audio" || item.step_type === "image" || item.step_type === "video") {
        await exec(
          `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, media_url, media_type, evolution_msg_id)
           VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`,
          [
            item.user_id, item.instance_id, cleanPhone,
            item.text_content || null,
            item.step_type === "text" ? null : item.media_url,
            item.step_type === "text" ? null : item.step_type,
            result?.key?.id || null,
          ]
        );
        if (item.conversation_id) {
          const preview = item.step_type === "text"
            ? (item.text_content || "").slice(0, 200)
            : `[${item.step_type}]${item.text_content ? " " + item.text_content.slice(0, 150) : ""}`;
          await exec(
            `UPDATE conversations
             SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out',
                 human_takeover = TRUE,
                 human_takeover_at = COALESCE(human_takeover_at, NOW())
             WHERE id = $2`,
            [preview, item.conversation_id]
          );
        }
      }

      await logEvent(item.user_id, item.instance_id, "inbox_dispatch_step_sent", {
        queue_id: item.id, step_type: item.step_type, phone: cleanPhone,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      const willRetry = claimed.attempt_count < 2; // máx 2 intentos
      await exec(
        `UPDATE inbox_dispatch_queue
         SET status = $1, error_message = $2,
             scheduled_at = CASE WHEN $3 THEN NOW() + interval '60 seconds' ELSE scheduled_at END
         WHERE id = $4`,
        [willRetry ? "pending" : "failed", String(errMsg).slice(0, 300), willRetry, item.id]
      );
      await logEvent(item.user_id, item.instance_id, "inbox_dispatch_step_failed", {
        queue_id: item.id, error: errMsg, step_type: item.step_type,
      });
    }
  }
}

// API: dispara un script a una conversation.
// Enquea todos los steps con scheduled_at calculado según los delays.
async function dispatchScript({ userId, instanceId, conversationId, phone, scriptId }) {
  const steps = await query(
    `SELECT * FROM quick_script_steps
     WHERE script_id = $1
     ORDER BY order_idx ASC, id ASC`,
    [scriptId]
  );
  if (!steps.length) return 0;

  let cumulative = 0; // segundos desde "ahora"
  let enqueued = 0;
  for (const s of steps) {
    cumulative += Math.max(0, s.delay_seconds || 0);
    if (s.step_type === "delay") continue; // delay sólo agrega tiempo, no se manda nada
    await exec(
      `INSERT INTO inbox_dispatch_queue
         (user_id, instance_id, conversation_id, phone, script_id, step_id,
          step_type, text_content, media_url, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               NOW() + ($10 || ' seconds')::interval)`,
      [
        userId, instanceId, conversationId, phone, scriptId, s.id,
        s.step_type, s.text_content || null, s.media_url || null,
        cumulative,
      ]
    );
    enqueued++;
  }

  return enqueued;
}

function start() {
  console.log("[INBOX-DISPATCHER] Worker iniciado (cron: cada 5s)");
  cron.schedule("*/5 * * * * *", () => {
    tick().catch(err => console.error("[INBOX-DISPATCHER ERR]", err.message));
  });
}

module.exports = { start, tick, dispatchScript };
