// ---------------------------------------------------------------------------
// CHANGE-REQUEST ROUTES (#66/#67/#68 — first slice)
//
// Thin HTTP layer over services/changeRequests.js. Auth mirrors the proposals
// routes: a bearer user token or an x-guest-token, and — for creating or voting —
// the caller must be a LIVE participant of the session (same #13 rule as the
// song vote). All the lifecycle/quorum/emit logic lives in the service.
// ---------------------------------------------------------------------------
const express = require("express");
const pool = require("../db");
const { getUserFromToken, getGuestFromToken } = require("../services/auth");
const {
  create,
  vote,
  buildDto,
  HttpError,
} = require("../services/changeRequests");

const router = express.Router();

async function identify(req) {
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = !user && guestToken ? await getGuestFromToken(guestToken) : null;
  return { user, guest };
}

async function assertLiveParticipant(sessionId, { user, guest }) {
  const voterId = user?.id || guest?.id;
  const column = user ? "user_id" : "guest_id";
  const [[p]] = await pool.query(
    `SELECT is_live FROM session_participants
      WHERE session_id = ? AND ${column} = ?`,
    [sessionId, voterId],
  );
  if (!p || !p.is_live) {
    throw new HttpError(403, "Nur aktive (live) Teilnehmer dürfen abstimmen");
  }
}

function fail(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error("[change-requests] route error:", err);
  return res.status(500).json({ error: "Interner Serverfehler" });
}

// POST /sessions/:id/change-requests  { type, payload }
router.post("/sessions/:id/change-requests", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const { type, payload } = req.body || {};
  try {
    const identity = await identify(req);
    if (!identity.user && !identity.guest) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await assertLiveParticipant(sessionId, identity);
    const dto = await create(sessionId, type, payload, identity);
    res.status(201).json(dto);
  } catch (err) {
    fail(res, err);
  }
});

// GET /sessions/:id/change-requests  → { open: [...], recent: [...] }
router.get("/sessions/:id/change-requests", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  try {
    const [openRows] = await pool.query(
      `SELECT * FROM change_requests
        WHERE session_id = ? AND status = 'open'
        ORDER BY id ASC`,
      [sessionId],
    );
    const [recentRows] = await pool.query(
      `SELECT * FROM change_requests
        WHERE session_id = ? AND status <> 'open'
        ORDER BY resolved_at DESC, id DESC
        LIMIT 10`,
      [sessionId],
    );
    const open = await Promise.all(openRows.map((r) => buildDto(r)));
    const recent = await Promise.all(recentRows.map((r) => buildDto(r)));
    res.json({ open, recent });
  } catch (err) {
    fail(res, err);
  }
});

// POST /change-requests/:crId/vote  (approve; idempotent)
router.post("/change-requests/:crId/vote", async (req, res) => {
  const crId = parseInt(req.params.crId, 10);
  try {
    const identity = await identify(req);
    if (!identity.user && !identity.guest) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const [[cr]] = await pool.query(
      `SELECT session_id FROM change_requests WHERE id = ?`,
      [crId],
    );
    if (!cr) return res.status(404).json({ error: "Change Request nicht gefunden" });
    await assertLiveParticipant(cr.session_id, identity);
    const dto = await vote(crId, identity);
    res.json(dto);
  } catch (err) {
    fail(res, err);
  }
});

// GET /sessions/:id/events  → append-only decision log (newest first)
router.get("/sessions/:id/events", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const [rows] = await pool.query(
      `SELECT id, session_id, type, change_request_id, payload, reversible,
              inverse, actor, created_at
         FROM session_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?`,
      [sessionId, limit],
    );
    res.json(rows);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
