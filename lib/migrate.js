require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { exec, query } = require("../db");

async function ensureMigrationsTable() {
  await exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Aplica todas las migraciones pendientes. Reutilizable: lo llama server.js
// al arrancar y también la CLI (node lib/migrate.js).
async function runMigrations() {
  await ensureMigrationsTable();
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  const applied = (await query("SELECT filename FROM schema_migrations")).map(r => r.filename);

  for (const file of files) {
    if (applied.includes(file)) {
      console.log(`[MIGRATE] skip ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`[MIGRATE] applying ${file}...`);
    await exec(sql);
    await exec("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    console.log(`[MIGRATE] ✓ ${file}`);
  }
  console.log("[MIGRATE] all done");
}

module.exports = { runMigrations };

// Si se invoca directo (node lib/migrate.js), correr y salir
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => { console.error("[MIGRATE ERR]", err); process.exit(1); });
}
