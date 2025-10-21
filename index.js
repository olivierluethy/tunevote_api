// src/server/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// MySQL Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tunevote',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// JWT & Guest Token
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';
const GUEST_TOKEN_EXPIRY = 60 * 60 * 24 * 7; // 7 Tage

// Socket.IO
const httpServer = app.listen(4000, () => {
  console.log('Server läuft auf http://localhost:4000');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

// === Hilfsfunktionen ===
const getUserFromToken = async (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query('SELECT id, username FROM users WHERE id = ?', [decoded.id]);
    return rows[0] || null;
  } catch {
    return null;
  }
};

const getGuestFromToken = async (guestToken) => {
  if (!guestToken) return null;
  const [rows] = await pool.query('SELECT id, nickname FROM guest_users WHERE guest_token = ?', [guestToken]);
  return rows[0] || null;
};

const ensureParticipant = async (sessionId, user = null, guest = null) => {
  const client = user ? { type: 'user', id: user.id } : { type: 'guest', id: guest.id };
  const [existing] = await pool.query(
    'SELECT id FROM session_participants WHERE session_id = ? AND ?? = ?',
    [sessionId, client.type + '_id', client.id]
  );

  if (existing.length === 0) {
    await pool.query(
      'INSERT INTO session_participants (session_id, ??, role) VALUES (?, ?, ?)',
      [client.type + '_id', sessionId, client.id, client.type === 'user' ? 'host' : 'guest']
    );
  }
};

// === Socket.IO: Playback Sync ===
io.on('connection', (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  if (!sessionId) return socket.disconnect();

  socket.join(sessionId);

  // Sende aktuellen Zustand
  pool.query('SELECT * FROM playback_sync WHERE session_id = ?', [sessionId])
    .then(([rows]) => {
      if (rows[0]) socket.emit('playback_state', rows[0]);
    });

  socket.on('host_play', ({ videoId, progress }) => {
    pool.query(
      'INSERT INTO playback_sync (session_id, current_video_id, progress_seconds, is_playing) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE current_video_id = ?, progress_seconds = ?, is_playing = 1, updated_at = NOW()',
      [sessionId, videoId, progress, videoId, progress]
    );
    io.to(sessionId).emit('playback_state', { current_video_id: videoId, progress_seconds: progress, is_playing: true });
  });

  socket.on('host_pause', (progress) => {
    pool.query(
      'UPDATE playback_sync SET progress_seconds = ?, is_playing = 0, updated_at = NOW() WHERE session_id = ?',
      [progress, sessionId]
    );
    io.to(sessionId).emit('playback_state', { progress_seconds: progress, is_playing: false });
  });

  socket.on('disconnect', () => {
    socket.leave(sessionId);
  });
});

// === Auth: Register / Login ===
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const [exists] = await pool.query('SELECT 1 FROM users WHERE email = ? OR username = ?', [email, username]);
    if (exists.length > 0) return res.status(409).json({ error: 'User exists' });

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', [username, email, password_hash]);
    const token = jwt.sign({ id: result.insertId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === Guest Join (ohne Login) ===
app.post('/guest/join', async (req, res) => {
  const { nickname } = req.body;
  try {
    const guestToken = uuidv4();
    await pool.query(
      'INSERT INTO guest_users (guest_token, nickname) VALUES (?, ?)',
      [guestToken, nickname || null]
    );
    res.json({ guestToken, nickname: nickname || 'Gast' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === Sessions (nur vom aktuellen Host) ===
app.get('/sessions', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  const user = await getUserFromToken(token);

  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.title, s.created_at, u.username AS host
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `, [user.id]);

    res.json(rows);
  } catch (err) {
    console.error('Get sessions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Sessions erstellen ===
app.post('/sessions', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });

  try {
    const [result] = await pool.query(
      'INSERT INTO sessions (user_id, title) VALUES (?, ?)',
      [user.id, title.trim()]
    );
    const sessionId = result.insertId;

    // Teilnehmer hinzufügen
    await ensureParticipant(sessionId, user);

    // Vollständige Session zurückgeben
    const [newSession] = await pool.query(
      'SELECT s.id, s.title, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?',
      [sessionId]
    );

    res.status(201).json(newSession[0]);
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Session laden (Host + Teilnehmer) ===
app.get('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  const guestToken = req.headers['x-guest-token'];

  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. Session holen
    const [sessRows] = await pool.query(
      'SELECT s.*, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.is_active = 1',
      [id]
    );
    if (!sessRows[0]) return res.status(404).json({ error: 'Session not found' });

    const session = sessRows[0];

    // 2. Teilnehmer eintragen (falls noch nicht geschehen)
    await ensureParticipant(id, user, guest);

    // 3. Antwort: **hostId** (damit Frontend Host‑Check funktioniert)
    res.json({
      ...session,
      hostId: session.user_id,   // <-- wichtig!
    });
  } catch (err) {
    console.error('GET /sessions/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Queue ===
app.get('/sessions/:id/queue', async (req, res) => {
  const { id } = req.params;
  try {
    const [queue] = await pool.query(`
      SELECT qi.*, u.username AS addedBy
      FROM queue_items qi
      LEFT JOIN users u ON qi.added_by = u.id
      WHERE qi.session_id = ? AND qi.position IS NOT NULL
      ORDER BY qi.position ASC
    `, [id]);

    // ← Immer Array!
    res.json(queue); // z. B. [{ id: 1, title: "...", ... }, ...]
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Proposals (Vorschläge) ===
app.get('/sessions/:id/proposals', async (req, res) => {
  const { id } = req.params;
  try {
    const [proposals] = await pool.query(`
      SELECT qi.*, COALESCE(v.votes, 0) AS votes, u.username AS addedBy
      FROM queue_items qi
      LEFT JOIN users u ON qi.added_by = u.id
      LEFT JOIN (SELECT queue_item_id, COUNT(*) AS votes FROM votes WHERE vote = 1 GROUP BY queue_item_id) v ON qi.id = v.queue_item_id
      WHERE qi.session_id = ? AND qi.position IS NULL
      ORDER BY votes DESC, qi.created_at ASC
      LIMIT 10
    `, [id]);
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/sessions/:id/proposals', async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  const guestToken = req.headers['x-guest-token'];

  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [existing] = await pool.query(
      'SELECT 1 FROM queue_items WHERE session_id = ? AND position IS NULL AND video_id = ?',
      [id, videoId]
    );
    if (existing.length > 0) return res.status(409).json({ error: 'Already proposed' });

    const [result] = await pool.query(
      'INSERT INTO queue_items (session_id, video_id, title, thumbnail, added_by, guest_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, videoId, title, thumbnail, user?.id || null, guest?.id || null]
    );

    await ensureParticipant(id, user, guest);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === Voting ===
app.post('/sessions/:id/proposals/:propId/vote', async (req, res) => {
  const { id, propId } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  const guestToken = req.headers['x-guest-token'];

  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [proposal] = await pool.query('SELECT 1 FROM queue_items WHERE id = ? AND session_id = ? AND position IS NULL', [propId, id]);
    if (!proposal[0]) return res.status(404).json({ error: 'Proposal not found' });

    const [vote] = await pool.query(
      'SELECT vote FROM votes WHERE queue_item_id = ? AND ?? = ?',
      [propId, user ? 'user_id' : 'guest_id', user?.id || guest?.id]
    );

    if (vote.length > 0) {
      await pool.query('DELETE FROM votes WHERE queue_item_id = ? AND ?? = ?', [propId, user ? 'user_id' : 'guest_id', user?.id || guest?.id]);
    } else {
      await pool.query(
        'INSERT INTO votes (queue_item_id, user_id, guest_id, vote) VALUES (?, ?, ?, 1)',
        [propId, user?.id || null, guest?.id || null]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === Host: Song direkt in Queue ===
app.post('/sessions/:id/queue/add', async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [session] = await pool.query('SELECT user_id FROM sessions WHERE id = ?', [id]);
    if (!session[0] || session[0].user_id !== user.id) return res.status(403).json({ error: 'Host only' });

    const [max] = await pool.query('SELECT MAX(position) AS pos FROM queue_items WHERE session_id = ? AND position IS NOT NULL', [id]);
    const position = (max[0].pos || 0) + 1;

    await pool.query(
      'INSERT INTO queue_items (session_id, video_id, title, thumbnail, position, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, videoId, title, thumbnail, position, user.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});