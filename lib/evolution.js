const axios = require("axios");

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

const client = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    apikey: EVOLUTION_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

client.interceptors.response.use(
  (r) => r,
  (err) => {
    const url = err.config?.url;
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`[EVO ERR] ${err.config?.method?.toUpperCase()} ${url} → ${status}`, data || err.message);
    return Promise.reject(err);
  }
);

// ─── Instances ─────────────────────────────────────────
async function createInstance(instanceName, webhookUrl) {
  const body = {
    instanceName,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
  };
  if (webhookUrl) {
    body.webhook = {
      url: webhookUrl,
      events: [
        "QRCODE_UPDATED",
        "CONNECTION_UPDATE",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "SEND_MESSAGE",
        "CONTACTS_UPSERT",
        "GROUPS_UPSERT",
        "GROUP_PARTICIPANTS_UPDATE",
      ],
      byEvents: false,
      base64: false,
    };
  }
  const { data } = await client.post("/instance/create", body);
  return data;
}

async function fetchInstances() {
  const { data } = await client.get("/instance/fetchInstances");
  return data;
}

async function getInstance(instanceName) {
  const { data } = await client.get(`/instance/fetchInstances?instanceName=${instanceName}`);
  return Array.isArray(data) ? data[0] : data;
}

async function getConnectionState(instanceName) {
  const { data } = await client.get(`/instance/connectionState/${instanceName}`);
  return data;
}

async function connectInstance(instanceName) {
  const { data } = await client.get(`/instance/connect/${instanceName}`);
  return data;
}

async function logoutInstance(instanceName) {
  const { data } = await client.delete(`/instance/logout/${instanceName}`);
  return data;
}

async function deleteInstance(instanceName) {
  const { data } = await client.delete(`/instance/delete/${instanceName}`);
  return data;
}

async function setInstanceProxy(instanceName, proxy) {
  // proxy = { host, port, protocol: 'http'|'https', username, password }
  const { data } = await client.post(`/proxy/set/${instanceName}`, {
    enabled: true,
    host: proxy.host,
    port: String(proxy.port),
    protocol: proxy.protocol || "http",
    username: proxy.username || "",
    password: proxy.password || "",
  });
  return data;
}

// ─── Messaging ─────────────────────────────────────────
async function sendText(instanceName, phone, text, options = {}) {
  const body = {
    number: phone,
    text,
    delay: options.delay || 0,
    linkPreview: options.linkPreview !== false,
  };
  const { data } = await client.post(`/message/sendText/${instanceName}`, body);
  return data;
}

async function checkWhatsAppNumbers(instanceName, numbers) {
  const { data } = await client.post(`/chat/whatsappNumbers/${instanceName}`, {
    numbers,
  });
  return data;
}

// ─── Media (image / video / document / audio) ──────────
// mediaType: "image" | "video" | "document" | "audio"
// media: URL pública o base64 del archivo
async function sendMedia(instanceName, phone, mediaType, media, options = {}) {
  const body = {
    number: phone,
    mediatype: mediaType,
    media,
    delay: options.delay || 0,
  };
  if (options.caption) body.caption = options.caption;
  if (options.fileName) body.fileName = options.fileName;
  if (options.mimetype) body.mimetype = options.mimetype;
  const { data } = await client.post(`/message/sendMedia/${instanceName}`, body);
  return data;
}

// "Escribiendo..." simulado — Evolution acepta presence updates
async function sendPresence(instanceName, phone, presence = "composing", delayMs = 0) {
  try {
    const { data } = await client.post(`/chat/sendPresence/${instanceName}`, {
      number: phone,
      presence, // "composing" | "recording" | "paused" | "available" | "unavailable"
      delay: delayMs,
    });
    return data;
  } catch (err) {
    return null; // no es crítico si falla
  }
}

// Marcar mensajes como leídos (simula que abriste el chat antes de responder)
async function markMessagesAsRead(instanceName, readMessages) {
  // readMessages: [{ remoteJid, fromMe, id }]
  try {
    const { data } = await client.post(`/chat/markMessageAsRead/${instanceName}`, {
      readMessages,
    });
    return data;
  } catch (err) {
    return null;
  }
}

