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

// Pick random text variant (or fall back to legacy text field)
function pickText(step) {
  const variants = Array.isArray(step.text_variants) ? step.text_variants.filter(Boolean) : [];
  if (variants.length > 0) return variants[rand(0, variants.length - 1)];
  return step.text || "";
}

// Append a unique UTM-ish param to URLs to avoid identical-link fingerprint
// while keeping the destination the same. Skips URLs that already have ?ref= or ?wid=.
function injectUtm(text, phone) {
  if (!text) return text;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const last4 = (phone || "").slice(-4);
  return text.replace(/(https?:\/\/[^\s]+)/gi, (url) => {
    if (/[?&](ref|wid|utm_source)=/i.test(url)) return url; // ya tiene tracking
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}wid=${id}${last4 ? "_" + last4 : ""}`;
  });
}

// Hora actual en TZ del autoresponder
function hourInTz(tz) {
  try {
    const h = new Date().toLocaleString("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
    return parseInt(h, 10);
  } catch {
    return new Date().getHours();
  }
}

// Devuelve segundos a esperar hasta entrar en ventana horaria
function secondsUntilQuietHoursOpen(start, end, tz) {
  const h = hourInTz(tz);
  if (start === end) return 0; // sin ventana
  // ventana normal start<end (ej 9-22)
  if (start < end) {
    if (h >= start && h < end) return 0; // dentro de ventana
    // estamos fuera → calcular cuándo abre
    const hoursToWait = h < start ? (start - h) : (24 - h + start);
    return hoursToWait * 3600 + rand(0, 600); // + jitter random hasta 10 min
  }
  // ventana cruzando medianoche (ej 22-6)
  if (h >= start || h < end) return 0;
  const hoursToWait = start - h;
  return hoursToWait * 3600 + rand(0, 600);
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
    SELECT q.*, s.step_type, s.text, s.text_variants, s.media_url, s.mime_type, s.file_name,
           s.show_typing, s.delay_min_sec, s.delay_max_sec, s.append_utm,
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

    // Pick random text variant + inject UTM
    let text = pickText(item);
    if (item.append_utm !== false) text = injectUtm(text, item.phone);

    try {
      // "Escribiendo..." opcional
      if (item.show_typing) {
        const typingMs = rand(1500, 4000);
        await evo.sendPresence(item.evolution_instance, item.phone, "composing", typingMs);
      }

      let result;
      if (item.step_type === "text") {
        result = await evo.sendText(item.evolution_instance, item.phone, text);
      } else {
        // media: image / video / audio / document
        // El text de un step media es CAPTION. Le aplicamos las variantes/UTM también.
        result = await evo.sendMedia(
          item.evolution_instance,
          item.phone,
          item.step_type,
          item.media_url,
          {
            caption: text || undefined,
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
          text || null,
          item.step_type === "text" ? null : item.media_url,
          item.step_type === "text" ? null : item.step_type,
          result?.key?.id || null,
        ]
      );

      const previewText =
        item.step_type === "text"
          ? (text || "").slice(0, 200)
          : `[${item.step_type}]${text ? " " + text.slice(0, 150) : ""}`;
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
// Aplica:
// - Ventana horaria (si fuera de horario, scheduled_at se empuja a la próxima apertura)
// - Burst smoothing (min gap entre fires del mismo chip)
// - Delays per-step random (anti-detection humano)
async function enqueueAutoresponder(autoResponderId, userId, instanceId, phone) {
  const ar = await queryOne(
    `SELECT * FROM auto_responders WHERE id = $1`,
    [autoResponderId]
  );
  if (!ar) return 0;

  const steps = await query(
    `SELECT * FROM auto_responder_steps
     WHERE auto_responder_id = $1
     ORDER BY order_idx ASC, id ASC`,
    [autoResponderId]
  );
  if (!steps.length) return 0;

  // Skip rate: a veces no respondemos (simula humano que olvida)
  if (ar.skip_rate_pct > 0 && Math.random() * 100 < ar.skip_rate_pct) {
    await logEvent(userId, instanceId, "autoresponder_skipped", { auto_responder_id: ar.id, phone, reason: "skip_rate" });
    return 0;
  }

  // 1) ¿Fuera de ventana horaria? Empujar base hasta apertura
  let baseDelaySec = secondsUntilQuietHoursOpen(
    ar.quiet_hours_start ?? 9,
    ar.quiet_hours_end ?? 22,
    ar.timezone || "America/Argentina/Buenos_Aires"
  );

  // 2) Burst smoothing: ¿el chip ya tiene fires programados/recientes? Espaciar
  const minGap = ar.min_gap_seconds_between_fires ?? 45;
  if (minGap > 0) {
    const lastScheduled = await queryOne(
      `SELECT MAX(scheduled_at) AS last_at
       FROM auto_responder_queue
       WHERE instance_id = $1 AND status IN ('pending', 'sending')`,
      [instanceId]
    );
    if (lastScheduled?.last_at) {
      const lastTs = new Date(lastScheduled.last_at).getTime();
      const targetTs = Date.now() + baseDelaySec * 1000;
      const minTs = lastTs + minGap * 1000 + rand(0, 30) * 1000; // + jitter 0-30s
      if (minTs > targetTs) {
        baseDelaySec = Math.ceil((minTs - Date.now()) / 1000);
      }
    }
  }

  // 3) Insertar steps con delays acumulados
  let cumulative = baseDelaySec;
  for (const s of steps) {
    const delay = rand(s.delay_min_sec || 0, s.delay_max_sec || 0);
    cumulative += delay;
    await exec(
      `INSERT INTO auto_responder_queue (user_id, instance_id, phone, step_id, scheduled_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [userId, instanceId, phone, s.id, cumulative]
    );
  }

  // Marcar como disparado (para cooldown)
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
