const express = require("express");
const pool = require("../db");
const { getUserFromToken } = require("../services/auth");
const { getScalar, getSingleValue } = require("../utils/helpers");

const router = express.Router();

router.get("/artist/:artistId", async (req, res) => {
  const { artistId } = req.params;

  try {
    //-- Artist-Basisinfos + aggregierte Hördaten über alle User
    const [[artist]] = await pool.query(
      `
      SELECT
        a.id,
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
        y.youtube_id AS id,
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
        u.id,
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

    res.json({ artist, topSongs, topUsers });
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
  const { userId } = req.params;

  try {
    // 1. Basis-Userdaten inkl. Gesamt-Hördauer
    const [[user]] = await pool.query(
      `SELECT 
         u.id,
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
  const { artistId } = req.params;
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
  const { artistId } = req.params;

  const authHeader = req.headers.authorization;
  let currentUserId = null;

  // Wenn Token vorhanden, User-ID extrahieren (für is_own_shout)
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const user = await getUserFromToken(authHeader.split(" ")[1]);
      currentUserId = user.id;
      console.log(`[GET shouts] Token ok – currentUserId = ${currentUserId}`); // ← NEU
    } catch {
      // Invalid token → kein Problem, is_own_shout wird null/0
      console.log(`[GET shouts] Token invalid: ${err.message}`); // ← NEU
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
        u.username,
        u.imageType,
        u.imageData,
        s.parent_id,
        s.message,
        s.created_at,
        s.is_deleted,
        COALESCE(SUM(sl.user_id IS NOT NULL), 0) AS likes,
        CASE WHEN s.user_id = ? THEN 1 ELSE 0 END AS is_own_shout
      FROM shouts s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN shout_likes sl ON sl.shout_id = s.id
      WHERE s.artist_id = ?
      GROUP BY s.id
      ORDER BY s.created_at ASC
      `,
      [currentUserId, artistId], // ← currentUserId als 1. Parameter für CASE WHEN
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


module.exports = router;
