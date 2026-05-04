// Worker de envío anti-detection
// Corre cada 30s. Para cada campaña activa, para cada chip asignado:
// - Verifica ventana horaria
// - Verifica límites diarios y totales
// - Verifica delay y batch pause
// - Si todo OK, manda 1 mensaje, recalcula próximo delay

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickTemplate(templates) {
  if (!templates) return "";
  if (Array.isArray(templates)) return templates[rand(0, templates.length - 1)];
  return String(templates);
}

function renderTemplate(template, lead) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === "nombre" || key === "name") return lead.name || "";
    return (lead.custom_vars && lead.custom_vars[key]) || "";
  });
}

function isWithinHours(start, end, tz = "America/Argentina/Buenos_Aires") {
  // Hora actual en TZ
  const now = new Date();
  const hourStr = now.toLocaleString("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
  const hour = parseInt(hourStr, 10);
  if (start <= end) return hour >= start && hour < end;
  // Cruza medianoche (raro)
  return hour >= start || hour < end;
}

async function resetDailyCountersIfNeeded() {
  // Reset contadores cuando cambia el día (en TZ Argentina)
  await exec(`
    UPDATE instances
    SET daily_sent_count = 0,
        in_batch_count = 0,
        last_reset_at = CURRENT_DATE
    WHERE last_reset_at < CURRENT_DATE
  `);
}

async function tick() {
  await resetDailyCountersIfNeeded();

  const campaigns = await query(`
    SELECT * FROM campaigns WHERE status = 'active'
  `);

  for (const camp of campaigns) {
    if (!isWithinHours(camp.hours_start, camp.hours_end, camp.timezone)) continue;

    // Total limit
    if (camp.total_limit && camp.total_sent >= camp.total_limit) {
      await exec("UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1", [camp.id]);
      continue;
    }

    // Instancias asignadas a esta campaña
    const instances = await query(`
      SELECT i.* FROM instances i
      JOIN campaign_instances ci ON ci.instance_id = i.id
      WHERE ci.campaign_id = $1 AND i.status = 'connected'
    `, [camp.id]);

    for (const inst of instances) {
      // Daily limit
      if (inst.daily_sent_count >= camp.daily_limit_per_chip) continue;

      // Batch pause activa?
      if (inst.batch_pause_until && new Date(inst.batch_pause_until) > new Date()) continue;

      // Delay desde último envío
      if (inst.next_send_after && new Date(inst.next_send_after) > new Date()) continue;

      // Próximo lead pending para este chip
      const lead = await queryOne(`
        SELECT * FROM leads
        WHERE campaign_id = $1 AND instance_id = $2 AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `, [camp.id, inst.id]);

      if (!lead) continue;

      // Marcar como sending para evitar concurrencia
      const claimed = await queryOne(`
        UPDATE leads SET status = 'sending', attempt_count = attempt_count + 1
        WHERE id = $1 AND status = 'pending'
        RETURNING *
      `, [lead.id]);
      if (!claimed) continue;

      // Renderizar mensaje
      const template = pickTemplate(camp.message_templates);
      const text = renderTemplate(template, claimed);

      try {
        const result = await evo.sendText(inst.evolution_instance, claimed.phone, text);
        await exec(`UPDATE leads SET status = 'sent', sent_at = NOW() WHERE id = $1`, [claimed.id]);
        await exec(`
          INSERT INTO messages_log (user_id, instance_id, lead_id, phone, direction, text, evolution_msg_id)
          VALUES ($1, $2, $3, $4, 'out', $5, $6)
        `, [camp.user_id, inst.id, claimed.id, claimed.phone, text, result?.key?.id || null]);
        await exec(`UPDATE campaigns SET total_sent = total_sent + 1 WHERE id = $1`, [camp.id]);
        await logEvent(camp.user_id, inst.id, "message_sent", { lead_id: claimed.id, campaign_id: camp.id });

        // Calcular próximo delay random
        const delaySec = rand(camp.delay_min_sec, camp.delay_max_sec);
        const nextBatch = inst.in_batch_count + 1;

        if (nextBatch >= camp.batch_size) {
          // Batch completado, pausa larga
          const pauseSec = rand(camp.batch_pause_min_sec, camp.batch_pause_max_sec);
          await exec(`
            UPDATE instances SET
              daily_sent_count = daily_sent_count + 1,
              total_sent_count = total_sent_count + 1,
              last_message_at = NOW(),
              next_send_after = NOW() + ($1 || ' seconds')::interval,
              batch_pause_until = NOW() + ($2 || ' seconds')::interval,
              in_batch_count = 0
            WHERE id = $3
          `, [delaySec, pauseSec, inst.id]);
        } else {
          await exec(`
            UPDATE instances SET
              daily_sent_count = daily_sent_count + 1,
              total_sent_count = total_sent_count + 1,
              last_message_at = NOW(),
              next_send_after = NOW() + ($1 || ' seconds')::interval,
              in_batch_count = in_batch_count + 1,
              batch_pause_until = NULL
            WHERE id = $2
          `, [delaySec, inst.id]);
        }
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        await exec(`
          UPDATE leads SET status = 'failed', error_message = $1 WHERE id = $2
        `, [errMsg.slice(0, 300), claimed.id]);
        await logEvent(camp.user_id, inst.id, "message_failed", { lead_id: claimed.id, error: errMsg });
        // Pequeño cooldown si falla
        await exec(`
          UPDATE instances SET next_send_after = NOW() + interval '60 seconds' WHERE id = $1
        `, [inst.id]);
      }
    }
  }
}

function start() {
  console.log("[SENDER] Worker iniciado (cron: cada 30s)");
  // Cada 30 segundos
  cron.schedule("*/30 * * * * *", () => {
    tick().catch(err => console.error("[SENDER ERR]", err.message));
  });
}

module.exports = { start, tick };
