const express = require("express");
const multer = require("multer");
const pool = require("../db");
const { getUserFromToken } = require("../services/auth");
const { getScalar, getSingleValue } = require("../utils/helpers");

const router = express.Router();

router.get("/profile", async (req, res) => {
  console.log("\n=== GET /profile aufgerufen ===");
  console.log("Vollständige Request-Headers:", req.headers);
  console.log("User-Agent:", req.headers["user-agent"]);
  console.log("IP:", req.ip || req.connection.remoteAddress);

  // 1. Authorization Header prüfen
  const authHeader = req.headers.authorization;
  console.log("Authorization Header:", authHeader || "FEHLT");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("Kein oder falscher Authorization-Header → 401");
    return res
      .status(401)
      .json({ error: "Unauthenticated – kein gültiger Token" });
  }

  const token = authHeader.split(" ")[1];
  console.log(
    "Extrahierter JWT-Token:",
    token ? `${token.slice(0, 15)}...${token.slice(-10)}` : "LEER",
  );

  // 2. Token dekodieren / User holen
  let user;
  try {
    user = await getUserFromToken(token);
  } catch (err) {
    console.log("Token ungültig oder abgelaufen:", err.message);
    return res.status(401).json({ error: "Unauthenticated – Token ungültig" });
  }

  if (!user) {
    console.log("getUserFromToken hat null zurückgegeben");
    return res.status(401).json({ error: "Unauthenticated" });
  }

  console.log("Erfolgreich authentifizierter User aus Token:", {
    id: user.id,
    username: user.username || "(nicht im Token)",
    email: user.email || "(nicht im Token)",
    iat: user.iat,
    exp: user.exp,
  });

  // 3. Datenbankabfrage – jetzt MIT Profilbild-Daten
  try {
    console.log(`Führe DB-Query aus für user.id = ${user.id}`);
    const [userRow] = await pool.query(
      `SELECT 
       id, 
       username, 
       email, 
       created_at,
       imageType,
       imageData 
     FROM users 
     WHERE id = ?`,
      [user.id],
    );

    console.log("Roh-Ergebnis der DB-Abfrage:", userRow);

    if (!userRow || userRow.length === 0) {
      console.log("User mit ID", user.id, "nicht in DB gefunden → 404");
      return res.status(404).json({ error: "User not found" });
    }

    const dbUser = userRow[0];
    console.log("Gefundener User in DB (inkl. Bild):", {
      id: dbUser.id,
      username: dbUser.username,
      email: dbUser.email,
      hasImage: !!(dbUser.imageType && dbUser.imageData),
    });

    // 4. Antwort an Frontend – jetzt mit imageType und imageData
    console.log("Sende erfolgreiche Antwort an Frontend → 200");
    console.log("imageData type:", typeof dbUser.imageData);
    console.log("imageData is Buffer:", Buffer.isBuffer(dbUser.imageData));
    console.log("imageData length:", dbUser.imageData?.length);

    res.json({
      username: dbUser.username,
      email: dbUser.email,
      imageType: dbUser.imageType || null,
      imageData: dbUser.imageData
        ? dbUser.imageData.toString("base64") // Direkt vom Buffer → Base64
        : null,
    });
  } catch (err) {
    console.error("Schwerer Fehler beim Laden des Profils:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: "Interner Serverfehler" });
  }

  console.log("=== GET /profile Ende ===\n");
});

// ============================================================
// POST /profile → Profil + Passwort ändern
// ============================================================

