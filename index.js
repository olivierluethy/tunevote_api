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

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tunevote',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

const httpServer = app.listen(4000, () => console.log('Server läuft auf http://localhost:4000'));
const io = new Server(httpServer, { cors: { origin: '*' } });

// === Auth ===
const getUserFromToken = async (token) => {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query('SELECT id, username FROM users WHERE id = ?', [decoded.id]);
    return rows[0] || null;
  } catch { return null; }
};

const getGuestFromToken = async (guestToken) => {
  if (!guestToken) return null;
  try {
    const [rows] = await pool.query('SELECT id, nickname FROM guest_users WHERE guest_token = ?', [guestToken]);
    return rows[0] || null;
  } catch { return null; }
};

const ensureParticipant = async (sessionId, user = null, guest = null, isHost = false) => {
  const column = user ? 'user_id' : 'guest_id';
  const id = user ? user.id : guest.id;
  const [existing] = await pool.query(`SELECT id FROM session_participants WHERE session_id = ? AND ${column} = ?`, [sessionId, id]);
  if (existing.length === 0) {
    await pool.query(`INSERT INTO session_participants (session_id, ${column}, role) VALUES (?, ?, ?)`, [sessionId, id, isHost ? 'host' : 'guest']);
  }
};

// === Socket.IO ===
io.on('connection', (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  if (!sessionId) return socket.disconnect();
  socket.join(sessionId);

  socket.on('host_song_start', async ({ videoId }) => {
    const startTime = Date.now();

    await pool.query(`
      INSERT INTO playback_sync (session_id, current_video_id, video_start_time, is_playing)
      VALUES (?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE 
        current_video_id = ?, 
        video_start_time = ?, 
        is_playing = 1
    `, [sessionId, videoId, startTime, videoId, startTime]);

    io.to(sessionId).emit('playback_sync', {
      current_video_id: videoId,
      video_start_time: startTime,
      is_playing: true,
    });
  });
});

