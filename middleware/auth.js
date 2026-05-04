const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";

function getUserFromRequest(req) {
  const token = req.cookies?.token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "No autenticado" });
  }
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Solo admins" });
  }
  next();
}

function attachUser(req, res, next) {
  req.user = getUserFromRequest(req);
  res.locals.currentUser = req.user;
  next();
}

module.exports = { authMiddleware, adminOnly, attachUser, getUserFromRequest, JWT_SECRET };
