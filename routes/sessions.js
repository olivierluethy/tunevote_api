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
  createNewPublicSession,
} = require("../services/playback");
const { normalize, parseIsoDuration } = require("../utils/helpers");

const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const router = express.Router();

router.get("/sessions/:id/playback-sync", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT current_video_id, video_start_time, is_playing FROM playback_sync WHERE session_id = ?",
      [id],
    );
    res.json(rows[0] || {});
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
          s.is_live, s.is_private,
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

    const [newSession] = await pool.query(
      "SELECT s.id, s.title, s.is_private, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?",
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
        WHERE is_private = 0 AND is_live = 1
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
router.get("/sessions/:id/current-voting-phase", async (req, res) => {
  const sessionId = parseInt(req.params.id);

  try {
    const [[round]] = await pool.query(`
      SELECT 
        id AS roundId,
        phase,
        UNIX_TIMESTAMP(phase_ends_at) * 1000 AS endsAtMs,
        CASE 
          WHEN phase = 'suggestion' THEN suggestion_duration 
          WHEN phase = 'voting' THEN voting_duration 
          ELSE 90 
        END AS durationSeconds
      FROM voting_rounds
      WHERE session_id = ?
        AND status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `, [sessionId]);

    if (!round) {
      return res.json({ phase: null, endsAt: null, duration: 0, roundId: null });
    }

    res.json({
      phase: round.phase,
      endsAt: round.endsAtMs,
      duration: round.durationSeconds,
      roundId: round.roundId
    });
  } catch (err) {
    console.error("Current phase fetch error:", err);
    res.status(500).json({ error: "Failed to get current phase" });
  }
});

// === Get session (includes is_live) ===
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
router.get("/sessions/:id/recommendations", async (req, res) => {
  const { id } = req.params;

  // ---- Auth ----
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  console.log("[Recommendations AUTH DEBUG] Eingehender guestToken:", guestToken);

  let user = null;
  let guest = null;

  if (token) {
    user = await getUserFromToken(token);
    console.log("[Recommendations AUTH] User-Token erkannt → user:", user ? user.id : "null");
  } else if (guestToken) {
    guest = await getGuestFromToken(guestToken);
    console.log("[Recommendations AUTH] Guest-Token erkannt → guest:", guest ? guest.id : "null");
  }

  if (!user && !guest) {
    console.warn("[Recommendations AUTH] Unauthorized – weder User noch Guest gefunden");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[Recommendations AUTH] Headers:", req.headers);
  console.log("[Recommendations AUTH] x-guest-token raw:", req.headers["x-guest-token"]);
  console.log("[Recommendations AUTH] Nach trim:", req.headers["x-guest-token"]?.trim());
  console.log("[Recommendations BLUFF AUTH] x-guest-token raw:", guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // ---- Session check ----
  const [sessionRows] = await pool.query(
    "SELECT is_live FROM sessions WHERE id = ? AND is_active = 1",
    [id],
  );
  if (!sessionRows[0]?.is_live)
    return res.status(400).json({ error: "Session not live" });

  // ---- Aktuelle Queue holen ----
  const [queueRows] = await pool.query(
    `
    SELECT yvc.title
    FROM queue_items qi
    JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
    WHERE qi.session_id = ?
      AND qi.item_type = 'music'
      AND qi.status IN ('queued','playing')
    ORDER BY qi.id DESC
    `,
    [id],
  );

  const titles = queueRows.map((r) => r.title);

  // ---- Voting-Round & AI Suggestion Check ----
  const [votingRoundRows] = await pool.query(
    `SELECT id FROM voting_rounds 
     WHERE session_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [id],
  );

  const currentRoundId = votingRoundRows[0]?.id;
  if (!currentRoundId) {
    console.log("[AI] No active voting round for session", id);
    return res.status(400).json({ error: "No active voting round" });
  }

  const [suggestedRows] = await pool.query(
    `SELECT COUNT(*) as count 
     FROM queue_items 
     WHERE voting_round_id = ? AND status = 'suggested'`,
    [currentRoundId],
  );

  const numItems = suggestedRows[0].count;

  // === 1. Alle aktuellen KI-Vorschläge laden ===
  let existingAi = await pool.query(
    `SELECT qi.id, yvc.title, qi.video_id AS youtubeId, yvc.thumbnail
     FROM queue_items qi
     LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
     WHERE qi.session_id = ?
       AND qi.voting_round_id = ?
       AND qi.item_source = 'ai'
       AND qi.status = 'suggested'
     ORDER BY qi.id ASC`,
    [id, currentRoundId],
  );
  existingAi = existingAi[0]; // [[rows], fields] → nur rows

  console.log(
    `[AI] Runde ${currentRoundId}: Gefunden ${existingAi.length} bestehende AI-Vorschläge`
  );

  // === 2. Falls mehr als 3 KI-Vorschläge existieren → überschüssige löschen ===
  if (existingAi.length > 3) {
    const toDelete = existingAi.slice(3).map((item) => item.id);
    await pool.query(
      `DELETE FROM queue_items WHERE id IN (?) AND item_source = 'ai'`,
      [toDelete],
    );
    console.log(
      `[AI] Cleaned up ${toDelete.length} excess AI suggestions → keeping only the oldest 3`
    );

    // Nach dem Löschen neu laden
    const [cleaned] = await pool.query(
      `SELECT qi.id, yvc.title, qi.video_id AS youtubeId, yvc.thumbnail
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
       WHERE qi.session_id = ? AND qi.voting_round_id = ? AND qi.item_source = 'ai' AND qi.status = 'suggested'
       ORDER BY qi.id ASC`,
      [id, currentRoundId],
    );
    existingAi = cleaned;
  }

  // === 3. Genau auf 3 KI-Vorschläge bringen ===
  const currentCount = existingAi.length;
  const needed = 3 - currentCount;

  let finalAiSuggestions = [...existingAi];

  try {
    if (needed > 0) {
      console.log(
        `[AI] ${numItems} total suggested items. Generating ${needed} new AI suggestion(s) to reach exactly 3...`
      );

      // ---- Get suggested titles to avoid duplicates ----
      const [suggestedTitleRows] = await pool.query(
        `
        SELECT yvc.title
        FROM queue_items qi
        JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
        WHERE qi.voting_round_id = ? AND qi.status = 'suggested'
        `,
        [currentRoundId],
      );

      const allTitles = [...titles, ...suggestedTitleRows.map((r) => r.title)];

      // ---- Prompt für AI ----
      const prompt = `
You are a music recommendation engine. Your job is to suggest popular songs that likely exist on YouTube.

RULES (MUST FOLLOW EXACTLY):
1. Output songs in this format: "Artist - Song Title"
2. NEVER include "(feat. ...)", "[Official...]", "(Official...)", "Remix", "Live", "Lyric Video"
3. Use only the MAIN ARTIST and SONG TITLE
4. The song MUST have an official YouTube music video
5. NEVER suggest any song that is already in the Current Queue

Examples of CORRECT format:
- "Dua Lipa - Levitating"
- "Beyoncé - Halo"
- "Khalid - Better"

Examples of WRONG format:
- "Dua Lipa - Levitating (feat. DaBaby) [Official Music Video]"
- "Beyoncé - Halo (Official Video)"

Current queue: ${JSON.stringify(allTitles)}

Instructions:
- Recommend ${needed} completely new songs NOT in the Current Queue.
- Output ONLY songs in the EXACT format above.
- Output ONLY JSON array:
[{"title": "Artist - Song Title"}]
`;

      // ---- Helper: normalize ----
      const normalize = (str) =>
        str
          .toLowerCase()
          .replace(/\(.*\)|\[.*\]/g, "")
          .replace(/\b(ft\.?|feat\.?|featuring)\b.*$/gi, "")
          .replace(
            /official|video|audio|lyric|visualizer|live|remix|explicit|clean|mv|music video/gi,
            "",
          )
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      // ---- Helper: Levenshtein ----
      const levenshteinDistance = (s1, s2) => {
        const track = Array(s2.length + 1)
          .fill(null)
          .map(() => Array(s1.length + 1).fill(null));
        for (let i = 0; i <= s1.length; i++) track[0][i] = i;
        for (let j = 0; j <= s2.length; j++) track[j][0] = j;
        for (let j = 1; j <= s2.length; j++) {
          for (let i = 1; i <= s1.length; i++) {
            const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
              track[j][i - 1] + 1,
              track[j - 1][i] + 1,
              track[j - 1][i - 1] + indicator,
            );
          }
        }
        return track[s2.length][s1.length];
      };

      const levenshteinRatio = (s1, s2) => {
        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;
        if (longer.length === 0) return 100;
        return Math.round(
          ((longer.length - levenshteinDistance(longer, shorter)) / longer.length) *
            100,
        );
      };

      console.log("[OpenAI] Requesting recommendations for session:", id);
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 400,
      });

      const raw = completion.choices?.[0]?.message?.content || "";

      let aiSuggestions = [];
      try {
        const cleaned = raw.replace(/```json|```/g, "").trim();
        aiSuggestions = JSON.parse(cleaned);
      } catch (e) {
        console.warn("[OpenAI] Failed to parse JSON:", raw);
      }
      if (!Array.isArray(aiSuggestions)) aiSuggestions = [];
      aiSuggestions = aiSuggestions.filter(
        (s) => s?.title && typeof s.title === "string",
      );

      const normalizedQueue = allTitles.map((t) => normalize(t));

      aiSuggestions = aiSuggestions.filter((s) => {
        const norm = normalize(s.title);
        const isDuplicate = normalizedQueue.some(
          (q) => levenshteinRatio(q, norm) > 90,
        );
        if (isDuplicate)
          console.log(`[Duplicate skipped] "${s.title}" already in queue`);
        return !isDuplicate;
      });

      const results = [];

      for (const s of aiSuggestions) {
        const normalizedAI = normalize(s.title);

        const [rows] = await pool.query(`SELECT * FROM youtube_video_cache`);
        let bestMatch = null;
        let bestScore = 0;

        for (const row of rows) {
          const normalizedCache = normalize(row.title_norm);
          const score = levenshteinRatio(normalizedAI, normalizedCache);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = row;
          }
        }

        if (bestMatch && bestScore > 80) {
          let durationSeconds = bestMatch.duration;
          if (durationSeconds === null) {
            try {
              const ytDetails = await axios.get(
                "https://www.googleapis.com/youtube/v3/videos",
                {
                  params: {
                    part: "contentDetails",
                    id: bestMatch.youtube_id,
                    key: YOUTUBE_KEY,
                  },
                },
              );

              const durIso = ytDetails.data.items?.[0]?.contentDetails?.duration;
              if (durIso) {
                const match = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
                const mins = parseInt(match?.[1] ?? 0, 10);
                const secs = parseInt(match?.[2] ?? 0, 10);
                durationSeconds = mins * 60 + secs;
                await pool.query(
                  `UPDATE youtube_video_cache SET duration = ? WHERE youtube_id = ?`,
                  [durationSeconds, bestMatch.youtube_id],
                );
              }
            } catch (err) {
              console.warn(
                "[YouTube] Failed to fetch duration from cache match:",
                err.message,
              );
            }
          }
          results.push({
            title: bestMatch.title,
            youtubeId: bestMatch.youtube_id,
            thumbnail: bestMatch.thumbnail || "",
            duration: durationSeconds,
          });
          if (results.length >= needed) break;
          continue;
        }

        try {
          const searchQuery = `${s.title
            .replace(/\(feat.*\)/gi, "")
            .replace(/\[feat.*\]/gi, "")
            .trim()} official music video`;
          const ytRes = await axios.get(
            "https://www.googleapis.com/youtube/v3/search",
            {
              params: {
                part: "snippet",
                q: searchQuery,
                type: "video",
                maxResults: 5,
                key: YOUTUBE_KEY,
              },
            },
          );

          const items = ytRes.data.items || [];
          if (items.length === 0) continue;

          let bestYtMatch = null;
          let bestYtScore = 0;
          for (const item of items) {
            const titleNorm = normalize(item.snippet.title);
            const score = levenshteinRatio(normalizedAI, titleNorm);
            if (score > bestYtScore) {
              bestYtScore = score;
              bestYtMatch = item;
            }
          }

          if (!bestYtMatch || bestYtScore < 80) continue;

          const videoId = bestYtMatch.id.videoId;
          const title = bestYtMatch.snippet.title;
          const thumbnail = bestYtMatch.snippet.thumbnails.medium?.url || "";
          const titleNorm = normalize(title);

          let durationSeconds = null;
          try {
            const ytDetails = await axios.get(
              "https://www.googleapis.com/youtube/v3/videos",
              {
                params: {
                  part: "contentDetails",
                  id: videoId,
                  key: YOUTUBE_KEY,
                },
              },
            );

            const durIso = ytDetails.data.items?.[0]?.contentDetails?.duration;
            if (durIso) {
              const match = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
              const mins = parseInt(match?.[1] ?? 0, 10);
              const secs = parseInt(match?.[2] ?? 0, 10);
              durationSeconds = mins * 60 + secs;
            }
          } catch (err) {
            console.warn("[YouTube] Failed to fetch duration:", err.message);
          }

          await pool.query(
            `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
               title = VALUES(title),
               title_norm = VALUES(title_norm),
               thumbnail = VALUES(thumbnail),
               duration = VALUES(duration)`,
            [videoId, title, titleNorm, thumbnail, durationSeconds],
          );

          results.push({
            title,
            youtubeId: videoId,
            thumbnail,
            duration: durationSeconds,
          });

          if (results.length >= needed) break;
        } catch (err) {
          console.warn(
            `[YouTube] Search failed for "${s.title}":`,
            err.message,
            err.response?.data,
          );
          if (err.response?.status === 403) {
            console.error("[YouTube 403] Check API-Key Restrictions/Quota!");
          }
        }
      }

      const created = [];

      for (const item of results) {
        const [insert] = await pool.query(
          `INSERT INTO queue_items
            (session_id, video_id, status, item_source, item_type, voting_round_id)
           VALUES (?, ?, 'suggested', 'ai', 'music', ?)`,
          [
            id,
            item.youtubeId,
            currentRoundId,
          ],
        );

        created.push({
          id: insert.insertId,
          title: item.title,
          youtubeId: item.youtubeId,
          thumbnail: item.thumbnail,
          status: "suggested",
          item_source: "ai",
        });
      }

      finalAiSuggestions = [...finalAiSuggestions, ...created];

      console.log(
        `[AI] Erfolgreich ${created.length} neue Vorschläge hinzugefügt → jetzt insgesamt ${finalAiSuggestions.length}`
      );
    } else {
      console.log(
        `[AI] Bereits ${currentCount} AI-Vorschläge vorhanden → keine Neugenerierung nötig`
      );
    }

    // === Finale Rückgabe ===
    return res.json(finalAiSuggestions);
  } catch (err) {
    console.error("[Recommendation Error]", err);
    // Fallback: trotzdem die bestehenden zurückgeben
    console.warn(
      `[AI] Generierung fehlgeschlagen – gebe trotzdem die ${finalAiSuggestions.length} vorhandenen zurück`
    );
    return res.json(finalAiSuggestions);
  }
});

// ---------------------------------------------------------------
// 5. NEW ENDPOINT – ADD RECOMMENDED SONG (click → queue)
// ---------------------------------------------------------------
router.post("/sessions/:id/recommendations/add", async (req, res) => {
  const { id: sessionId } = req.params;
  const { youtubeId } = req.body; // nur youtubeId vom Client nötig

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  try {
    // =================================================
    // Session-Status holen (wie in /proposals)
    // =================================================
    const [[sessionRow]] = await pool.query(
      "SELECT user_id, is_live FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isSessionLive = sessionRow.is_live === 1;

    let votingRoundId = null;
    let status = "suggested"; // Default für Empfehlungen: immer suggested

    // =================================================
    // STRIKTE Phase-Prüfung – genau wie in /proposals
    // =================================================
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, phase 
         FROM voting_rounds 
         WHERE session_id = ? 
           AND status = 'open' 
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );

      if (!round) {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber KEINE offene Runde → 403`);
        return res.status(403).json({ 
          error: "Keine aktive Voting-Runde – Empfehlungen momentan nicht möglich" 
        });
      }

      if (round.phase !== "suggestion") {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber falsche Phase (${round.phase}) → 403`);
        return res.status(403).json({ 
          error: `Nur in der Vorschlagsphase möglich (aktuell: ${round.phase})` 
        });
      }

      // Alles korrekt → verknüpfen
      votingRoundId = round.id;
      status = "suggested";
    }

    // =================================================
    // Video-Infos aus Cache holen
    // =================================================
    const [rows] = await pool.query(
      `SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ? LIMIT 1`,
      [youtubeId],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Video nicht gefunden im Cache" });
    }

    const { title, thumbnail, duration } = rows[0];

    // =================================================
    // Doppelte-Prüfung (optional – nur bei suggested)
    // =================================================
    if (status === "suggested" && votingRoundId) {
      const [existing] = await pool.query(
        `SELECT id FROM queue_items 
         WHERE session_id = ? 
           AND voting_round_id = ? 
           AND video_id = ? 
           AND status = 'suggested' 
         LIMIT 1`,
        [sessionId, votingRoundId, youtubeId]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "Dieser Song wurde in dieser Runde bereits vorgeschlagen"
        });
      }
    }

    // =================================================
    // Insert – jetzt MIT voting_round_id
    // =================================================
    await pool.query(
      `INSERT INTO queue_items
       (session_id, item_type, video_id, added_by, guest_id,
        status, voting_round_id, item_source)
       VALUES (?, 'music', ?, ?, ?, ?, ?, 'ai')`,
      [
        sessionId,
        youtubeId,
        user?.id || null,
        guest?.id || null,
        status,
        votingRoundId
      ]
    );

    // Broadcast
    getIO().to(sessionId).emit("proposals_updated", {}); // da suggested

    console.log(`[RECOMMENDATIONS/ADD] Erfolgreich hinzugefügt: ${title} (Round ${votingRoundId || 'none'})`);

    res.json({ 
      success: true, 
      youtubeId, 
      title, 
      thumbnail, 
      duration,
      status,
      votingRoundId 
    });

  } catch (err) {
    console.error("Add recommendation error:", err);
    res.status(500).json({ error: "Failed to add song" });
  }
});

router.get("/sessions/:id/invites/accepted", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  // === 1. Token prüfen (genau wie in deinen anderen Routes) ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
  const guestToken = req.headers["x-guest-token"];

  let user = null;
  if (token) {
    user = await getUserFromToken(token);
  }
  // Gäste dürfen diese Route NICHT nutzen
  if (!user || guestToken) {
    return res
      .status(401)
      .json({
        error: "Nur eingeloggte User (keine Gäste) dürfen diese Route nutzen",
      });
  }

  try {
    // === 2. Session direkt per SQL holen + Berechtigung prüfen ===
    const [sessionRows] = await pool.query(
      `SELECT id, user_id, title, is_private, is_live 
       FROM sessions 
       WHERE id = ? 
       LIMIT 1`,
      [sessionId],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Session nicht gefunden" });
    }

    const session = sessionRows[0];

    if (session.is_private !== 1) {
      return res.status(400).json({ message: "Session ist nicht privat" });
    }

    if (session.user_id !== user.id) {
      return res
        .status(403)
        .json({
          message: "Nur der Host darf die akzeptierten Einladungen sehen",
        });
    }

    // === 3. Akzeptierte Einladungen holen ===
    const [invites] = await pool.query(
      `SELECT 
          si.id,
          si.email AS invitee_email,
          u.imageType,
          u.imageData,
          si.invited_user_id,
          u.username AS invitee_name,
          si.accepted_at
       FROM session_invites si
       LEFT JOIN users u ON si.invited_user_id = u.id
       WHERE si.session_id = ?
         AND si.status = 'accepted'
       ORDER BY si.accepted_at DESC`,
      [sessionId],
    );

    // === 4. Perfektes Format für dein Frontend ===
    const formatted = invites.map((invite) => {
      let imageData = null;

      if (invite.imageData && invite.imageType) {
        imageData = `data:${invite.imageType};base64,${invite.imageData.toString("base64")}`;
      }

      return {
        id: invite.id,
        invitee_email: invite.invitee_email,
        invitee_name: invite.invitee_name || null,
        accepted_at: invite.accepted_at,
        imageData,
      };
    });

    return res.json(formatted);
  } catch (err) {
    console.error("Fehler in GET /sessions/:id/invites/accepted:", err);
    return res.status(500).json({ message: "Interner Serverfehler" });
  }
});

router.delete("/sessions/:id/invites/:inviteId", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const inviteId = parseInt(req.params.inviteId);

  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [session] = await pool.query(
    "SELECT user_id FROM sessions WHERE id = ?",
    [sessionId],
  );
  if (!session || session[0].user_id !== user.id) {
    return res.status(403).json({ message: "Nur Host" });
  }

  await pool.query(
    "UPDATE session_invites SET status = 'revoked', revoked_at = NOW() WHERE id = ? AND session_id = ?",
    [inviteId, sessionId],
  );

  res.json({ success: true });
});

// === Proposals endpoint (POST) ===
router.post("/sessions/:id/proposals", async (req, res) => {
  const { id: sessionId } = req.params;
  const {
    videoId,
    title: clientTitle,
    thumbnail: clientThumbnail,
    item_type,
    description,
    duration: pauseDuration,
  } = req.body;

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // 1. Session-Status holen
    const [[sessionRow]] = await pool.query(
      "SELECT user_id, is_live FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isHost = user && sessionRow.user_id === user.id;
    const isSessionLive = sessionRow.is_live === 1;

    let votingRoundId = null;
    let status = "queued";

    // 2. Wenn Session live ist → STRIKTE Phase-Prüfung
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, phase 
         FROM voting_rounds 
         WHERE session_id = ? 
           AND status = 'open' 
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );

      // Keine offene Runde → komplett verbieten
      if (!round) {
        return res.status(403).json({ 
          error: "Keine aktive Voting-Runde – Vorschläge/Pausen momentan nicht möglich" 
        });
      }

      // Runde existiert, aber nicht suggesting → verbieten
      if (round.phase !== "suggestion") {
        return res.status(403).json({ 
          error: "Aktuell läuft die Abstimmung – Vorschläge/Pausen erst in der nächsten Vorschlagsphase möglich" 
        });
      }

      // Alles korrekt → suggested + round verknüpfen
      votingRoundId = round.id;
      status = "suggested";
    } else {
      // Session nicht live → nur Host darf direkt queued einfügen
      if (!isHost) {
        return res.status(403).json({ 
          error: "Nur der Host darf Vorschläge machen, solange die Session nicht live ist" 
        });
      }
      // status bleibt "queued" (wie vorher)
    }

    // =================================================
    // Pause-Handling
    // =================================================
    if (item_type === "pause") {
      const duration = Number(pauseDuration) || 30;
      if (duration < 5 || duration > 600) {
        return res.status(400).json({ 
          error: "Pausendauer muss zwischen 5 und 600 Sekunden liegen" 
        });
      }

      const desc = (description || "Kurze Pause").trim().slice(0, 100);

      await pool.query(
        `INSERT INTO queue_items
         (session_id, item_type, description, pause_duration_seconds,
          added_by, guest_id, status, item_source, voting_round_id)
         VALUES (?, 'pause', ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          desc,
          duration,
          user?.id || null,
          guest?.id || null,
          status,
          user ? "user" : "guest",
          votingRoundId   // ← jetzt immer gesetzt, wenn suggesting läuft
        ]
      );

      // Broadcast
      if (status === "suggested") {
        getIO().to(sessionId).emit("proposals_updated", {});
      } else {
        getIO().to(sessionId).emit("queue_updated", {});
      }

      return res.status(201).json({ 
        success: true, 
        type: "pause", 
        status,
        votingRoundId 
      });
    }

    // =================================================
    // Musik-Handling
    // =================================================
    if (!videoId) {
      return res.status(400).json({ error: "Missing videoId" });
    }

    let title, thumbnail, duration;

    // Cache oder ytdl
    const [cachedRows] = await pool.query(
      "SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ?",
      [videoId]
    );

    if (cachedRows.length > 0) {
      ({ title, thumbnail, duration } = cachedRows[0]);
    } else {
      try {
        const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const videoDetails = info.videoDetails;

        title = videoDetails.title || clientTitle || "Unbekannter Titel";
        thumbnail =
          videoDetails.thumbnails?.[0]?.url ||
          clientThumbnail ||
          `https://i.ytimg.com/vi/${videoId}/default.jpg`;
        duration = parseInt(videoDetails.lengthSeconds) || 0;

        await pool.query(
          `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration)
           VALUES (?, ?, ?, ?, ?)`,
          [videoId, title, normalize(title), thumbnail, duration]
        );
      } catch (ytdlErr) {
        console.error("ytdl failed:", ytdlErr);
        return res.status(400).json({ error: "Video nicht verfügbar" });
      }
    }

    // Doppelte-Prüfung nur wenn suggested
    if (status === "suggested" && votingRoundId) {
      const [existing] = await pool.query(
        `SELECT id FROM queue_items 
         WHERE session_id = ? 
           AND voting_round_id = ? 
           AND video_id = ? 
           AND status = 'suggested' 
         LIMIT 1`,
        [sessionId, votingRoundId, videoId]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "Dieser Song wurde in dieser Runde bereits vorgeschlagen"
        });
      }
    }

    await pool.query(
      `INSERT INTO queue_items
       (session_id, item_type, video_id, added_by, guest_id,
        status, voting_round_id, item_source)
       VALUES (?, 'music', ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        videoId,
        user?.id || null,
        guest?.id || null,
        status,
        votingRoundId,          // ← jetzt garantiert korrekt gesetzt
        user ? "user" : "guest"
      ]
    );

    // Broadcast
    if (status === "suggested") {
      getIO().to(sessionId).emit("proposals_updated", {});
    } else {
      getIO().to(sessionId).emit("queue_updated", {});
    }

    res.status(201).json({
      success: true,
      type: "music",
      status,
      votingRoundId
    });

  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Interner Fehler" });
  }
});


// === GET: Alle vorgeschlagenen Songs (für Voting) ===
router.get("/sessions/:id/proposals", async (req, res) => {
  const { id: sessionId } = req.params;

  try {
    const [proposals] = await pool.query(
      `
      SELECT
        q.id,
        COALESCE(yvc.title, q.description)               AS title,
        yvc.thumbnail                                    AS thumbnail,
        q.status,
        q.video_id,
        q.voting_round_id,
        q.item_type,        -- NEU
        q.item_source,      -- NEU
        q.description,      -- für Pausen
        COALESCE(yvc.duration, q.pause_duration_seconds) AS duration,
        COALESCE(v.vote_count, 0) AS votes,
        u.username AS addedByUser,
        g.nickname AS addedByGuest
      FROM queue_items q
      LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = q.video_id
      LEFT JOIN users u ON q.added_by = u.id
      LEFT JOIN guest_users g ON q.guest_id = g.id

      LEFT JOIN (
        SELECT queue_item_id, COUNT(*) AS vote_count
        FROM votes
        GROUP BY queue_item_id
      ) v ON v.queue_item_id = q.id

      WHERE q.session_id = ?
        AND q.status IN ('suggested', 'proposal')

      ORDER BY q.created_at ASC
      `,
      [sessionId],
    );

    // → Einheitliches API-Format erzeugen
    const result = proposals.map((p) => ({
      id: p.id,
      title: p.title,
      thumbnail: p.thumbnail,
      status: p.status,
      videoId: p.video_id,
      votingRoundId: p.voting_round_id,
      itemType: p.item_type, // music | pause
      itemSource: p.item_source, // user | guest | ai
      description: p.description,
      duration: p.duration,
      votes: p.votes,
      addedBy: p.addedByUser || p.addedByGuest || "Unbekannt",
    }));

    res.json(result);
  } catch (err) {
    console.error("Failed to load proposals:", err);
    res.status(500).json({ error: "Failed to load proposals" });
  }
});

// Beispiel-Endpoint zum Abschließen einer Votingrunde
router.post("/voting-rounds/:id/close", async (req, res) => {
  const { id } = req.params;

  try {
    // 1️⃣ Sieger bestimmen
    const [winnerRows] = await pool.query(
      `
      SELECT q.id, COUNT(v.id) AS votes
      FROM queue_items q
      LEFT JOIN votes v ON q.id = v.queue_item_id
      WHERE q.voting_round_id = ?
      GROUP BY q.id
      ORDER BY votes DESC
      LIMIT 1
    `,
      [id],
    );

    if (winnerRows.length === 0) {
      await pool.query("UPDATE voting_rounds SET status='closed' WHERE id=?", [
        id,
      ]);
      return res.json({ success: true, message: "Keine Vorschläge vorhanden" });
    }

    const winnerId = winnerRows[0].id;

    // 2️⃣ Votingrunde updaten
    await pool.query(
      "UPDATE voting_rounds SET status='computed', winner_queue_item_id=? WHERE id=?",
      [winnerId, id],
    );

    // 3️⃣ Gewinner in Queue verschieben
    await pool.query("UPDATE queue_items SET status='queued' WHERE id=?", [
      winnerId,
    ]);

    // 4️⃣ Alle anderen Vorschläge ablehnen
    await pool.query(
      "UPDATE queue_items SET status='rejected' WHERE voting_round_id=? AND id<>?",
      [id, winnerId],
    );

    getIO().emit("queue_updated", {});
    res.json({ success: true, winnerId });
  } catch (err) {
    console.error("Voting close error:", err);
    res.status(500).json({ error: "Failed to close voting round" });
  }
});


// GET /sessions/:id/current-phase
router.get("/sessions/:id/current-phase", async (req, res) => {
  const { id } = req.params;

  try {
    const [[round]] = await pool.query(
      `SELECT phase, phase_ends_at, 
              TIMESTAMPDIFF(SECOND, created_at, phase_ends_at) AS duration
       FROM voting_rounds 
       WHERE session_id = ? AND status = 'open' 
       ORDER BY id DESC LIMIT 1`,
      [id],
    );

    if (!round || !round.phase_ends_at) {
      return res.status(404).json({ error: "No active phase" });
    }

    res.json({
      phase: round.phase,
      endsAt: new Date(round.phase_ends_at).toISOString(),
      duration: round.duration || 90,
      roundId: round.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Voting ===
// POST /sessions/:id/proposals/:propId/vote
router.post("/sessions/:id/proposals/:propId/vote", async (req, res) => {
  const { id, propId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // Session live?
  const [[sessionRow]] = await pool.query(
    "SELECT is_live FROM sessions WHERE id = ?",
    [id],
  );
  if (!sessionRow || sessionRow.is_live !== 1) {
    return res.status(403).json({ error: "Session nicht live" });
  }

  // Nur in Voting-Phase erlaubt
  const [[currentRound]] = await pool.query(
    `SELECT phase, id AS roundId 
     FROM voting_rounds 
     WHERE session_id = ? AND status = 'open' 
     ORDER BY id DESC LIMIT 1`,
    [id],
  );

  if (!currentRound || currentRound.phase !== "voting") {
    return res.status(403).json({ error: "Aktuell läuft keine Abstimmung" });
  }

  // Proposal existiert und ist suggested?
  const [[proposal]] = await pool.query(
    `SELECT voting_round_id FROM queue_items 
     WHERE id = ? AND session_id = ? AND status = 'suggested'`,
    [propId, id],
  );
  if (!proposal || proposal.voting_round_id !== currentRound.roundId) {
    return res.status(404).json({ error: "Vorschlag nicht abstimmbar" });
  }

  const voterId = user?.id || guest?.id;
  const voterColumn = user ? "user_id" : "guest_id";

  // Toggle Vote (Upvote / Widerruf)
  const [[existing]] = await pool.query(
    `SELECT id FROM votes WHERE queue_item_id = ? AND ${voterColumn} = ?`,
    [propId, voterId],
  );

  if (existing) {
    await pool.query(`DELETE FROM votes WHERE id = ?`, [existing.id]);
  } else {
    await pool.query(
      `INSERT INTO votes (queue_item_id, user_id, guest_id) VALUES (?, ?, ?)`,
      [propId, user?.id || null, guest?.id || null],
    );
  }

  // Immer nur UI updaten – KEINE vorzeitige Auswertung mehr!
  getIO().to(id).emit("proposals_updated");

  // 🔥 NEU: Top-Charts aktualisieren (Votes zählen ja mit!)
  await broadcastTodayTopArtists();

  res.json({ success: true });
});

// DELETE /sessions/:sessionId/proposals/:proposalId
router.delete("/sessions/:sessionId/proposals/:proposalId", async (req, res) => {
  const { sessionId, proposalId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  let userId = null;
  let guestId = null;

  // === Authentifizierung ===
  if (token) {
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Ungültiger Token" });
    userId = user.id;
  } else if (guestToken) {
    const guest = await getGuestFromToken(guestToken);
    if (!guest) return res.status(401).json({ error: "Ungültiger Gast-Token" });
    guestId = guest.id;
  } else {
    return res.status(401).json({ error: "Kein Zugriffstoken" });
  }

  try {
    // 1. Den suggested queue_item + Host-ID der Session holen
    const [rows] = await pool.query(
      `SELECT qi.*, s.user_id AS host_user_id 
       FROM queue_items qi
       JOIN sessions s ON qi.session_id = s.id
       WHERE qi.id = ? 
         AND qi.session_id = ? 
         AND qi.status = 'suggested'`,
      [proposalId, sessionId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Vorschlag nicht gefunden oder nicht mehr löschbar",
      });
    }

    const item = rows[0];

    // 2. Aktuelle Voting-Phase prüfen
    const [phaseRows] = await pool.query(
      `SELECT phase FROM voting_rounds 
       WHERE session_id = ? AND status = 'open' 
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );

    const currentPhase = phaseRows[0]?.phase || null;

    if (currentPhase !== "suggestion") {
      return res.status(403).json({
        message: "Löschen nur in der Vorschlagsphase möglich",
      });
    }

    // 3. Berechtigung prüfen: Eigentümer ODER Host
    const isOwner =
      (userId && item.added_by === userId) ||
      (guestId && item.guest_id === guestId);

    const isHost = userId && item.host_user_id === userId;

    if (!isOwner && !isHost) {
      return res.status(403).json({
        message: "Du kannst nur deinen eigenen Vorschlag entfernen",
      });
    }

    // 4. Löschen
    await pool.query("DELETE FROM queue_items WHERE id = ?", [proposalId]);

    // 5. Echtzeit-Update an alle
    req.io?.to(`session_${sessionId}`).emit("proposals_updated");
    req.io?.to(`session_${sessionId}`).emit("queue_updated");

    return res.json({ message: "Vorschlag erfolgreich entfernt" });
  } catch (err) {
    console.error("Fehler beim Löschen des Vorschlags:", err);
    return res.status(500).json({ message: "Serverfehler" });
  }
});

