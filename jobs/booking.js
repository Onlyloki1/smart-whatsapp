// Worker del booking flow.
//
// Procesa booking_events en 2 fases:
//
// Fase 1 — DM con invite al lead (cuando dm_scheduled_at <= NOW)
//   - Crea el grupo (chip + closer)
//   - Pide invite link a Evolution
//   - Manda DM al lead con el mensaje configurado + invite link
//   - status: pending → dm_sent
//
// Fase 2 — Post-join (cuando lead entra al grupo y post_join_scheduled_at <= NOW)
//   - Manda texto en el grupo (welcome message)
//   - Manda audio en el grupo (si está configurado)
//   - status: joined → completed

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Formatear fecha/hora en TZ
function fmt(scheduledAt, tz = "America/Argentina/Buenos_Aires") {
  if (!scheduledAt) return { date: "(sin fecha)", time: "(sin hora)" };
  const d = new Date(scheduledAt);
  const opts = { timeZone: tz, hour12: false };
  const date = d.toLocaleDateString("es-AR", { ...opts, day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("es-AR", { ...opts, hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

// Reemplaza {date}, {time}, {datetime}, {lead_name}, {invite_url}, {closer_name} en strings
function renderTpl(tpl, ctx) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");
}

// ─── Fase 1: DM con invite ─────────────────────────────────────────
async function processPendingDMs() {
  const items = await query(`
    SELECT be.*, bc.group_name_template, bc.dm_text, bc.timezone,
           i.evolution_instance, i.status AS instance_status,
           c.phone AS closer_phone, c.name AS closer_name
    FROM booking_events be
    LEFT JOIN booking_config bc ON bc.user_id = be.user_id
    LEFT JOIN instances i ON i.id = be.instance_id
    LEFT JOIN closers c ON c.id = be.closer_id
    WHERE be.status = 'pending'
      AND be.dm_scheduled_at IS NOT NULL
      AND be.dm_scheduled_at <= NOW()
    ORDER BY be.dm_scheduled_at ASC
    LIMIT 10
  `);

  for (const ev of items) {
    if (!ev.instance_id || ev.instance_status !== "connected") {
      // chip no disponible, reintentar en 60s
      await exec(
        `UPDATE booking_events SET dm_scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
        [ev.id]
      );
      continue;
    }

    // Claim
    const claimed = await queryOne(
      `UPDATE booking_events SET status = 'creating_group'
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [ev.id]
    );
    if (!claimed) continue;

    try {
      const ctx = {
        lead_name: ev.lead_name || "",
        closer_name: ev.closer_name || "",
        ...fmt(ev.scheduled_at, ev.timezone || "America/Argentina/Buenos_Aires"),
      };
      ctx.datetime = `${ctx.date} ${ctx.time}`;

      // 1. Crear grupo: chip + closer como participants iniciales
      const subject = renderTpl(ev.group_name_template, ctx).slice(0, 90); // límite WA ~100 chars
      const participants = ev.closer_phone ? [String(ev.closer_phone).replace(/[^0-9]/g, "")] : [];
      const groupRes = await evo.createGroup(ev.evolution_instance, subject, participants);
      const groupJid = groupRes?.id || groupRes?.groupJid || groupRes?.key?.id;
      if (!groupJid) throw new Error("createGroup no devolvió group jid: " + JSON.stringify(groupRes).slice(0, 200));

      // 2. Invite link
      const inviteRes = await evo.fetchInviteCode(ev.evolution_instance, groupJid);
      const inviteUrl = inviteRes?.inviteUrl || (inviteRes?.inviteCode ? `https://chat.whatsapp.com/${inviteRes.inviteCode}` : null);
      if (!inviteUrl) throw new Error("fetchInviteCode no devolvió URL: " + JSON.stringify(inviteRes).slice(0, 200));

      // 3. DM al lead con el template renderizado
      ctx.invite_url = inviteUrl;
      const dmText = renderTpl(ev.dm_text, ctx);
      const cleanLead = String(ev.lead_phone).replace(/[^0-9]/g, "");

      // Mini typing para realismo
      await evo.sendPresence(ev.evolution_instance, cleanLead, "composing", rand(2000, 4000)).catch(()=>{});
      const dmRes = await evo.sendText(ev.evolution_instance, cleanLead, dmText);

      // Loggear DM en messages_log + actualizar conversación (si existe)
      await exec(
        `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
         VALUES ($1, $2, $3, 'out', $4, $5)`,
        [ev.user_id, ev.instance_id, cleanLead, dmText, dmRes?.key?.id || null]
      );
      await exec(
        `UPDATE conversations
         SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out'
         WHERE instance_id = $2 AND phone = $3`,
        [dmText.slice(0, 200), ev.instance_id, cleanLead]
      );

      // Update booking_event
      await exec(
        `UPDATE booking_events
         SET status = 'dm_sent', group_jid = $1, group_subject = $2, invite_url = $3,
             group_created_at = NOW(), dm_sent_at = NOW()
         WHERE id = $4`,
        [groupJid, subject, inviteUrl, ev.id]
      );

      await logEvent(ev.user_id, ev.instance_id, "booking_dm_sent", {
        booking_id: ev.id, lead_phone: cleanLead, group_jid: groupJid,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      await exec(
        `UPDATE booking_events
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [String(errMsg).slice(0, 500), ev.id]
      );
      await logEvent(ev.user_id, ev.instance_id, "booking_failed", {
        booking_id: ev.id, error: errMsg, phase: "dm",
      });
    }
  }
}

// ─── Fase 2: post-join (texto + audio en el grupo) ─────────────────
async function processPostJoinMessages() {
  const items = await query(`
    SELECT be.*, bc.post_join_text, bc.post_join_audio_url, bc.timezone,
           i.evolution_instance, i.status AS instance_status
    FROM booking_events be
    LEFT JOIN booking_config bc ON bc.user_id = be.user_id
    LEFT JOIN instances i ON i.id = be.instance_id
    WHERE be.status = 'joined'
      AND be.post_join_scheduled_at IS NOT NULL
      AND be.post_join_scheduled_at <= NOW()
    ORDER BY be.post_join_scheduled_at ASC
    LIMIT 10
  `);

  for (const ev of items) {
    if (!ev.evolution_instance || ev.instance_status !== "connected") {
      await exec(
        `UPDATE booking_events SET post_join_scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
        [ev.id]
      );
      continue;
    }

    const claimed = await queryOne(
      `UPDATE booking_events SET status = 'sending_welcome'
       WHERE id = $1 AND status = 'joined'
       RETURNING id`,
      [ev.id]
    );
    if (!claimed) continue;

    try {
      const ctx = {
        lead_name: ev.lead_name || "",
        ...fmt(ev.scheduled_at, ev.timezone || "America/Argentina/Buenos_Aires"),
      };
      ctx.datetime = `${ctx.date} ${ctx.time}`;

      // Mandar texto en el grupo (target = group_jid)
      const text = renderTpl(ev.post_join_text, ctx);
      if (text && text.trim()) {
        await evo.sendPresence(ev.evolution_instance, ev.group_jid, "composing", rand(2000, 4000)).catch(()=>{});
        await evo.sendText(ev.evolution_instance, ev.group_jid, text);
      }

      // Mandar audio (si configurado)
      if (ev.post_join_audio_url) {
        // pequeña pausa entre texto y audio
        await new Promise(r => setTimeout(r, rand(2000, 4000)));
        await evo.sendPresence(ev.evolution_instance, ev.group_jid, "recording", rand(2000, 4000)).catch(()=>{});
        await evo.sendWhatsAppAudio(ev.evolution_instance, ev.group_jid, ev.post_join_audio_url);
      }

      await exec(
        `UPDATE booking_events
         SET status = 'completed', post_join_sent_at = NOW()
         WHERE id = $1`,
        [ev.id]
      );
      await logEvent(ev.user_id, ev.instance_id, "booking_completed", {
        booking_id: ev.id, group_jid: ev.group_jid,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      await exec(
        `UPDATE booking_events
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [String(errMsg).slice(0, 500), ev.id]
      );
      await logEvent(ev.user_id, ev.instance_id, "booking_failed", {
        booking_id: ev.id, error: errMsg, phase: "post_join",
      });
    }
  }
}

async function tick() {
  await processPendingDMs();
  await processPostJoinMessages();
}

function start() {
  console.log("[BOOKING] Worker iniciado (cron: cada 15s)");
  cron.schedule("*/15 * * * * *", () => {
    tick().catch((err) => console.error("[BOOKING ERR]", err.message));
  });
}

module.exports = { start, tick };
