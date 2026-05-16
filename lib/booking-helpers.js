// Helpers compartidos entre hooks (webhook real) y test-fire (manual)

const evo = require("./evolution");

// Devuelve el nombre de la etiqueta de hora según la convención de Juan:
//  10, 11, 12 → "10 AM" / "11 AM" / "12 AM"
//  13..21    → "13 PM" / ... / "21 PM"
//  Otros horarios → null (sin etiqueta)
function getHourLabelName(scheduledAt, tz = "America/Argentina/Buenos_Aires") {
  if (!scheduledAt) return null;
  const d = new Date(scheduledAt);
  if (isNaN(d.getTime())) return null;
  let hour;
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).format(d);
    hour = parseInt(hourStr, 10);
  } catch {
    hour = d.getUTCHours();
  }
  if (isNaN(hour)) return null;
  if (hour >= 10 && hour <= 12) return `${hour} AM`;
  if (hour >= 13 && hour <= 21) return `${hour} PM`;
  return null;
}

// Procesa un booking en modo contact_only:
//  1. Guarda el contacto con el nombre del calendario
//  2. Aplica la etiqueta del budget rank (según label_mapping)
//  3. Aplica la etiqueta de la hora (según convención Juan)
//
// Retorna un objeto con resultado detallado.
async function processContactOnly({ cfg, instance, phone, name, scheduledAt, budgetRank }) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  const out = {
    ok: true, mode: "contact_only",
    phone: cleanPhone, name, budget_rank: budgetRank ?? null,
  };

  // 1) Guardar contacto
  try {
    await evo.updateContactName(instance.evolution_instance, cleanPhone, name || cleanPhone);
    out.contact_saved = true;
  } catch (e) {
    out.contact_save_error = e.message;
  }

  // 2 & 3) Fetch labels una sola vez y aplicar las que correspondan
  let labels = [];
  try {
    labels = await evo.findLabels(instance.evolution_instance);
  } catch (e) {
    out.labels_fetch_error = e.message;
  }

  const remoteJid = `${cleanPhone}@s.whatsapp.net`;

  const applyByName = async (labelName, okKey, errKey) => {
    if (!labelName) return;
    const wanted = String(labelName).trim();
    const found = labels.find(l => String(l?.name || "").trim() === wanted);
    if (!found) {
      out[errKey] = `Etiqueta "${wanted}" no existe en el chip`;
      return;
    }
    try {
      const labelId = found.id || found.labelId;
      await evo.handleLabel(instance.evolution_instance, remoteJid, labelId, "add");
      out[okKey] = wanted;
    } catch (e) {
      out[errKey] = e.message;
    }
  };

  // Budget label
  const labelMap = cfg.label_mapping || {};
  const budgetLabel = labelMap[String(budgetRank)] || labelMap[budgetRank];
  await applyByName(budgetLabel, "label_applied", "label_error");

  // Hour label
  const hourLabel = getHourLabelName(scheduledAt, cfg.timezone || "America/Argentina/Buenos_Aires");
  await applyByName(hourLabel, "hour_label_applied", "hour_label_error");

  return out;
}

module.exports = { processContactOnly, getHourLabelName };
