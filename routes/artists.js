const express = require("express");
const pool = require("../db");
const { getUserFromToken } = require("../services/auth");
const { getScalar, getSingleValue } = require("../utils/helpers");
const { fetchUserStats } = require("../services/userStats");
const { resolveId, resolveVideoId } = require("../services/publicId");

const router = express.Router();

router.get("/artist/:artistId", async (req, res) => {
  try {
    const artistId = await resolveId("artists", req.params.artistId);
    if (!artistId) return res.status(404).json({ error: "Artist not found" });

    //-- Artist-Basisinfos + aggregierte Hördaten über alle User
    const [[artist]] = await pool.query(
      `
      SELECT
        a.public_id AS id,
        a.name,
        a.image_url,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM artists a
      LEFT JOIN youtube_video_cache y ON y.artist_id = a.id
      LEFT JOIN queue_items q ON q.video_id = y.youtube_id
      LEFT JOIN session_song_listens s ON s.queue_item_id = q.id
      WHERE a.id = ?
      GROUP BY a.id
      `,
      [artistId],
    );

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    //-- Top Songs nach aggregierter Hördauer über alle Nutzer
    const [topSongs] = await pool.query(
      `
      SELECT
        y.public_id AS id,
        y.title,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM youtube_video_cache y
      JOIN queue_items q ON q.video_id = y.youtube_id
      LEFT JOIN session_song_listens s ON s.queue_item_id = q.id
      WHERE y.artist_id = ?
        AND q.status IN ('played','playing','queued')
      GROUP BY y.youtube_id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId],
    );

    //-- Top User nach gesamter Hördauer für diesen Artist
    const [topUsersRaw] = await pool.query(
      `
      SELECT
        u.public_id AS id,
        u.username,
        u.imageType,
        u.imageData,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM users u
      JOIN session_song_listens s ON s.user_id = u.id
      JOIN queue_items q ON q.id = s.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND q.status IN ('played','playing','queued')
      GROUP BY u.id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId],
    );

    // Base64-Profilbilder generieren
    const topUsers = topUsersRaw.map((u) => {
      let profileImage = null;
      if (u.imageType && u.imageData) {
        profileImage = `data:${u.imageType};base64,${u.imageData.toString("base64")}`;
      }
      return {
        id: u.id,
        username: u.username,
        total_seconds: u.total_seconds,
        profileImage,
      };
    });

    //-- Daily listen trend (last 30 days) + 5-day forecast for this artist
    const [dailyRows] = await pool.query(
      `SELECT DATE_FORMAT(s.listened_from, '%Y-%m-%d') AS date, COUNT(*) AS listens
       FROM session_song_listens s
       JOIN queue_items q ON q.id = s.queue_item_id
       JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE y.artist_id = ? AND s.listened_from >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE_FORMAT(s.listened_from, '%Y-%m-%d')
       ORDER BY date ASC`,
      [artistId],
    );
    const daily = dailyRows.map((d) => ({
      date: d.date,
      listens: Number(d.listens),
    }));
    const dailyMap = {};
    daily.forEach((d) => (dailyMap[d.date] = d.listens));
    const forecast = forecastDaily(dailyMap, 5);

    res.json({ artist, topSongs, topUsers, daily, forecast });
  } catch (err) {
    console.error("Artist page failed:", err);
    res.status(500).json({ error: "Failed to load artist details" });
  }
});

/**
 * Holt alle relevanten Statistiken eines Users parallel
 * @param {number} userId
 * @returns {Promise<Object>} Statistiken-Objekt
 */