router.post("/profile", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  if (!user) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  const { username, email, currentPassword, newPassword, confirmPassword } =
    req.body;

  // Validierung
  if (!username || !email) {
    return res
      .status(400)
      .json({ error: "Benutzername und E-Mail sind erforderlich" });
  }

  if (username.length < 3 || username.length > 50) {
    return res
      .status(400)
      .json({ error: "Benutzername muss 3–50 Zeichen haben" });
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  try {
    // Prüfen, ob Username oder E-Mail bereits von anderem Nutzer verwendet wird
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)) AND id != ?`,
      [username, email, user.id],
    );

    if (existing.length > 0) {
      const field =
        existing[0].username?.toLowerCase() === username.toLowerCase()
          ? "Benutzername"
          : "E-Mail";
      return res.status(409).json({ error: `${field} bereits vergeben` });
    }

    // Passwort ändern?
    if (newPassword) {
      if (!currentPassword) {
        return res
          .status(400)
          .json({ error: "Aktuelles Passwort erforderlich" });
      }
      if (newPassword !== confirmPassword) {
        return res
          .status(400)
          .json({ error: "Neue Passwörter stimmen nicht überein" });
      }
      if (newPassword.length < 8) {
        return res
          .status(400)
          .json({ error: "Neues Passwort muss mind. 8 Zeichen haben" });
      }

      // Aktuelles Passwort prüfen
      const [currentUser] = await pool.query(
        `SELECT password_hash FROM users WHERE id = ?`,
        [user.id],
      );

      const validPassword = await bcrypt.compare(
        currentPassword,
        currentUser[0].password_hash,
      );
      if (!validPassword) {
        return res.status(400).json({ error: "Aktuelles Passwort ist falsch" });
      }

      // Neues Passwort hashen
      const password_hash = await bcrypt.hash(newPassword, 12);

      // Update mit Passwort
      await pool.query(
        `UPDATE users 
         SET username = ?, email = ?, password_hash = ?, updated_at = NOW()
         WHERE id = ?`,
        [username, email, password_hash, user.id],
      );
    } else {
      // Nur Name + E-Mail ändern
      await pool.query(
        `UPDATE users 
         SET username = ?, email = ?, updated_at = NOW()
         WHERE id = ?`,
        [username, email, user.id],
      );
    }

    // Optional: Token neu generieren oder Session aktualisieren (falls du JWT nutzt)
    // Hier einfach Erfolg zurückgeben
    res.json({ success: true, message: "Profil erfolgreich aktualisiert" });
  } catch (err) {
    console.error("Fehler beim Aktualisieren des Profils:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});


router.get("/profile/user-stats", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    // Hilfsfunktion: Extrahiere Zahl aus [rows, fields] → rows[0]?.value || 0
    const getValue = (result, field = "count") => {
      return result && result[0] && result[0][0]
        ? Number(result[0][0][field] || 0)
        : 0;
    };

    const getSingleRowValue = (result, field) => {
      if (!result || !result[0] || result[0].length === 0) return 0;
      return Number(result[0][0][field] || 0);
    };

    const [
      votesOnOwnSuggestionsRes,
      winsAgainstQueueRes,
      maxStreakWinsRes,
      votesOnOwnButLostRes,
      votesOnOthersAndWonRes,
      votesOnOthersAndLostRes,
      streaksForeignVotesRes,
      sessionsWithoutVoteRes,
      maxStreakNoVoteRes,
    ] = await Promise.all([
      // 1. Wie oft wurde über eigene Vorschläge abgestimmt?
      pool.query(
        `
        SELECT COUNT(DISTINCT v.queue_item_id) AS count
        FROM votes v
        JOIN queue_items qi ON v.queue_item_id = qi.id
        WHERE qi.added_by = ?
      `,
        [userId],
      ),

      // 2. Wie oft hat der User mit eigenem Vorschlag gewonnen?
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM voting_rounds vr
        JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
        WHERE qi.added_by = ?
      `,
        [userId],
      ),

      // 3. Längster Gewinn-Streak (aufeinanderfolgende Siege mit eigenem Song)
      pool.query(
        `
        WITH wins AS (
          SELECT vr.started_at
          FROM voting_rounds vr
          JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
          WHERE qi.added_by = ?
          ORDER BY vr.started_at
        ),
        ranked AS (
          SELECT 
            started_at,
            ROW_NUMBER() OVER (ORDER BY started_at) AS rn,
            ROW_NUMBER() OVER (ORDER BY started_at) AS grp
          FROM wins
        )
        SELECT MAX(rn - grp + 1) AS max_streak
        FROM ranked
      `,
        [userId],
      ),

      // 4. Eigener Song bekam Votes, hat aber NICHT gewonnen
      pool.query(
        `
        SELECT COUNT(DISTINCT qi.id) AS count
        FROM queue_items qi
        JOIN votes v ON v.queue_item_id = qi.id
        LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id AND vr.winner_queue_item_id = qi.id
        WHERE qi.added_by = ? AND vr.winner_queue_item_id IS NULL
      `,
        [userId],
      ),

      // 5. Auf fremden Song gevotet → der hat gewonnen

      // Gewonnen heisst wenn queued_items status auf "queued", "playing", "played" ist
      // added_by NOT logged IN User ID
      // votes WHERE user_id = logged IN User ID
      // AND queue_items equals to votes.queue_items_id = queued_items.id
      pool.query(
        `
  SELECT COUNT(*) AS count
  FROM votes v
  JOIN queue_items qi ON v.queue_item_id = qi.id
  WHERE v.user_id = ?
    AND qi.added_by != ?
    AND qi.added_by IS NOT NULL                    -- kein AI-Vorschlag
    AND qi.voting_round_id IS NOT NULL             -- war definitiv ein Voting-Vorschlag
    AND qi.status IN ('queued', 'playing', 'played')  -- hat es in die echte Queue geschafft → gewonnen
`,
        [userId, userId],
      ),

      // 6. Auf fremden Song gevotet → der hat verloren
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM votes v
        JOIN queue_items qi ON v.queue_item_id = qi.id
        JOIN voting_rounds vr ON qi.voting_round_id = vr.id
        WHERE v.user_id = ? 
          AND qi.added_by != ? 
          AND (vr.winner_queue_item_id != qi.id OR vr.winner_queue_item_id IS NULL)
      `,
        [userId, userId],
      ),

      // 7+8. Streaks: aufeinanderfolgende erfolgreiche / erfolglose Votes auf fremde Songs
      pool.query(
        `
        WITH foreign_votes AS (
          SELECT 
            v.created_at,
            (vr.winner_queue_item_id = qi.id) AS did_win
          FROM votes v
          JOIN queue_items qi ON v.queue_item_id = qi.id
          LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id
          WHERE v.user_id = ? AND qi.added_by != ?
          ORDER BY v.created_at
        ),
        ranked AS (
          SELECT 
            did_win,
            ROW_NUMBER() OVER (ORDER BY created_at) AS rn,
            ROW_NUMBER() OVER (PARTITION BY did_win ORDER BY created_at) AS grp
          FROM foreign_votes
        ),
        streaks AS (
          SELECT did_win, MAX(rn - grp + 1) AS streak_length
          FROM ranked
          GROUP BY did_win
        )
        SELECT 
          MAX(CASE WHEN did_win = 1 THEN streak_length ELSE 0 END) AS max_winning_streak,
          MAX(CASE WHEN did_win = 0 THEN streak_length ELSE 0 END) AS max_losing_streak
        FROM streaks
      `,
        [userId, userId],
      ),

      // 9. Anzahl Sessions, in denen der User gar nicht gevotet hat
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM sessions s
        WHERE s.user_id = ?
          AND NOT EXISTS (
            SELECT 1 
            FROM votes v 
            JOIN queue_items qi ON v.queue_item_id = qi.id 
            WHERE v.user_id = ? AND qi.session_id = s.id
          )
      `,
        [userId, userId],
      ),

      // 10. Längster Streak von Sessions ohne Vote
      pool.query(
        `
        WITH session_activity AS (
          SELECT 
            s.created_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM votes v
              JOIN queue_items qi ON v.queue_item_id = qi.id
              WHERE v.user_id = ? AND qi.session_id = s.id
            ) THEN 1 ELSE 0 END AS has_voted
          FROM sessions s
          WHERE s.user_id = ?
          ORDER BY s.created_at
        ),
        ranked AS (
          SELECT 
            has_voted,
            ROW_NUMBER() OVER (ORDER BY created_at) AS rn,
            ROW_NUMBER() OVER (PARTITION BY has_voted ORDER BY created_at) AS grp
          FROM session_activity
        )
        SELECT MAX(CASE WHEN has_voted = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_streak
        FROM ranked
      `,
        [userId, userId],
      ),
    ]);

    const stats = {
      votesOnOwnSuggestions: getValue(votesOnOwnSuggestionsRes),
      winsAgainstQueue: getValue(winsAgainstQueueRes),
      maxStreakWinsAgainstQueue: getSingleRowValue(
        maxStreakWinsRes,
        "max_streak",
      ),
      votesOnOwnButLost: getValue(votesOnOwnButLostRes),
      votesOnOthersAndWon: getValue(votesOnOthersAndWonRes),
      votesOnOthersAndLost: getValue(votesOnOthersAndLostRes),
      maxStreakVotesOnWinningOthers: getSingleRowValue(
        streaksForeignVotesRes,
        "max_winning_streak",
      ),
      maxStreakVotesOnLosingOthers: getSingleRowValue(
        streaksForeignVotesRes,
        "max_losing_streak",
      ),
      sessionsWithoutVote: getValue(sessionsWithoutVoteRes),
      maxStreakSessionsWithoutVote: getSingleRowValue(
        maxStreakNoVoteRes,
        "max_streak",
      ),
    };

    res.json(stats);
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res
      .status(500)
      .json({ error: "Interner Serverfehler beim Laden der Statistiken" });
  }
});

