const express = require("express");
const { query, queryOne } = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

router.get("/dashboard", async (req, res) => {
  const uid = req.user.id;

  const [chips, msgsToday, unread, firedToday, queuePending, takeoverCount] = await Promise.all([
    queryOne(`SELECT COUNT(*) AS c FROM instances WHERE user_id = $1`, [uid]),
    queryOne(
      `SELECT
         SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS received
       FROM messages_log
       WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
      [uid]
    ),
    queryOne(
      `SELECT COALESCE(SUM(unread_count), 0) AS c FROM conversations WHERE user_id = $1`,
      [uid]
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM auto_responder_fired f
       JOIN auto_responders ar ON ar.id = f.auto_responder_id
       WHERE ar.user_id = $1 AND f.fired_at >= CURRENT_DATE`,
      [uid]
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM auto_responder_queue WHERE user_id = $1 AND status = 'pending'`,
      [uid]
    ),
    queryOne(
      `SELECT COUNT(*) AS c FROM conversations WHERE user_id = $1 AND human_takeover = TRUE`,
      [uid]
    ),
  ]);

  res.json({
    chips: parseInt(chips.c, 10),
    sent_today: parseInt(msgsToday.sent || 0, 10),
    received_today: parseInt(msgsToday.received || 0, 10),
    unread: parseInt(unread.c, 10),
    autoresponders_fired_today: parseInt(firedToday.c, 10),
    queue_pending: parseInt(queuePending.c, 10),
    conversations_takeover: parseInt(takeoverCount.c, 10),
  });
});

module.exports = router;