router.get("/user/:userId", async (req, res) => {
  try {
    const userId = await resolveId("users", req.params.userId);
    if (!userId) return res.status(404).json({ error: "User nicht gefunden" });

    // 1. Basis-Userdaten inkl. Gesamt-Hördauer
    const [[user]] = await pool.query(
      `SELECT
         u.public_id AS id,
         u.username,
         u.imageData,
         SUM(l.listen_seconds) AS total_seconds
       FROM users u
       LEFT JOIN session_song_listens l ON l.user_id = u.id
       WHERE u.id = ?
       GROUP BY u.id`,
      [userId],
    );

    if (!user) {
      return res.status(404).json({ error: "User nicht gefunden" });
    }

    // 2. Alle weiteren Statistiken parallel holen
    const statsData = await fetchUserStats(userId);

    // 3. Antwort zusammenbauen
    res.json({
      user: {
        id: user.id,
        username: user.username,
        image_url: user.imageData
          ? `data:image/jpeg;base64,${user.imageData.toString("base64")}`
          : null,
        total_listen_seconds: user.total_seconds || 0,
        is_live_host: statsData.isCurrentlyLiveHost,
        active_session: statsData.activeSession,
      },
      top_songs: statsData.topSongs,
      top_co_listeners: statsData.topCoListeners,
      session_count: statsData.sessionCount,
      stats: statsData.stats,
    });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});


router.get("/top-today", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        a.id AS artist_id,
        a.name AS artist_name,
        a.image_url,
        COUNT(v.id) AS vote_count
      FROM votes v
      JOIN queue_items qi ON qi.id = v.queue_item_id
      JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      JOIN artists a ON a.id = yvc.artist_id
      WHERE DATE(v.created_at) = CURDATE()
      GROUP BY a.id, a.name, a.image_url
      ORDER BY vote_count DESC
       LIMIT 10`,
    );
    res.json(rows);
  } catch (err) {
    console.error("Top Today error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});


router.get("/top-weekly-songs", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        yvc.youtube_id,
        yvc.title AS song_title,
        yvc.thumbnail,
        a.id AS artist_id,
        a.name AS artist_name,
        COUNT(qi.id) AS queue_count
      FROM queue_items qi
      JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      JOIN artists a ON a.id = yvc.artist_id
      WHERE
        qi.status IN ('played', 'queued')
        AND YEARWEEK(qi.created_at, 1) = YEARWEEK(CURDATE(), 1)
      GROUP BY
        yvc.youtube_id,
        yvc.title,
        yvc.thumbnail,
        a.id,
        a.name
      ORDER BY queue_count DESC
      LIMIT 10
      `,
    );

    res.json(rows);
  } catch (err) {
    console.error("Top Weekly Songs error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// Multer: Nur eine Datei mit dem Feldnamen "profileImage" akzeptieren

router.post("/artist/:artistId/shouts", async (req, res) => {
  const artistId = await resolveId("artists", req.params.artistId);
  if (!artistId) return res.status(404).json({ error: "Artist not found" });
  const { message, parent_id } = req.body;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  try {
    // Prüfen, ob parent_id existiert und zum gleichen Künstler gehört
    if (parent_id) {
      const [[parent]] = await pool.query(
        `SELECT id FROM shouts WHERE id = ? AND artist_id = ?`,
        [parent_id, artistId],
      );
      if (!parent) {
        return res.status(400).json({ error: "Invalid parent shout" });
      }
    }

    const [result] = await pool.query(
      `
      INSERT INTO shouts (artist_id, user_id, parent_id, message, created_at)
      VALUES (?, ?, ?, ?, NOW())
      `,
      [artistId, user.id, parent_id || null, message],
    );

    res.json({
      success: true,
      shout: {
        id: result.insertId,
        artist_id: artistId,
        user_id: user.id,
        parent_id: parent_id || null,
        message,
        username: user.username,
        created_at: new Date(),
      },
    });
  } catch (err) {
    console.error("Failed to post shout:", err);
    res.status(500).json({ error: "Failed to post shout" });
  }
});


router.get("/artist/:artistId/shouts", async (req, res) => {
  const artistId = await resolveId("artists", req.params.artistId);
  if (!artistId) return res.status(404).json({ error: "Artist not found" });

  const authHeader = req.headers.authorization;
  let currentUserId = null;

  // Wenn Token vorhanden, User-ID extrahieren (für is_own_shout)
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const user = await getUserFromToken(authHeader.split(" ")[1]);
      currentUserId = user?.id ?? null;
    } catch (err) {
      // Invalid token → kein Problem, is_own_shout/my_reaction bleibt 0
      console.log(`[GET shouts] Token invalid: ${err.message}`);
    }
  }

  try {
    // Alle Shouts für diesen Artist inkl. Usernamen, Profilbilder, Likes + is_own_shout + is_deleted
    const [shouts] = await pool.query(
      `
      SELECT
        s.id,
        s.artist_id,
        s.user_id,
        u.public_id AS author_public_id,
        u.username,
        u.imageType,
        u.imageData,
        s.parent_id,
        s.message,
        s.created_at,
        s.is_deleted,
        s.is_edited,
        COALESCE(SUM(CASE WHEN sl.value = 1 THEN 1 ELSE 0 END), 0) AS likes,
        COALESCE(SUM(CASE WHEN sl.value = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
        COALESCE(MAX(CASE WHEN sl.user_id = ? THEN sl.value END), 0) AS my_reaction,
        CASE WHEN s.user_id = ? THEN 1 ELSE 0 END AS is_own_shout
      FROM shouts s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN shout_likes sl ON sl.shout_id = s.id
      WHERE s.artist_id = ?
      GROUP BY s.id
      ORDER BY s.created_at ASC
      `,
      [currentUserId, currentUserId, artistId],
    );

    // Profilbilder als Data-URLs konvertieren
    const formattedShouts = shouts.map((s) => {
      let profileImage = null;
      if (s.imageType && s.imageData) {
        profileImage = `data:${s.imageType};base64,${s.imageData.toString("base64")}`;
      }
      return {
        ...s,
        profileImage,
        is_own_shout: Boolean(s.is_own_shout), // ← Als Boolean für Frontend
      };
    });

    res.json(formattedShouts);
  } catch (err) {
    console.error("Failed to fetch shouts:", err);
    res.status(500).json({ error: "Failed to fetch shouts" });
  }
});


