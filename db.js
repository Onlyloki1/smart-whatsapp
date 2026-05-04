const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function queryOne(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function exec(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function logEvent(userId, instanceId, type, payload) {
  try {
    await exec(
      "INSERT INTO system_events (user_id, instance_id, event_type, payload) VALUES ($1, $2, $3, $4)",
      [userId, instanceId, type, payload || {}]
    );
  } catch (e) {
    console.error("[EVENT LOG ERR]", e.message);
  }
}

module.exports = { pool, query, queryOne, exec, tx, logEvent };
