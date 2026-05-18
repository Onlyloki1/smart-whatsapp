// Upload de audios para scripts (multer → /public/uploads/audio/<uuid>.<ext>)
// El archivo queda servido vía /uploads/audio/<file> con express.static

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "audio");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_AUDIO = new Set([".mp3", ".ogg", ".m4a", ".aac", ".wav", ".opus"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".mp3";
    if (!ALLOWED_AUDIO.has(ext)) return cb(new Error("Extensión no permitida"));
    const id = crypto.randomBytes(12).toString("hex");
    cb(null, `u${req.user.id}-${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB (límite WhatsApp)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_AUDIO.has(ext)) return cb(new Error("Solo .mp3/.ogg/.m4a/.aac/.wav/.opus"));
    cb(null, true);
  },
});

// POST /api/uploads/audio
router.post("/audio", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Archivo requerido (campo 'file')" });
  // URL pública (servida desde express.static)
  const publicUrl = `/uploads/audio/${req.file.filename}`;
  const fullUrl = `${req.protocol}://${req.get("host")}${publicUrl}`;
  res.json({ ok: true, url: fullUrl, path: publicUrl, size: req.file.size });
});

module.exports = router;
