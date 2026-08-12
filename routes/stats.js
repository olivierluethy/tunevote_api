const express = require("express");
const pool = require("../db");
const { getUserFromToken } = require("../services/auth");
const {
  shapeGenreRanking,
  polarMoment,
  shapeLeaderboard,
} = require("../services/statsShaping");

const router = express.Router();

// The "most votes given" board: one row per user, ranked by votes cast, DESC.
// Shared by the leaderboard (#42) and the polar-moment stat (#50).
async function votesGivenBoard() {
  const [rows] = await pool.query(
    `SELECT v.user_id AS userId, u.username AS name, COUNT(*) AS score
       FROM votes v
       JOIN users u ON u.id = v.user_id
      WHERE v.user_id IS NOT NULL
      GROUP BY v.user_id, u.username
      ORDER BY score DESC, u.username ASC`,
  );
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    score: Number(r.score),
  }));
}

// GET /stats/votes-leaderboard?limit=10 — "most votes given" ranking (#42).
// Auth is optional: when a token is present the caller's own row is flagged and
// also returned separately even if they fall outside the top slice.
router.get("/stats/votes-leaderboard", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  try {
    const board = await votesGivenBoard();
    res.json(shapeLeaderboard(board, user?.id ?? null, limit));
  } catch (err) {
    console.error("votes-leaderboard failed:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// GET /stats/polar-moment (auth) — where the caller stands on the votes-given
// leaderboard vs. the person one rank above them (#50).
router.get("/stats/polar-moment", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const board = await votesGivenBoard();
    res.json(polarMoment(board, user.id));
  } catch (err) {
    console.error("polar-moment failed:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

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