// 📊 Listening Summary: Aggregierte Stats, Top-Songs, Top-Artists

router.get("/profile/listening-summary", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  let user;
  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    const [[listeningMinutesRows], [topHeardSongsRows], [topArtistsRows]] =
      await Promise.all([
        pool.query(
          `SELECT
           FLOOR(SUM(listen_seconds) / 60) AS total_minutes,
           COUNT(DISTINCT session_id) AS sessions_count,
           COUNT(*) AS song_listens
         FROM session_song_listens
         WHERE user_id = ?`,
          [userId],
        ),
        pool.query(
          `SELECT
           y.title,
           y.thumbnail,
           SUM(s.listen_seconds) AS total_seconds,
           COUNT(*) AS listens
         FROM session_song_listens s
         JOIN queue_items q ON q.id = s.queue_item_id
         LEFT JOIN youtube_video_cache y ON y.youtube_id = q.video_id
         WHERE s.user_id = ?
         GROUP BY y.title, y.thumbnail
         ORDER BY total_seconds DESC
         LIMIT 10`,
          [userId],
        ),
        pool.query(
          `SELECT
            a.id AS artist_id,
           a.name,
           a.image_url,
           SUM(s.listen_seconds) AS total_seconds
         FROM session_song_listens s
         JOIN queue_items q ON q.id = s.queue_item_id
         JOIN youtube_video_cache y ON y.youtube_id = q.video_id
         JOIN artists a ON a.id = y.artist_id
         WHERE s.user_id = ?
         GROUP BY a.id
         ORDER BY total_seconds DESC
         LIMIT 5`,
          [userId],
        ),
      ]);

    res.json({
      stats: listeningMinutesRows[0] || {
        total_minutes: 0,
        sessions_count: 0,
        song_listens: 0,
      },
      topSongs: topHeardSongsRows,
      topArtists: topArtistsRows,
    });
  } catch (err) {
    console.error("Error fetching listening summary:", err);
    res.status(500).json({ error: "Fehler beim Laden der Hörstatistiken" });
  }
});

