// Worker del autoresponder.
//
// Tres crons:
//
// 1) tick (cada 5s)
//    - Cancela queue de conversaciones con human_takeover
//    - Procesa conversaciones con autoresponder_pending_at <= NOW (debounce vencido)
//    - Procesa items de auto_responder_queue ya listos para enviar
//
// 2) presenceKeepalive (cada 6s)
//    - Para cada chip con items pendientes de enviar en próximos 60s,
//      manda "composing" presence (chip parece estar tipeando todo el tiempo
//      hasta que dispara, no solo 2 segundos al final)
//
// 3) randomOnlinePulse (cada ~20 min con jitter)
//    - Random "available" presence en cada chip conectado durante horario
//      hábil (simula que el dueño está activo aunque no esté respondiendo nada)

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickText(step) {
  const variants = Array.isArray(step.text_variants) ? step.text_variants.filter(Boolean) : [];
  if (variants.length > 0) return variants[rand(0, variants.length - 1)];
  return step.text || "";
}

function injectUtm(text, phone) {
  if (!text) return text;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const last4 = (phone || "").slice(-4);
  return text.replace(/(https?:\/\/[^\s]+)/gi, (url) => {
    if (/[?&](ref|wid|utm_source)=/i.test(url)) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}wid=${id}${last4 ? "_" + last4 : ""}`;
  });
}

function hourInTz(tz) {
  try {
    const h = new Date().toLocaleString("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
    return parseInt(h, 10);
  } catch {
    return new Date().getHours();
  }
}

function isWithinHours(start, end, tz) {
  if (start === end) return true;
  const h = hourInTz(tz);
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function secondsUntilQuietHoursOpen(start, end, tz) {
  const h = hourInTz(tz);
  if (start === end) return 0;
  if (start < end) {
    if (h >= start && h < end) return 0;
    const hoursToWait = h < start ? (start - h) : (24 - h + start);
    return hoursToWait * 3600 + rand(0, 600);
  }
  if (h >= start || h < end) return 0;
  const hoursToWait = start - h;
  return hoursToWait * 3600 + rand(0, 600);
}

// ─── Disparar autoresponders aplicables a un inbound ──────────────
// Se llama desde la cron de debounce (NO desde el webhook directamente).
// wasNewConversation: estado capturado al PRIMER inbound del burst.
async function maybeFireAutoresponder({ userId, instanceId, phone, text, wasNewConversation, priorTakeover }) {
  if (priorTakeover) return 0;

  const responders = await query(
    `SELECT * FROM auto_responders
     WHERE user_id = $1
       AND enabled = TRUE
       AND (instance_id IS NULL OR instance_id = $2)
     ORDER BY (instance_id IS NOT NULL) DESC, id ASC`,
    [userId, instanceId]
  );

  for (const ar of responders) {
    if (ar.trigger_type === "first_message" && !wasNewConversation) continue;
    if (ar.trigger_type === "keyword") {
      const kw = (ar.trigger_keyword || "").toLowerCase().trim();
      if (!kw || !(text || "").toLowerCase().includes(kw)) continue;
    }

    const cooldown = ar.cooldown_hours || 24;
    const fired = await queryOne(
      `SELECT fired_at FROM auto_responder_fired
       WHERE auto_responder_id = $1 AND instance_id = $2 AND phone = $3`,
      [ar.id, instanceId, phone]
    );
    if (fired && cooldown > 0) {
      const hoursAgo = (Date.now() - new Date(fired.fired_at).getTime()) / 3600000;
      if (hoursAgo < cooldown) continue;
    }

    const count = await enqueueAutoresponder(ar.id, userId, instanceId, phone);
    await logEvent(userId, instanceId, "autoresponder_fired", {
      auto_responder_id: ar.id, phone, steps: count,
    });
    return count; // solo primer match
  }
  return 0;
}

// ─── Encolar steps con anti-detection ──────────────────────────────
async function enqueueAutoresponder(autoResponderId, userId, instanceId, phone) {
  const ar = await queryOne(`SELECT * FROM auto_responders WHERE id = $1`, [autoResponderId]);
  if (!ar) return 0;

  const steps = await query(
    `SELECT * FROM auto_responder_steps
     WHERE auto_responder_id = $1
     ORDER BY order_idx ASC, id ASC`,
    [autoResponderId]
  );
  if (!steps.length) return 0;

  if (ar.skip_rate_pct > 0 && Math.random() * 100 < ar.skip_rate_pct) {
    await logEvent(userId, instanceId, "autoresponder_skipped", { auto_responder_id: ar.id, phone, reason: "skip_rate" });
    return 0;
  }

  let baseDelaySec = secondsUntilQuietHoursOpen(
    ar.quiet_hours_start ?? 9,
    ar.quiet_hours_end ?? 22,
    ar.timezone || "America/Argentina/Buenos_Aires"
  );

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
      const minTs = lastTs + minGap * 1000 + rand(0, 30) * 1000;
      if (minTs > targetTs) {
        baseDelaySec = Math.ceil((minTs - Date.now()) / 1000);
      }
    }
  }

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

  await exec(
    `INSERT INTO auto_responder_fired (auto_responder_id, instance_id, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (auto_responder_id, instance_id, phone) DO UPDATE SET fired_at = NOW()`,
    [autoResponderId, instanceId, phone]
  );

  return steps.length;
}

// ─── Main tick: debounce + queue processing ────────────────────────
async function tick() {
  // 1) Cancelar pendientes de chats con human_takeover
  await exec(`
    UPDATE auto_responder_queue q
    SET status = 'cancelled'
    FROM conversations c
    WHERE q.status = 'pending'
      AND c.instance_id = q.instance_id
      AND c.phone = q.phone
      AND c.human_takeover = TRUE
  `);

  // 2) Procesar conversaciones con debounce vencido
  // (autoresponder_pending_at <= NOW y no hay nuevo inbound en últimos 5s)
  const pending = await query(`
    SELECT c.id, c.user_id, c.instance_id, c.phone, c.last_msg_text,
           c.autoresponder_pending_was_new, c.human_takeover,
           c.last_inbound_msg_id, c.last_inbound_at,
           i.evolution_instance
    FROM conversations c
    JOIN instances i ON i.id = c.instance_id
    WHERE c.autoresponder_pending_at IS NOT NULL
      AND c.autoresponder_pending_at <= NOW()
      AND (c.last_inbound_at IS NULL OR c.last_inbound_at <= NOW() - interval '5 seconds')
    LIMIT 50
  `);

  for (const c of pending) {
    // Reclamar (evita race en cron overlap)
    const claimed = await queryOne(
      `UPDATE conversations
       SET autoresponder_pending_at = NULL
       WHERE id = $1 AND autoresponder_pending_at IS NOT NULL
       RETURNING id`,
      [c.id]
    );
    if (!claimed) continue;

    if (c.human_takeover) continue; // por las dudas

    // 2a) "Leer" el último inbound (mark-as-read antes de responder)
    if (c.last_inbound_msg_id && c.evolution_instance) {
      const remoteJid = `${c.phone}@s.whatsapp.net`;
      await evo.markMessagesAsRead(c.evolution_instance, [
        { remoteJid, fromMe: false, id: c.last_inbound_msg_id },
      ]);
    }

    // 2b) Disparar autoresponder
    await maybeFireAutoresponder({
      userId: c.user_id,
      instanceId: c.instance_id,
      phone: c.phone,
      text: c.last_msg_text || "",
      wasNewConversation: !!c.autoresponder_pending_was_new,
      priorTakeover: false,
    });
  }

  // 3) Procesar items de la queue listos para enviar
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
    if (item.instance_status !== "connected") {
      await exec(
        `UPDATE auto_responder_queue SET scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
        [item.id]
      );
      continue;
    }

    const claimed = await queryOne(
      `UPDATE auto_responder_queue
       SET status = 'sending', attempt_count = attempt_count + 1
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [item.id]
    );
    if (!claimed) continue;

    let text = pickText(item);
    if (item.append_utm !== false) text = injectUtm(text, item.phone);

    try {
      // Burst final de "composing" (la sustained ya la hace el cron de keepalive)
      if (item.show_typing) {
        const typingMs = rand(1500, 4000);
        await evo.sendPresence(item.evolution_instance, item.phone, "composing", typingMs);
      }

      let result;
      if (item.step_type === "text") {
        result = await evo.sendText(item.evolution_instance, item.phone, text);
      } else {
        result = await evo.sendMedia(
          item.evolution_instance, item.phone, item.step_type, item.media_url,
          { caption: text || undefined, mimetype: item.mime_type || undefined, fileName: item.file_name || undefined }
        );
      }

      await exec(`UPDATE auto_responder_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`, [item.id]);

      await exec(
        `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, media_url, media_type, evolution_msg_id)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, $7)`,
        [item.user_id, item.instance_id, item.phone,
         text || null,
         item.step_type === "text" ? null : item.media_url,
         item.step_type === "text" ? null : item.step_type,
         result?.key?.id || null]
      );

      const previewText = item.step_type === "text"
        ? (text || "").slice(0, 200)
        : `[${item.step_type}]${text ? " " + text.slice(0, 150) : ""}`;
      await exec(
        `UPDATE conversations
         SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out'
         WHERE instance_id = $2 AND phone = $3`,
        [previewText, item.instance_id, item.phone]
      );

      await logEvent(item.user_id, item.instance_id, "autoresponder_step_sent", {
        queue_id: item.id, step_id: item.step_id, step_type: item.step_type, phone: item.phone,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      const willRetry = claimed.attempt_count < 3;
      await exec(
        `UPDATE auto_responder_queue
         SET status = $1, error_message = $2,
             scheduled_at = CASE WHEN $3 THEN NOW() + interval '120 seconds' ELSE scheduled_at END
         WHERE id = $4`,
        [willRetry ? "pending" : "failed", String(errMsg).slice(0, 300), willRetry, item.id]
      );
      await logEvent(item.user_id, item.instance_id, "autoresponder_step_failed", {
        queue_id: item.id, error: errMsg, will_retry: willRetry,
      });
    }
  }
}

// ─── Cron: sustained "composing" durante delay ─────────────────────
// Para cada chip que tiene items por enviar en los próximos 60s,
// manda un burst de "composing" para que el lead vea que estás escribiendo
// (en lugar de ver el chip offline 30s y de repente un mensaje).
async function presenceKeepalive() {
  const upcoming = await query(`
    SELECT DISTINCT i.evolution_instance, q.phone
    FROM auto_responder_queue q
    JOIN instances i ON i.id = q.instance_id
    WHERE q.status = 'pending'
      AND q.scheduled_at > NOW()
      AND q.scheduled_at <= NOW() + interval '60 seconds'
      AND i.status = 'connected'
    LIMIT 30
  `);

  for (const u of upcoming) {
    const burstMs = rand(2500, 5500);
    await evo.sendPresence(u.evolution_instance, u.phone, "composing", burstMs).catch(() => {});
  }
}

// ─── Cron: random "available" pulse ────────────────────────────────
// Cada chip conectado emite "available" 1-2 veces por hora durante horario
// hábil. Simula que el dueño abre WhatsApp casual.
async function randomOnlinePulse() {
  // Solo durante horario hábil (9-22 ARG hardcoded; el AR-level es por autoresponder)
  if (!isWithinHours(9, 22, "America/Argentina/Buenos_Aires")) return;

  const chips = await query(
    `SELECT id, evolution_instance FROM instances WHERE status = 'connected'`
  );
  for (const c of chips) {
    // 30% probabilidad por tick (cada 20 min) → ~ 1 pulse cada 60 min promedio
    if (Math.random() > 0.30) continue;
    // No tenemos un "target phone" para "available" general — Evolution requiere number.
    // Workaround: presence "available" hacia un chat existente random (último contacto).
    const lastChat = await queryOne(
      `SELECT phone FROM conversations
       WHERE instance_id = $1 AND last_msg_at > NOW() - interval '7 days'
       ORDER BY last_msg_at DESC LIMIT 1`,
      [c.id]
    );
    if (!lastChat) continue;
    await evo.sendPresence(c.evolution_instance, lastChat.phone, "available", rand(3000, 8000)).catch(() => {});
  }
}

function start() {
  console.log("[AUTORESPONDER] Worker iniciado (tick:5s, presence:6s, online-pulse:20min)");
  cron.schedule("*/5 * * * * *", () => {
    tick().catch((err) => console.error("[AUTORESPONDER ERR]", err.message));
  });
  cron.schedule("*/6 * * * * *", () => {
    presenceKeepalive().catch((err) => console.error("[PRESENCE ERR]", err.message));
  });
  cron.schedule("*/20 * * * *", () => {
    randomOnlinePulse().catch((err) => console.error("[ONLINE-PULSE ERR]", err.message));
  });
}

module.exports = { start, tick, enqueueAutoresponder, maybeFireAutoresponder };