// Actualizar nombre de contacto en la libreta del chip (Baileys-side)
// Reduce un poco la cara de "número desconocido respondiéndole a otro número desconocido"
async function updateContactName(instanceName, phone, name) {
  try {
    const { data } = await client.post(`/chat/updateContact/${instanceName}`, {
      number: phone,
      name,
    });
    return data;
  } catch (err) {
    return null;
  }
}

// ─── Groups ────────────────────────────────────────────
async function joinGroupByInvite(instanceName, inviteCode) {
  const { data } = await client.get(
    `/group/inviteCode/${instanceName}?inviteCode=${encodeURIComponent(inviteCode)}`
  );
  return data;
}

async function fetchAllGroups(instanceName) {
  const { data } = await client.get(`/group/fetchAllGroups/${instanceName}?getParticipants=false`);
  return data;
}

// Crear grupo nuevo. Devuelve { id (group jid), subject, ... }
async function createGroup(instanceName, subject, participants, description = "") {
  const { data } = await client.post(`/group/create/${instanceName}`, {
    subject,
    description,
    participants, // array de teléfonos E.164 sin +
  });
  return data;
}

// Conseguir invite code de un grupo existente (devuelve { inviteUrl, inviteCode })
async function fetchInviteCode(instanceName, groupJid) {
  const { data } = await client.get(
    `/group/inviteCode/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`
  );
  return data; // { inviteUrl: "https://chat.whatsapp.com/...", inviteCode: "..." }
}

// Agregar participantes a grupo existente
async function addParticipants(instanceName, groupJid, participants) {
  const { data } = await client.post(
    `/group/updateParticipant/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`,
    { action: "add", participants }
  );
  return data;
}

// Promover participantes a admin del grupo
async function promoteParticipants(instanceName, groupJid, participants) {
  const { data } = await client.post(
    `/group/updateParticipant/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`,
    { action: "promote", participants }
  );
  return data;
}

// Mandar audio tipo "voice note" (PTT — apretás para grabar)
// audioUrl: URL pública del .mp3/.ogg/.m4a
async function sendWhatsAppAudio(instanceName, phoneOrGroupJid, audioUrl, options = {}) {
  const body = {
    number: phoneOrGroupJid,
    audio: audioUrl,
    delay: options.delay || 0,
  };
  const { data } = await client.post(`/message/sendWhatsAppAudio/${instanceName}`, body);
  return data;
}

// ─── WhatsApp Business Labels ──────────────────────────
// Listar labels existentes en el chip (tienen que crearse manualmente en la
// app WhatsApp Business primero — Baileys no permite crear labels via API)
async function findLabels(instanceName) {
  try {
    const { data } = await client.get(`/label/findLabels/${instanceName}`);
    return Array.isArray(data) ? data : (data?.labels || []);
  } catch (err) {
    return [];
  }
}

// Aplicar o quitar label a un chat (chat = remoteJid del contacto)
// action: "add" | "remove"
async function handleLabel(instanceName, remoteJid, labelId, action = "add") {
  const { data } = await client.post(`/label/handleLabel/${instanceName}`, {
    number: remoteJid.replace(/@s\.whatsapp\.net$|@c\.us$/, ""),
    labelId,
    action,
  });
  return data;
}

// Actualizar webhook events de una instancia existente (para agregar GROUP_PARTICIPANTS_UPDATE)
async function setInstanceWebhook(instanceName, webhookUrl, events) {
  const { data } = await client.post(`/webhook/set/${instanceName}`, {
    url: webhookUrl,
    events,
    enabled: true,
    byEvents: false,
    base64: false,
  });
  return data;
}

module.exports = {
  client,
  createInstance,
  fetchInstances,
  getInstance,
  getConnectionState,
  connectInstance,
  logoutInstance,
  deleteInstance,
  setInstanceProxy,
  sendText,
  sendMedia,
  sendPresence,
  markMessagesAsRead,
  updateContactName,
  checkWhatsAppNumbers,
  joinGroupByInvite,
  fetchAllGroups,
  createGroup,
  fetchInviteCode,
  addParticipants,
  promoteParticipants,
  sendWhatsAppAudio,
  findLabels,
  handleLabel,
  setInstanceWebhook,
};