// 🕒 Recent Listens: Letzte gehörte Songs

router.get("/profile/recent-listens", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  let user;
  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    const [recentListensRows] = await pool.query(
      `SELECT
         y.title,
         y.thumbnail,
         s.listened_from,
         s.listen_seconds,
         s.completed
       FROM session_song_listens s
       JOIN queue_items q ON q.id = s.queue_item_id
       LEFT JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE s.user_id = ?
       ORDER BY s.listened_from DESC
       LIMIT 20`,
      [userId],
    );

    res.json({ recentListens: recentListensRows });
  } catch (err) {
    console.error("Error fetching recent listens:", err);
    res
      .status(500)
      .json({ error: "Fehler beim Laden der zuletzt gehörten Songs" });
  }
});


async function fetchUserStats(userId) {
  const [
    [topSongs],
    [topCoListeners],
    [sessionCount],
    [liveSessionsCount],
    [activeSessionResult],
    // === Voting-Statistiken ===
    [votesOnOwnSuggestions],
    [winsOfOwnSuggestions],
    [maxWinStreakOwn],
    [ownSuggestionsLost],
    [votesOnOthersWon],
    [votesOnOthersLost],
    [foreignVoteStreaks],
    [sessionsWithoutAnyVote],
    [maxStreakNoVote],
    // === Zusätzliche Metriken ===
    [songsHeardCount],
    [votesOnOwnByOthers],
  ] = await Promise.all([
    // 1. Top 10 Songs (nach Hördauer)
    pool.query(
      `SELECT
         q.video_id,
         MAX(y.title)          AS title,
         MAX(y.thumbnail)      AS thumbnail,
         SUM(l.listen_seconds) AS total_seconds,
         COUNT(*)              AS listen_count
       FROM session_song_listens l
       JOIN queue_items q ON q.id = l.queue_item_id
       JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE l.user_id = ?
       GROUP BY q.video_id
       ORDER BY total_seconds DESC
       LIMIT 10`,
      [userId],
    ),

    // 2. Top 10 Mit-Hörer
    pool.query(
      `SELECT 
         u.id,
         u.username,
         u.imageData,
         u.imageType,
         SUM(l.listen_seconds) AS total_seconds
       FROM session_song_listens l
       JOIN session_song_listens l2 
         ON l.session_id = l2.session_id 
         AND l2.user_id = ? 
         AND l.user_id != l2.user_id
       JOIN users u ON u.id = l.user_id
       GROUP BY u.id
       ORDER BY total_seconds DESC
       LIMIT 10`,
      [userId],
    ),

    // 3. Anzahl eindeutiger Sessions
    pool.query(
      `SELECT COUNT(DISTINCT session_id) AS count 
       FROM session_song_listens 
       WHERE user_id = ?`,
      [userId],
    ),

    // 4. Anzahl aktuell live Sessions (als Host)
    pool.query(
      `SELECT COUNT(*) AS count 
       FROM sessions 
       WHERE user_id = ? AND is_live = 1`,
      [userId],
    ),

    // 5. Aktuelle Session, in der der User gerade ist (als Teilnehmer)
    pool.query(
      `SELECT 
         s.id,
         s.title,
         s.is_private,
         COUNT(sp2.id) AS participant_count
       FROM session_participants sp
       JOIN sessions s ON s.id = sp.session_id
       LEFT JOIN session_participants sp2 
         ON sp2.session_id = s.id AND sp2.is_live = 1
       WHERE sp.user_id = ? 
         AND sp.is_live = 1
         AND s.is_active = 1
       GROUP BY s.id
       LIMIT 1`,
      [userId],
    ),

    // === Voting Stats ===
    pool.query(
      `SELECT COUNT(DISTINCT v.queue_item_id) AS count FROM votes v JOIN queue_items qi ON v.queue_item_id = qi.id WHERE qi.added_by = ?`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count FROM voting_rounds vr JOIN queue_items qi ON vr.winner_queue_item_id = qi.id WHERE qi.added_by = ?`,
      [userId],
    ),

    pool.query(
      `WITH wins AS (
         SELECT vr.started_at
         FROM voting_rounds vr
         JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
         WHERE qi.added_by = ?
         ORDER BY vr.started_at
       )
       SELECT MAX(rn - grp + 1) AS max_streak
       FROM (
         SELECT 
           started_at,
           ROW_NUMBER() OVER (ORDER BY started_at) AS rn,
           ROW_NUMBER() OVER (ORDER BY started_at) AS grp
         FROM wins
       ) ranked`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(DISTINCT qi.id) AS count
       FROM queue_items qi
       JOIN votes v ON v.queue_item_id = qi.id
       LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id AND vr.winner_queue_item_id = qi.id
       WHERE qi.added_by = ? AND vr.winner_queue_item_id IS NULL`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       WHERE v.user_id = ?
         AND qi.added_by != ?
         AND qi.added_by IS NOT NULL
         AND qi.voting_round_id IS NOT NULL
         AND qi.status IN ('queued', 'playing', 'played')`,
      [userId, userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       JOIN voting_rounds vr ON qi.voting_round_id = vr.id
       WHERE v.user_id = ? 
         AND qi.added_by != ? 
         AND (vr.winner_queue_item_id != qi.id OR vr.winner_queue_item_id IS NULL)`,
      [userId, userId],
    ),

    pool.query(
      `WITH foreign_votes AS (
         SELECT 
           v.created_at,
           (vr.winner_queue_item_id = qi.id) AS did_win
         FROM votes v
         JOIN queue_items qi ON v.queue_item_id = qi.id
         LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id
         WHERE v.user_id = ? AND qi.added_by != ?
         ORDER BY v.created_at
       ),
       ranked AS (
         SELECT 
           did_win,
           ROW_NUMBER() OVER (ORDER BY created_at) rn,
           ROW_NUMBER() OVER (PARTITION BY did_win ORDER BY created_at) grp
         FROM foreign_votes
       )
       SELECT 
         MAX(CASE WHEN did_win = 1 THEN (rn - grp + 1) ELSE 0 END) AS max_winning_streak,
         MAX(CASE WHEN did_win = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_losing_streak
       FROM ranked`,
      [userId, userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM sessions s
       WHERE s.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM votes v 
           JOIN queue_items qi ON v.queue_item_id = qi.id 
           WHERE v.user_id = ? AND qi.session_id = s.id
         )`,
      [userId, userId],
    ),

    pool.query(
      `WITH session_activity AS (
         SELECT 
           s.created_at,
           CASE WHEN EXISTS (
             SELECT 1 FROM votes v
             JOIN queue_items qi ON v.queue_item_id = qi.id
             WHERE v.user_id = ? AND qi.session_id = s.id
           ) THEN 1 ELSE 0 END AS has_voted
         FROM sessions s
         WHERE s.user_id = ?
         ORDER BY s.created_at
       ),
       ranked AS (
         SELECT 
           has_voted,
           ROW_NUMBER() OVER (ORDER BY created_at) rn,
           ROW_NUMBER() OVER (PARTITION BY has_voted ORDER BY created_at) grp
         FROM session_activity
       )
       SELECT MAX(CASE WHEN has_voted = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_streak
       FROM ranked`,
      [userId, userId],
    ),

    // Zusätzliche Metriken
    pool.query(
      `SELECT COUNT(DISTINCT queue_item_id) AS count FROM session_song_listens WHERE user_id = ?`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(DISTINCT v.queue_item_id) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       WHERE qi.added_by = ? AND v.user_id != qi.added_by`,
      [userId],
    ),
  ]);

  const normalizedTopCoListeners = topCoListeners.map((u) => ({
    id: u.id,
    username: u.username,
    total_seconds: u.total_seconds,
    image_url: u.imageData
      ? `data:${u.imageType};base64,${u.imageData.toString("base64")}`
      : null,
  }));

  return {
    topSongs,
    topCoListeners: normalizedTopCoListeners,
    sessionCount: getScalar(sessionCount),
    isCurrentlyLiveHost: getScalar(liveSessionsCount) > 0,
    activeSession: activeSessionResult[0]
      ? {
          id: activeSessionResult[0].id,
          is_private: !!activeSessionResult[0].is_private,
          name: activeSessionResult[0].is_private
            ? null
            : activeSessionResult[0].title,
          participant_count: activeSessionResult[0].is_private
            ? null
            : activeSessionResult[0].participant_count,
          join_url: activeSessionResult[0].is_private
            ? null
            : `/session/${activeSessionResult[0].id}`,
        }
      : null,

    stats: {
      totalSongsHeard: getScalar(songsHeardCount),
      votesOnOwnSuggestions: getScalar(votesOnOwnSuggestions),
      votesOnOwnByOthers: getScalar(votesOnOwnByOthers),
      winsOfOwnSuggestions: getScalar(winsOfOwnSuggestions),
      maxWinStreakOwn: getSingleValue(maxWinStreakOwn, "max_streak"),
      ownSuggestionsLost: getScalar(ownSuggestionsLost),
      votesOnOthersAndWon: getScalar(votesOnOthersWon),
      votesOnOthersAndLost: getScalar(votesOnOthersLost),
      maxWinningStreakForeign: getSingleValue(
        foreignVoteStreaks,
        "max_winning_streak",
      ),
      maxLosingStreakForeign: getSingleValue(
        foreignVoteStreaks,
        "max_losing_streak",
      ),
      sessionsWithoutAnyVote: getScalar(sessionsWithoutAnyVote),
      maxStreakNoVote: getSingleValue(maxStreakNoVote, "max_streak"),
    },
  };
}


const upload = multer({
  storage: multer.memoryStorage(), // Wir speichern temporär im RAM, da wir es direkt als Base64 in die DB schreiben
  limits: {
    fileSize: 5 * 1024 * 1024, // Max. 5 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Nur Bilddateien (JPEG, PNG, GIF, WebP) sind erlaubt"));
    }
  },
});

