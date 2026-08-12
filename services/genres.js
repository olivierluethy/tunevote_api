const { openai, CHAT_MODEL } = require("./openai");

// ---------------------------------------------------------------------------
// GENRES — single source of truth for the fixed genre taxonomy.
//
// Used by the AI genre classifier (tagging youtube_video_cache.genre), the host
// genre selector (sessions.ai_genre / recommendations steering) and the genre
// ranking stats. Never hard-code genre strings elsewhere — import from here.
// ---------------------------------------------------------------------------

const GENRES = [
  "Pop",
  "Hip-Hop/Rap",
  "Rock",
  "Electronic/Dance",
  "R&B/Soul",
  "Latin",
  "Country",
  "Jazz/Blues",
  "Classical",
  "Metal",
  "Folk/Acoustic",
  "Reggae/Dancehall",
  "Schlager/Volksmusik",
  "Other",
];

const SET = new Set(GENRES);

// True when g is exactly one of the fixed genre strings.
const isGenre = (g) => typeof g === "string" && SET.has(g);

// Classify a song title into EXACTLY ONE genre from GENRES. Never throws and
// never returns anything outside the list — falls back to "Other" on any
// failure (no OpenAI key, network error, unparseable reply).
async function classifyGenre(title, artist = "") {
  if (!openai || !title) return "Other";
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      messages: [
        {
          role: "user",
          content:
            `Classify this song into EXACTLY ONE genre from this list: ${GENRES.join(
              ", ",
            )}.\n` +
            `Song: "${title}"${artist ? ` by ${artist}` : ""}.\n` +
            `Reply with only the genre string exactly as written in the list, nothing else.`,
        },
      ],
    });
    const raw = (res.choices?.[0]?.message?.content || "").trim();
    const exact = GENRES.find((g) => g.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const loose = GENRES.find((g) =>
      raw.toLowerCase().includes(g.toLowerCase()),
    );
    return loose || "Other";
  } catch (e) {
    console.warn("classifyGenre failed:", e.message);
    return "Other";
  }
}

module.exports = { GENRES, isGenre, classifyGenre };
