const express = require("express");
const pool = require("../db");
const { shapeGenreRanking } = require("../services/statsShaping");

const router = express.Router();

// GET /stats/genre-ranking?window=week|month|all  (#43)
// Ranks genres by how many songs of each genre were played in the window,
// derived from playback_history joined to the AI-tagged genre on the cache.
router.get("/stats/genre-ranking", async (req, res) => {
  const window = String(req.query.window || "week").toLowerCase();
  const days = window === "month" ? 30 : window === "all" ? null : 7;

  try {
    const where =
      days === null ? "" : "WHERE ph.played_at >= (NOW() - INTERVAL ? DAY)";
    const params = days === null ? [] : [days];
    const [rows] = await pool.query(
      `SELECT COALESCE(yvc.genre, 'Other') AS genre, COUNT(*) AS plays
         FROM playback_history ph
         JOIN youtube_video_cache yvc ON ph.youtube_id = yvc.youtube_id
         ${where}
        GROUP BY COALESCE(yvc.genre, 'Other')`,
      params,
    );
    res.json({ window, ranking: shapeGenreRanking(rows) });
  } catch (err) {
    console.error("genre-ranking failed:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

module.exports = router;
