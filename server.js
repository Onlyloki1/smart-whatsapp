require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const { pool } = require("./db");
const { runMigrations } = require("./lib/migrate");
const { authMiddleware, attachUser } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const instancesRoutes = require("./routes/instances");
const webhookRoutes = require("./routes/webhook");
const autoresponderRoutes = require("./routes/autoresponder");
const inboxRoutes = require("./routes/inbox");
const closersRoutes = require("./routes/closers");
const bookingConfigRoutes = require("./routes/booking-config");
const hooksRoutes = require("./routes/hooks");
const sender = require("./jobs/sender");
const autoresponder = require("./jobs/autoresponder");
const booking = require("./jobs/booking");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ─── EJS ───────────────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(attachUser);

// ─── Health ────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API Routes ────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/instances", instancesRoutes);
app.use("/api/autoresponders", autoresponderRoutes);
app.use("/api/inbox", inboxRoutes);
app.use("/api/closers", closersRoutes);
app.use("/api/booking-config", bookingConfigRoutes);
app.use("/api/hooks", hooksRoutes); // hooks públicos (GHL/Calendly) — sin auth
app.use("/api/stats", require("./routes/stats"));
app.use("/api/webhook", webhookRoutes); // webhook Evolution — sin auth

// ─── Vistas ────────────────────────────────────────────
app.get("/", (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

app.get("/register", (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("register", { error: null });
});

app.get("/dashboard", authMiddleware, (req, res) => {
  res.render("dashboard", { user: req.user });
});

app.get("/instances", authMiddleware, (req, res) => {
  res.render("instances", { user: req.user });
});

app.get("/campaigns", authMiddleware, (req, res) => {
  res.render("campaigns", { user: req.user });
});

app.get("/autoresponders", authMiddleware, (req, res) => {
  res.render("autoresponders", { user: req.user });
});

app.get("/inbox", authMiddleware, (req, res) => {
  res.render("inbox", { user: req.user });
});

app.get("/booking", authMiddleware, (req, res) => {
  res.render("booking", { user: req.user });
});

// ─── 404 ───────────────────────────────────────────────
app.use((req, res) => {
  if (req.accepts("html")) return res.status(404).render("404");
  res.status(404).json({ error: "Not found" });
});

// ─── Error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[ERR]", err);
  res.status(500).json({ error: err.message });
});

// NOTA: el refresh de webhooks en boot fue eliminado porque generaba ráfagas
// de calls a Evolution/Baileys en cada deploy → WhatsApp lo veía como
// "automation sospechosa" y deslogueaba linked devices.
// Si necesitás re-suscribir un chip a eventos nuevos, hacelo manual desde
// la UI (endpoint /api/instances/:id/refresh-webhook).

async function boot() {
  try {
    await runMigrations();
  } catch (err) {
    console.error("[BOOT] Migration failed:", err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[APP] smart-whatsapp listening on :${PORT}`);
    if (process.env.DISABLE_SENDER !== "true") {
      sender.start();
    }
    if (process.env.DISABLE_AUTORESPONDER !== "true") {
      autoresponder.start();
    }
    if (process.env.DISABLE_BOOKING !== "true") {
      booking.start();
    }
  });
}

boot();