// Der Endpunkt – Authentifizierung manuell, wie in deinem /sessions-Beispiel

router.post("/profile/image", upload.single("profileImage"), async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // 2. Ab hier ist der User authentifiziert → user.id verfügbar
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine Bilddatei hochgeladen" });
    }

    const imageType = req.file.mimetype; // z. B. "image/jpeg"
    const imageData = req.file.buffer; // ← Roh-Bytes, kein Base64!

    // Update in der users-Tabelle
    const query = `
      UPDATE users 
      SET imageType = ?, imageData = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `;

    await pool.query(query, [imageType, imageData, user.id]);
    // ← pool.query, wie in deinem Beispiel (nicht db.query)

    // Rückgabe für das Frontend
    res.json({
      imageType,
      imageData: imageData.toString("base64"),
    });
  } catch (err) {
    console.error("Fehler beim Hochladen des Profilbilds:", err);

    if (err.message === "Nur Bilddateien sind erlaubt") {
      return res.status(400).json({ error: "Nur Bilddateien sind erlaubt" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Bilddatei zu groß (max. 5 MB)" });
    }

    res
      .status(500)
      .json({ error: "Interner Serverfehler beim Speichern des Bildes" });
  }
});


router.get("/profile/artist/:artistId/insights", async (req, res) => {
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

  const userId = user.id;
  const artistId = parseInt(req.params.artistId, 10);

  try {
    const [[artist]] = await pool.query(
      `SELECT id, name, image_url FROM artists WHERE id = ?`,
      [artistId],
    );

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    const [[summary]] = await pool.query(
      `
      SELECT
        SUM(l.listen_seconds)        AS total_seconds,
        COUNT(*)                    AS listen_events,
        COUNT(DISTINCT q.video_id)  AS song_count,
        COUNT(DISTINCT l.session_id) AS session_count,
        SUM(l.completed) / COUNT(*) AS completion_rate
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      `,
      [artistId, userId],
    );

    const [topSongs] = await pool.query(
      `
      SELECT
        q.video_id,
        MAX(y.title)          AS title,
        MAX(y.thumbnail)      AS thumbnail,
        SUM(l.listen_seconds) AS total_seconds,
        COUNT(*)              AS listen_count
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY q.video_id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId, userId],
    );

    const [dailySessionsRaw] = await pool.query(
      `
      SELECT
        DATE(l.listened_from) AS date,
        s.id                  AS session_id,
        s.title               AS session_title,
        s.created_at          AS session_started_at,
        SUM(l.listen_seconds) AS session_seconds
      FROM session_song_listens l
      JOIN sessions s ON s.id = l.session_id
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND l.listened_from >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY DATE(l.listened_from), s.id
      ORDER BY date ASC, s.created_at ASC
      `,
      [artistId, userId],
    );

    const [dailyRaw] = await pool.query(
      `
      SELECT
        DATE(l.listened_from) AS date,
        SUM(l.listen_seconds) AS seconds
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND l.listened_from >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY DATE(l.listened_from)
      ORDER BY date ASC
      `,
      [artistId, userId],
    );

    const daily = dailyRaw.map((d) => ({
      date: d.date,
      seconds: Number(d.seconds) || 0,
    }));

    const maxDailySeconds = daily.length
      ? Math.max(...daily.map((d) => d.seconds))
      : 0;

    const [sessions] = await pool.query(
      `
      SELECT
        s.id                  AS session_id,
        s.title,
        s.created_at          AS started_at,
        SUM(l.listen_seconds) AS total_seconds
      FROM session_song_listens l
      JOIN sessions s ON s.id = l.session_id
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY s.id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId, userId],
    );

    const dailySessionsMap = {};

    dailySessionsRaw.forEach((row) => {
      const date = row.date;
      if (!dailySessionsMap[date]) {
        dailySessionsMap[date] = { date, sessions: [], total_seconds: 0 };
      }

      const seconds = Number(row.session_seconds) || 0;

      dailySessionsMap[date].sessions.push({
        session_id: row.session_id,
        title: row.session_title,
        started_at: row.session_started_at,
        seconds,
        minutes: Math.floor(seconds / 60),
      });

      dailySessionsMap[date].total_seconds += seconds;
    });

    const dailySessions = Object.values(dailySessionsMap).sort(
      (a, b) => new Date(a.date) - new Date(b.date),
    );

    res.json({
      artist,
      total_minutes: Math.floor((summary.total_seconds || 0) / 60),
      song_count: summary.song_count || 0,
      session_count: summary.session_count || 0,
      avg_minutes_per_song: Math.floor(
        (summary.total_seconds || 0) /
          Math.max(summary.song_count || 1, 1) /
          60,
      ),
      completion_rate: summary.completion_rate,
      top_songs: topSongs,
      daily_listens: daily,
      max_daily_seconds: maxDailySeconds,
      sessions,
      daily_sessions: dailySessions,
    });
  } catch (err) {
    console.error("Artist insights failed:", err);
    res.status(500).json({ error: "Failed to load artist insights" });
  }
});


router.delete("/profile/image", async (req, res) => {
  // gleiche Authentifizierung wie bei /profile/image
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  await pool.query(
    "UPDATE users SET imageType = NULL, imageData = NULL WHERE id = ?",
    [user.id],
  );
  res.json({ imageType: null, imageData: null });
});

// Irgendwo zentral, z. B. in deiner socket.io oder utils Datei
// Direkt nach der io-Definition (z. B. nach const io = new Server(...))


module.exports = router;