router.post("/shouts/:shoutId/like", async (req, res) => {
  const { shoutId } = req.params;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    // Prüfen, ob Shout existiert
    const [[shout]] = await pool.query("SELECT id FROM shouts WHERE id = ?", [
      shoutId,
    ]);
    if (!shout) {
      return res.status(404).json({ error: "Shout not found" });
    }

    // Prüfen, ob Like bereits existiert
    const [existingLike] = await pool.query(
      "SELECT id FROM shout_likes WHERE shout_id = ? AND user_id = ?",
      [shoutId, user.id],
    );

    if (existingLike.length) {
      // Like existiert → entfernen (Unlike)
      await pool.query("DELETE FROM shout_likes WHERE id = ?", [
        existingLike[0].id,
      ]);
      return res.json({ success: true, liked: false });
    }

    // Like hinzufügen
    await pool.query(
      "INSERT INTO shout_likes (shout_id, user_id, created_at) VALUES (?, ?, NOW())",
      [shoutId, user.id],
    );

    res.json({ success: true, liked: true });
  } catch (err) {
    console.error("Failed to toggle like:", err);
    res.status(500).json({ error: "Failed to toggle like" });
  }
});


// React to a shout: value = 1 (like / thumbs up) or -1 (dislike / thumbs down).
// One reaction per user per shout; clicking the same one again removes it.
router.post("/shouts/:shoutId/react", async (req, res) => {
  const { shoutId } = req.params;
  const value = Number(req.body?.value);
  if (value !== 1 && value !== -1) {
    return res
      .status(400)
      .json({ error: "value must be 1 (like) or -1 (dislike)" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (!user) return res.status(401).json({ error: "Invalid token" });

  try {
    const [[shout]] = await pool.query("SELECT id FROM shouts WHERE id = ?", [
      shoutId,
    ]);
    if (!shout) return res.status(404).json({ error: "Shout not found" });

    const [[existing]] = await pool.query(
      "SELECT id, value FROM shout_likes WHERE shout_id = ? AND user_id = ?",
      [shoutId, user.id],
    );

    let myReaction;
    if (existing && Number(existing.value) === value) {
      // Same reaction clicked again → toggle it off.
      await pool.query("DELETE FROM shout_likes WHERE id = ?", [existing.id]);
      myReaction = 0;
    } else {
      await pool.query(
        `INSERT INTO shout_likes (shout_id, user_id, value, created_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [shoutId, user.id, value],
      );
      myReaction = value;
    }

    const [[counts]] = await pool.query(
      `SELECT COALESCE(SUM(value = 1), 0) AS likes,
              COALESCE(SUM(value = -1), 0) AS dislikes
         FROM shout_likes WHERE shout_id = ?`,
      [shoutId],
    );
    res.json({
      success: true,
      my_reaction: myReaction,
      likes: Number(counts.likes),
      dislikes: Number(counts.dislikes),
    });
  } catch (err) {
    console.error("Failed to react to shout:", err);
    res.status(500).json({ error: "Failed to react to shout" });
  }
});


// Edit a shout — author only.
router.patch("/shouts/:shoutId", async (req, res) => {
  const { shoutId } = req.params;
  const { message } = req.body || {};

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (!user) return res.status(401).json({ error: "Invalid token" });

  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  try {
    const [[shout]] = await pool.query(
      "SELECT id, user_id, is_deleted FROM shouts WHERE id = ?",
      [shoutId],
    );
    if (!shout) return res.status(404).json({ error: "Shout not found" });
    if (shout.user_id !== user.id) {
      return res.status(403).json({ error: "You can only edit your own comment" });
    }
    if (shout.is_deleted) {
      return res.status(400).json({ error: "Cannot edit a deleted comment" });
    }

    await pool.query(
      "UPDATE shouts SET message = ?, is_edited = 1 WHERE id = ?",
      [message.trim(), shoutId],
    );
    res.json({ success: true, message: message.trim(), is_edited: true });
  } catch (err) {
    console.error("Failed to edit shout:", err);
    res.status(500).json({ error: "Failed to edit shout" });
  }
});


router.delete("/shouts/:shoutId", async (req, res) => {
  const { shoutId } = req.params;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const [[shout]] = await pool.query("SELECT * FROM shouts WHERE id = ?", [
      shoutId,
    ]);
    if (!shout) return res.status(404).json({ error: "Shout not found" });
    if (shout.user_id !== user.id)
      return res.status(403).json({ error: "Not allowed" });

    const now = new Date();
    const createdAt = new Date(shout.created_at);
    const deleteWindowMinutes = 30; // z.B. 30 Minuten Zeitfenster
    const diffMinutes = (now - createdAt) / (1000 * 60);

    if (diffMinutes <= deleteWindowMinutes) {
      // Vollständig löschen inkl. Likes & Unterkommentare (Cascade)
      await pool.query("DELETE FROM shout_likes WHERE shout_id = ?", [shoutId]);
      await pool.query("DELETE FROM shouts WHERE id = ? OR parent_id = ?", [
        shoutId,
        shoutId,
      ]);
    } else {
      // Soft Delete: Text ersetzen, Likes löschen, Unterkommentare bleiben
      await pool.query(
        "UPDATE shouts SET message = '[Kommentar gelöscht]', is_deleted = 1, deleted_at = NOW() WHERE id = ?",
        [shoutId],
      );
      await pool.query("DELETE FROM shout_likes WHERE shout_id = ?", [shoutId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete shout:", err);
    res.status(500).json({ error: "Failed to delete shout" });
  }
});


// ---------------------------------------------------------------------------
// Song stats — GET /song/:videoId/stats
// plays, unique listeners, last-listened, a 30-day trend + 5-day forecast, and
// the song's popularity rank across all-time / month / week / day / hour.
// ---------------------------------------------------------------------------

// Fixed SQL window fragments (constants, never user input). Column is
// unqualified so it resolves to the session_song_listens row in scope.
const RANK_WINDOWS = {
  all: "1=1",
  month: "listened_from >= DATE_FORMAT(NOW(), '%Y-%m-01')",
  week: "YEARWEEK(listened_from, 1) = YEARWEEK(NOW(), 1)",
  day: "DATE(listened_from) = CURDATE()",
  hour: "listened_from >= DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00')",
};

async function songRanking(videoId, windowSql) {
  const [[row]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM session_song_listens s JOIN queue_items q ON q.id=s.queue_item_id
          WHERE q.video_id = ? AND ${windowSql}) AS this_count,
       (SELECT COUNT(DISTINCT q.video_id) FROM session_song_listens s JOIN queue_items q ON q.id=s.queue_item_id
          WHERE q.video_id IS NOT NULL AND ${windowSql}) AS total,
       1 + (SELECT COUNT(*) FROM (
              SELECT COUNT(*) c FROM session_song_listens s JOIN queue_items q ON q.id=s.queue_item_id
              WHERE q.video_id IS NOT NULL AND ${windowSql}
              GROUP BY q.video_id
              HAVING c > (SELECT COUNT(*) FROM session_song_listens s2 JOIN queue_items q2 ON q2.id=s2.queue_item_id
                          WHERE q2.video_id = ? AND ${windowSql})
            ) t) AS rank_pos`,
    [videoId, videoId],
  );
  const thisCount = Number(row.this_count) || 0;
  return {
    rank: thisCount > 0 ? Number(row.rank_pos) : null,
    total: Number(row.total) || 0,
    plays: thisCount,
  };
}

const localKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

// Least-squares linear projection of daily listens for the next `days` days.
function forecastDaily(dailyMap, days = 5) {
  const N = 14;
  const today = new Date();
  const ys = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    ys.push(dailyMap[localKey(d)] || 0);
  }
  const xs = ys.map((_, i) => i);
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  const slope = denom ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const out = [];
  for (let k = 1; k <= days; k++) {
    const d = new Date(today);
    d.setDate(today.getDate() + k);
    out.push({
      date: localKey(d),
      listens: Math.max(0, Math.round(intercept + slope * (N - 1 + k))),
    });
  }
  return out;
}

router.get("/song/:videoId/stats", async (req, res) => {
  try {
    const videoId = await resolveVideoId(req.params.videoId);
    if (!videoId) return res.status(404).json({ error: "Song not found" });
    const [songRows] = await pool.query(
      `SELECT
         y.public_id AS video_id, y.title, y.thumbnail, y.duration,
         a.public_id AS artist_id, a.name AS artist_name,
         COUNT(s.id) AS plays,
         COUNT(DISTINCT s.user_id) AS listeners,
         COALESCE(FLOOR(SUM(s.listen_seconds) / 60), 0) AS total_minutes,
         MAX(s.listened_from) AS last_listened
       FROM youtube_video_cache y
       LEFT JOIN artists a ON a.id = y.artist_id
       LEFT JOIN queue_items q ON q.video_id = y.youtube_id
       LEFT JOIN session_song_listens s ON s.queue_item_id = q.id
       WHERE y.youtube_id = ?
       GROUP BY y.youtube_id`,
      [videoId],
    );
    if (!songRows.length) {
      return res.status(404).json({ error: "Song not found" });
    }
    const song = songRows[0];

    const [dailyRows] = await pool.query(
      `SELECT DATE_FORMAT(s.listened_from, '%Y-%m-%d') AS date, COUNT(*) AS listens
       FROM session_song_listens s JOIN queue_items q ON q.id = s.queue_item_id
       WHERE q.video_id = ? AND s.listened_from >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE_FORMAT(s.listened_from, '%Y-%m-%d')
       ORDER BY date ASC`,
      [videoId],
    );
    const daily = dailyRows.map((d) => ({
      date: d.date,
      listens: Number(d.listens),
    }));
    const dailyMap = {};
    daily.forEach((d) => (dailyMap[d.date] = d.listens));
    const forecast = forecastDaily(dailyMap, 5);

    const rankKeys = Object.keys(RANK_WINDOWS);
    const rankResults = await Promise.all(
      rankKeys.map((k) => songRanking(videoId, RANK_WINDOWS[k])),
    );
    const rankings = {};
    rankKeys.forEach((k, i) => (rankings[k] = rankResults[i]));

    res.json({
      song: {
        video_id: song.video_id,
        title: song.title,
        thumbnail: song.thumbnail,
        duration: song.duration,
        artist_id: song.artist_id,
        artist_name: song.artist_name,
      },
      plays: Number(song.plays) || 0,
      listeners: Number(song.listeners) || 0,
      total_minutes: Number(song.total_minutes) || 0,
      last_listened: song.last_listened,
      daily,
      forecast,
      rankings,
    });
  } catch (err) {
    console.error("Failed to load song stats:", err);
    res.status(500).json({ error: "Failed to load song stats" });
  }
});


// Top 10 artists by plays in a time window (all|month|week|day|hour).
// Powers the "top artists this month/week/day/hour" leaderboard popups.
router.get("/top-artists", async (req, res) => {
  const window = String(req.query.window || "all");
  const windowSql = RANK_WINDOWS[window] || RANK_WINDOWS.all;
  try {
    const [rows] = await pool.query(
      `SELECT a.public_id AS artist_id, a.name AS artist_name, a.image_url,
              COUNT(*) AS plays,
              COUNT(DISTINCT s.user_id) AS listeners
       FROM session_song_listens s
       JOIN queue_items q ON q.id = s.queue_item_id
       JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       JOIN artists a ON a.id = y.artist_id
       WHERE ${windowSql}
       GROUP BY a.id, a.name, a.image_url
       ORDER BY plays DESC, listeners DESC
       LIMIT 10`,
    );
    res.json({
      window,
      artists: rows.map((r) => ({
        artist_id: r.artist_id,
        artist_name: r.artist_name,
        image_url: r.image_url,
        plays: Number(r.plays),
        listeners: Number(r.listeners),
      })),
    });
  } catch (err) {
    console.error("Failed to load top artists:", err);
    res.status(500).json({ error: "Failed to load top artists" });
  }
});


module.exports = router;