// === Host: direct queue add (blocked if session is_live) ===
router.post("/sessions/:id/queue/add", async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query(
    "SELECT user_id, is_live FROM sessions WHERE id = ?",
    [id],
  );
  if (sess[0].is_live)
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
    "SELECT is_live FROM sessions WHERE id = ?",
    [id],
  );
  if (!sess) return res.status(404).json({ error: "Session not found" });
  if (sess.is_live) {
    return res.status(400).json({ error: "Session already live" });
  }

  // 🧹 Reset playback_sync
  await pool.query(`DELETE FROM playback_sync WHERE session_id = ?`, [id]);

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
  await pool.query("UPDATE sessions SET is_live = 1 WHERE id = ?", [id]);

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

    // 🕒 Ersten Song auf "playing" setzen
    await pool.query(
      `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
      [firstId],
    );

    // 🧩 playback_sync setzen
    await pool.query(
      `INSERT INTO playback_sync (session_id, current_video_id, progress_seconds, is_playing, video_start_time)
       VALUES (?, ?, 0, 1, ?)
       ON DUPLICATE KEY UPDATE
         current_video_id = VALUES(current_video_id),
         video_start_time = VALUES(video_start_time),
         is_playing = 1`,
      [id, firstVideoId, startTime],
    );

    console.log(
      `[Playback] Session ${id} STARTED with first song: videoId=${firstVideoId} – "${first[0].title}"`,
    );

    getIO().to(id).emit("session_started", {
      autoStarted: true,
      firstVideoId,
      video_start_time: startTime,
    });

    getIO().to(id).emit("playback_sync", {
      current_queue_item_id: firstId,
      current_video_id: firstVideoId,
      video_start_time: startTime,
      is_playing: true,
    });

    if (sessionTimers[id]) clearTimeout(sessionTimers[id]);
    sessionTimers[id] = setTimeout(() => advanceToNext(id), duration * 1000);

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
      (session_id, status, phase, phase_ends_at, suggestion_duration, voting_duration)
     VALUES (?, 'open', 'suggestion', ?, ?, ?)`,
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

    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND is_live = 1",
      [parseInt(id, 10)],
    );

    getIO().emit("participant_count_update", {
      sessionId: parseInt(id, 10),
      count: count || 0,
    });

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

    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND is_live = 1",
      [sessionIdInt],
    );

    getIO().emit("participant_count_update", {
      sessionId: sessionIdInt,
      count: count || 0,
    });
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
router.post("/sessions/:sessionId/invite", async (req, res) => {
  const { sessionId } = req.params;
  const { email: rawEmail } = req.body;

  // === Authentifizierung ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  // === E-Mail Validierung & Normalisierung ===
  const email = rawEmail?.trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  // Selbst-Einladung verhindern
  if (email === user.email) {
    return res
      .status(400)
      .json({ error: "Du kannst dich nicht selbst einladen." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // === 1. Session + Host-Validierung (inkl. host_email) ===
    const [[session]] = await conn.query(
      `SELECT s.title, s.user_id, s.is_private, u.username AS host_name, u.email AS host_email
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ?`,
      [sessionId],
    );

    if (!session) {
      await conn.rollback();
      return res.status(404).json({ error: "Session nicht gefunden" });
    }
    if (session.is_private === 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Nur private Sessions können Einladungen versenden" });
    }
    if (session.user_id !== user.id) {
      await conn.rollback();
      return res
        .status(403)
        .json({ error: "Nur der Host darf Einladungen verschicken" });
    }
    if (email === session.host_email?.toLowerCase()) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Der Session-Host kann nicht eingeladen werden." });
    }

    const sessionTitle =
      session.title?.trim() || "Eine private TuneVote Session";
    const hostName = session.host_name || "Der Host";

    // === 2. Prüfen, ob der Benutzer bereits registriert ist ===
    const [[existingUser]] = await conn.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email],
    );
    const invitedUserId = existingUser ? existingUser.id : null;
    const userExists = !!invitedUserId;

    // === 3. Existierende Einladung prüfen & ggf. reaktivieren/neu anlegen ===
    const [inviteRows] = await conn.query(
      `SELECT * FROM session_invites 
       WHERE session_id = ? AND LOWER(email) = LOWER(?) 
       LIMIT 1 FOR UPDATE`,
      [sessionId, email],
    );
    const existingInvite = inviteRows[0] || null;

    if (existingInvite) {
      if (
        existingInvite.status === "revoked" ||
        existingInvite.status === "rejected"
      ) {
        await conn.query(
          `UPDATE session_invites 
           SET status = 'pending',
               invited_user_id = ?,
               invited_by_user_id = ?,
               updated_at = NOW(),
               accepted_at = NULL,
               rejected_at = NULL,
               revoked_at = NULL
           WHERE id = ?`,
          [invitedUserId, user.id, existingInvite.id],
        );
      }
    } else {
      await conn.query(
        `INSERT INTO session_invites 
         (session_id, email, invited_by_user_id, invited_user_id, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [sessionId, email, user.id, invitedUserId],
      );
    }

    await conn.commit();

    // === 4. E-Mail-Inhalte je nach Registrierungsstatus unterscheiden ===
    const baseUrl = process.env.FRONTEND_URL || "https://app.tunevote.com/ ";
    const dashboardLink = `${baseUrl}/dashboard`;
    const primaryColor = "#4f46e5";

    // Zwei komplett unterschiedliche Templates – klar getrennt
    const htmlForExistingUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Neue Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du hast eine neue Einladung!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zur privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Da du bereits ein TuneVote-Konto hast, findest du die Einladung direkt in deinem Dashboard.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Einladung im Dashboard ansehen
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const htmlForNewUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du wurdest zu einer Session eingeladen!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zu einer privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Erstelle jetzt kostenlos ein Konto, um der Session beizutreten und mit abzustimmen!
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Registrieren & Session beitreten
                </a>
              </div>
              <p style="font-size:14px;color:#6b7280;text-align:center;margin-top:32px;">
                Oder direkt hier klicken:<br>
                <a href="${dashboardLink}" style="color:${primaryColor};">${dashboardLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const subject = userExists
      ? `Neue Einladung: ${sessionTitle}`
      : `${hostName} hat dich zu "${sessionTitle}" eingeladen`;

    const html = userExists ? htmlForExistingUser : htmlForNewUser;

    // === 5. E-Mail versenden ===
    try {
      await transporter.sendMail({
        from: `"TuneVote" <${process.env.GMAIL_USER}>`,
        to: email,
        subject,
        text: userExists
          ? `Du hast eine neue Einladung zu "${sessionTitle}". Öffne dein Dashboard: ${dashboardLink}`
          : `Du wurdest zu "${sessionTitle}" eingeladen! Erstelle ein Konto: ${dashboardLink}`,
        html,
      });
    } catch (mailErr) {
      console.error("E-Mail-Versand fehlgeschlagen:", mailErr);
      return res.status(500).json({
        success: true,
        message:
          "Einladung gespeichert, aber E-Mail konnte nicht gesendet werden.",
        emailError: true,
        alreadyRegistered: userExists,
      });
    }

    return res.json({
      success: true,
      message: "Einladung erfolgreich versendet",
      alreadyRegistered: userExists,
    });
  } catch (err) {
    console.error("Invite error:", err);
    if (conn) await conn.rollback().catch(() => {});
    return res
      .status(500)
      .json({ error: "Fehler beim Versenden der Einladung" });
  } finally {
    if (conn) conn.release();
  }
});

// GET: Einladungen, die du verschickt hast (nur offene)
router.get("/invites/sent", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
      si.id,
      si.email,

      -- Dynamischer Status
      si.status,
      si.created_at,
      si.accepted_at,
      si.rejected_at,
      si.revoked_at,
      si.updated_at,
      s.title AS session_title
      FROM session_invites si
      JOIN sessions s ON si.session_id = s.id
      WHERE si.invited_by_user_id = ? AND si.status = 'pending'
      ORDER BY si.created_at DESC
  `,
    [user.id],
  );

  res.json(invites);
});

// GET: Einladungen, die du erhalten hast (nur unbearbeitet / pending)
router.get("/invites/received", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
       si.id, si.email, si.created_at, si.accepted_at, si.rejected_at, si.revoked_at,
       si.status,
       s.title AS session_title, 
       u.username AS host_name
     FROM session_invites si
     JOIN sessions s ON si.session_id = s.id
     JOIN users u ON s.user_id = u.id
     WHERE (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       AND si.status = 'pending'
     ORDER BY si.created_at DESC`,
    [user.email, user.id],
  );

  res.json(invites);
});

// POST: Einladung annehmen + Socket.IO Event an Host schicken
router.post("/invites/:inviteId/accept", async (req, res) => {
  const inviteId = parseInt(req.params.inviteId, 10);
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Invite mit Session-Info und aktuellem Status holen + sperren
    const [invites] = await connection.query(
      `SELECT si.*, s.user_id AS host_id 
       FROM session_invites si
       JOIN sessions s ON si.session_id = s.id
       WHERE si.id = ? 
         AND si.status = 'pending'
         AND (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       FOR UPDATE`,
      [inviteId, user.email, user.id],
    );

    if (invites.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        error:
          "Einladung nicht gefunden, bereits bearbeitet oder nicht für dich",
      });
    }

    const invite = invites[0];

    // 2. Einladung als akzeptiert markieren
    await connection.query(
      `UPDATE session_invites 
       SET status = 'accepted',
           accepted_at = NOW(),
           invited_user_id = COALESCE(invited_user_id, ?),
           updated_at = NOW()
       WHERE id = ?`,
      [user.id, inviteId],
    );

    await connection.commit();

    // 3. Fertiges Objekt für Frontend + Socket.IO bauen
    const formattedInvite = {
      id: invite.id,
      invitee_email: invite.email,
      invitee_name: user.username || null, // wichtig!
      accepted_at: new Date().toISOString(),
    };

    // 4. Socket.IO Event nur an den Host der Session schicken
    getIO().to(`session-host-${invite.session_id}`).emit(
      "invite:accepted",
      formattedInvite,
    );

    // Optional: auch global an alle im Session-Raum (falls Co-Hosts etc.)
    // getIO().to(`session-${invite.session_id}`).emit("invite:accepted", formattedInvite);

    // 5. Erfolgreiche Antwort ans Frontend (kann der Client ignorieren, weil er ja eh updatet)
    return res.json({ success: true, invite: formattedInvite });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Fehler beim Akzeptieren der Einladung:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  } finally {
    if (connection) connection.release();
  }
});

router.post("/invites/:inviteId/reject", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'rejected',
         rejected_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND status = 'pending'
       AND (LOWER(email) = LOWER(?) OR invited_user_id = ?)`,
    [inviteId, user.email, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder bereits verarbeitet",
    });
  }

  res.json({ success: true });
});

