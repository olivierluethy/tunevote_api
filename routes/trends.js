const express = require("express");
const pool = require("../db");
const { momentum } = require("../services/trendMomentum");

const router = express.Router();

// GET /trends?videoIds=a,b,c  (#46)
// Returns { [videoId]: { pct, dir } } — 7-day momentum of plays + votes vs the
// previous 7 days. Unknown/no-activity ids come back as { pct: 0, dir: 'flat' }.
router.get("/trends", async (req, res) => {
  const ids = String(req.query.videoIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);

  const out = {};
  for (const id of ids) out[id] = { pct: 0, dir: "flat" };
  if (ids.length === 0) return res.json(out);

  try {
    // recent = last 7d, previous = the 7d before that. Two grouped queries
    // (plays + votes) summed per id, then momentum() per id.
    const recent = {}; // id -> count
    const previous = {};
    const bump = (bucket, id, n) => {
      bucket[id] = (bucket[id] || 0) + Number(n || 0);
    };

    const [plays] = await pool.query(
      `SELECT youtube_id AS id,
              SUM(played_at >= (NOW() - INTERVAL 7 DAY)) AS recent,
              SUM(played_at <  (NOW() - INTERVAL 7 DAY)) AS previous
         FROM playback_history
        WHERE youtube_id IN (?) AND played_at >= (NOW() - INTERVAL 14 DAY)
        GROUP BY youtube_id`,
      [ids],
    );
    for (const r of plays) {
      bump(recent, r.id, r.recent);
      bump(previous, r.id, r.previous);
    }

    const [votes] = await pool.query(
      `SELECT qi.video_id AS id,
              SUM(v.created_at >= (NOW() - INTERVAL 7 DAY)) AS recent,
              SUM(v.created_at <  (NOW() - INTERVAL 7 DAY)) AS previous
         FROM votes v
         JOIN queue_items qi ON v.queue_item_id = qi.id
        WHERE qi.video_id IN (?) AND v.created_at >= (NOW() - INTERVAL 14 DAY)
        GROUP BY qi.video_id`,
      [ids],
    );
    for (const r of votes) {
      bump(recent, r.id, r.recent);
      bump(previous, r.id, r.previous);
    }

    for (const id of ids) {
      out[id] = momentum(recent[id] || 0, previous[id] || 0);
    }
    res.json(out);
  } catch (err) {
    console.error("trends failed:", err);
    // Degrade gracefully — search still works without trend arrows.
    res.json(out);
  }
});

module.exports = router;
