require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const { sendEmail } = require("./email.js");
const crypto = require("crypto");
const ytdl = require("ytdl-core");

const generateResetToken = () => crypto.randomBytes(32).toString("hex");

const hashPassword = (password) => bcrypt.hash(password, 10);

// ---------------------------------------------------------------
// 1. NEW DEPENDENCIES
// ---------------------------------------------------------------
const { Configuration, OpenAIApi } = require("openai");

// ---------------------------------------------------------------
// OPENAI v4+ (openai@6.8.1) – korrekte Initialisierung
// ---------------------------------------------------------------
const { OpenAI } = require("openai");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY missing – recommendations disabled");
}

let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });
}

// ---------------------------------------------------------------
// 3. HELPER: safe JSON parsing from OpenAI
// ---------------------------------------------------------------
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

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "tunevote",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// === DB Connection Check ===
(async () => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT DATABASE() AS db, USER() AS user, NOW() AS time",
    );
    console.log("✅ MySQL connected successfully!");
    console.log("   Database:", rows[0].db);
    console.log("   User:", rows[0].user);
    console.log("   Server time:", rows[0].time);
    connection.release();
  } catch (err) {
    console.error("❌ MySQL connection failed!");
    console.error("   Error:", err.message);
    console.error(
      "   Check your .env settings (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)",
    );
    process.exit(1); // stop server if DB not reachable
  }
})();

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_here";
const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const httpServer = app.listen(4000, () =>
  console.log("Server läuft auf http://localhost:4000"),
);
const io = new Server(httpServer, { cors: { origin: "*" } });

const sessionTimers = {};