// POST: Einladung ablehnen
router.post("/invites/:inviteId/revoke", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'revoked',
         revoked_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND invited_by_user_id = ?
       AND status = 'pending'`,
    [inviteId, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder nicht mehr widerrufbar",
    });
  }

  res.json({ success: true });
});

// ============================================================
// GET /sessions/:sessionId/participants → Nur live Teilnehmer (is_live = 1)
// + Echtzeit-Updates über Socket.IO
// ============================================================

router.get("/sessions/:sessionId/participants", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId, 10);

  if (isNaN(sessionId)) {
    return res.status(400).json({ error: "Ungültige Session-ID" });
  }

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  try {
    // Prüfen, ob der Aufrufer überhaupt zur Session gehört (Sicherheit)
    const column = user ? "user_id" : "guest_id";
    const id = user ? user.id : guest.id;

    const [allowed] = await pool.query(
      `SELECT 1 FROM session_participants 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionId, id],
    );

    if (allowed.length === 0) {
      return res
        .status(403)
        .json({ error: "Du bist nicht Teil dieser Session" });
    }

    // Alle LIVE Teilnehmer holen
    const [participants] = await pool.query(
      `SELECT 
         sp.id,
         sp.role,
         COALESCE(u.username, g.nickname, 'Gast') AS name,
         (sp.role = 'host') AS isHost,
        u.imageType,
        u.imageData
       FROM session_participants sp
       LEFT JOIN users u ON sp.user_id = u.id
       LEFT JOIN guest_users g ON sp.guest_id = g.id
       WHERE sp.session_id = ? AND sp.is_live = 1
       ORDER BY sp.joined_at DESC`,
      [sessionId],
    );

    const formatted = participants.map((p) => {
      let profileImage = null;

      if (p.imageType && p.imageData) {
        profileImage = `data:${p.imageType};base64,${p.imageData.toString("base64")}`;
      }

      return {
        name: p.name,
        isHost: !!p.isHost,
        profileImage,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Fehler beim Laden der Live-Teilnehmer:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});


module.exports = router;
