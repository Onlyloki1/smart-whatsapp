// Endpoints públicos (sin auth de cookie) que terceros disparan
// Ej: GHL / Calendly cuando un lead reserva un slot.

const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");
const evo = require("../lib/evolution");

const router = express.Router();

// Helper: parsea fecha desde múltiples campos típicos de GHL/Calendly
function parseScheduledAt(body) {
  return (
    body.scheduled_at ||
    body.appointment?.startTime ||
    body.appointment?.start_time ||
    body.startTime ||
    body.start_time ||
    body.calendar?.startTime ||
    body.contact?.appointmentTime ||
    body.payload?.scheduled_event?.start_time ||
    body.event?.start_time ||
    null
  );
}

// Helper: parsea teléfono (E.164 sin +, solo dígitos)
function parsePhone(body) {
  const raw =
    body.phone ||
    body.contact?.phone ||
    body.contact?.phoneNumber ||
    body.customer?.phone ||
    body.payload?.invitee?.text_reminder_number ||
    body.invitee?.phone ||
    null;
  if (!raw) return null;
  return String(raw).replace(/[^0-9]/g, "");
}

function parseName(body) {
  return (
    body.lead_name ||
    body.name ||
    body.full_name ||
    (body.contact?.firstName && body.contact?.lastName
      ? `${body.contact.firstName} ${body.contact.lastName}`
      : null) ||
    body.contact?.fullName ||
    body.contact?.name ||
    body.customer?.name ||
    body.payload?.invitee?.name ||
    body.invitee?.name ||
    null
  );
}

// budget_rank: 1-4 según el form de GHL
// (1) 500-990, (2) 1000-2000, (3) 2000-4000, (4) 4000+
function parseBudgetRank(body) {
  // intenta múltiples paths comunes de GHL
  const raw =
    body.budget_rank || body.budgetRank || body.rank ||
    body.budget || body.presupuesto ||
    body.customField?.budget || body.customFields?.budget ||
    body.contact?.budgetRange || body.contact?.customField?.budget ||
    body.contact?.budget ||
    body.tags ||
    null;
  if (raw == null) return null;
  const s = Array.isArray(raw) ? raw.join(" ") : String(raw);
  const lower = s.toLowerCase();
  // por rangos textuales
  if (/(\b1\b|\(1\)|500.{0,3}990|500.{0,3}1000|500.{0,3}\$990)/i.test(lower)) return 1;
  if (/(\b2\b|\(2\)|1.?000.{0,3}2.?000|1k.{0,3}2k)/i.test(lower)) return 2;
  if (/(\b3\b|\(3\)|2.?000.{0,3}4.?000|2k.{0,3}4k)/i.test(lower)) return 3;
  if (/(\b4\b|\(4\)|4.?000.?\+|m[áa]s.{0,5}4|over.{0,5}4)/i.test(lower)) return 4;
  // si vino solo el número
  const n = parseInt(lower, 10);
  if (n >= 1 && n <= 4) return n;
  return null;
}

