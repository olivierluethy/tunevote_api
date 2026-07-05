const express = require("express");
const axios = require("axios");
const ytdl = require("@distube/ytdl-core");
const pool = require("../db");
const { getIO } = require("../lib/io");
const {
  getUserFromToken,
  getGuestFromToken,
  ensureParticipant,
  hasActiveSubscription,
} = require("../services/auth");
const transporter = require("../services/mailer");
const { openai, safeParseOpenAI } = require("../services/openai");
const { broadcastTodayTopArtists } = require("../services/broadcast");
const {
  sessionTimers,
  startPhaseTimer,
  advanceToNext,
  broadcastLiveParticipants,
  broadcastParticipantCount,
  createNewPublicSession,
} = require("../services/playback");
const { normalize, parseIsoDuration } = require("../utils/helpers");

const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const router = express.Router();

router.get("/sessions/:id/playback-sync", async (req, res) => {
  const { id } = req.params;

  try {
    // Derived from the single source of truth: the queue_items row that is
    // 'playing' (video_id + startedAt). No separate playback_sync table.
    const [rows] = await pool.query(
      `SELECT qi.video_id                          AS current_video_id,
              COALESCE(qi.started_at_ms, UNIX_TIMESTAMP(qi.startedAt) * 1000) AS video_start_time,
              (s.status = 'live' AND qi.item_type = 'music') AS is_playing
         FROM sessions s
         JOIN queue_items qi
           ON qi.session_id = s.id AND qi.status = 'playing'
        WHERE s.id = ?`,
      [id],
    );
    // server_time lets the client estimate its clock offset vs the server (the
    // start time and "now" are both on the server clock), so every device
    // converges to the same playback position regardless of its local clock.
    res.json({ ...(rows[0] || {}), server_time: Date.now() });
  } catch (err) {
    console.error("Playback sync error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/sessions", async (req, res) => {
  let user = null;
  let isGuest = false;

  // 1. Bearer Token (eingeloggter User)
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (token) {
    try {
      user = await getUserFromToken(token); // { id, username, ... } (email kann fehlen!)
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  // 2. Gast-Token
  const guestToken = req.headers["x-guest-token"];
  if (!user && guestToken) {
    try {
      const [rows] = await pool.query(
        "SELECT id, nickname FROM guest_users WHERE guest_token = ?",
        [guestToken],
      );
      if (rows.length > 0) {
        isGuest = true;
        user = { id: null, isGuest: true, nickname: rows[0].nickname };
      }
    } catch (err) {
      console.error("Guest token error:", err);
    }
  }

  // 3. Kein Zugriff ohne Auth
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    let rows;

    // ——————————————————————————————
    // Gast → nur öffentliche Sessions
    // ——————————————————————————————
    if (isGuest || !user.id) {
      [rows] = await pool.query(`
        SELECT 
          s.id,
          s.title,
          s.created_at,
          s.user_id AS hostId,
          u.username AS host,
          s.is_live,
          s.status,
          s.is_private,
          (
            SELECT COUNT(*)
            FROM session_participants sp
            WHERE sp.session_id = s.id AND sp.is_live = 1
          ) AS participant_count
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.is_private = 0
        ORDER BY participant_count DESC, s.created_at DESC
      `);
      return res.json(rows);
    }

    // ——————————————————————————————
    // Eingeloggter User → öffentlich + eigene + akzeptierte private Einladungen
    // ——————————————————————————————
    const userId = user.id;

    // E-Mail sicher aus der DB holen (auch wenn sie im JWT fehlt)
    const [[{ email: userEmail }]] = await pool.query(
      "SELECT email FROM users WHERE id = ?",
      [userId],
    );

    if (!userEmail) {
      // Sollte nie passieren, aber zur Sicherheit: nur öffentliche + eigene Sessions
      [rows] = await pool.query(
        `
        SELECT 
          s.id, s.title, s.created_at, s.user_id AS hostId, u.username AS host,
          s.is_live, s.status, s.is_private,
          (
            SELECT COUNT(*) FROM session_participants sp
            WHERE sp.session_id = s.id AND sp.is_live = 1
          ) AS participant_count
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.is_private = 0 OR s.user_id = ?
        ORDER BY participant_count DESC, s.created_at DESC
      `,
        [userId],
      );
      return res.json(rows);
    }

    // Hauptquery: alles in einem Rutsch
    [rows] = await pool.query(
      `
      SELECT DISTINCT
        s.id,
        s.title,
        s.created_at,
        s.user_id AS hostId,
        u.username AS host,
        s.is_live,
        s.status,
        s.is_private,
        (
          SELECT COUNT(*)
          FROM session_participants sp
          WHERE sp.session_id = s.id AND sp.is_live = 1
        ) AS participant_count
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN session_invites si 
        ON si.session_id = s.id 
       AND si.email = ?
       AND si.accepted_at IS NOT NULL                 -- WICHTIG: nur akzeptierte!
       AND si.status != 'revoked'
      WHERE 
        s.is_private = 0                               -- öffentlich
        OR s.user_id = ?                                -- eigener Host
        OR si.id IS NOT NULL                            -- akzeptierte Einladung
      ORDER BY participant_count DESC, s.created_at DESC
    `,
      [userEmail, userId],
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get sessions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// === Sessions erstellen ===

router.post("/sessions", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { title, is_private } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: "Title required" });

  const privateFlag = is_private ? 1 : 0;

  // Paywall: private sessions require an active $5/month subscription.
  // Public sessions remain free.
  if (privateFlag === 1) {
    const entitled = await hasActiveSubscription(user.id);
    if (!entitled) {
      return res.status(402).json({
        error: "subscription_required",
        message:
          "A $5/month subscription is required to create private sessions.",
      });
    }
  }

  try {
    const [result] = await pool.query(
      "INSERT INTO sessions (user_id, title, is_private) VALUES (?, ?, ?)",
      [user.id, title.trim(), privateFlag],
    );

    console.log("🟢 Session insert result:", result);

    const sessionId = result.insertId;
    console.log("✅ New session created:", sessionId);

    await ensureParticipant(sessionId, user, null, true);

    // Return the SAME row shape as GET /sessions so the client can insert the
    // new session optimistically with a complete object. Notably this includes
    // `hostId` (s.user_id) — without it the dashboard's isHost check fails and
    // the delete/host actions don't appear until a reload refetches the list.
    const [newSession] = await pool.query(
      `SELECT
         s.id,
         s.title,
         s.created_at,
         s.user_id AS hostId,
         u.username AS host,
         s.is_live,
         s.status,
         s.is_private,
         (
           SELECT COUNT(*)
           FROM session_participants sp
           WHERE sp.session_id = s.id AND sp.is_live = 1
         ) AS participant_count
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ?`,
      [sessionId],
    );

    res.status(201).json(newSession[0]);
  } catch (err) {
    console.error("❌ Error creating session:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// Wenn Benutzer ohne guest user & ohne account -> hier soll nach einer Session gesucht werden die Live ist, und danach sollte diese URL bereitgestellt und über das JSON verschickt werden wodurch man sich in der Live Session befindet.
// === Auto-Join für nicht eingeloggte Benutzer ===

router.get("/join", async (req, res) => {
  try {
    // 1. Authentifizierung prüfen – nur komplett unauthentifizierte erlauben
    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    if (user || guest) {
      return res.status(400).json({
        error: "Already authenticated – bitte /sessions verwenden",
      });
    }

    // ─────────────────────────────────────────────
    // Wichtigster Teil: Name aus Query-Parameter
    // ─────────────────────────────────────────────
    const requestedTitle = req.query.name || req.query.title; // z. B. ?name=Midnight Neon Drive 🌌
    const useCustomName = !!requestedTitle && requestedTitle.trim().length > 0;

    const DEFAULT_TITLE = "TuneVote Radio – Live for everyone";

    let sessionId;
    let autoStarted = false;

    // Fall 1: Expliziter Name → immer neue Session erstellen
    if (useCustomName) {
      sessionId = await createNewPublicSession(requestedTitle.trim());
      autoStarted = true;
    }
    // Fall 2: Kein Name → wie bisher: älteste live Session nehmen oder Standard-Session erstellen
    else {
      // Älteste öffentliche live Session suchen
      const [existing] = await pool.query(`
        SELECT id
        FROM sessions
        WHERE is_private = 0 AND status = 'live'
        ORDER BY created_at ASC
        LIMIT 1
      `);

      if (existing.length > 0) {
        sessionId = existing[0].id;
      } else {
        sessionId = await createNewPublicSession(DEFAULT_TITLE);
        autoStarted = true;
      }
    }

    // 3. Redirect zum Frontend
    res.json({
      redirect: `https://app.tunevote.com/session/${sessionId}`,
    });

    // ─────────────────────────────────────────────
    // Auto-Start nur bei neu erstellter Session
    // ─────────────────────────────────────────────
    if (autoStarted) {
      setTimeout(async () => {
        try {
          await axios.post(`https://api.tunevote.com/sessions/${sessionId}/start`);
          console.log(`[AUTO] Session ${sessionId} gestartet (Titel: ${requestedTitle || DEFAULT_TITLE})`);
        } catch (err) {
          console.error("[AUTO] Start fehlgeschlagen:", err.response?.data || err.message);
        }
      }, 800);
    }

  } catch (err) {
    console.error("Fehler in /join:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});


// GET /sessions/:id/current-voting-phase

router.get("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query(
    "SELECT s.*, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?",
    [id],
  );
  if (!sess[0]) return res.status(404).json({ error: "Not found" });

  res.json({ ...sess[0], hostId: sess[0].user_id, is_live: !!sess[0].is_live });
});

// === PATCH: Session-Namen ändern (nur Host!) ===

router.patch("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  // Authentifizierung
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Nur angemeldete User (keine Gäste!) dürfen Session-Namen ändern
  if (!user) {
    return res
      .status(403)
      .json({ error: "Gäste dürfen den Session-Namen nicht ändern" });
  }

  // Validierung
  if (
    !title ||
    typeof title !== "string" ||
    title.trim().length < 1 ||
    title.trim().length > 100
  ) {
    return res.status(400).json({ error: "Ungültiger Name (1–100 Zeichen)" });
  }

  const cleanTitle = title.trim();

  try {
    // Prüfen, ob Session existiert und der User der Host ist
    const [rows] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Session nicht gefunden" });
    }

    if (rows[0].user_id !== user.id) {
      return res
        .status(403)
        .json({ error: "Nur der Host darf den Namen ändern" });
    }

    // Update durchführen
    await pool.query("UPDATE sessions SET title = ? WHERE id = ?", [
      cleanTitle,
      id,
    ]);

    // Broadcast so every viewer (dashboard cards + inside the session) sees the
    // new name within a second, instead of waiting for the next poll cycle.
    getIO().emit("session_renamed", {
      sessionId: parseInt(id, 10),
      title: cleanTitle,
    });

    res.json({ success: true, title: cleanTitle });
  } catch (err) {
    console.error("Fehler beim Umbenennen der Session:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// === Queue endpoints ===

router.get("/sessions/:id/queue", async (req, res) => {
  const { id } = req.params;

  const [queue] = await pool.query(
    `
    SELECT
      qi.id,
      qi.session_id,
      qi.video_id,
      qi.added_by,
      qi.guest_id,
      qi.status,
      qi.created_at,
      qi.playedAt,
      qi.startedAt,
      qi.pause_duration_seconds,
      qi.description,
      qi.item_type,
      qi.item_source,
      qi.voting_round_id,
      qi.item_type AS itemType,
      COALESCE(yvc.title, qi.description)               AS title,
      yvc.thumbnail                                     AS thumbnail,
      COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
      COALESCE(u.username, g.nickname, 'Gast')          AS addedBy
    FROM queue_items qi
    LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
    LEFT JOIN users u ON qi.added_by = u.id
    LEFT JOIN guest_users g ON qi.guest_id = g.id
    WHERE qi.session_id = ?
      AND (qi.status IS NULL OR qi.status NOT IN ('suggested', 'archived'))
    ORDER BY qi.id ASC
    `,
    [id],
  );

  res.json(queue);
});

// ---------------------------------------------------------------
// UPDATED ENDPOINT – GET RECOMMENDATIONS (AI + YouTube Search + Memory + Levenshtein)
// ---------------------------------------------------------------

router.post("/sessions/:id/queue/add", async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query(
    "SELECT user_id, status FROM sessions WHERE id = ?",
    [id],
  );
  if (sess[0].status === "live")
    return res.status(403).json({ error: "Session started" });

  try {
    if (!YOUTUBE_KEY) throw new Error("YouTube API key missing");
    const ytRes = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "contentDetails",
          id: videoId,
          key: YOUTUBE_KEY,
        },
      },
    );
    const durationIso = ytRes.data.items[0]?.contentDetails.duration;
    const duration = parseIsoDuration(durationIso);

    // Ensure the cache row exists before inserting into queue_items —
    // queue_items.video_id is now an FK to youtube_video_cache.youtube_id.
    await pool.query(
      `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         title_norm = VALUES(title_norm),
         thumbnail = COALESCE(VALUES(thumbnail), thumbnail),
         duration = COALESCE(VALUES(duration), duration)`,
      [videoId, title, normalize(title), thumbnail, duration],
    );

    await pool.query(
      "INSERT INTO queue_items (session_id, video_id, added_by, status, item_type) VALUES (?, ?, ?, 'queued', 'music')",
      [id, videoId, user.id],
    );

    getIO().to(id).emit("queue_updated", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Queue add error:", err);
    res.status(500).json({ error: "Failed to add to queue" });
  }
});

// === Session löschen (nur Host) ===

router.delete("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = await getUserFromToken(token);

  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Prüfen, ob die Session existiert und der Benutzer der Host ist
    const [session] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );
    if (!session[0])
      return res.status(404).json({ error: "Session not found" });
    if (session[0].user_id !== user.id) {
      return res
        .status(403)
        .json({ error: "Only the host can delete the session" });
    }

    // Session löschen (ON DELETE CASCADE kümmert sich um zugehörige Einträge)
    await pool.query("DELETE FROM sessions WHERE id = ?", [id]);

    // Timer für die Session stoppen, falls vorhanden
    if (sessionTimers[id]) {
      clearTimeout(sessionTimers[id]);
      delete sessionTimers[id];
    }

    // Alle Teilnehmer via Socket.IO benachrichtigen
    getIO().to(id).emit("session_deleted", {
      message: "Die Session wurde vom Host gelöscht.",
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Delete session error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Start session (host) ===

router.post("/sessions/:id/start", async (req, res) => {
  const { id } = req.params;

  const [[sess]] = await pool.query(
    "SELECT status FROM sessions WHERE id = ?",
    [id],
  );
  if (!sess) return res.status(404).json({ error: "Session not found" });
  if (sess.status === "live") {
    return res.status(400).json({ error: "Session already live" });
  }

  // Alle bisherigen "suggested" Vorschläge in die Queue übernehmen
  await pool.query(
    `
    UPDATE queue_items 
    SET status = 'queued', voting_round_id = NULL 
    WHERE session_id = ? AND status = 'suggested'
  `,
    [id],
  );

  // 🚀 Session live setzen
  await pool.query(
    "UPDATE sessions SET is_live = 1, status = 'live' WHERE id = ?",
    [id],
  );

  // 🎵 Prüfen, ob Songs in der Queue sind → sofort abspielen
  const [first] = await pool.query(
    `SELECT qi.id, qi.video_id,
            COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
            COALESCE(yvc.title, qi.description)               AS title
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      WHERE qi.session_id = ? AND qi.status = 'queued'
      ORDER BY qi.id ASC LIMIT 1`,
    [id],
  );

  let firstSongStarted = false;
  if (first[0]) {
    const firstId = first[0].id;
    const firstVideoId = first[0].video_id;
    const duration = first[0].duration || 180;
    const startTime = Date.now();

    // 🕒 Ersten Song auf "playing" setzen (startedAt = single source of truth)
    await pool.query(
      `UPDATE queue_items SET status = 'playing', startedAt = NOW(), started_at_ms = ? WHERE id = ?`,
      [startTime, firstId],
    );

    // Durable deadline so the reconciler can advance/recover the first song too.
    await pool.query(
      `UPDATE sessions SET current_plays_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?`,
      [Math.max(1, Math.floor(duration)), id],
    );

    console.log(
      `[Playback] Session ${id} STARTED with first song: videoId=${firstVideoId} – "${first[0].title}"`,
    );

    getIO().to(id).emit("session_started", {
      autoStarted: true,
      firstVideoId,
      video_start_time: startTime,
      server_time: startTime,
    });

    getIO().to(id).emit("playback_sync", {
      current_queue_item_id: firstId,
      current_video_id: firstVideoId,
      current_title: first[0].title,
      video_start_time: startTime,
      server_time: startTime,
      is_playing: true,
    });

    if (sessionTimers[id]) clearTimeout(sessionTimers[id]);
    sessionTimers[id] = setTimeout(
      () => advanceToNext(id, firstId),
      duration * 1000,
    );

    firstSongStarted = true;
  } else {
    getIO().to(id).emit("queue_empty");
    console.log(`[Session ${id}] Gestartet – aber Queue ist leer`);
  }

  // ===============================================
  // Erste Voting-Runde mit Phasen starten
  // ===============================================
  const suggestionDuration = 90; // Sekunden
  const votingDuration = 60; // Sekunden
  const suggestionEndsAt = new Date(Date.now() + suggestionDuration * 1000);

  const [roundResult] = await pool.query(
    `INSERT INTO voting_rounds
      (session_id, state, phase_ends_at, suggestion_duration, voting_duration)
     VALUES (?, 'suggesting', ?, ?, ?)`,
    [id, suggestionEndsAt, suggestionDuration, votingDuration],
  );

  const votingRoundId = roundResult.insertId;

  startPhaseTimer(id, votingRoundId, "suggestion", suggestionDuration);

  getIO().to(id).emit("voting_phase_changed", {
    phase: "suggestion",
    endsAt: suggestionEndsAt.getTime(),
    roundId: votingRoundId,
    duration: suggestionDuration,
  });

  getIO().to(id).emit("proposals_updated");
  getIO().to(id).emit("queue_updated");

  console.log(
    `[Session ${id}] Radio gestartet! Erste Voting-Runde #${votingRoundId} (Vorschläge: ${suggestionDuration}s, Voting: ${votingDuration}s)`,
  );

  res.json({
    success: true,
    firstSongStarted,
    votingRoundStarted: true,
    votingRoundId,
  });
});

// === Join Live ===

router.post("/sessions/:id/join-live", async (req, res) => {
  try {
    const { id } = req.params;

    console.log("📥 [JOIN-LIVE] Incoming request:", {
      sessionId: id,
      headersAuth: req.headers.authorization,
      headersGuest: req.headers["x-guest-token"],
      ip: req.ip,
      cookies: req.headers.cookie,
      body: req.body,
    });

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];

    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    console.log("🔍 [JOIN-LIVE] Decoded tokens:", {
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      guest: guest ? { id: guest.id, tempName: guest.tempName } : null,
    });

    if (!user && !guest) {
      console.warn(
        "❌ [JOIN-LIVE] Unauthorized — no valid token or guest token",
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [sess] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );

    if (!sess[0]) {
      console.warn("⚠️ [JOIN-LIVE] Session not found in DB:", id);
      return res.status(404).json({ error: "Session not found" });
    }

    const column = user ? "user_id" : "guest_id";
    const participantId = user ? user.id : guest.id;
    const role = user
      ? sess[0].user_id === user.id
        ? "host"
        : "user"
      : "guest";

    console.log("👤 [JOIN-LIVE] Participant info:", {
      sessionId: id,
      participantId,
      type: user ? "user" : "guest",
      role,
      sessionOwnerId: sess[0].user_id,
    });

    // === Check existing participant ===
    const [existing] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [parseInt(id, 10), parseInt(participantId, 10)],
    );

    if (existing.length > 0) {
      console.log(
        "♻️ [JOIN-LIVE] Participant already exists. Reactivating is_live=1",
        existing[0],
      );
      await pool.query(
        `
  UPDATE session_participants 
  SET 
    is_live = 1,
    role = ?,
    left_at = NULL
  WHERE session_id = ? AND ${column} = ?
  `,
        [role, id, participantId],
      );
    } else {
      console.log(
        "🆕 [JOIN-LIVE] Participant not found in DB. Inserting new record.",
      );
      await pool.query(
        `
  INSERT INTO session_participants 
    (session_id, ${column}, role, is_live, joined_at)
  VALUES (?, ?, ?, 1, NOW())
  `,
        [id, participantId, role],
      );
    }

    // === Final DB check ===
    const [check] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [parseInt(id, 10), parseInt(participantId, 10)],
    );

    console.log("📝 [JOIN-LIVE] DB state after join:", check);

    console.log("✅ [JOIN-LIVE] Join successful for participant:", {
      sessionId: parseInt(id, 10),
      participantId: parseInt(participantId, 10),
      role,
    });

    await broadcastLiveParticipants(parseInt(id, 10));
    await broadcastParticipantCount(parseInt(id, 10));

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [JOIN-LIVE] Error occurred:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === Leave Live ===

router.post("/sessions/:id/leave-live", async (req, res) => {
  try {
    const sessionIdInt = parseInt(req.params.id, 10);

    console.log("📤 [LEAVE-LIVE] Incoming request:", {
      sessionId: sessionIdInt,
      headersAuth: req.headers.authorization,
      headersGuest: req.headers["x-guest-token"],
      ip: req.ip,
      cookies: req.headers.cookie,
      body: req.body,
    });

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    console.log("🔍 [LEAVE-LIVE] Decoded tokens:", {
      user: user ? { id: user.id, name: user.name } : null,
      guest: guest ? { id: guest.id, tempName: guest.tempName } : null,
    });

    if (!user && !guest) {
      console.warn(
        "❌ [LEAVE-LIVE] Unauthorized — no valid token or guest token",
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    const column = user ? "user_id" : "guest_id";
    const participantIdInt = parseInt(user ? user.id : guest.id, 10);

    console.log("👤 [LEAVE-LIVE] Participant leaving:", {
      sessionId: sessionIdInt,
      participantId: participantIdInt,
      type: user ? "user" : "guest",
    });

    const [beforeUpdate] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    console.log("📝 [LEAVE-LIVE] DB state before leaving:", beforeUpdate);

    await pool.query(
      `UPDATE session_participants SET left_at = NOW(), is_live = 0 WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    const [afterUpdate] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    console.log("📝 [LEAVE-LIVE] DB state after leaving:", afterUpdate);

    getIO().to(sessionIdInt).emit("participant_left", {
      participantId: participantIdInt,
      isGuest: !!guest,
    });

    console.log(
      "✅ [LEAVE-LIVE] Participant left successfully, event emitted.",
    );

    await broadcastLiveParticipants(sessionIdInt);
    await broadcastParticipantCount(sessionIdInt);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ [LEAVE-LIVE] Error occurred:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Live stream endpoint (HOOK) ===

router.get("/sessions/:id/live/stream", async (req, res) => {
  res.status(501).json({
    error:
      "Live streaming not implemented on backend. Integrate WebRTC/mediasoup or an audio streaming server.",
  });
});

// POST /forgot-password

module.exports = router;
