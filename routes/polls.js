const express = require("express");
const pool = require("../db");
const { getIO } = require("../lib/io");
const { getUserFromToken, getGuestFromToken } = require("../services/auth");
const { pollPercents } = require("../services/pollShaping");

const router = express.Router();

// Load an active poll's options with their vote counts, shaped with percentages.
async function loadResults(pollId) {
  const [options] = await pool.query(
    `SELECT po.id, po.label, COUNT(pv.id) AS votes
       FROM poll_options po
       LEFT JOIN poll_votes pv ON pv.option_id = po.id
      WHERE po.poll_id = ?
      GROUP BY po.id, po.label, po.sort
      ORDER BY po.sort ASC, po.id ASC`,
    [pollId],
  );
  return pollPercents(options);
}

// Resolve a stable, anonymous-friendly voter key: registered user, else guest
// token, else a client-supplied localStorage id. Prevents one identity voting
// twice (also enforced by the UNIQUE(poll_id, voter_key) DB constraint).
async function resolveVoterKey(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (token) {
    const user = await getUserFromToken(token);
    if (user) return `u${user.id}`;
  }
  const guestToken = req.headers["x-guest-token"];
  if (guestToken) return `g${String(guestToken).trim().slice(0, 60)}`;
  const anon = req.body?.voterKey;
  if (anon) return `a${String(anon).slice(0, 60)}`;
  return null;
}

// GET /polls/active — the single active poll with live results.
router.get("/polls/active", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, question FROM polls WHERE is_active = 1 ORDER BY id DESC LIMIT 1",
    );
    if (!rows[0]) return res.json(null);
    const results = await loadResults(rows[0].id);
    res.json({ id: rows[0].id, question: rows[0].question, ...results });
  } catch (err) {
    console.error("polls/active failed:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// POST /polls/:id/vote { optionId, voterKey? } — one vote per identity.
router.post("/polls/:id/vote", async (req, res) => {
  const pollId = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body?.optionId, 10);
  if (!optionId) return res.status(400).json({ error: "optionId fehlt" });

  const voterKey = await resolveVoterKey(req);
  if (!voterKey) return res.status(400).json({ error: "Keine Wähler-Kennung" });

  try {
    // Option must belong to this (active) poll.
    const [opt] = await pool.query(
      `SELECT po.id FROM poll_options po
         JOIN polls p ON p.id = po.poll_id
        WHERE po.id = ? AND po.poll_id = ? AND p.is_active = 1`,
      [optionId, pollId],
    );
    if (!opt[0]) {
      return res.status(404).json({ error: "Option oder Umfrage nicht gefunden" });
    }

    try {
      await pool.query(
        "INSERT INTO poll_votes (poll_id, option_id, voter_key) VALUES (?, ?, ?)",
        [pollId, optionId, voterKey],
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Bereits abgestimmt" });
      }
      throw e;
    }

    const results = await loadResults(pollId);
    // Global broadcast — the dashboard/home sockets are global listeners.
    getIO().emit("poll_results", { pollId, ...results });
    res.json({ pollId, ...results });
  } catch (err) {
    console.error("polls vote failed:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

module.exports = router;
