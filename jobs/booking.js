// Worker del booking flow (v2: pool de group-creators + multi-team + promote).
//
// Fase 1 — DM con invite al lead (cuando dm_scheduled_at <= NOW)
//   - Elige chip group-creator menos cargado HOY (round-robin)
//   - Ese chip crea grupo con TODOS los team_members como participantes
//   - Promueve a admin a cada team member (todos quedan admin)
//   - Pide invite link al grupo
//   - Manda DM al lead DESDE EL ADMIN CHIP (no el group-creator)
//   - status: pending → dm_sent
//
// Fase 2 — Post-join (cuando lead entra al grupo)
//   - 60s después del join → texto + audio en el grupo
//   - Manda desde el group-creator chip (el que creó el grupo)

const cron = require("node-cron");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");
const callbell = require("../lib/callbell");

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fmt(scheduledAt, tz = "America/Argentina/Buenos_Aires") {
  if (!scheduledAt) return { date: "(sin fecha)", time: "(sin hora)" };
  const d = new Date(scheduledAt);
  const opts = { timeZone: tz, hour12: false };
  const date = d.toLocaleDateString("es-AR", { ...opts, day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("es-AR", { ...opts, hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

function renderTpl(tpl, ctx) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    return v == null ? "" : String(v);
  });
}

// Elige el group-creator chip CONECTADO con menos grupos creados HOY
async function pickGroupCreator(instanceIds) {
  if (!instanceIds || !instanceIds.length) return null;
  const c = await queryOne(`
    SELECT i.id, i.evolution_instance, i.name
    FROM instances i
    WHERE i.id = ANY($1::int[]) AND i.status = 'connected'
    ORDER BY (
      SELECT COUNT(*) FROM booking_events be
      WHERE be.group_creator_instance_id = i.id
        AND be.group_created_at >= CURRENT_DATE
    ) ASC, RANDOM()
    LIMIT 1
  `, [instanceIds]);
  return c;
}

// ─── Fase 1: DM con invite ─────────────────────────────────────────
async function processPendingDMs() {
  const items = await query(`
    SELECT be.*, bc.group_name_template, bc.dm_text, bc.timezone,
           bc.contact_name_template,
           bc.dm_channel, bc.callbell_channel_uuid,
           bc.instance_id AS admin_instance_id,
           bc.group_creator_instance_ids, bc.team_member_ids,
           bc.promote_team_to_admin,
           i.evolution_instance AS admin_evolution_instance,
           i.phone_number AS admin_phone_number,
           i.status AS admin_instance_status
    FROM booking_events be
    LEFT JOIN booking_config bc ON bc.user_id = be.user_id
    LEFT JOIN instances i ON i.id = bc.instance_id
    WHERE be.status = 'pending'
      AND be.dm_scheduled_at IS NOT NULL
      AND be.dm_scheduled_at <= NOW()
    ORDER BY be.dm_scheduled_at ASC
    LIMIT 10
  `);

  for (const ev of items) {
    const channel = ev.dm_channel || "callbell";

    // Validar que tenemos el medio de envío del DM
    if (channel === "evolution") {
      if (!ev.admin_instance_id || ev.admin_instance_status !== "connected") {
        await exec(
          `UPDATE booking_events SET dm_scheduled_at = NOW() + interval '60 seconds' WHERE id = $1`,
          [ev.id]
        );
        continue;
      }
    } else if (channel === "callbell") {
      if (!ev.callbell_channel_uuid) {
        await exec(
          `UPDATE booking_events SET status = 'failed', error_message = 'callbell_channel_uuid no configurado' WHERE id = $1`,
          [ev.id]
        );
        continue;
      }
      if (!process.env.CALLBELL_API_KEY) {
        await exec(
          `UPDATE booking_events SET status = 'failed', error_message = 'CALLBELL_API_KEY no en env' WHERE id = $1`,
          [ev.id]
        );
        continue;
      }
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
      // 1. Elegir group-creator (menos cargado hoy)
      const creatorIds = Array.isArray(ev.group_creator_instance_ids) ? ev.group_creator_instance_ids : [];
      const creator = await pickGroupCreator(creatorIds);
      if (!creator) throw new Error("Ningún chip group-creator conectado disponible");

      // 2. Cargar team members
      const teamIds = Array.isArray(ev.team_member_ids) ? ev.team_member_ids : [];
      const team = await query(
        `SELECT id, name, phone, role FROM closers
         WHERE user_id = $1 AND id = ANY($2::int[]) AND active = TRUE`,
        [ev.user_id, teamIds]
      );
      if (!team.length) throw new Error("No hay team members activos configurados");
      const teamPhones = team.map(t => String(t.phone).replace(/[^0-9]/g, ""));

      // 3. Build context para renderizar templates
      const ctx = {
        lead_name: ev.lead_name || "",
        budget_rank: ev.budget_rank ?? "?",
        ...fmt(ev.scheduled_at, ev.timezone || "America/Argentina/Buenos_Aires"),
      };
      ctx.datetime = `${ctx.date} ${ctx.time}`;

      const subject = renderTpl(ev.group_name_template, ctx).slice(0, 90);

      // Si el admin chip es DISTINTO del creator chip, sumarlo al grupo también
      const adminPhone = String(ev.admin_phone_number || "").replace(/[^0-9]/g, "");
      const creatorPhone = (() => {
        // El phone_number del creator lo pedimos aparte si hace falta
        return null;
      })();
      // Sumamos admin phone solo si: 1) está conectado un admin, 2) es distinto del creator
      const adminIsSeparate = ev.admin_instance_id && ev.admin_instance_id !== creator.id && adminPhone;

      // Phones que tienen que terminar como ADMIN del grupo:
      // - todos los team members (Tomi, Carlos, Triager)
      // - admin chip si es separado del creator
      const phonesToManage = [...teamPhones];
      if (adminIsSeparate) phonesToManage.push(adminPhone);

      // 4. Crear grupo (el creator chip queda como admin auto)
      const groupRes = await evo.createGroup(creator.evolution_instance, subject, phonesToManage);
      const groupJid = groupRes?.id || groupRes?.groupJid || groupRes?.key?.id || groupRes?.data?.id;
      if (!groupJid) throw new Error("createGroup no devolvió group jid: " + JSON.stringify(groupRes).slice(0, 200));

      // Pequeño delay para que Baileys termine de sincronizar los participants
      await new Promise(r => setTimeout(r, 1500));

      // 4b. Asegurar que todos están adentro (idempotente: si ya están, ignora)
      try {
        await evo.addParticipants(creator.evolution_instance, groupJid, phonesToManage);
      } catch (e) {
        // ya estaban, ok
      }

      // Otro delay
      await new Promise(r => setTimeout(r, 1500));

      // 5. Promote a admin (si configurado)
      if (ev.promote_team_to_admin !== false && phonesToManage.length > 0) {
        try {
          const promoteRes = await evo.promoteParticipants(creator.evolution_instance, groupJid, phonesToManage);
          await logEvent(ev.user_id, creator.id, "booking_promote_done", {
            booking_id: ev.id, group_jid: groupJid, phones: phonesToManage,
            result_sample: JSON.stringify(promoteRes).slice(0, 200),
          });
        } catch (e) {
          console.warn("[BOOKING] promote falló:", e.message);
          await logEvent(ev.user_id, creator.id, "booking_promote_failed", {
            booking_id: ev.id, error: e.message, phones: phonesToManage,
          });
        }
      }

      // 6. Invite link
      const inviteRes = await evo.fetchInviteCode(creator.evolution_instance, groupJid);
      const inviteUrl = inviteRes?.inviteUrl || (inviteRes?.inviteCode ? `https://chat.whatsapp.com/${inviteRes.inviteCode}` : null);
      if (!inviteUrl) throw new Error("fetchInviteCode no devolvió URL");

      // 7. DM al lead — ruta según canal configurado
      ctx.invite_url = inviteUrl;
      const dmText = renderTpl(ev.dm_text, ctx);
      const cleanLead = String(ev.lead_phone).replace(/[^0-9]/g, "");
      let dmExternalId = null;

      if (channel === "callbell") {
        // Vía Callbell: continúa el thread del lead (que vive en Callbell)
        const res = await callbell.sendText(ev.callbell_channel_uuid, cleanLead, dmText);
        dmExternalId = res?.message?.uuid || res?.uuid || null;
      } else {
        // Vía Evolution admin chip
        const contactNameTpl = ev.contact_name_template || "{lead_name}";
        const contactName = renderTpl(contactNameTpl, ctx).trim();
        if (contactName && ev.lead_name) {
          evo.updateContactName(ev.admin_evolution_instance, cleanLead, contactName).catch(()=>{});
          await exec(
            `UPDATE conversations SET custom_name = $1
             WHERE instance_id = $2 AND phone = $3`,
            [contactName, ev.admin_instance_id, cleanLead]
          );
        }
        await evo.sendPresence(ev.admin_evolution_instance, cleanLead, "composing", rand(2000, 4000)).catch(()=>{});
        const dmRes = await evo.sendText(ev.admin_evolution_instance, cleanLead, dmText);
        dmExternalId = dmRes?.key?.id || null;

        await exec(
          `INSERT INTO messages_log (user_id, instance_id, phone, direction, text, evolution_msg_id)
           VALUES ($1, $2, $3, 'out', $4, $5)`,
          [ev.user_id, ev.admin_instance_id, cleanLead, dmText, dmExternalId]
        );
        await exec(
          `UPDATE conversations
           SET last_msg_text = $1, last_msg_at = NOW(), last_direction = 'out'
           WHERE instance_id = $2 AND phone = $3`,
          [dmText.slice(0, 200), ev.admin_instance_id, cleanLead]
        );
      }

      // 8. Update booking_event
      await exec(
        `UPDATE booking_events
         SET status = 'dm_sent',
             group_jid = $1, group_subject = $2, invite_url = $3,
             group_creator_instance_id = $4, team_member_phones = $5::jsonb,
             group_created_at = NOW(), dm_sent_at = NOW()
         WHERE id = $6`,
        [groupJid, subject, inviteUrl, creator.id, JSON.stringify(teamPhones), ev.id]
      );

      await logEvent(ev.user_id, creator.id, "booking_dm_sent", {
        booking_id: ev.id, lead_phone: cleanLead, group_jid: groupJid,
        group_creator: creator.name, team_count: team.length, budget_rank: ev.budget_rank,
        dm_channel: channel,
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || "unknown";
      await exec(
        `UPDATE booking_events
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [String(errMsg).slice(0, 500), ev.id]
      );
      await logEvent(ev.user_id, ev.admin_instance_id, "booking_failed", {
        booking_id: ev.id, error: errMsg, phase: "dm",
      });
    }
  }
}

// ─── Fase 2: post-join (texto + audio en el grupo) ─────────────────
// El mensaje se manda desde el chip GROUP-CREATOR (que ya está en el grupo)
async function processPostJoinMessages() {
  const items = await query(`
    SELECT be.*, bc.post_join_text, bc.post_join_audio_url, bc.timezone,
           i.evolution_instance, i.status AS instance_status
    FROM booking_events be
    LEFT JOIN booking_config bc ON bc.user_id = be.user_id
    LEFT JOIN instances i ON i.id = be.group_creator_instance_id
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
        budget_rank: ev.budget_rank ?? "?",
        ...fmt(ev.scheduled_at, ev.timezone || "America/Argentina/Buenos_Aires"),
      };
      ctx.datetime = `${ctx.date} ${ctx.time}`;

      const text = renderTpl(ev.post_join_text, ctx);
      if (text && text.trim()) {
        await evo.sendPresence(ev.evolution_instance, ev.group_jid, "composing", rand(2000, 4000)).catch(()=>{});
        await evo.sendText(ev.evolution_instance, ev.group_jid, text);
      }

      if (ev.post_join_audio_url) {
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
      await logEvent(ev.user_id, ev.group_creator_instance_id, "booking_completed", {
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
      await logEvent(ev.user_id, ev.group_creator_instance_id, "booking_failed", {
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