// ─── POST /api/hooks/booking/:token ────────────────────────────────
// Body acepta múltiples formatos (GHL / Calendly / custom):
// - phone (requerido)
// - name (opcional)
// - scheduled_at (opcional, ISO o "YYYY-MM-DD HH:mm")
router.post("/booking/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const cfg = await queryOne(
      `SELECT * FROM booking_config WHERE webhook_token = $1 AND enabled = TRUE`,
      [token]
    );
    if (!cfg) return res.status(401).json({ error: "Token inválido o booking deshabilitado" });

    const phone = parsePhone(req.body);
    if (!phone) return res.status(400).json({ error: "phone requerido" });

    const name = parseName(req.body);
    const budgetRank = parseBudgetRank(req.body);
    const scheduledRaw = parseScheduledAt(req.body);
    const scheduledAt = scheduledRaw ? new Date(scheduledRaw) : null;
    if (scheduledRaw && isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ error: "scheduled_at inválido" });
    }

    // ─── MODO 1: contact_only — solo guarda contacto + aplica etiqueta ─────
    if (cfg.contact_only_mode) {
      if (!cfg.instance_id) return res.status(400).json({ error: "Falta admin chip para guardar contacto" });

      const inst = await queryOne(
        `SELECT * FROM instances WHERE id = $1 AND user_id = $2`,
        [cfg.instance_id, cfg.user_id]
      );
      if (!inst || inst.status !== "connected") {
        return res.status(400).json({ error: "Admin chip no conectado" });
      }

      const out = { ok: true, mode: "contact_only", phone, name, budget_rank: budgetRank };

      // 1) Guardar contacto con el nombre del calendario
      try {
        await evo.updateContactName(inst.evolution_instance, phone, name || phone);
        out.contact_saved = true;
      } catch (e) {
        out.contact_save_error = e.message;
      }

      // 2) Aplicar etiqueta según budget_rank
      const labelMap = cfg.label_mapping || {};
      const labelName = labelMap[String(budgetRank)] || labelMap[budgetRank];
      if (labelName) {
        try {
          const labels = await evo.findLabels(inst.evolution_instance);
          const found = labels.find(l => String(l?.name || "").trim() === String(labelName).trim());
          if (!found) {
            out.label_error = `Etiqueta "${labelName}" no existe en el chip. Creala en WhatsApp Business app primero.`;
          } else {
            const labelId = found.id || found.labelId;
            const remoteJid = `${phone}@s.whatsapp.net`;
            await evo.handleLabel(inst.evolution_instance, remoteJid, labelId, "add");
            out.label_applied = labelName;
          }
        } catch (e) {
          out.label_error = e.message;
        }
      } else if (budgetRank) {
        out.label_skipped = `Sin mapeo para rank ${budgetRank}`;
      }

      // Guardar en booking_events igual (para historial)
      await exec(
        `INSERT INTO booking_events
           (user_id, instance_id, lead_phone, lead_name, scheduled_at, budget_rank,
            status, raw_webhook_payload, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cfg.user_id, cfg.instance_id, phone, name, scheduledAt, budgetRank,
          out.contact_saved ? "completed" : "failed",
          JSON.stringify({ ...req.body, _mode: "contact_only" }),
          out.contact_save_error || out.label_error || null,
        ]
      );

      await logEvent(cfg.user_id, cfg.instance_id, "booking_contact_only", out);
      return res.json(out);
    }

    // ─── MODO 2: full flow (grupo + DM) — el flujo original ───────────────
    const channel = cfg.dm_channel || "callbell";
    if (channel === "evolution" && !cfg.instance_id) {
      return res.status(400).json({ error: "Canal Evolution: falta admin chip" });
    }
    if (channel === "callbell" && !cfg.callbell_channel_uuid) {
      return res.status(400).json({ error: "Canal Callbell: falta channel UUID" });
    }
    const creators = Array.isArray(cfg.group_creator_instance_ids) ? cfg.group_creator_instance_ids : [];
    if (!creators.length) return res.status(400).json({ error: "No hay chips group-creator configurados" });
    const team = Array.isArray(cfg.team_member_ids) ? cfg.team_member_ids : [];
    if (!team.length) return res.status(400).json({ error: "No hay team members configurados" });

    const delayMin = cfg.delay_before_dm_minutes ?? 5;

    const ev = await queryOne(
      `INSERT INTO booking_events
         (user_id, instance_id, lead_phone, lead_name, scheduled_at, budget_rank,
          status, dm_scheduled_at, raw_webhook_payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending',
               NOW() + ($7 || ' minutes')::interval,
               $8)
       RETURNING *`,
      [
        cfg.user_id, cfg.instance_id,
        phone, name, scheduledAt, budgetRank,
        delayMin, JSON.stringify(req.body || {}),
      ]
    );

    await logEvent(cfg.user_id, cfg.instance_id, "booking_received", {
      booking_id: ev.id, phone, scheduled_at: scheduledAt, budget_rank: budgetRank,
    });

    res.json({ ok: true, booking_id: ev.id, dm_in_minutes: delayMin, budget_rank: budgetRank });
  } catch (err) {
    console.error("[HOOK BOOKING ERR]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
