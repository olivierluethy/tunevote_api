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
    const cleaned = text
      .replace(/^```(?:json)?\s*|\s*```$/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.filter(s => s.title && s.youtubeId) : [];
  } catch (e) {
    console.warn("OpenAI JSON parse failed:", e.message, "\nRaw:", text);
    return [];
  }
};

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tunevote',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// === DB Connection Check ===
(async () => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query("SELECT DATABASE() AS db, USER() AS user, NOW() AS time");
    console.log("✅ MySQL connected successfully!");
    console.log("   Database:", rows[0].db);
    console.log("   User:", rows[0].user);
    console.log("   Server time:", rows[0].time);
    connection.release();
  } catch (err) {
    console.error("❌ MySQL connection failed!");
    console.error("   Error:", err.message);
    console.error("   Check your .env settings (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)");
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

// Advance to next song
const advanceToNext = async (sessionId) => {
  try {
    const [sync] = await pool.query(
      "SELECT current_video_id FROM playback_sync WHERE session_id = ?",
      [sessionId]
    );
    if (!sync[0]) return;

    const currentVideoId = sync[0].current_video_id;

    // Mark current as played (Pause hat evtl. NULL video_id → extra Bedingung)
    await pool.query(
      `UPDATE queue_items 
       SET status = 'played', played = 1, playedAt = NOW() 
       WHERE session_id = ? AND (video_id = ? OR (video_id IS NULL AND ? IS NULL)) AND played = 0`,
      [sessionId, currentVideoId, currentVideoId]
    );

    // Check remaining
    const [remaining] = await pool.query(
      "SELECT COUNT(*) as count FROM queue_items WHERE session_id = ? AND played = 0",
      [sessionId]
    );

    if (remaining[0].count === 0) {
      await pool.query(
        `UPDATE queue_items SET status = 'queued', played = 0, playedAt = NULL WHERE session_id = ?`,
        [sessionId]
      );
      await pool.query("UPDATE sessions SET is_live = 0 WHERE id = ?", [sessionId]);
      await pool.query("DELETE FROM playback_sync WHERE session_id = ?", [sessionId]);
      io.to(sessionId).emit("session_ended", { message: "All items played" });
      io.to(sessionId).emit("queue_updated");
      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      delete sessionTimers[sessionId];
      return;
    }

    // Get next item
    const [nextItems] = await pool.query(
      `SELECT id, video_id, item_type, duration, title 
       FROM queue_items 
       WHERE session_id = ? AND played = 0 
       ORDER BY id ASC 
       LIMIT 1`,
      [sessionId]
    );

    const next = nextItems[0];
    if (!next) return;

    const { id: nextId, video_id: nextVideoId, item_type, duration, title } = next;
    const startTime = Date.now();

    // Mark as playing
    await pool.query(
      `UPDATE queue_items SET status = 'playing', playedAt = NOW() WHERE id = ?`,
      [nextId]
    );

    // PAUSE HANDLING 🟨
    if (item_type === "pause") {
      console.log(`[Session ${sessionId}] Starting pause: ${title} (${duration}s)`);

      io.to(sessionId).emit("pause_started", {
        title,
        duration,
        startTime,
      });

      // Stelle sicher, dass wir Playback-Sync zurücksetzen
      await pool.query(
        `UPDATE playback_sync 
         SET current_video_id = NULL, is_playing = 0, video_start_time = ? 
         WHERE session_id = ?`,
        [startTime, sessionId]
      );

      // Timer für das Ende der Pause
      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      sessionTimers[sessionId] = setTimeout(async () => {
        io.to(sessionId).emit("pause_ended", { title });
        await advanceToNext(sessionId);
      }, duration * 1000);

      return; // ⛔ Nicht weiter abspielen, Pause beendet hier den aktuellen Durchgang
    }

    // MUSIC HANDLING 🎵
    await pool.query(
      `UPDATE playback_sync 
       SET current_video_id = ?, video_start_time = ?, is_playing = 1 
       WHERE session_id = ?`,
      [nextVideoId, startTime, sessionId]
    );

    io.to(sessionId).emit("playback_sync", {
      current_video_id: nextVideoId,
      video_start_time: startTime,
      is_playing: true,
    });
    io.to(sessionId).emit("queue_updated");

    if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
    sessionTimers[sessionId] = setTimeout(() => advanceToNext(sessionId), duration * 1000);

    console.log(`[Session ${sessionId}] Playing music: ${nextVideoId} (${duration}s)`);

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

    await pool.query(
      `DELETE FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionId, participantId]
    );
  });

  socket.on("session_deleted", (data) => {
    alert(data.message); // Zeige eine Nachricht an
    // Optional: Weiterleitung zur Hauptseite oder Session-Liste
    window.location.href = "/"; // Beispiel: Zur Hauptseite weiterleiten
  });
});

// === Playback Sync Endpoint ===
app.get("/sessions/:id/playback-sync", async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT current_video_id, video_start_time, is_playing FROM playback_sync WHERE session_id = ?",
      [id]
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
        [guestToken]
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
          WHERE sp.session_id = s.id
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
      [user.id, title.trim()]
    );

    // 🔽 Hier Logging hinzufügen:
    console.log("🟢 Session insert result:", result);

    const sessionId = result.insertId;
    console.log("✅ New session created with ID:", sessionId, "by user:", user.id);

    await ensureParticipant(sessionId, user, null, true);

    const [newSession] = await pool.query(
      "SELECT s.id, s.title, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?",
      [sessionId]
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
      "SELECT id FROM sessions WHERE is_live = 1 ORDER BY created_at ASC LIMIT 1"
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
    SELECT qi.*, COALESCE(u.username, g.nickname, 'Gast') AS addedBy
    FROM queue_items qi
    LEFT JOIN users u ON qi.added_by = u.id
    LEFT JOIN guest_users g ON qi.guest_id = g.id
    WHERE qi.session_id = ?
    ORDER BY qi.id ASC
  `,
    [id],
  );
  res.json(queue);
});

// === Proposals endpoint (POST) ===
app.post("/sessions/:id/proposals", async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail, item_type, duration, description } = req.body;

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query("SELECT is_live FROM sessions WHERE id = ?", [id]);
  if (!sess[0]) return res.status(404).json({ error: "Session not found" });

  try {
    // 🟨 1️⃣ FALL: PAUSE
    if (item_type === "pause") {
      await pool.query(
        `INSERT INTO queue_items 
         (session_id, item_type, title, description, duration, added_by, guest_id, status, played)
         VALUES (?, 'pause', ?, ?, ?, ?, ?, 'queued', 0)`,
        [
          id,
          description || "Pause",
          description || "Pause",
          duration || 30,
          user?.id || null,
          guest?.id || null
        ]
      );

      io.to(id).emit("queue_updated", {});
      return res.status(201).json({ success: true, type: "pause" });
    }

    // 🟦 2️⃣ FALL: MUSIK (Standard)
    if (!videoId || !title) {
      return res.status(400).json({ error: "Missing videoId or title" });
    }

    if (!YOUTUBE_KEY) throw new Error("YouTube API key missing");

    const ytRes = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "contentDetails",
          id: videoId,
          key: YOUTUBE_KEY,
        },
      }
    );

    const durationIso = ytRes.data.items[0]?.contentDetails.duration;
    const durationSeconds = parseIsoDuration(durationIso);

    await pool.query(
      `INSERT INTO queue_items 
       (session_id, item_type, video_id, title, thumbnail, added_by, guest_id, status, played, duration)
       VALUES (?, 'music', ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      [
        id,
        videoId,
        title,
        thumbnail,
        user?.id || null,
        guest?.id || null,
        durationSeconds,
      ]
    );

    io.to(id).emit("queue_updated", {});
    res.status(201).json({ success: true, type: "music" });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Failed to add proposal" });
  }
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
      }
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
      [id]
    );
    if (!session[0]) return res.status(404).json({ error: "Session not found" });
    if (session[0].user_id !== user.id) {
      return res.status(403).json({ error: "Only the host can delete the session" });
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

  const [sess] = await pool.query("SELECT is_live FROM sessions WHERE id = ?", [id]);
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
    [id]
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
    [firstId]
  );

  // 🧩 Set playback sync
  await pool.query(
    `INSERT INTO playback_sync (session_id, current_video_id, progress_seconds, is_playing, video_start_time)
     VALUES (?, ?, 0, 1, ?)
     ON DUPLICATE KEY UPDATE
       current_video_id = VALUES(current_video_id),
       video_start_time = VALUES(video_start_time),
       is_playing = 1`,
    [id, firstVideoId, startTime]
  );
  console.log(`[Playback] Session ${id} STARTED with first song: videoId=${firstVideoId}`);

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

  console.log(`[Session ${id}] Radio started with first song (${firstVideoId})`);
  res.json({ success: true });
});

// === Join Live ===
app.post("/sessions/:id/join-live", async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  const [sess] = await pool.query("SELECT user_id FROM sessions WHERE id = ?", [id]);
  if (!sess[0]) return res.status(404).json({ error: "Session not found" });

  const column = user ? "user_id" : "guest_id";
  const participantId = user ? user.id : guest.id;
  const role = user && sess[0].user_id === user.id ? "host" : "guest";

  const [exists] = await pool.query(
    `SELECT id FROM session_participants WHERE session_id = ? AND ${column} = ?`,
    [id, participantId]
  );
  if (exists.length === 0) {
    await pool.query(
      `INSERT INTO session_participants (session_id, ${column}, role) VALUES (?, ?, ?)`,
      [id, participantId, role]
    );
  }

  res.json({ success: true });
});

// === Leave Live ===
app.post("/sessions/:id/leave-live", async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  const column = user ? "user_id" : "guest_id";
  const participantId = user ? user.id : guest.id;

  await pool.query(
    `DELETE FROM session_participants WHERE session_id = ? AND ${column} = ?`,
    [id, participantId]
  );

  io.to(id).emit("participant_left", { participantId, isGuest: !!guest });

  res.json({ success: true });
});

// === Live stream endpoint (HOOK) ===
app.get("/sessions/:id/live/stream", async (req, res) => {
  res.status(501).json({
    error:
      "Live streaming not implemented on backend. Integrate WebRTC/mediasoup or an audio streaming server.",
  });
});

// POST /forgot-password
app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const [users] = await pool.query("SELECT id, username FROM users WHERE email = ?", [email]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: "Email not found" });

    const resetToken = generateResetToken();
    const expiry = new Date(Date.now() + 3600000); // 1 Stunde

    await pool.query(
      "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?",
      [resetToken, expiry, user.id]
    );

    const resetLink = `http://localhsot/reset-password/${resetToken}`;
    await sendEmail(
      email,
      "Passwort zurücksetzen",
      `Klicke hier, um dein Passwort zurückzusetzen: ${resetLink}\n\nDer Link läuft in 1 Stunde ab.`
    );

    res.json({ message: "Reset-Link per E-Mail gesendet!" });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// POST /reset-password
app.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "Token und Passwort erforderlich" });

  try {
    const [users] = await pool.query(
      "SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > NOW()",
      [token]
    );

    if (!users[0]) return res.status(400).json({ error: "Token ungültig oder abgelaufen" });

    const userId = users[0].id;
    const password_hash = await hashPassword(newPassword);

    await pool.query(
      "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
      [password_hash, userId]
    );

    res.json({ message: "Passwort erfolgreich zurückgesetzt!" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// ---------------------------------------------------------------
// 4. UPDATED ENDPOINT – GET RECOMMENDATIONS (AI + YouTube Search)
// ---------------------------------------------------------------
app.get("/sessions/:id/recommendations", async (req, res) => {
  const { id } = req.params;

  // ---- Auth ----
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // ---- Session check ----
  const [sessionRows] = await pool.query(
    "SELECT is_live FROM sessions WHERE id = ?",
    [id]
  );
  if (!sessionRows[0]?.is_live)
    return res.status(400).json({ error: "Session not live" });

  // ---- Queue holen ----
  const [queueRows] = await pool.query(
    `SELECT title FROM queue_items 
     WHERE session_id = ? AND item_type = 'music' AND played = 0
     ORDER BY id ASC LIMIT 3`,
    [id]
  );
  const titles = queueRows.map((r) => r.title);
  if (titles.length < 2) return res.status(200).json([]);

  // ---- Cache prüfen ----
  const [cacheRows] = await pool.query(
    "SELECT data, expires FROM recommendation_cache WHERE session_id = ?",
    [id]
  );
  const cached = cacheRows?.[0];
  if (cached && new Date(cached.expires) > new Date()) {
    let data = typeof cached.data === "string" ? JSON.parse(cached.data) : cached.data;
    return res.json(data);
  }

  // ---- Prompt (AI → nur Titel) ----
  const prompt = `
You are a music recommendation engine with up-to-date knowledge of popular songs and their official YouTube music videos (as of mid-2025).

I will give you a list of song titles (artist + title).
Your task: Recommend 2 to 3 additional songs that match in style, mood, energy, or theme — only songs with official, high-quality YouTube music videos (VEVO, official artist channels, or label uploads).

Rules:
Only suggest songs that are widely known and have stable, official YouTube videos (e.g., from VEVO, Warner, Sony, Universal, or official artist channels).
Do NOT suggest remixes, fan uploads, lyric videos, or deleted/unavailable content.
You must know the exact YouTube video ID from your training data — do not guess or fabricate IDs.
If you're unsure about a video ID, skip that song — never output an invalid or broken link.

Output only a JSON array of objects with:
"title": Full "Artist - Song Title"
"youtubeId": The correct, official YouTube video ID (11 characters)

No explanations, no extra text, no markdown.

Example Input:
["The Weeknd - Blinding Lights", "Dua Lipa - Levitating", "Harry Styles - As It Was"]

Correct Output:
[
{"title": "Doja Cat - Say So", "youtubeId": "F3EG4outsD0"},
{"title": "Lizzo - About Damn Time", "youtubeId": "IzS7BaatisA"},
{"title": "The Kid LAROI, Justin Bieber - STAY", "youtubeId": "kTJczUoc26U"}
]

Now recommend for:
${JSON.stringify(titles)}
`;

  try {
    console.log("[OpenAI] Requesting recommendations for session:", id);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 400,
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let aiSuggestions = safeParseOpenAI(raw);

    // Fallback-Sicherung
    if (!Array.isArray(aiSuggestions)) aiSuggestions = [];
    aiSuggestions = aiSuggestions.filter((s) => s?.title);

    // ---- YouTube Search für jeden vorgeschlagenen Titel ----
    const results = [];
    for (const sug of aiSuggestions) {
      const q = sug.title;
      try {
        const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/search", {
          params: {
            part: "snippet",
            q,
            type: "video",
            videoCategoryId: "10",
            maxResults: 1,
            key: YOUTUBE_KEY,
          },
        });

        const video = ytRes.data.items?.[0];
        if (!video) continue;

        results.push({
          title: video.snippet.title,
          youtubeId: video.id.videoId,
          thumbnail: video.snippet.thumbnails.medium?.url || "",
        });
      } catch (ytErr) {
        console.warn(`[YouTube] Failed for "${q}":`, ytErr.message);
      }
    }

    // ---- Cache speichern ----
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query(
      `INSERT INTO recommendation_cache (session_id, data, expires)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?, expires = ?`,
      [id, JSON.stringify(results), expires, JSON.stringify(results), expires]
    );

    console.log(`[Recommend] ${results.length} results cached for session ${id}`);
    return res.json(results);
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
  const { youtubeId, title } = req.body;

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // ---- fetch thumbnail + duration (same logic as normal proposal) ----
  if (!YOUTUBE_KEY) return res.status(500).json({ error: "YouTube key missing" });

  try {
    const ytRes = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
      params: { part: "snippet,contentDetails", id: youtubeId, key: YOUTUBE_KEY },
    });
    const item = ytRes.data.items[0];
    if (!item) return res.status(404).json({ error: "Video not found" });

    const thumbnail = item.snippet.thumbnails.medium?.url || "";
    const duration = parseIsoDuration(item.contentDetails.duration);

    await pool.query(
      `INSERT INTO queue_items 
       (session_id, item_type, video_id, title, thumbnail, added_by, guest_id, status, played, duration)
       VALUES (?, 'music', ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      [id, youtubeId, title, thumbnail, user?.id || null, guest?.id || null, duration]
    );

    io.to(id).emit("queue_updated");
    res.json({ success: true });
  } catch (err) {
    console.error("Add recommendation error:", err);
    res.status(500).json({ error: "Failed to add song" });
  }
});