require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");

const { pool } = require("./db");
const { authMiddleware, attachUser } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const instancesRoutes = require("./routes/instances");
const webhookRoutes = require("./routes/webhook");
const sender = require("./jobs/sender");

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
app.use("/api/webhook", webhookRoutes); // webhook NO va con authMiddleware

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

app.get("/inbox", authMiddleware, (req, res) => {
  res.render("inbox", { user: req.user });
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

app.listen(PORT, () => {
  console.log(`[APP] smart-whatsapp listening on :${PORT}`);
  if (process.env.DISABLE_SENDER !== "true") {
    sender.start();
  }
});
