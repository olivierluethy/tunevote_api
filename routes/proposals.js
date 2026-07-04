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
const { openai, safeParseOpenAI, CHAT_MODEL } = require("../services/openai");
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

router.get("/sessions/:id/current-voting-phase", async (req, res) => {
  const sessionId = parseInt(req.params.id);

  try {
    const [[round]] = await pool.query(`
      SELECT
        id AS roundId,
        state,
        UNIX_TIMESTAMP(phase_ends_at) * 1000 AS endsAtMs,
        CASE
          WHEN state = 'suggesting' THEN suggestion_duration
          WHEN state = 'voting' THEN voting_duration
          ELSE 90
        END AS durationSeconds
      FROM voting_rounds
      WHERE session_id = ?
        AND state IN ('suggesting','voting')
      ORDER BY id DESC
      LIMIT 1
    `, [sessionId]);

    if (!round) {
      return res.json({ phase: null, endsAt: null, duration: 0, roundId: null });
    }

    res.json({
      phase: round.state === "voting" ? "voting" : "suggestion",
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
    "SELECT status FROM sessions WHERE id = ?",
    [id],
  );
  if (sessionRows[0]?.status !== "live")
    return res.status(400).json({ error: "Session not live" });

  // ---- Voting-Round & AI Suggestion Check ----
  const [votingRoundRows] = await pool.query(
    `SELECT id FROM voting_rounds 
     WHERE session_id = ? AND state IN ('suggesting','voting')
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

      // ---- COMPREHENSIVE exclusion list ----
      // Everything this session has ever touched — across ALL rounds and ALL
      // statuses (played, queued, playing, suggested, skipped) — so we never
      // re-suggest a song the group has already seen. The old code only excluded
      // the current queue, which is why played/earlier-round songs kept coming
      // back. Capped so the prompt stays bounded on long sessions.
      const [seenRows] = await pool.query(
        `SELECT yvc.title
           FROM queue_items qi
           JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
          WHERE qi.session_id = ? AND qi.item_type = 'music'
          GROUP BY yvc.title
          ORDER BY MAX(qi.id) DESC
          LIMIT 200`,
        [id],
      );
      const allTitles = seenRows.map((r) => r.title);

      // ---- Taste seed ----
      // Songs the humans in this session actually chose (user/guest, not AI)
      // reveal the group's taste, steering recommendations toward the session's
      // vibe instead of generic global top-40.
      const [tasteRows] = await pool.query(
        `SELECT yvc.title
           FROM queue_items qi
           JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
          WHERE qi.session_id = ?
            AND qi.item_type = 'music'
            AND qi.item_source IN ('user','guest')
          ORDER BY qi.id DESC
          LIMIT 12`,
        [id],
      );
      const tasteSeed = [...new Set(tasteRows.map((r) => r.title))];

      // ---- Rotating exploration angle ----
      // The DB state changes slowly, so identical inputs would otherwise yield
      // identical output. Picking a random angle each call forces variety across
      // genres, eras and regions even when the queue looks the same.
      const EXPLORATION_ANGLES = [
        "lean into lesser-known deep cuts, not just chart-toppers",
        "include tracks released before the year 2000",
        "include international / non-English-language artists",
        "focus on indie, alternative and underground artists",
        "include hip-hop, rap and R&B",
        "include electronic, house and dance",
        "include rock, punk and their subgenres",
        "surface fresh releases from the last two years",
        "include soul, funk, disco and jazz-influenced tracks",
        "mix in acoustic and singer-songwriter material",
        "include Latin, Afrobeats and other global-pop styles",
        "include classic, iconic tracks people may have forgotten",
      ];
      const angle =
        EXPLORATION_ANGLES[
          Math.floor(Math.random() * EXPLORATION_ANGLES.length)
        ];

      const tasteLine = tasteSeed.length
        ? `The people in this room added these songs, which reflect their taste:\n${JSON.stringify(
            tasteSeed,
          )}\nRecommend songs a fan of those would enjoy, but branch out.`
        : `There is no strong taste signal yet, so recommend broadly appealing songs.`;

      // ---- Prompt für AI ----
      const prompt = `
You are a music recommendation engine for a live group listening session.
Suggest real songs that exist on YouTube with an official music video.

${tasteLine}

Variety directive for THIS batch: ${angle}. Do NOT return only obvious global chart hits — favour a diverse mix of different artists.

FORMAT RULES (MUST FOLLOW EXACTLY):
1. Output each song as "Artist - Song Title", using only the MAIN artist and title.
2. NEVER add "(feat. ...)", "[Official...]", "(Official Video)", "Remix", "Live", "Lyric Video" or similar suffixes.
3. Correct: "Artist Name - Song Title". Wrong: "Artist Name - Song Title (feat. X) [Official Music Video]".

HARD CONSTRAINTS:
- Do NOT suggest anything in the "Already used" list below, nor any near-identical title.
- Return ${needed} DIFFERENT song(s), each by a different artist where possible.

Already used (never repeat any of these): ${JSON.stringify(allTitles)}

Output ONLY a JSON array, nothing else:
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

      console.log(
        `[OpenAI] Requesting ${needed} recommendation(s) for session ${id} · model=${CHAT_MODEL} · angle="${angle}"`,
      );
      const completion = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: prompt }],
        // Higher temperature + penalties push away from the same handful of
        // global chart hits and reduce repeats within a batch.
        temperature: 0.95,
        top_p: 0.9,
        presence_penalty: 0.6,
        frequency_penalty: 0.5,
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
      "SELECT user_id, status FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isSessionLive = sessionRow.status === "live";

    let votingRoundId = null;
    let status = "suggested"; // Default für Empfehlungen: immer suggested

    // =================================================
    // STRIKTE Phase-Prüfung – genau wie in /proposals
    // =================================================
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, state
         FROM voting_rounds
         WHERE session_id = ? 
           AND state IN ('suggesting','voting') 
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );

      if (!round) {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber KEINE offene Runde → 403`);
        return res.status(403).json({ 
          error: "Keine aktive Voting-Runde – Empfehlungen momentan nicht möglich" 
        });
      }

      if (round.state !== "suggesting") {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber falsche Phase (${round.state}) → 403`);
        return res.status(403).json({ 
          error: `Nur in der Vorschlagsphase möglich (aktuell: ${round.state})` 
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
      "SELECT user_id, status FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isHost = user && sessionRow.user_id === user.id;
    const isSessionLive = sessionRow.status === "live";

    let votingRoundId = null;
    let status = "queued";

    // 2. Wenn Session live ist → STRIKTE Phase-Prüfung
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, state
         FROM voting_rounds
         WHERE session_id = ? 
           AND state IN ('suggesting','voting') 
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
      if (round.state !== "suggesting") {
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
      await pool.query("UPDATE voting_rounds SET state='closed' WHERE id=?", [
        id,
      ]);
      return res.json({ success: true, message: "Keine Vorschläge vorhanden" });
    }

    const winnerId = winnerRows[0].id;

    // 2️⃣ Votingrunde updaten
    await pool.query(
      "UPDATE voting_rounds SET state='closed', winner_queue_item_id=? WHERE id=?",
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
      `SELECT state, phase_ends_at,
              TIMESTAMPDIFF(SECOND, created_at, phase_ends_at) AS duration
       FROM voting_rounds 
       WHERE session_id = ? AND state IN ('suggesting','voting') 
       ORDER BY id DESC LIMIT 1`,
      [id],
    );

    if (!round || !round.phase_ends_at) {
      return res.status(404).json({ error: "No active phase" });
    }

    res.json({
      phase: round.state === "voting" ? "voting" : "suggestion",
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
    "SELECT status FROM sessions WHERE id = ?",
    [id],
  );
  if (!sessionRow || sessionRow.status !== "live") {
    return res.status(403).json({ error: "Session nicht live" });
  }

  // Nur in Voting-Phase erlaubt
  const [[currentRound]] = await pool.query(
    `SELECT state, id AS roundId
     FROM voting_rounds
     WHERE session_id = ? AND state IN ('suggesting','voting') 
     ORDER BY id DESC LIMIT 1`,
    [id],
  );

  if (!currentRound || currentRound.state !== "voting") {
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
      `SELECT state FROM voting_rounds
       WHERE session_id = ? AND state IN ('suggesting','voting')
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );

    const currentPhase = phaseRows[0]?.state || null;

    if (currentPhase !== "suggesting") {
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

module.exports = router;
