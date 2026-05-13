// Endpoints públicos (sin auth de cookie) que terceros disparan
// Ej: GHL / Calendly cuando un lead reserva un slot.

const express = require("express");
const { query, queryOne, exec, logEvent } = require("../db");

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

    if (!cfg.instance_id) return res.status(400).json({ error: "No hay chip configurado para booking" });
    if (!cfg.closer_id) return res.status(400).json({ error: "No hay closer configurado" });

    const phone = parsePhone(req.body);
    if (!phone) return res.status(400).json({ error: "phone requerido" });

    const name = parseName(req.body);
    const scheduledRaw = parseScheduledAt(req.body);
    const scheduledAt = scheduledRaw ? new Date(scheduledRaw) : null;
    if (scheduledRaw && isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ error: "scheduled_at inválido" });
    }

    const delayMin = cfg.delay_before_dm_minutes ?? 5;

    const ev = await queryOne(
      `INSERT INTO booking_events
         (user_id, instance_id, closer_id, lead_phone, lead_name, scheduled_at,
          status, dm_scheduled_at, raw_webhook_payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending',
               NOW() + ($7 || ' minutes')::interval,
               $8)
       RETURNING *`,
      [
        cfg.user_id, cfg.instance_id, cfg.closer_id,
        phone, name, scheduledAt,
        delayMin, JSON.stringify(req.body || {}),
      ]
    );

    await logEvent(cfg.user_id, cfg.instance_id, "booking_received", {
      booking_id: ev.id, phone, scheduled_at: scheduledAt,
    });

    res.json({ ok: true, booking_id: ev.id, dm_in_minutes: delayMin });
  } catch (err) {
    console.error("[HOOK BOOKING ERR]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