// === Auth ===
const getUserFromToken = async (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query(
      "SELECT id, username FROM users WHERE id = ?",
      [decoded.id],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
};

const ensureGuestToken = async () => {
  let guestToken = localStorage.getItem("guestToken");
  const nickname = localStorage.getItem("guestName") || "Gast";

  // Wenn noch kein Token vorhanden, neuen Gast anlegen
  if (!guestToken) {
    try {
      const { data } = await axios.post("http://localhost:4000/guest/join", {
        nickname,
      });
      guestToken = data.guestToken;
      localStorage.setItem("guestToken", guestToken);
      localStorage.setItem("guestName", data.nickname);
      console.log("New guest created:", data);
    } catch (err) {
      console.error("Guest creation failed:", err);
    }
  }

  return guestToken;
};

const getGuestFromToken = async (guestToken) => {
  if (!guestToken) return null;
  try {
    const [rows] = await pool.query(
      "SELECT id, nickname FROM guest_users WHERE guest_token = ?",
      [guestToken],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
};

const ensureParticipant = async (
  sessionId,
  user = null,
  guest = null,
  isHost = false,
) => {
  const column = user ? "user_id" : "guest_id";
  const id = user ? user.id : guest.id;
  const [existing] = await pool.query(
    `SELECT id FROM session_participants WHERE session_id = ? AND ${column} = ?`,
    [sessionId, id],
  );
  if (existing.length === 0) {
    await pool.query(
      `INSERT INTO session_participants (session_id, ${column}, role) VALUES (?, ?, ?)`,
      [sessionId, id, isHost ? "host" : "guest"],
    );
  }
};

// Function to parse ISO duration
const parseIsoDuration = (iso) => {
  let seconds = 0;
  const matches = iso.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (matches) {
    seconds += (parseInt(matches[1]) || 0) * 3600;
    seconds += (parseInt(matches[2]) || 0) * 60;
    seconds += parseInt(matches[3]) || 0;
  }
  return seconds;
};

// Advance to next queue item — Identifikation ausschließlich über queue_items.id / status
const advanceToNext = async (sessionId) => {
  try {
    // 1) Aktuelles playing-Item eindeutig ermitteln (wenn vorhanden)
    //    Wir wählen das zuletzt gestartete "playing"-Item (falls mehrere vorhanden sind).
    const [playingRows] = await pool.query(
      `SELECT id, video_id, item_type, duration, title
       FROM queue_items
       WHERE session_id = ? AND status = 'playing'
       ORDER BY COALESCE(startedAt, created_at) DESC
       LIMIT 1`,
      [sessionId],
    );

    const currentPlaying = playingRows[0] || null;
    const currentPlayingId = currentPlaying?.id || null;

    // 2) Falls ein aktuelles playing-Item existiert -> als played markieren
    if (currentPlayingId) {
      await pool.query(
        `UPDATE queue_items
         SET status = 'played', played = 1, playedAt = NOW()
         WHERE id = ?`,
        [currentPlayingId],
      );

      console.log(
        `[Session ${sessionId}] Marked played: queue_item_id=${currentPlayingId}`,
      );
    } else {
      console.log(
        `[Session ${sessionId}] No item with status='playing' found to mark as played`,
      );
    }

    // 3) Prüfen ob noch ungespielte Items existieren
    const [remaining] = await pool.query(
      `SELECT COUNT(*) as count
       FROM queue_items
       WHERE session_id = ? AND played = 0 AND status IN ('queued', 'playing')`,
      [sessionId],
    );

    if (remaining[0].count === 0) {
      // Alles gespielt — Session zurücksetzen / beenden
      await pool.query(
        `UPDATE queue_items
         SET status = 'queued', played = 0, playedAt = NULL
         WHERE session_id = ? AND status IN ('played', 'skipped', 'playing')`,
        [sessionId],
      );

      await pool.query("UPDATE sessions SET is_live = 0 WHERE id = ?", [
        sessionId,
      ]);
      await pool.query("DELETE FROM playback_sync WHERE session_id = ?", [
        sessionId,
      ]);

      io.to(sessionId).emit("session_ended");
      io.to(sessionId).emit("queue_updated");

      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      delete sessionTimers[sessionId];

      console.log(`[Session ${sessionId}] No remaining items → Session ended`);
      return;
    }

    // 4) Nächstes ungespieltes & queued Item holen (eindeutig über id-Order)
    const [nextItems] = await pool.query(
      `SELECT id, video_id, item_type, duration, title
       FROM queue_items
       WHERE session_id = ? AND played = 0 AND status = 'queued'
       ORDER BY id ASC
       LIMIT 1`,
      [sessionId],
    );

    const next = nextItems[0];
    if (!next) {
      console.warn(
        `[Session ${sessionId}] No next item found despite remaining > 0`,
      );
      return;
    }

    const {
      id: nextId,
      video_id: nextVideoId,
      item_type,
      duration,
      title,
    } = next;

    const startTime = Date.now();

    // 5) Markiere das nächste Item als 'playing' (startedAt setzen)
    await pool.query(
      `UPDATE queue_items
       SET status = 'playing', startedAt = NOW()
       WHERE id = ?`,
      [nextId],
    );

    // 6) PAUSE-Fall: setze playback_sync entsprechend und sende pause events
    if (item_type === "pause") {
      console.log(
        `[Session ${sessionId}] Starting pause: ${title} (QueueItem=${nextId}, ${duration}s)`,
      );

      io.to(sessionId).emit("pause_started", {
        queue_item_id: nextId,
        title,
        duration,
        startTime,
      });

      // playback_sync bleibt ohne current_video_id (NULL), aber wir lassen den client wissen welches queue_item läuft
      await pool.query(
        `UPDATE playback_sync
         SET current_video_id = NULL,
             is_playing = 0,
             video_start_time = ?
         WHERE session_id = ?`,
        [startTime, sessionId],
      );

      // Timer für Ende der Pause
      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      sessionTimers[sessionId] = setTimeout(
        async () => {
          io.to(sessionId).emit("pause_ended", { queue_item_id: nextId });
          await advanceToNext(sessionId);
        },
        (duration || 0) * 1000,
      );

      // Event: Wir senden zusätzlich die queue item id damit Clients es als "LIVE" erkennen können
      io.to(sessionId).emit("playback_sync", {
        current_queue_item_id: nextId,
        current_video_id: null,
        video_start_time: startTime,
        is_playing: false,
      });

      io.to(sessionId).emit("queue_updated");
      return;
    }

    // 7) MUSIC-Fall: Aktualisiere playback_sync und sende Events.
    await pool.query(
      `UPDATE playback_sync
       SET current_video_id = ?, video_start_time = ?, is_playing = 1
       WHERE session_id = ?`,
      [nextVideoId, startTime, sessionId],
    );

    io.to(sessionId).emit("playback_sync", {
      current_queue_item_id: nextId, // für Frontend-LIVE-Markierung (ungültige Spalte in DB nicht nötig)
      current_video_id: nextVideoId,
      video_start_time: startTime,
      is_playing: true,
    });

    io.to(sessionId).emit("queue_updated");

    // 8) Timer für automatisches Weiterspringen nach Duration
    if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
    const safeDurationMs = Math.max(0, (duration || 0) * 1000);
    sessionTimers[sessionId] = setTimeout(
      () => advanceToNext(sessionId),
      safeDurationMs,
    );

    console.log(
      `[Session ${sessionId}] Playing music: ${title} (QueueItem=${nextId}, duration=${duration}s)`,
    );
  } catch (err) {
    console.error(`Error advancing queue for session ${sessionId}:`, err);
  }
};

// === Socket.IO ===
io.on("connection", (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  if (!sessionId) return socket.disconnect();
  socket.join(sessionId);

  socket.on("disconnect", async () => {
    const token = socket.handshake.auth.token;
    const guestToken = socket.handshake.auth.guestToken;

    const user = token ? await getUserFromToken(token) : null;
    const guest = guestToken ? await getGuestFromToken(guestToken) : null;

    if (!user && !guest) return;

    const column = user ? "user_id" : "guest_id";
    const participantId = user ? user.id : guest.id;

    // --- Nur is_live auf 0 setzen statt löschen ---
    await pool.query(
      `UPDATE session_participants 
       SET is_live = 0 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionId, participantId],
    );

    // --- Optional: Event senden ---
    io.to(sessionId).emit("participant_left", {
      participantId,
      isGuest: !!guest,
    });
  });

  socket.on("session_deleted", (data) => {
    alert(data.message);
    window.location.href = "/";
  });
});

// === Playback Sync Endpoint ===
app.get("/sessions/:id/playback-sync", async (req, res) => {
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

// === Auth: Register / Login ===
app.post("/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const [exists] = await pool.query(
      "SELECT 1 FROM users WHERE email = ? OR username = ?",
      [email, username],
    );
    if (exists.length > 0)
      return res.status(409).json({ error: "User exists" });

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
      [username, email, password_hash],
    );
    const token = jwt.sign({ id: result.insertId, username }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Missing credentials" });

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
      email,
    ]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// === Guest join ===
app.post("/guest/join", async (req, res) => {
  const { nickname } = req.body;
  const guestToken = uuidv4();
  await pool.query(
    "INSERT INTO guest_users (guest_token, nickname) VALUES (?, ?)",
    [guestToken, nickname || "Gast"],
  );
  res.json({ guestToken, nickname: nickname || "Gast" });
});

// === Sessions (sichtbar für alle angemeldeten Nutzer + Gäste) ===
app.get("/sessions", async (req, res) => {
  let user = null;
  let isGuest = false;

  // 1. Prüfe eingeloggten Nutzer
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  if (token) {
    try {
      user = await getUserFromToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  // 2. Prüfe Gast
  const guestToken = req.headers["x-guest-token"];
  if (!user && guestToken) {
    try {
      const [rows] = await pool.query(
        "SELECT id, nickname FROM guest_users WHERE guest_token = ?",
        [guestToken],
      );
      if (rows.length > 0) {
        isGuest = true;
        user = { id: null, isGuest: true, nickname: rows[0].nickname }; // Optional
      }
    } catch (err) {
      console.error("Guest token check failed:", err);
    }
  }

  // 3. Kein Zugriff?
  if (!user && !isGuest) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [rows] = await pool.query(`
      SELECT 
        s.id, 
        s.title, 
        s.created_at, 
        u.username AS host, 
        s.user_id AS hostId, 
        s.is_live,
        (
          SELECT COUNT(*) 
          FROM session_participants sp 
          WHERE sp.session_id = s.id AND sp.is_live = 1
        ) AS participant_count
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      ORDER BY participant_count DESC, s.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("Get sessions error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Sessions erstellen ===
app.post("/sessions", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "Title required" });

  try {
    const [result] = await pool.query(
      "INSERT INTO sessions (user_id, title) VALUES (?, ?)",
      [user.id, title.trim()],
    );

    // 🔽 Hier Logging hinzufügen:
    console.log("🟢 Session insert result:", result);

    const sessionId = result.insertId;
    console.log(
      "✅ New session created with ID:",
      sessionId,
      "by user:",
      user.id,
    );

    await ensureParticipant(sessionId, user, null, true);

    const [newSession] = await pool.query(
      "SELECT s.id, s.title, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?",
      [sessionId],
    );

    console.log("📦 Retrieved new session:", newSession[0]);

    res.status(201).json(newSession[0]);
  } catch (err) {
    console.error("❌ Error creating session:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Wenn Benutzer ohne guest user & ohne account -> hier soll nach einer Session gesucht werden die Live ist, und danach sollte diese URL bereitgestellt und über das JSON verschickt werden wodurch man sich in der Live Session befindet.
// === Auto-Join für nicht eingeloggte Benutzer ===
app.get("/join", async (req, res) => {
  try {
    // Prüfen, ob der Benutzer eingeloggt ist (JWT oder Gast)
    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    // Nur fortfahren, wenn KEIN Account & KEIN Gast vorhanden ist
    if (user || guest) {
      return res.status(400).json({ error: "Already authenticated" });
    }

    // Live-Session suchen (erste mit is_live = 1)
    const [sessions] = await pool.query(
      "SELECT id FROM sessions WHERE is_live = 1 ORDER BY created_at ASC LIMIT 1",
    );

    if (sessions.length === 0) {
      return res.status(404).json({ error: "No live session available" });
    }

    const sessionId = sessions[0].id;
    const joinUrl = `http://localhost:5173/session/${sessionId}`;

    // JSON mit Weiterleitungs-URL zurückgeben
    res.json({ redirect: joinUrl });
  } catch (err) {
    console.error("Error in /join:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === Get session (includes is_live) ===
app.get("/sessions/:id", async (req, res) => {
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

// === Queue endpoints ===
app.get("/sessions/:id/queue", async (req, res) => {
  const { id } = req.params;

  const [queue] = await pool.query(
    `
    SELECT 
      qi.*, 
      qi.item_type AS itemType,           -- <-- NEU: camelCase für Frontend
      COALESCE(u.username, g.nickname, 'Gast') AS addedBy
    FROM queue_items qi
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
app.get("/sessions/:id/recommendations", async (req, res) => {
  const { id } = req.params;

  // ---- Auth ----
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getUserFromToken(guestToken) : null;
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
      AND qi.played = 0
    ORDER BY qi.id DESC
    `,
    [id],
  );

  const titles = queueRows.map((r) => r.title);
  if (titles.length < 2) return res.status(200).json([]);

  // ---- NEW: Voting-Round & AI Suggestion Check ----
  const [votingRoundRows] = await pool.query(
    `SELECT id FROM voting_rounds 
     WHERE session_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [id]
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
    [currentRoundId]
  );
  const numItems = suggestedRows[0].count;

  const needed = 3 - numItems;
  if (needed <= 0) {
    console.log("[AI] Already 3 or more items in voting round. Returning existing AI suggestions.");
    const [existingAi] = await pool.query(
      `SELECT id, title, video_id AS youtubeId, thumbnail
       FROM queue_items
       WHERE session_id = ?
         AND voting_round_id = ?
         AND item_source = 'ai'
         AND status = 'suggested'`,
      [id, currentRoundId]
    );
    return res.json(existingAi);
  }

  const [existingAi] = await pool.query(
    `SELECT id, title, video_id AS youtubeId, thumbnail
     FROM queue_items
     WHERE session_id = ?
       AND voting_round_id = ?
       AND item_source = 'ai'
       AND status = 'suggested'`,
    [id, currentRoundId]
  );

  console.log(`[AI] ${numItems} items in voting round. Generating ${needed} AI suggestion(s)...`);

  // ---- Get suggested titles to avoid duplicates ----
  const [suggestedTitleRows] = await pool.query(
    `
    SELECT yvc.title
    FROM queue_items qi
    JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
    WHERE qi.voting_round_id = ? AND qi.status = 'suggested'
    `,
    [currentRoundId]
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
      ((longer.length - levenshteinDistance(longer, shorter)) / longer.length) * 100,
    );
  };

  try {
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
        const score = levenshteinRatio(normalizedAI, row.title_norm);
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
              }
            );

            const durIso = ytDetails.data.items?.[0]?.contentDetails?.duration;
            if (durIso) {
              const match = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
              const mins = parseInt(match?.[1] ?? 0, 10);
              const secs = parseInt(match?.[2] ?? 0, 10);
              durationSeconds = mins * 60 + secs;
              await pool.query(
                `UPDATE youtube_video_cache SET duration = ? WHERE youtube_id = ?`,
                [durationSeconds, bestMatch.youtube_id]
              );
            }
          } catch (err) {
            console.warn("[YouTube] Failed to fetch duration from cache match:", err.message);
          }
        }
        results.push({
          title: bestMatch.title,
          youtubeId: bestMatch.youtube_id,
          thumbnail: bestMatch.thumbnail || "",
          duration: durationSeconds
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

        // ---- NEW: Fetch video duration ----
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
            }
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

        // ---- UPDATED: Cache includes duration ----
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

        // ---- UPDATED: push duration into results ----
        results.push({ 
          title, 
          youtubeId: videoId, 
          thumbnail,
          duration: durationSeconds 
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
          (session_id, video_id, title, thumbnail, duration, status, item_source, item_type, voting_round_id)
         VALUES (?, ?, ?, ?, ?, 'suggested', 'ai', 'music', ?)`,
        [id, item.youtubeId, item.title, item.thumbnail, item.duration, currentRoundId],
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

    const allAi = [...existingAi, ...created];
    return res.json(allAi);
  } catch (err) {
    console.error("[Recommendation Error]", err);
    res.status(500).json({ error: "Recommendation failed" });
  }
});


// ---------------------------------------------------------------
// 5. NEW ENDPOINT – ADD RECOMMENDED SONG (click → queue)
// ---------------------------------------------------------------
app.post("/sessions/:id/recommendations/add", async (req, res) => {
  const { id } = req.params;
  const { youtubeId } = req.body; // nur youtubeId vom Client nötig

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  try {
    // --- Hole Video-Infos aus youtube_video_cache ---
    const [rows] = await pool.query(
      `SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ? LIMIT 1`,
      [youtubeId],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Video nicht gefunden im Cache" });
    }

    const { title, thumbnail, duration } = rows[0];

    await pool.query(
      `INSERT INTO queue_items 
       (session_id, item_type, video_id, title, thumbnail, added_by, guest_id, status, played, duration)
       VALUES (?, 'music', ?, ?, ?, ?, ?, 'suggested', 0, ?)`,
      [
        id,
        youtubeId,
        title,
        thumbnail,
        user?.id || null,
        guest?.id || null,
        duration || 0,
      ],
    );

    io.to(id).emit("queue_updated");
    res.json({ success: true, youtubeId, title, thumbnail, duration });
  } catch (err) {
    console.error("Add recommendation error:", err);
    res.status(500).json({ error: "Failed to add song" });
  }
});

// === Proposals endpoint (POST) ===
app.post("/sessions/:id/proposals", async (req, res) => {
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
    // === FALL: PAUSE ===
    if (item_type === "pause") {
      const duration = pauseDuration || 30;
      const desc = description || "Kurze Pause";

      await pool.query(
        `INSERT INTO queue_items 
         (session_id, item_type, title, description, duration, added_by, guest_id, status, played, item_source)
         VALUES (?, 'pause', ?, ?, ?, ?, ?, 'suggested', 0, ?)`,
        [
          sessionId,
          desc,
          desc,
          duration,
          user?.id || null,
          guest?.id || null,
          user ? "user" : "guest",
        ],
      );

      io.to(sessionId).emit("queue_updated", {});
      return res.status(201).json({ success: true, type: "pause" });
    }

    // === FALL: MUSIK ===
    if (!videoId) {
      return res.status(400).json({ error: "Missing videoId" });
    }

    let title, thumbnail, duration;

    // 1. Versuche aus Cache zu holen
    const [cachedRows] = await pool.query(
      "SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ?",
      [videoId],
    );

    if (cachedRows.length > 0) {
      // Cache-Treffer
      ({ title, thumbnail, duration } = cachedRows[0]);
    } else {
      // 2. Nicht im Cache → ytdl holen und cachen
      try {
        const info = await ytdl.getBasicInfo(
          `https://www.youtube.com/watch?v=${videoId}`,
        );
        const videoDetails = info.videoDetails;

        title = videoDetails.title || clientTitle || "Unbekannter Titel";
        thumbnail =
          videoDetails.thumbnails?.[0]?.url ||
          clientThumbnail ||
          `https://i.ytimg.com/vi/${videoId}/default.jpg`;
        duration = parseInt(videoDetails.lengthSeconds) || 0;

        // In Cache speichern
        await pool.query(
          `INSERT INTO youtube_video_cache 
           (youtube_id, title, title_norm, thumbnail, duration)
           VALUES (?, ?, ?, ?, ?)`,
          [videoId, title, normalize(title), thumbnail, duration],
        );
      } catch (ytdlErr) {
        console.error("ytdl fallback failed for videoId:", videoId, ytdlErr);
        return res.status(400).json({
          error: "Video nicht verfügbar oder konnte nicht geladen werden",
          details: "YouTube-Link ungültig oder Video nicht abrufbar",
        });
      }
    }

    // === Voting-Runde Logik ===
    let [openRounds] = await pool.query(
      "SELECT id FROM voting_rounds WHERE session_id = ? AND status = 'open' LIMIT 1",
      [sessionId],
    );

    let votingRoundId = null;
    let status = "queued";

    if (openRounds.length === 0) {
      const [result] = await pool.query(
        "INSERT INTO voting_rounds (session_id, status, created_at) VALUES (?, 'open', NOW())",
        [sessionId],
      );
      votingRoundId = result.insertId;
      status = "suggested";
    } else {
      votingRoundId = openRounds[0].id;
      status = "suggested";
    }

    // === Max. 5 Vorschläge pro Runde ===
    const [proposalCount] = await pool.query(
      `SELECT COUNT(*) AS count 
       FROM queue_items 
       WHERE session_id = ? 
         AND status = 'suggested'
         AND voting_round_id = ?`,
      [sessionId, votingRoundId],
    );

    if (proposalCount[0].count >= 5) {
      return res.status(400).json({
        message: "Maximal 5 Songs pro Voting-Runde erlaubt.",
      });
    }

    // === Vorschlag in DB speichern ===
    await pool.query(
      `INSERT INTO queue_items 
       (session_id, item_type, video_id, title, thumbnail, added_by, guest_id, status, played, duration, voting_round_id, item_source)
       VALUES (?, 'music', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        sessionId,
        videoId,
        title,
        thumbnail,
        user?.id || null,
        guest?.id || null,
        status,
        duration,
        votingRoundId,
        user ? "user" : "guest",
      ],
    );

    // === Socket Updates ===
    if (status === "suggested") {
      io.to(sessionId).emit("proposal_added", {
        title,
        videoId,
        votingRoundId,
      });
      io.to(sessionId).emit("proposals_updated", {});
    } else {
      io.to(sessionId).emit("queue_updated", {});
    }

    // === Erfolg ===
    res.status(201).json({
      success: true,
      type: "music",
      status,
      votingRoundId,
    });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({
      error: "Interner Serverfehler beim Hinzufügen des Vorschlags",
      details: err.message,
    });
  }
});

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// === GET: Alle vorgeschlagenen Songs (für Voting) ===
app.get("/sessions/:id/proposals", async (req, res) => {
  const { id: sessionId } = req.params;

  try {
    const [proposals] = await pool.query(
      `
      SELECT 
        q.id,
        q.title,
        q.thumbnail,
        q.status,
        q.video_id,
        q.voting_round_id,
        q.item_type,        -- NEU
        q.item_source,      -- NEU
        q.description,      -- für Pausen
        q.duration,
        COALESCE(v.vote_count, 0) AS votes,
        u.username AS addedByUser,
        g.nickname AS addedByGuest
      FROM queue_items q
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
app.post("/voting-rounds/:id/close", async (req, res) => {
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

    io.emit("queue_updated", {});
    res.json({ success: true, winnerId });
  } catch (err) {
    console.error("Voting close error:", err);
    res.status(500).json({ error: "Failed to close voting round" });
  }
});

async function checkQuorum(votingRoundId, sessionId) {
  // Hole Voting Round Daten
  const [roundRows] = await pool.query(
    "SELECT max_suggestions, quorum_percent FROM voting_rounds WHERE id = ?",
    [votingRoundId],
  );
  if (!roundRows[0]) return;

  const { max_suggestions, quorum_percent } = roundRows[0];

  // Anzahl der Votes pro Vorschlag zählen
  const [votesRows] = await pool.query(
    `SELECT queue_item_id, COUNT(*) AS votes 
     FROM votes v
     JOIN queue_items q ON v.queue_item_id = q.id
     WHERE q.voting_round_id = ?
     GROUP BY queue_item_id`,
    [votingRoundId],
  );

  // Prüfen ob Quorum erreicht
  const votesNeeded = Math.ceil(max_suggestions * quorum_percent);
  for (const v of votesRows) {
    if (v.votes >= votesNeeded) {
      // Voting Round schließen und Gewinner setzen
      await pool.query(
        'UPDATE voting_rounds SET status = "computed", winner_queue_item_id = ? WHERE id = ?',
        [v.queue_item_id, votingRoundId],
      );
      io.to(sessionId).emit("voting_round_completed", {
        winner: v.queue_item_id,
      });
      break;
    }
  }
}

// === Voting ===
app.post("/sessions/:id/proposals/:propId/vote", async (req, res) => {
  const { id, propId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // Prüfen, ob Proposal existiert
  const [prop] = await pool.query(
    "SELECT voting_round_id FROM queue_items WHERE id = ? AND session_id = ?",
    [propId, id],
  );
  if (!prop[0]) return res.status(404).json({ error: "Not found" });

  const voterColumn = user ? "user_id" : "guest_id";
  const voterId = user?.id || guest?.id;

  // Prüfen, ob User/Guest schon gelikt hat
  const [existingVote] = await pool.query(
    `SELECT id FROM votes WHERE queue_item_id = ? AND ${voterColumn} = ?`,
    [propId, voterId],
  );

  if (existingVote.length > 0) {
    // Wenn bereits gelikt → Widerruf
    await pool.query(
      `DELETE FROM votes WHERE queue_item_id = ? AND ${voterColumn} = ?`,
      [propId, voterId],
    );
  } else {
    // Neu liken
    await pool.query(
      `INSERT INTO votes (queue_item_id, user_id, guest_id, vote) VALUES (?, ?, ?, 1)`,
      [propId, user?.id || null, guest?.id || null],
    );
  }

  // Event für alle Clients
  io.to(id).emit("proposals_updated");

  // === Prüfen, ob ALLE Teilnehmer abgestimmt haben ===
  const [voteCheck] = await pool.query(
    `
  SELECT 
    p.cnt AS total_participants,
    COALESCE(v.voted_count, 0) AS voted_participants
  FROM (
    SELECT COUNT(*) AS cnt 
    FROM session_participants sp
    WHERE sp.session_id = ?
  ) p
  LEFT JOIN (
    SELECT COUNT(DISTINCT voter_key) AS voted_count
    FROM (
      SELECT CONCAT('U', v.user_id) AS voter_key
      FROM votes v
      JOIN queue_items qi ON v.queue_item_id = qi.id
      WHERE qi.session_id = ? 
        AND qi.status = 'suggested' 
        AND v.user_id IS NOT NULL

      UNION ALL

      SELECT CONCAT('G', v.guest_id) AS voter_key
      FROM votes v
      JOIN queue_items qi ON v.queue_item_id = qi.id
      WHERE qi.session_id = ? 
        AND qi.status = 'suggested' 
        AND v.guest_id IS NOT NULL
    ) AS voters
  ) v ON 1=1
  `,
    [id, id, id],
  );

  const totalParticipants = voteCheck[0].total_participants;
  const votedParticipants = voteCheck[0].voted_participants;

  console.log(
    `Abstimmung: ${votedParticipants}/${totalParticipants} haben abgestimmt`,
  );

  // Nur wenn ALLE abgestimmt haben
  if (totalParticipants > 0 && votedParticipants >= totalParticipants) {
    // === Gewinner ermitteln ===
    const [winnerResult] = await pool.query(
      `
    SELECT 
      qi.id,
      COUNT(v.id) AS vote_count
    FROM queue_items qi
    LEFT JOIN votes v ON qi.id = v.queue_item_id
    WHERE qi.session_id = ? 
      AND qi.status = 'suggested'
    GROUP BY qi.id
    HAVING COUNT(v.id) > 0
    ORDER BY vote_count DESC, qi.created_at ASC
    LIMIT 1
    `,
      [id],
    );

    if (winnerResult.length > 0) {
      const winningId = winnerResult[0].id;

      // Gewinner in Queue verschieben
      await pool.query(
        `UPDATE queue_items SET status = 'queued' WHERE id = ?`,
        [winningId],
      );

      // Alle anderen suggested → archived
      await pool.query(
        `UPDATE queue_items 
       SET status = 'archived' 
       WHERE session_id = ? AND status = 'suggested' AND id != ?`,
        [id, winningId],
      );

      // Optional: Voting-Runde schließen (falls verwendet)
      // await pool.query(`UPDATE voting_rounds SET status = 'computed', winner_queue_item_id = ? WHERE session_id = ? AND status = 'open'`, [winningId, id]);

      // Informiere alle Clients
      io.to(id).emit("proposals_updated");
      io.to(id).emit("queue_updated");

      console.log(
        `Voting abgeschlossen: Song #${winningId} gewinnt in Session ${id}`,
      );
    } else {
      console.log(`Kein Gewinner – kein Song hat Stimmen in Session ${id}`);
    }
  }

  res.json({ success: true });
});

// === Host: direct queue add (blocked if session is_live) ===
app.post("/sessions/:id/queue/add", async (req, res) => {
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

    await pool.query(
      "INSERT INTO queue_items (session_id, video_id, title, thumbnail, added_by, status, played, duration) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      [id, videoId, title, thumbnail, user.id, "queued", duration],
    );

    io.to(id).emit("queue_updated", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Queue add error:", err);
    res.status(500).json({ error: "Failed to add to queue" });
  }
});

// === Session löschen (nur Host) ===
app.delete("/sessions/:id", async (req, res) => {
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
    io.to(id).emit("session_deleted", {
      message: "Die Session wurde vom Host gelöscht.",
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Delete session error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Start session (host) ===
app.post("/sessions/:id/start", async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query("SELECT is_live FROM sessions WHERE id = ?", [
    id,
  ]);
  if (sess[0]?.is_live) {
    return res.status(400).json({ error: "Session already live" });
  }

  // 🧹 Reset playback_sync
  await pool.query(`DELETE FROM playback_sync WHERE session_id = ?`, [id]);

  // 🚀 Set session to live
  await pool.query("UPDATE sessions SET is_live = 1 WHERE id = ?", [id]);

  // 🎵 Fetch first unplayed song
  const [first] = await pool.query(
    "SELECT id, video_id, duration FROM queue_items WHERE session_id = ? AND played = 0 ORDER BY id ASC LIMIT 1",
    [id],
  );

  if (!first[0]) {
    io.to(id).emit("queue_empty");
    return res.status(400).json({ error: "Queue empty" });
  }

  const firstId = first[0].id;
  const firstVideoId = first[0].video_id;
  const duration = first[0].duration;
  const startTime = Date.now();

  // 🕒 Mark first song as playing
  await pool.query(
    `UPDATE queue_items SET status = 'playing', playedAt = NOW() WHERE id = ?`,
    [firstId],
  );

  // 🧩 Set playback sync
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
    `[Playback] Session ${id} STARTED with first song: videoId=${firstVideoId}`,
  );

  // 📡 Broadcast: the radio goes live
  io.to(id).emit("session_started", {
    autoStarted: true,
    firstVideoId,
    video_start_time: startTime,
  });

  // 📻 Broadcast playback state
  io.to(id).emit("playback_sync", {
    current_video_id: firstVideoId,
    video_start_time: startTime,
    is_playing: true,
  });

  // Start timer for first song
  if (sessionTimers[id]) clearTimeout(sessionTimers[id]);
  sessionTimers[id] = setTimeout(() => advanceToNext(id), duration * 1000);

  console.log(
    `[Session ${id}] Radio started with first song (${firstVideoId})`,
  );
  res.json({ success: true });
});

// === Join Live ===
// === Join Live ===
app.post("/sessions/:id/join-live", async (req, res) => {
  try {
    const { id } = req.params;

    console.log("📥 [JOIN-LIVE] Incoming request:", {
      sessionId: id,
      headersAuth: req.headers.authorization,
      headersGuest: req.headers["x-guest-token"],
      ip: req.ip,
      cookies: req.headers.cookie,
    });

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];

    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    console.log("🔍 [JOIN-LIVE] Token decoded:", {
      user: user ? { id: user.id, name: user.name } : null,
      guest: guest ? { id: guest.id, tempName: guest.tempName } : null,
    });

    if (!user && !guest) {
      console.warn("❌ [JOIN-LIVE] Unauthorized — no valid token");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [sess] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );
    if (!sess[0]) {
      console.warn("⚠️ [JOIN-LIVE] Session not found:", id);
      return res.status(404).json({ error: "Session not found" });
    }

    const column = user ? "user_id" : "guest_id";
    const participantId = user ? user.id : guest.id;

    console.log("👤 [JOIN-LIVE] Participant attempting to join:", {
      sessionId: id,
      participantId,
      type: user ? "user" : "guest",
      role: user ? (sess[0].user_id === user.id ? "host" : "user") : "guest",
    });

    const sessionIdInt = parseInt(id, 10);
    const participantIdInt = parseInt(participantId, 10);
    const role = user
      ? sess[0].user_id === user.id
        ? "host"
        : "user"
      : "guest";

    // === 1) Prüfen ob Eintrag existiert ===
    const [existing] = await pool.query(
      `SELECT * FROM session_participants 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    if (existing.length > 0) {
      // === 2) Existiert bereits → nur reaktivieren ===
      console.log(
        "♻️ [JOIN-LIVE] Participant exists — updating is_live=1",
        existing[0],
      );

      await pool.query(
        `UPDATE session_participants 
         SET is_live = 1, role = ?
         WHERE session_id = ? AND ${column} = ?`,
        [role, sessionIdInt, participantIdInt],
      );
    } else {
      // === 3) Existiert NICHT → Insert ===
      console.log("🆕 [JOIN-LIVE] Inserting new participant");

      await pool.query(
        `INSERT INTO session_participants (session_id, ${column}, role, is_live)
         VALUES (?, ?, ?, 1)`,
        [sessionIdInt, participantIdInt, role],
      );
    }

    // === Final check ===
    const [check] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    console.log("📝 [JOIN-LIVE] DB state after join:", check);

    console.log("✅ [JOIN-LIVE] Join successful:", {
      sessionId: sessionIdInt,
      participantId: participantIdInt,
      role,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [JOIN-LIVE] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === Leave Live ===
app.post("/sessions/:id/leave-live", async (req, res) => {
  try {
    const sessionIdInt = parseInt(req.params.id, 10);

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

    const column = user ? "user_id" : "guest_id";
    const participantIdInt = parseInt(user ? user.id : guest.id, 10);

    await pool.query(
      `UPDATE session_participants SET is_live = 0 WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    io.to(sessionIdInt).emit("participant_left", {
      participantId: participantIdInt,
      isGuest: !!guest,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Live stream endpoint (HOOK) ===
app.get("/sessions/:id/live/stream", async (req, res) => {
  res.status(501).json({
    error:
      "Live streaming not implemented on backend. Integrate WebRTC/mediasoup or an audio streaming server.",
  });
});

// POST /forgot-password
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const [users] = await pool.query(
      "SELECT id, username FROM users WHERE email = ?",
      [email],
    );
    const user = users[0];
    if (!user) return res.status(404).json({ error: "Email not found" });

    const resetToken = generateResetToken();
    const expiry = new Date(Date.now() + 3600000); // 1 Stunde

    await pool.query(
      "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?",
      [resetToken, expiry, user.id],
    );

    const resetLink = `http://localhsot/reset-password/${resetToken}`;
    await sendEmail(
      email,
      "Passwort zurücksetzen",
      `Klicke hier, um dein Passwort zurückzusetzen: ${resetLink}\n\nDer Link läuft in 1 Stunde ab.`,
    );

    res.json({ message: "Reset-Link per E-Mail gesendet!" });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// POST /reset-password
app.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword)
    return res.status(400).json({ error: "Token und Passwort erforderlich" });

  try {
    const [users] = await pool.query(
      "SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()",
      [token],
    );

    if (!users[0])
      return res.status(400).json({ error: "Token ungültig oder abgelaufen" });

    const userId = users[0].id;
    const password_hash = await hashPassword(newPassword);

    await pool.query(
      "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
      [password_hash, userId],
    );

    res.json({ message: "Passwort erfolgreich zurückgesetzt!" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/youtube-cache", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT title_norm, title, youtube_id AS youtubeId, thumbnail FROM youtube_video_cache",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Cache fetch failed" });
  }
});

app.post("/youtube-cache", async (req, res) => {
  const { title_norm, title, youtube_id, thumbnail } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO youtube_video_cache (title_norm, title, youtube_id, thumbnail)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        thumbnail = VALUES(thumbnail)
    `,
      [title_norm, title, youtube_id, thumbnail],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Cache save failed" });
  }
});

app.get("/youtube-info/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // 1. Erst prüfen, ob es bereits im Cache ist
    const [cached] = await pool.query(
      "SELECT * FROM youtube_video_cache WHERE youtube_id = ?",
      [id],
    );

    if (cached.length) {
      // Cache-Treffer → exakt dasselbe Format wie YouTube-API zurückgeben
      const row = cached[0];
      return res.json({
        id: { videoId: id },
        snippet: {
          title: row.title,
          description: "", // optional
          channelTitle: "", // optional
          thumbnails: {
            default: { url: row.thumbnail },
            medium: { url: row.thumbnail },
            high: { url: row.thumbnail },
          },
        },
      });
    }

    // 2. Nicht im Cache → mit ytdl holen
    const info = await ytdl.getBasicInfo(
      `https://www.youtube.com/watch?v=${id}`,
    );

    const thumbs = info.videoDetails.thumbnails || [];
    const getThumb = (size) => {
      const map = { default: 0, medium: 1, high: thumbs.length - 1 };
      return (
        thumbs[map[size]]?.url || `https://i.ytimg.com/vi/${id}/${size}.jpg`
      );
    };

    const title = info.videoDetails.title || "Unbekannter Titel";
    const thumbnail = getThumb("default"); // wir nutzen nur default im Cache

    // 3. **In Cache schreiben**
    await pool.query(
      `INSERT INTO youtube_video_cache 
       (youtube_id, title, thumbnail, title_norm, duration) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        title,
        thumbnail,
        normalize(title), // deine normalize-Funktion
        info.videoDetails.lengthSeconds || 0,
      ],
    );

    // 4. Antwort im YouTube-API-Format
    res.json({
      id: { videoId: id },
      snippet: {
        title,
        description: info.videoDetails.description || "",
        channelTitle: info.videoDetails.author?.name || "",
        thumbnails: {
          default: { url: thumbnail },
          medium: { url: getThumb("medium") },
          high: { url: getThumb("high") },
        },
      },
    });
  } catch (err) {
    console.error("YTDL error:", err);
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});
