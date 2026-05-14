// Cliente Callbell API (https://api.callbell.eu)
//
// Sirve para mandar mensajes a leads cuya conversación vive en Callbell
// (típicamente CTWA leads que escribieron al número de Callbell).
//
// Free-form text solo funciona si el lead te escribió en las últimas 24h.
// Para casos fuera de esa ventana → usar template aprobado.

const axios = require("axios");

const BASE_URL = "https://api.callbell.eu/v1";

function getAuth() {
  const key = process.env.CALLBELL_API_KEY;
  if (!key) throw new Error("CALLBELL_API_KEY no configurado en env");
  return key;
}

// Mandar texto free-form (solo dentro de 24h de la última inbound del lead)
// phoneE164: sin "+", solo dígitos (ej: "5491136109797")
// channelUuid: UUID del channel de Callbell que envía
async function sendText(channelUuid, phoneE164, text) {
  const key = getAuth();
  const cleanPhone = String(phoneE164).replace(/[^0-9]/g, "");
  if (!channelUuid) throw new Error("channelUuid requerido");

  try {
    const r = await axios.post(
      `${BASE_URL}/messages/send`,
      {
        to: `+${cleanPhone}`,
        from: channelUuid,
        type: "text",
        content: { text },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return r.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400);
    throw new Error(`Callbell sendText failed: ${msg}`);
  }
}

// Mandar template (cuando el free-form no funciona — fuera de ventana 24h)
// params: array de strings (corresponde a {{1}}, {{2}}, ...)
async function sendTemplate(channelUuid, phoneE164, templateUuid, params = [], language = "es") {
  const key = getAuth();
  const cleanPhone = String(phoneE164).replace(/[^0-9]/g, "");
  if (!channelUuid) throw new Error("channelUuid requerido");
  if (!templateUuid) throw new Error("templateUuid requerido");

  try {
    const r = await axios.post(
      `${BASE_URL}/messages/send`,
      {
        to: `+${cleanPhone}`,
        from: channelUuid,
        type: "template",
        template_uuid: templateUuid,
        template_values: params,
        language,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return r.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400);
    throw new Error(`Callbell sendTemplate failed: ${msg}`);
  }
}

module.exports = { sendText, sendTemplate };
