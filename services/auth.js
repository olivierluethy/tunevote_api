const jwt = require("jsonwebtoken");
const pool = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_here";

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

// === Subscription entitlement ===
// "active" status alone is not enough — Stripe keeps a sub in 'active' through
// its paid window even after the user has clicked Cancel, with the actual
// expiry sitting in current_period_end. Both must be checked.
async function hasActiveSubscription(userId) {
  const [rows] = await pool.query(
    `SELECT subscription_status, subscription_current_period_end
       FROM users WHERE id = ?`,
    [userId],
  );
  const row = rows[0];
  if (!row) return false;
  if (row.subscription_status !== "active") return false;
  if (!row.subscription_current_period_end) return false;
  return new Date(row.subscription_current_period_end) > new Date();
}

const getGuestFromToken = async (guestToken) => {
  if (!guestToken) return null;

  const cleanToken = guestToken.trim().replace(/^["']|["']$/g, '');
  console.log(
    "[getGuestFromToken] Eingehender Token (raw):", JSON.stringify(guestToken),
    "| cleaned:", cleanToken,
    "| Länge:", cleanToken.length
  );

  try {
    const [rows] = await pool.query(
      "SELECT id, nickname FROM guest_users WHERE guest_token = ?",
      [cleanToken]
    );
    console.log(
      "[getGuestFromToken] Ergebnis für '" + cleanToken + "':",
      rows.length, "Zeilen", rows[0] || "keine"
    );
    return rows[0] || null;
  } catch (err) {
    console.error("[getGuestFromToken] DB-Fehler:", err);
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

module.exports = {
  JWT_SECRET,
  getUserFromToken,
  hasActiveSubscription,
  getGuestFromToken,
  ensureParticipant,
};
