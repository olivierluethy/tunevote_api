const { OpenAI } = require("openai");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY missing – recommendations disabled");
}

// Null when no key is configured; callers must guard against that.
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// Chat model for song recommendations. Configurable so it can be swapped or
// rolled back without a code change. Defaults to gpt-4o-mini: far more diverse
// and current than gpt-3.5-turbo, and cheap.
const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Safely parse a JSON array of song suggestions out of an OpenAI text response,
// tolerating ```json fences and malformed output.
const safeParseOpenAI = (text) => {
  if (!text) return [];
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed)
      ? parsed.filter((s) => s.title && s.youtubeId)
      : [];
  } catch (e) {
    console.warn("OpenAI JSON parse failed:", e.message, "\nRaw:", text);
    return [];
  }
};

module.exports = { openai, safeParseOpenAI, CHAT_MODEL };
