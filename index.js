require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

// MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tunevote',
});

// JWT secret key
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

// Socket.IO setup
const httpServer = app.listen(4000, () => {
  console.log('Server listening on port 4000');
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',
  }
});

let session = {
  videoId: null,
  startTime: null,
  paused: false,
  pauseOffset: 0,
};

io.on('connection', (socket) => {
  socket.emit('session_state', session);

  socket.on('host_start', (videoId) => {
    session = {
      videoId,
      startTime: Date.now(),
      paused: false,
      pauseOffset: 0,
    };
    io.emit('session_update', session);
  });

  socket.on('host_pause', (offset) => {
    session.paused = true;
    session.pauseOffset = offset;
    io.emit('session_update', session);
  });

  socket.on('host_resume', () => {
    session.paused = false;
    session.startTime = Date.now() - session.pauseOffset * 1000;
    io.emit('session_update', session);
  });
});

// Register endpoint
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const [existingUser] = await pool.query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', [username, email, password_hash]);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Generate JWT
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