// === Playback Sync Endpoint ===
app.get('/sessions/:id/playback-sync', async (req, res) => {
  const { id } = req.params;
  const [row] = await pool.query('SELECT current_video_id, video_start_time, is_playing FROM playback_sync WHERE session_id = ?', [id]);
  res.json(row[0] || {});
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

// === Guest join ===
// === Routes ===
app.post('/guest/join', async (req, res) => {
  const { nickname } = req.body;
  const guestToken = uuidv4();
  await pool.query('INSERT INTO guest_users (guest_token, nickname) VALUES (?, ?)', [guestToken, nickname || 'Gast']);
  res.json({ guestToken, nickname: nickname || 'Gast' });
});

// === Sessions (sichtbar für alle angemeldeten Nutzer) ===
app.get('/sessions', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  const user = await getUserFromToken(token);

  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [rows] = await pool.query(`
      SELECT s.id, s.title, s.created_at, u.username AS host, s.user_id AS hostId, s.is_live
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at DESC
    `);

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
    const [result] = await pool.query('INSERT INTO sessions (user_id, title) VALUES (?, ?)', [user.id, title.trim()]);
    const sessionId = result.insertId;

    await ensureParticipant(sessionId, user, null, true); // Host korrekt setzen

    const [newSession] = await pool.query('SELECT s.id, s.title, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?', [sessionId]);
    res.status(201).json(newSession[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// === Get session (includes is_live) ===
app.get('/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  const guestToken = req.headers['x-guest-token'];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: 'Unauthorized' });

  const [sess] = await pool.query('SELECT s.*, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?', [id]);
  if (!sess[0]) return res.status(404).json({ error: 'Not found' });

  await ensureParticipant(id, user, guest);
  res.json({ ...sess[0], hostId: sess[0].user_id, is_live: !!sess[0].is_live });
});

// === Queue endpoints ===
app.get('/sessions/:id/queue', async (req, res) => {
  const { id } = req.params;
  const [queue] = await pool.query(`
    SELECT qi.*, COALESCE(u.username, g.nickname, 'Gast') AS addedBy
    FROM queue_items qi
    LEFT JOIN users u ON qi.added_by = u.id
    LEFT JOIN guest_users g ON qi.guest_id = g.id
    WHERE qi.session_id = ?
    ORDER BY qi.position ASC, qi.created_at ASC
  `, [id]);
  res.json(queue);
});


// === Proposals endpoint (GET) ===
app.post('/sessions/:id/proposals', async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  const guestToken = req.headers['x-guest-token'];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: 'Unauthorized' });

  const [sess] = await pool.query('SELECT is_live FROM sessions WHERE id = ?', [id]);
  if (sess[0]?.is_live) return res.status(403).json({ error: 'Session started' });

  await pool.query(
    'INSERT INTO queue_items (session_id, video_id, title, thumbnail, added_by, guest_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, videoId, title, thumbnail, user?.id || null, guest?.id || null, 'proposal']
  );

  io.to(id).emit('queue_updated', {});
  res.status(201).json({ success: true });
});


// === Vote (unchanged, but simple) ===
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

    io.to(id).emit('proposals_updated', {});
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Host: direct queue add (blocked if session is_live) ===
app.post('/sessions/:id/queue/add', async (req, res) => {
  const { id } = req.params;
  const { videoId, title, thumbnail } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const [sess] = await pool.query('SELECT user_id, is_live FROM sessions WHERE id = ?', [id]);
  if (!sess[0] || sess[0].user_id !== user.id) return res.status(403).json({ error: 'Host only' });
  if (sess[0].is_live) return res.status(403).json({ error: 'Session started' });

  const [max] = await pool.query('SELECT MAX(position) AS pos FROM queue_items WHERE session_id = ? AND position IS NOT NULL', [id]);
  const position = (max[0].pos || 0) + 1;

  await pool.query(
    'INSERT INTO queue_items (session_id, video_id, title, thumbnail, position, added_by, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, videoId, title, thumbnail, position, user.id, 'queued']
  );

  io.to(id).emit('queue_updated', {});
  res.json({ success: true });
});

// === Start session (host) ===
app.post('/sessions/:id/start', async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const [sess] = await pool.query('SELECT user_id, is_live FROM sessions WHERE id = ?', [id]);
  if (!sess[0] || sess[0].user_id !== user.id) return res.status(403).json({ error: 'Host only' });
  if (sess[0].is_live) return res.status(400).json({ error: 'Started' });

  await pool.query('UPDATE sessions SET is_live = 1 WHERE id = ?', [id]);
  io.to(id).emit('session_started', {});

  const [first] = await pool.query('SELECT video_id FROM queue_items WHERE session_id = ? AND position = 1', [id]);
  if (first[0]) {
    await pool.query(
      'INSERT INTO playback_sync (session_id, current_video_id, progress_seconds, is_playing) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE current_video_id = ?',
      [id, first[0].video_id, first[0].video_id]
    );
  }

  res.json({ success: true });
});

app.post('/sessions/:id/queue/consume', async (req, res) => {
  const { id } = req.params;
  const token = req.headers.authorization?.split(' ')[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const [sess] = await pool.query('SELECT user_id FROM sessions WHERE id = ?', [id]);
  if (!sess[0] || sess[0].user_id !== user.id) return res.status(403).json({ error: 'Host only' });

  await pool.query('DELETE FROM queue_items WHERE session_id = ? AND position = (SELECT MIN(position) FROM queue_items WHERE session_id = ? AND position IS NOT NULL)', [id, id]);
  await pool.query('UPDATE queue_items SET position = position - 1 WHERE session_id = ? AND position IS NOT NULL', [id]);
  io.to(id).emit('queue_updated', {});
  res.json({ success: true });
});

// === Live stream endpoint (HOOK) ===
app.get('/sessions/:id/live/stream', async (req, res) => {
  // IMPORTANT: This endpoint is a placeholder/hook.
  // For real-time, low-latency audio streaming you should implement a WebRTC SFU (e.g. mediasoup, Janus),
  // or a media server that can transcode YouTube audio -> stream to clients.
  //
  // Currently we respond with 501 Not Implemented to indicate integration point.
  res.status(501).json({ error: 'Live streaming not implemented on backend. Integrate WebRTC/mediasoup or an audio streaming server.' });
});