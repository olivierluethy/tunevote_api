const axios = require("axios");
const pool = require("../db");
const { getIO } = require("../lib/io");
const { openai, CHAT_MODEL } = require("./openai");

const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

// ---------------------------------------------------------------------------
// AI SONG RECOMMENDATIONS — shared generator.
//
// Generates up to `needed` AI song suggestions for a session's OPEN voting round
// and inserts them as votable `status='suggested'`, `item_source='ai'` items.
// Used by both the GET /recommendations endpoint (client-triggered) and the
// reconciler's server-authoritative auto-fill (keeps a live session's queue
// stocked so playback never goes silent while users are present).
//
// The title→YouTube mapping, exclusion list, taste seed, rotating exploration
// angle and per-call search budget all live here (moved out of the route so
// there is a single source of truth). Returns the array of created items.
// ---------------------------------------------------------------------------

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

async function generateAiSuggestions(
  sessionId,
  votingRoundId,
  needed,
  opts = {},
) {
  if (!openai || !needed || needed <= 0 || !votingRoundId) return [];
  const id = sessionId;
  const currentRoundId = votingRoundId;
  // Extra titles to exclude on top of the session's own history — used by the
  // "regenerate bad AI suggestions" flow (#27) to avoid re-proposing rejects.
  const excludeTitles = Array.isArray(opts.excludeTitles)
    ? opts.excludeTitles
    : [];

  // ---- Comprehensive exclusion list (everything the session ever touched) ----
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
  const allTitles = [...seenRows.map((r) => r.title), ...excludeTitles];

  // ---- Taste seed (what the humans here actually chose) ----
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

  // When the host has chosen a genre for the session (#39), steer every batch
  // toward it; otherwise rotate through the random exploration angles.
  const [genreRows] = await pool.query(
    `SELECT ai_genre FROM sessions WHERE id = ?`,
    [id],
  );
  const hostGenre = genreRows?.[0]?.ai_genre || null;
  const angle = hostGenre
    ? `focus specifically on the "${hostGenre}" genre — every song should clearly fit it`
    : EXPLORATION_ANGLES[
        Math.floor(Math.random() * EXPLORATION_ANGLES.length)
      ];

  const tasteLine = tasteSeed.length
    ? `The people in this room added these songs, which reflect their taste:\n${JSON.stringify(
        tasteSeed,
      )}\nRecommend songs a fan of those would enjoy, but branch out.`
    : `There is no strong taste signal yet, so recommend broadly appealing songs.`;

  const wanted = needed + 5;

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
- Return ${wanted} DIFFERENT songs, each by a different artist where possible.

Already used (never repeat any of these): ${JSON.stringify(allTitles)}

Output ONLY a JSON array, nothing else:
[{"title": "Artist - Song Title"}]
`;

  console.log(
    `[OpenAI] Requesting ${needed} recommendation(s) for session ${id} · model=${CHAT_MODEL} · angle="${angle}"`,
  );
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.95,
    top_p: 0.9,
    presence_penalty: 0.6,
    frequency_penalty: 0.5,
    max_tokens: 400,
  });

  const rawText = completion.choices?.[0]?.message?.content || "";
  let aiSuggestions = [];
  try {
    aiSuggestions = JSON.parse(rawText.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.warn("[OpenAI] Failed to parse JSON:", rawText);
  }
  if (!Array.isArray(aiSuggestions)) aiSuggestions = [];
  aiSuggestions = aiSuggestions.filter(
    (s) => s?.title && typeof s.title === "string",
  );

  const normalizedQueue = allTitles.map((t) => normalize(t));
  aiSuggestions = aiSuggestions.filter((s) => {
    const norm = normalize(s.title);
    return !normalizedQueue.some((q) => levenshteinRatio(q, norm) > 90);
  });

  // Load the cache once + the videos already used in this session.
  const [cacheRows] = await pool.query(
    `SELECT youtube_id, title, title_norm, thumbnail, duration FROM youtube_video_cache`,
  );
  const [usedRows] = await pool.query(
    `SELECT DISTINCT video_id FROM queue_items WHERE session_id = ? AND item_type = 'music'`,
    [id],
  );
  const usedVideoIds = new Set(usedRows.map((r) => r.video_id));

  const results = [];
  let searchBudget = needed + 1; // cap live YouTube searches (quota) per call

  for (const s of aiSuggestions) {
    if (results.length >= needed) break;
    const normalizedAI = normalize(s.title);
    const artist = normalize(s.title.split(" - ")[0] || "");

    let bestMatch = null;
    let bestScore = 0;
    for (const row of cacheRows) {
      if (usedVideoIds.has(row.youtube_id)) continue;
      const score = levenshteinRatio(normalizedAI, normalize(row.title_norm));
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
            const m = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
            durationSeconds =
              parseInt(m?.[1] ?? 0, 10) * 60 + parseInt(m?.[2] ?? 0, 10);
            await pool.query(
              `UPDATE youtube_video_cache SET duration = ? WHERE youtube_id = ?`,
              [durationSeconds, bestMatch.youtube_id],
            );
          }
        } catch (err) {
          console.warn("[YouTube] duration (cache) failed:", err.message);
        }
      }
      usedVideoIds.add(bestMatch.youtube_id);
      results.push({
        title: bestMatch.title,
        youtubeId: bestMatch.youtube_id,
        thumbnail: bestMatch.thumbnail || "",
        duration: durationSeconds,
      });
      continue;
    }

    if (searchBudget <= 0) continue;
    searchBudget--;

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
        if (usedVideoIds.has(item.id.videoId)) continue;
        const titleNorm = normalize(item.snippet.title);
        let score = levenshteinRatio(normalizedAI, titleNorm);
        if (artist && titleNorm.includes(artist)) score = Math.max(score, 74);
        if (score > bestYtScore) {
          bestYtScore = score;
          bestYtMatch = item;
        }
      }
      if (!bestYtMatch || bestYtScore < 70) continue;

      const videoId = bestYtMatch.id.videoId;
      const title = bestYtMatch.snippet.title;
      const thumbnail = bestYtMatch.snippet.thumbnails.medium?.url || "";
      const titleNorm = normalize(title);

      let durationSeconds = null;
      try {
        const ytDetails = await axios.get(
          "https://www.googleapis.com/youtube/v3/videos",
          {
            params: { part: "contentDetails", id: videoId, key: YOUTUBE_KEY },
          },
        );
        const durIso = ytDetails.data.items?.[0]?.contentDetails?.duration;
        if (durIso) {
          const m = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
          durationSeconds =
            parseInt(m?.[1] ?? 0, 10) * 60 + parseInt(m?.[2] ?? 0, 10);
        }
      } catch (err) {
        console.warn("[YouTube] duration failed:", err.message);
      }

      await pool.query(
        `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration, public_id)
         VALUES (?, ?, ?, ?, ?, UUID())
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), title_norm = VALUES(title_norm),
           thumbnail = VALUES(thumbnail), duration = VALUES(duration)`,
        [videoId, title, titleNorm, thumbnail, durationSeconds],
      );
      usedVideoIds.add(videoId);
      results.push({ title, youtubeId: videoId, thumbnail, duration: durationSeconds });
    } catch (err) {
      console.warn(`[YouTube] Search failed for "${s.title}":`, err.message);
      if (err.response?.status === 403)
        console.error("[YouTube 403] Check API-Key Restrictions/Quota!");
    }
  }

  const created = [];
  for (const item of results) {
    const [insert] = await pool.query(
      `INSERT INTO queue_items
        (session_id, video_id, status, item_source, item_type, voting_round_id)
       VALUES (?, ?, 'suggested', 'ai', 'music', ?)`,
      [id, item.youtubeId, currentRoundId],
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

  // Notify everyone in the session so the new votable AI items show up live.
  if (created.length > 0) {
    try {
      getIO().to(String(id)).emit("proposals_updated", {});
    } catch (e) {
      /* io not ready — non-fatal */
    }
  }

  return created;
}

module.exports = { generateAiSuggestions };
