require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const crypto = require("crypto");
const ytdl = require("@distube/ytdl-core");
const nodemailer = require("nodemailer");
const multer = require("multer");

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD, // mit Leerzeichen aus App-Passwort!
  },
});

// Teste beim Start einmal
transporter
  .verify()
  .then(() => console.log("Gmail ready"))
  .catch(console.error);

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

// ---------------------------------------------------------------
// Stripe billing — initialised before any body parser so the webhook
// route below can claim the raw body. The Stripe SDK verifies webhook
// signatures byte-for-byte against the request body, so the webhook
// handler MUST be mounted before app.use(express.json()).
// ---------------------------------------------------------------
const Stripe = require("stripe");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://app.tunevote.com";

let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY);
  console.log("✅ Stripe initialised");
} else {
  console.warn("⚠️  STRIPE_SECRET_KEY missing — billing endpoints will 500");
}

app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send("billing not configured");
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("⚠️  Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const sessionObj = event.data.object;
          const userId = sessionObj.client_reference_id
            ? parseInt(sessionObj.client_reference_id, 10)
            : null;
          const customerId = sessionObj.customer;
          const subscriptionId = sessionObj.subscription;
          if (userId && subscriptionId) {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            // Newer Stripe API versions moved current_period_end off the
            // subscription root and into items.data[].current_period_end.
            // Fall back to the items-level field so we never store NULL
            // on accounts pinned to the new API version.
            const periodEndUnix =
              sub.current_period_end ??
              sub.items?.data?.[0]?.current_period_end ??
              null;
            const periodEnd = periodEndUnix
              ? new Date(periodEndUnix * 1000)
              : null;
            const status =
              sub.status === "active" || sub.status === "trialing"
                ? "active"
                : sub.status === "past_due" || sub.status === "unpaid"
                  ? "past_due"
                  : "canceled";
            await pool.query(
              `UPDATE users
                  SET stripe_customer_id = ?,
                      stripe_subscription_id = ?,
                      subscription_status = ?,
                      subscription_current_period_end = ?
                WHERE id = ?`,
              [customerId, subscriptionId, status, periodEnd, userId],
            );
            console.log(`💳 user ${userId} subscribed (sub ${subscriptionId})`);
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const periodEndUnix =
            sub.current_period_end ??
            sub.items?.data?.[0]?.current_period_end ??
            null;
          const periodEnd = periodEndUnix
            ? new Date(periodEndUnix * 1000)
            : null;
          let status;
          if (event.type === "customer.subscription.deleted") {
            status = "canceled";
          } else if (sub.status === "active" || sub.status === "trialing") {
            status = "active";
          } else if (sub.status === "past_due" || sub.status === "unpaid") {
            status = "past_due";
          } else {
            status = "canceled";
          }
          await pool.query(
            `UPDATE users
                SET stripe_subscription_id = ?,
                    subscription_status = ?,
                    subscription_current_period_end = ?
              WHERE stripe_customer_id = ?`,
            [sub.id, status, periodEnd, sub.customer],
          );
          console.log(
            `💳 sub ${sub.id} → ${status} (customer ${sub.customer})`,
          );
          break;
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error("❌ Stripe webhook handler error:", err);
      res.status(500).send("handler error");
    }
  },
);

app.use(express.json());

const pool = require("./db");

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
  console.log("Server läuft auf https://app.tunevote.com/"),
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

// === Billing: status / checkout / portal ===
app.get("/billing/status", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT subscription_status, subscription_current_period_end
       FROM users WHERE id = ?`,
    [user.id],
  );
  const row = rows[0] || {};
  const active =
    row.subscription_status === "active" &&
    row.subscription_current_period_end &&
    new Date(row.subscription_current_period_end) > new Date();
  res.json({
    active: !!active,
    status: row.subscription_status || "none",
    current_period_end: row.subscription_current_period_end || null,
  });
});

app.post("/billing/checkout-session", async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: "billing not configured" });
  }
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT email, stripe_customer_id FROM users WHERE id = ?`,
    [user.id],
  );
  const userRow = rows[0];
  if (!userRow) return res.status(404).json({ error: "user not found" });

  try {
    const params = {
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${APP_PUBLIC_URL}/?checkout=success`,
      cancel_url: `${APP_PUBLIC_URL}/?checkout=canceled`,
      client_reference_id: String(user.id),
      allow_promotion_codes: true,
    };
    if (userRow.stripe_customer_id) {
      params.customer = userRow.stripe_customer_id;
    } else {
      params.customer_email = userRow.email;
    }
    const checkoutSession = await stripe.checkout.sessions.create(params);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err);
    res.status(500).json({ error: "checkout failed" });
  }
});

app.post("/billing/portal-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "billing not configured" });
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT stripe_customer_id FROM users WHERE id = ?`,
    [user.id],
  );
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: "no subscription" });

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_PUBLIC_URL}/`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error("❌ Stripe portal error:", err);
    res.status(500).json({ error: "portal failed" });
  }
});

const phaseTimers = {}; // { sessionId: timeout }

async function startPhaseTimer(sessionId, roundId, currentPhase, seconds) {
  if (phaseTimers[sessionId]) clearTimeout(phaseTimers[sessionId]);

  const nextPhase = currentPhase === "suggestion" ? "voting" : "suggestion";

  phaseTimers[sessionId] = setTimeout(async () => {
    try {
      console.log(
        `[PhaseTimer] Timer abgelaufen für Session ${sessionId}, Runde ${roundId}, ` +
          `Phase: ${currentPhase} → nächste Phase: ${nextPhase}`,
      );

      if (nextPhase === "voting") {
        // --- Wechsel zu Voting-Phase (unverändert)
        const votingEnds = new Date(Date.now() + 60 * 1000);
        await pool.query(
          `
          UPDATE voting_rounds 
          SET phase = 'voting', phase_ends_at = ? 
          WHERE id = ? AND session_id = ?
        `,
          [votingEnds, roundId, sessionId],
        );

        console.log(
          `[Voting] Wechsel zu Voting-Phase → ends at ${votingEnds.toISOString()}`,
        );

        io.to(sessionId).emit("voting_phase_changed", {
          phase: "voting",
          endsAt: votingEnds.getTime(),
          roundId,
          duration: 60,
        });

        startPhaseTimer(sessionId, roundId, "voting", 60);
      } else if (nextPhase === "suggestion") {
        // ==================== VOTING BEENDET → GEWINNER BESTIMMEN ====================
        console.log(
          `[Voting] Voting-Runde ${roundId} beendet – starte Gewinnerermittlung`,
        );

        let winnerId = null;

        // 1. Prüfen: Gab es überhaupt Votes?
        const [votedSongs] = await pool.query(
          `
    SELECT qi.id
    FROM queue_items qi
    WHERE qi.voting_round_id = ?
      AND qi.status = 'suggested'
      AND EXISTS (SELECT 1 FROM votes v WHERE v.queue_item_id = qi.id)
    ORDER BY (
      SELECT COUNT(*) FROM votes v WHERE v.queue_item_id = qi.id
    ) DESC, qi.created_at ASC
    LIMIT 1
    `,
          [roundId],
        );

        if (votedSongs.length > 0) {
          winnerId = votedSongs[0].id;
          await pool.query(
            "UPDATE queue_items SET status = 'queued' WHERE id = ?",
            [winnerId],
          );
          console.log(`[Voting] Gewinner durch Votes: #${winnerId}`);
        } else {
          console.log(
            `[Voting] Keine Votes abgegeben → Fallback-Regeln prüfen`,
          );

          // 1. Gibt es User/Guest-Vorschläge?
          const [userProposal] = await pool.query(
            `
      SELECT id
      FROM queue_items
      WHERE voting_round_id = ?
        AND status = 'suggested'
        AND item_source IN ('user', 'guest')
      ORDER BY created_at ASC
      LIMIT 1
      `,
            [roundId],
          );

          if (userProposal.length > 0) {
            winnerId = userProposal[0].id;
            await pool.query(
              "UPDATE queue_items SET status = 'queued', item_type = 'music' WHERE id = ?",
              [winnerId],
            );
            console.log(
              `[Voting] Keine Votes → Ältester User-/Guest-Vorschlag gewinnt: #${winnerId}`,
            );
          } else {
            console.log(
              `[Voting] Kein User-/Guest-Vorschlag → prüfe AI-Fallback`,
            );

            // ──────────────────────────────────────────────────────
            // Live-Check NUR über session_participants.is_live (wie gewünscht)
            const [liveRows] = await pool.query(
              "SELECT COUNT(*) AS cnt FROM session_participants WHERE session_id = ? AND is_live = 1",
              [sessionId],
            );
            const liveCount = liveRows[0]?.cnt ?? 0;

            // Optional: Socket-Anzahl nur noch zum Debuggen loggen (kann später entfernt werden)
            const liveSocketsDebug = await io
              .in(String(sessionId))
              .fetchSockets();
            const socketCountDebug = liveSocketsDebug.length;

            console.log(
              `[Voting LIVE-CHECK] ` +
                `DB live participants (is_live=1): ${liveCount} | ` +
                `Socket.IO Verbindungen (nur Debug): ${socketCountDebug} | ` +
                `Runde: ${roundId} | Session: ${sessionId}`,
            );

            if (liveCount > 0) {
              // AI-Fallback versuchen – nur wenn laut DB noch jemand live ist
              const [aiCountRows] = await pool.query(
                `
      SELECT COUNT(*) AS cnt
      FROM queue_items
      WHERE voting_round_id = ?
        AND status = 'suggested'
        AND item_source = 'ai'
        AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.queue_item_id = queue_items.id)
      `,
                [roundId],
              );
              const aiCount = aiCountRows[0]?.cnt ?? 0;

              console.log(
                `[Voting] AI-Fallback-Prüfung: ${aiCount} AI-Songs ohne Votes vorhanden`,
              );

              if (aiCount >= 3) {
                const [aiRows] = await pool.query(
                  `
        SELECT id
        FROM queue_items
        WHERE voting_round_id = ?
          AND status = 'suggested'
          AND item_source = 'ai'
          AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.queue_item_id = queue_items.id)
        ORDER BY RAND()
        LIMIT 1
        `,
                  [roundId],
                );

                if (aiRows.length > 0) {
                  winnerId = aiRows[0].id;
                  await pool.query(
                    "UPDATE queue_items SET status = 'queued', item_type = 'music' WHERE id = ?",
                    [winnerId],
                  );
                  console.log(
                    `[Voting] Fallback: Zufälliger AI-Song gewählt (#${winnerId}) – ` +
                      `${aiCount} AI-Songs, ${liveCount} live (DB)`,
                  );
                } else {
                  console.log(
                    `[Voting] Kein AI-Song gefunden trotz aiCount >= 3`,
                  );
                }
              } else {
                console.log(
                  `[Voting] Fallback nicht möglich: Nur ${aiCount}/3 AI-Songs (0 Votes), ` +
                    `${liveCount} live (DB)`,
                );
              }
            } else {
              // === WIRKLICH KEIN LIVE-TEILNEHMER laut Datenbank ===
              console.log(
                `[Voting] KEIN GEWINNER & KEINE LIVE-TEILNEHMER ` +
                  `(DB live count: ${liveCount}, Sockets nur Debug: ${socketCountDebug}) → Session wird beendet`,
              );

              // Alle vorgeschlagenen Songs archivieren
              await pool.query(
                "UPDATE queue_items SET status = 'archived' WHERE voting_round_id = ? AND status = 'suggested'",
                [roundId],
              );
              console.log(`[Voting] Alle suggested Songs archiviert`);

              // Runde schließen
              await pool.query(
                `UPDATE voting_rounds 
       SET status = 'closed', phase = 'closed', winner_queue_item_id = NULL 
       WHERE id = ?`,
                [roundId],
              );
              console.log(
                `[Voting] Runde ${roundId} geschlossen (kein Gewinner)`,
              );

              // Session beenden
              await pool.query(
                `UPDATE sessions 
       SET is_live = 0, ended_at = NOW() 
       WHERE id = ? AND is_live = 1`,
                [sessionId],
              );
              console.log(
                `[Session] Session ${sessionId} als beendet markiert`,
              );

              // Nur die wirklich gespielten Items zurücksetzen (dein aktueller Ansatz)
              await pool.query(
                `
                            UPDATE queue_items
            SET
              status = 'queued',
              playedAt = NULL,
              startedAt = NULL,
              voting_round_id = NULL
            WHERE session_id = ?
              AND status IN ('played', 'playing', 'suggested');
                `,
                [sessionId],
              );
              console.log(
                `[Session] Gespielte Queue Items wurden zurückgesetzt`,
              );

              // Broadcast
              io.to(sessionId).emit("session_ended", {
                reason: "no_active_participants",
                message:
                  "The session was terminated because no one was active anymore.",
              });
              console.log(`[Broadcast] session_ended gesendet`);

              // Raum räumen
              io.in(sessionId).socketsLeave(sessionId);
              console.log(
                `[Socket] Alle Clients aus Raum ${sessionId} entfernt`,
              );

              // Timer aufräumen
              if (phaseTimers[sessionId]) {
                clearTimeout(phaseTimers[sessionId]);
                delete phaseTimers[sessionId];
                console.log(`[Timer] Phase-Timer für ${sessionId} aufgeräumt`);
              }

              return; // ← verhindert Neustart der Runde
            }
          }
        }

        // === Restliche archivieren ===
        if (winnerId) {
          await pool.query(
            `
      UPDATE queue_items
      SET status = 'archived'
      WHERE voting_round_id = ? AND status = 'suggested' AND id != ?
      `,
            [roundId, winnerId],
          );
          console.log(
            `[Voting] Alle nicht-gewählten Vorschläge archiviert (Gewinner: ${winnerId})`,
          );
        } else {
          await pool.query(
            "UPDATE queue_items SET status = 'archived' WHERE voting_round_id = ? AND status = 'suggested'",
            [roundId],
          );
          console.log(`[Voting] Alle Vorschläge archiviert (kein Gewinner)`);
        }

        // === Runde schließen ===
        await pool.query(
          `
    UPDATE voting_rounds
    SET status = 'closed', phase = 'closed', winner_queue_item_id = ?
    WHERE id = ?
    `,
          [winnerId || null, roundId],
        );
        console.log(`[Voting] Runde ${roundId} geschlossen`);

        // Top-Charts aktualisieren
        await broadcastTodayTopArtists(io);
        console.log(`[Broadcast] Top Artists aktualisiert`);

        // Broadcasts
        io.to(sessionId).emit("voting_round_completed", { winnerId, roundId });
        io.to(sessionId).emit("queue_updated");
        io.to(sessionId).emit("proposals_updated");
        console.log(
          `[Broadcast] voting_round_completed, queue_updated, proposals_updated gesendet`,
        );

        // === Neue Runde in 3 Sekunden ===
        setTimeout(async () => {
          const newEnds = new Date(Date.now() + 90 * 1000);
          const [newRound] = await pool.query(
            `
      INSERT INTO voting_rounds
        (session_id, status, phase, phase_ends_at, suggestion_duration, voting_duration)
      VALUES (?, 'open', 'suggestion', ?, 90, 60)
      `,
            [sessionId, newEnds],
          );

          const newRoundId = newRound.insertId;

          console.log(
            `[Voting] Neue Suggestion-Runde gestartet: ${newRoundId}`,
          );

          io.to(sessionId).emit("suggesting_phase_started", {
            roundId: newRoundId,
            endsAt: newEnds.getTime(),
            duration: 90,
          });

          io.to(sessionId).emit("voting_phase_changed", {
            phase: "suggestion",
            endsAt: newEnds.getTime(),
            roundId: newRoundId,
            duration: 90,
          });

          startPhaseTimer(sessionId, newRoundId, "suggestion", 90);
        }, 3000);
      }
    } catch (err) {
      console.error("[PhaseTimer] Schwerwiegender Fehler:", err);
    }
  }, seconds * 1000);
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

async function finalizeListeningForCurrentSong(sessionId) {
  // 1. Aktuellen Song holen
  const [rows] = await pool.query(
    `
    SELECT qi.id, qi.startedAt, yvc.duration
    FROM queue_items qi
    JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
    WHERE qi.session_id = ? AND qi.status = 'playing' AND qi.item_type = 'music'
    LIMIT 1
    `,
    [sessionId],
  );

  if (rows.length === 0) return;

  const song = rows[0];
  if (!song.startedAt || !song.duration) return;

  const songStart = new Date(song.startedAt);
  const songEnd = new Date(songStart.getTime() + song.duration * 1000);

  // 2. Teilnehmer mit Zeitüberschneidung holen
  const [participants] = await pool.query(
    `
    SELECT *
    FROM session_participants
    WHERE session_id = ?
      AND joined_at <= ?
      AND (left_at IS NULL OR left_at >= ?)
    `,
    [sessionId, songEnd, songStart],
  );

  // 3. Für jeden Teilnehmer Listening berechnen
  for (const p of participants) {
    const listenedFrom = new Date(
      Math.max(songStart.getTime(), new Date(p.joined_at).getTime()),
    );

    const listenedTo = new Date(
      Math.min(
        songEnd.getTime(),
        p.left_at ? new Date(p.left_at).getTime() : songEnd.getTime(),
      ),
    );

    const listenSeconds = Math.floor((listenedTo - listenedFrom) / 1000);

    // zu kurz? ignorieren
    if (listenSeconds <= 5) continue;

    const completed = listenSeconds >= song.duration * 0.9 ? 1 : 0;

    await pool.query(
      `
      INSERT INTO session_song_listens
        (session_id, queue_item_id, user_id, guest_id,
         listened_from, listened_to, listen_seconds, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        sessionId,
        song.id,
        p.user_id,
        p.guest_id,
        listenedFrom,
        listenedTo,
        listenSeconds,
        completed,
      ],
    );
  }
}

// Advance to next queue item — Identifikation ausschließlich über queue_items.id / status
// Advance to next queue item — NOW WITH EMERGENCY AUTO-PROMOTION FROM VOTING
const advanceToNext = async (sessionId) => {
  try {
    // 🔥 NEU: Listening für aktuellen Song abschließen
    await finalizeListeningForCurrentSong(sessionId);

    // 1) Mark current playing as played
    const [playingRows] = await pool.query(
      `SELECT id FROM queue_items WHERE session_id = ? AND status = 'playing' LIMIT 1`,
      [sessionId],
    );
    if (playingRows.length > 0) {
      const currentId = playingRows[0].id;
      await pool.query(
        `UPDATE queue_items SET status = 'played', playedAt = NOW() WHERE id = ?`,
        [currentId],
      );

      // 🔥 Optional: Auch hier broadcasten (falls played-Songs mitzählen sollen)
      await broadcastTodayTopArtists(io);
      console.log(`[Session ${sessionId}] Marked played: #${currentId}`);
    }

    // 2) Check if there are still queued items
    const [queuedRows] = await pool.query(
      `SELECT qi.id, qi.video_id, qi.item_type,
              COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
              COALESCE(yvc.title, qi.description)               AS title
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
       WHERE qi.session_id = ? AND qi.status = 'queued'
       ORDER BY qi.id ASC
       LIMIT 1`,
      [sessionId],
    );

    let next = queuedRows[0] || null;

    // ========= EMERGENCY: NO QUEUED ITEM? → AUTO-PROMOTE FROM CURRENT VOTING ROUND =========
    if (!next) {
      const [openRound] = await pool.query(
        `SELECT id FROM voting_rounds WHERE session_id = ? AND status = 'open' LIMIT 1`,
        [sessionId],
      );

      if (openRound.length > 0) {
        const roundId = openRound[0].id;

        console.log(
          `[Session ${sessionId}] EMERGENCY: No queued song → auto-promoting winner from voting round #${roundId}`,
        );

        // Same winner logic as in phase timer — EXACT COPY
        let winnerId = null;

        // 1. Highest voted
        const [votedSongs] = await pool.query(
          `
          SELECT qi.id
          FROM queue_items qi
          WHERE qi.voting_round_id = ? AND qi.status = 'suggested'
            AND EXISTS (SELECT 1 FROM votes v WHERE v.queue_item_id = qi.id)
          ORDER BY (
            SELECT COUNT(*) FROM votes v WHERE v.queue_item_id = qi.id
          ) DESC, qi.created_at ASC
          LIMIT 1
        `,
          [roundId],
        );

        if (votedSongs.length > 0) {
          winnerId = votedSongs[0].id;
        } else {
          // 2. Fallback: oldest user/guest suggestion
          const [userProposal] = await pool.query(
            `
            SELECT id FROM queue_items
            WHERE voting_round_id = ? AND status = 'suggested' AND item_source IN ('user', 'guest')
            ORDER BY created_at ASC LIMIT 1
          `,
            [roundId],
          );
          if (userProposal.length > 0) winnerId = userProposal[0].id;
          else {
            // 3. Random AI song if live users exist and ≥3 AI songs (deine Logik prüft nur Existenz, aber Kommentar sagt ≥3 – belassen wie ist)
            const [liveCountRow] = await pool.query(
              `SELECT COUNT(*) AS cnt FROM session_participants WHERE session_id = ? AND is_live = 1`,
              [sessionId],
            );
            if (liveCountRow[0].cnt > 0) {
              const [aiRows] = await pool.query(
                `
                SELECT id FROM queue_items
                WHERE voting_round_id = ? AND status = 'suggested' AND item_source = 'ai'
                  AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.queue_item_id = queue_items.id)
                ORDER BY RAND() LIMIT 1
              `,
                [roundId],
              );
              if (aiRows.length > 0) winnerId = aiRows[0].id;
            }
          }
        }

        if (winnerId) {
          await pool.query(
            `UPDATE queue_items SET status = 'queued' WHERE id = ?`,
            [winnerId],
          );

          // Archive others
          await pool.query(
            `UPDATE queue_items SET status = 'archived'
             WHERE voting_round_id = ? AND status = 'suggested' AND id != ?`,
            [roundId, winnerId],
          );

          // Close round early
          await pool.query(
            `UPDATE voting_rounds SET status = 'closed', winner_queue_item_id = ? WHERE id = ?`,
            [winnerId, roundId],
          );

          // 🔥 NEU: Auch hier zählt der Song jetzt mit!
          await broadcastTodayTopArtists(io);

          io.to(sessionId).emit("voting_round_completed", {
            winnerId,
            roundId,
            emergency: true,
          });
          io.to(sessionId).emit("proposals_updated");
          io.to(sessionId).emit("queue_updated");

          // Now fetch the newly queued song
          const [emergencyNext] = await pool.query(
            `SELECT qi.id, qi.video_id, qi.item_type,
                    COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
                    COALESCE(yvc.title, qi.description)               AS title
             FROM queue_items qi
             LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
             WHERE qi.id = ?`,
            [winnerId],
          );
          next = emergencyNext[0];
          console.log(
            `[Session ${sessionId}] Emergency auto-promoted song #${winnerId} to prevent silence`,
          );
        }
      }
    }

    // 3) Still no song? → End session properly (with extra safety check)
    if (!next) {
      const [activeParticipants] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM session_participants WHERE session_id = ? AND is_live = 1`,
        [sessionId],
      );
      const [openRounds] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM voting_rounds WHERE session_id = ? AND status = 'open'`,
        [sessionId],
      );

      // NEUE PRÜFUNG: Gibt es noch einen aktiven "playing" Eintrag?
      const [currentlyPlaying] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM queue_items WHERE session_id = ? AND status = 'playing'`,
        [sessionId],
      );

      const noActiveUsers = activeParticipants[0].cnt === 0;
      const noOpenVoting = openRounds[0].cnt === 0;
      const nothingPlaying = currentlyPlaying[0].cnt === 0;

      if (noActiveUsers && noOpenVoting && nothingPlaying) {
        // Jetzt wirklich sicher: nichts läuft mehr → Session beenden
        await pool.query(`UPDATE sessions SET is_live = 0 WHERE id = ?`, [
          sessionId,
        ]);
        await pool.query(
          `UPDATE session_participants SET is_live = 0 WHERE session_id = ?`,
          [sessionId],
        );
        io.to(sessionId).emit("session_ended");
        console.log(
          `[Session ${sessionId}] Session ended (no songs playing, no queued next, no users, no voting)`,
        );
      } else {
        let reasons = [];
        if (!noActiveUsers) reasons.push("active users");
        if (!noOpenVoting) reasons.push("open voting");
        if (!nothingPlaying) reasons.push("song currently playing");
        console.log(
          `[Session ${sessionId}] No song to play next, but session stays alive → ${reasons.join(", ")}`,
        );
      }
      return;
    }

    // 4) Play the next song (normal flow)
    const {
      id: nextId,
      video_id: nextVideoId,
      item_type,
      duration,
      title,
    } = next;
    const startTime = Date.now();

    if (item_type === "pause") {
      await pool.query(
        `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
        [nextId],
      );
      await pool.query(
        `UPDATE playback_sync SET current_video_id = NULL, is_playing = 0, video_start_time = ? WHERE session_id = ?`,
        [startTime, sessionId],
      );
      io.to(sessionId).emit("pause_started", {
        queue_item_id: nextId,
        title,
        duration,
        startTime,
      });
      io.to(sessionId).emit("playback_sync", {
        current_queue_item_id: nextId,
        current_video_id: null,
        video_start_time: startTime,
        is_playing: false,
      });

      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      sessionTimers[sessionId] = setTimeout(
        () => advanceToNext(sessionId),
        duration * 1000,
      );
    } else {
      await pool.query(
        `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
        [nextId],
      );
      await pool.query(
        `INSERT INTO playback_sync (session_id, current_video_id, video_start_time, is_playing)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           current_video_id = VALUES(current_video_id),
           video_start_time = VALUES(video_start_time),
           is_playing = 1`,
        [sessionId, nextVideoId, startTime],
      );

      io.to(sessionId).emit("playback_sync", {
        current_queue_item_id: nextId,
        current_video_id: nextVideoId,
        video_start_time: startTime,
        is_playing: true,
      });

      if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
      const safeDurationMs = Math.max(1000, (duration || 180) * 1000);
      sessionTimers[sessionId] = setTimeout(
        () => advanceToNext(sessionId),
        safeDurationMs,
      );

      console.log(
        `[Session ${sessionId}] Now playing: "${title}" (#${nextId})`,
      );
    }

    io.to(sessionId).emit("queue_updated");
  } catch (err) {
    console.error(`[Session ${sessionId}] advanceToNext error:`, err);
  }
};

// Hilfsfunktion: Sendet aktuelle Live-Teilnehmer an alle in der Session
const broadcastLiveParticipants = async (sessionId) => {
  try {
    const [participants] = await pool.query(
      `SELECT 
         COALESCE(u.username, g.nickname, 'Gast') AS name,
         (sp.role = 'host') AS isHost
       FROM session_participants sp
       LEFT JOIN users u ON sp.user_id = u.id
       LEFT JOIN guest_users g ON sp.guest_id = g.id
       WHERE sp.session_id = ? AND sp.is_live = 1
       ORDER BY sp.joined_at DESC`,
      [sessionId],
    );

    const formatted = participants.map((p) => ({
      name: p.name,
      isHost: !!p.isHost,
    }));

    // An alle Clients in der Session senden
    io.to(sessionId.toString()).emit("live_participants_updated", formatted);
  } catch (err) {
    console.error("Fehler beim Broadcast von Live-Teilnehmern:", err);
  }
};

// === Socket.IO ===
io.on("connection", (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  const sessionIdInt = parseInt(sessionId, 10);

  console.log("🔌 [WS-CONNECT] New socket connection:", {
    socketId: socket.id,
    sessionId,
    ip: socket.handshake.address,
    headers: socket.handshake.headers,
  });

  if (!sessionId) {
    console.log("❌ [WS-CONNECT] Missing sessionId → disconnect");
    return socket.disconnect();
  }

  socket.join(sessionId);
  console.log(`➡️ [WS-CONNECT] Socket ${socket.id} joined room ${sessionId}`);

  socket.on("disconnect", async () => {
    console.log("📴 [WS-DISCONNECT] Triggered for socket:", socket.id);

    const token = socket.handshake.headers.authorization?.split(" ")[1];
    const guestToken = socket.handshake.headers["x-guest-token"];

    console.log("🔍 [WS-DISCONNECT] Token extraction:", { token, guestToken });

    const user = token ? await getUserFromToken(token) : null;
    const guest = guestToken ? await getGuestFromToken(guestToken) : null;

    console.log("🧩 [WS-DISCONNECT] Identity resolved:", {
      user: user ? { id: user.id } : null,
      guest: guest ? { id: guest.id } : null,
    });

    if (!user && !guest) {
      console.warn("⚠️ [WS-DISCONNECT] Unknown participant → no DB update");
      return;
    }

    const column = user ? "user_id" : "guest_id";
    const participantIdInt = parseInt(user ? user.id : guest.id, 10);

    // Check if participant is host
    const [sessionOwner] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [sessionIdInt],
    );

    const isHost = user && sessionOwner[0]?.user_id === user.id;

    console.log("🏷️ [WS-DISCONNECT] Role check:", {
      isHost,
      participantId: participantIdInt,
      column,
    });

    await pool.query(
      `UPDATE session_participants 
       SET is_live = 0 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    await broadcastLiveParticipants(sessionIdInt);

    console.log("📝 [WS-DISCONNECT] Marked is_live=0 in DB");

    io.to(sessionIdInt).emit("participant_left", {
      participantId: participantIdInt,
      isGuest: !!guest,
      hostLeft: isHost,
    });

    if (isHost) {
      console.log("👑 [WS-DISCONNECT] HOST LEFT → Live may end soon");
      io.to(sessionIdInt).emit("host_left", {
        sessionId: sessionIdInt,
      });
    }

    console.log("🚪 [WS-DISCONNECT] Completed for:", participantIdInt);
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
  // Wir erwarten jetzt nur noch email und password vom Frontend
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Bitte fülle alle Felder aus." });
  }

  try {
    // 1. Prüfen, ob die E-Mail bereits existiert
    const [emailRows] = await pool.query(
      "SELECT id, google_id, facebook_id, email, username, password_hash FROM users WHERE LOWER(email) = LOWER(?)",
      [email]
    );

    if (emailRows.length > 0) {
      const existingUser = emailRows[0];

      // FALL: E-Mail existiert bereits als Social-Login -> Weiterleitung
      if (!existingUser.password_hash) {
        if (existingUser.google_id) {
          return res.status(200).json({ 
            success: false,
            redirect: "google",
            message: "Konto existiert bereits via Google. Leite weiter..." 
          });
        }
        if (existingUser.facebook_id) {
          return res.status(200).json({ 
            success: false,
            redirect: "facebook",
            message: "Konto existiert bereits via Facebook. Leite weiter..." 
          });
        }
      }
      
      // FALL: E-Mail existiert bereits als normaler Account
      return res.status(409).json({ error: "Diese E-Mail-Adresse wird bereits verwendet." });
    }

    // 2. Benutzernamen automatisch generieren (Teil vor dem @)
    let baseUsername = email.split('@')[0];
    
    // Sicherstellen, dass der Username eindeutig ist
    let finalUsername = baseUsername;
    const [userRows] = await pool.query("SELECT id FROM users WHERE username = ?", [finalUsername]);
    
    if (userRows.length > 0) {
      // Wenn der Name vergeben ist, hängen wir eine kurze Zufallszahl an
      finalUsername = `${baseUsername}_${Math.floor(100 + Math.random() * 899)}`;
    }

    // 3. Neuer Benutzer anlegen
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
      [finalUsername, email, password_hash]
    );

    const newUserId = result.insertId;

    // 4. Invites verknüpfen
    await pool.query(
      `UPDATE session_invites SET invited_user_id = ? WHERE invited_user_id IS NULL AND LOWER(email) = LOWER(?)`,
      [newUserId, email]
    );

    // 5. JWT erstellen (mit dem neuen finalUsername)
    const token = jwt.sign(
      { id: newUserId, username: finalUsername }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Registrierung erfolgreich!",
      token,
      username: finalUsername,
      userId: newUserId
    });

  } catch (err) {
    console.error("Registrierungs-Fehler:", err);
    res.status(500).json({ error: "Server-Fehler bei der Registrierung." });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Bitte gib E-Mail und Passwort an." });
  }

  try {
    // 1. User anhand der E-Mail suchen
    const [rows] = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [email]);
    const user = rows[0];

    // 2. Prüfen, ob der User überhaupt existiert
    if (!user) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten." });
    }

    // 3. SPECIAL CASE: Social-Login Check
    // Wenn kein Passwort-Hash vorhanden ist, wurde der Account via Google oder Facebook erstellt
    if (!user.password_hash) {
      if (user.google_id) {
        return res.status(403).json({ 
          error: "Social_Login_Required", 
          message: "Dieser Account ist mit Google verknüpft. Bitte nutze 'Login mit Google'.",
          method: "google"
        });
      }
      if (user.facebook_id) {
        return res.status(403).json({ 
          error: "Social_Login_Required", 
          message: "Dieser Account ist mit Facebook verknüpft. Bitte nutze 'Login mit Facebook'.",
          method: "facebook"
        });
      }
    }

    // 4. Standard Passwort-Check
    const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten." });
    }

    // 5. JWT erstellen (Payload konsistent zu Google/Facebook halten)
    const token = jwt.sign(
      { id: user.id, username: user.username }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    // 6. Erfolg
    res.json({ 
      token, 
      username: user.username,
      userId: user.id 
    });

  } catch (err) {
    console.error("Login Fehler:", err);
    res.status(500).json({ error: "Ein interner Serverfehler ist aufgetreten." });
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

  // 1. Bearer Token (eingeloggter User)
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (token) {
    try {
      user = await getUserFromToken(token); // { id, username, ... } (email kann fehlen!)
    } catch (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  // 2. Gast-Token
  const guestToken = req.headers["x-guest-token"];
  if (!user && guestToken) {
    try {
      const [rows] = await pool.query(
        "SELECT id, nickname FROM guest_users WHERE guest_token = ?",
        [guestToken],
      );
      if (rows.length > 0) {
        isGuest = true;
        user = { id: null, isGuest: true, nickname: rows[0].nickname };
      }
    } catch (err) {
      console.error("Guest token error:", err);
    }
  }

  // 3. Kein Zugriff ohne Auth
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    let rows;

    // ——————————————————————————————
    // Gast → nur öffentliche Sessions
    // ——————————————————————————————
    if (isGuest || !user.id) {
      [rows] = await pool.query(`
        SELECT 
          s.id,
          s.title,
          s.created_at,
          s.user_id AS hostId,
          u.username AS host,
          s.is_live,
          s.is_private,
          (
            SELECT COUNT(*)
            FROM session_participants sp
            WHERE sp.session_id = s.id AND sp.is_live = 1
          ) AS participant_count
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.is_private = 0
        ORDER BY participant_count DESC, s.created_at DESC
      `);
      return res.json(rows);
    }

    // ——————————————————————————————
    // Eingeloggter User → öffentlich + eigene + akzeptierte private Einladungen
    // ——————————————————————————————
    const userId = user.id;

    // E-Mail sicher aus der DB holen (auch wenn sie im JWT fehlt)
    const [[{ email: userEmail }]] = await pool.query(
      "SELECT email FROM users WHERE id = ?",
      [userId],
    );

    if (!userEmail) {
      // Sollte nie passieren, aber zur Sicherheit: nur öffentliche + eigene Sessions
      [rows] = await pool.query(
        `
        SELECT 
          s.id, s.title, s.created_at, s.user_id AS hostId, u.username AS host,
          s.is_live, s.is_private,
          (
            SELECT COUNT(*) FROM session_participants sp
            WHERE sp.session_id = s.id AND sp.is_live = 1
          ) AS participant_count
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.is_private = 0 OR s.user_id = ?
        ORDER BY participant_count DESC, s.created_at DESC
      `,
        [userId],
      );
      return res.json(rows);
    }

    // Hauptquery: alles in einem Rutsch
    [rows] = await pool.query(
      `
      SELECT DISTINCT
        s.id,
        s.title,
        s.created_at,
        s.user_id AS hostId,
        u.username AS host,
        s.is_live,
        s.is_private,
        (
          SELECT COUNT(*)
          FROM session_participants sp
          WHERE sp.session_id = s.id AND sp.is_live = 1
        ) AS participant_count
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN session_invites si 
        ON si.session_id = s.id 
       AND si.email = ?
       AND si.accepted_at IS NOT NULL                 -- WICHTIG: nur akzeptierte!
       AND si.status != 'revoked'
      WHERE 
        s.is_private = 0                               -- öffentlich
        OR s.user_id = ?                                -- eigener Host
        OR si.id IS NOT NULL                            -- akzeptierte Einladung
      ORDER BY participant_count DESC, s.created_at DESC
    `,
      [userEmail, userId],
    );

    return res.json(rows);
  } catch (err) {
    console.error("Get sessions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// === Sessions erstellen ===
app.post("/sessions", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { title, is_private } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: "Title required" });

  const privateFlag = is_private ? 1 : 0;

  // Paywall: private sessions require an active $5/month subscription.
  // Public sessions remain free.
  if (privateFlag === 1) {
    const entitled = await hasActiveSubscription(user.id);
    if (!entitled) {
      return res.status(402).json({
        error: "subscription_required",
        message:
          "A $5/month subscription is required to create private sessions.",
      });
    }
  }

  try {
    const [result] = await pool.query(
      "INSERT INTO sessions (user_id, title, is_private) VALUES (?, ?, ?)",
      [user.id, title.trim(), privateFlag],
    );

    console.log("🟢 Session insert result:", result);

    const sessionId = result.insertId;
    console.log("✅ New session created:", sessionId);

    await ensureParticipant(sessionId, user, null, true);

    const [newSession] = await pool.query(
      "SELECT s.id, s.title, s.is_private, s.created_at, u.username AS host FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?",
      [sessionId],
    );

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
    // 1. Authentifizierung prüfen – nur komplett unauthentifizierte erlauben
    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    if (user || guest) {
      return res.status(400).json({
        error: "Already authenticated – bitte /sessions verwenden",
      });
    }

    // ─────────────────────────────────────────────
    // Wichtigster Teil: Name aus Query-Parameter
    // ─────────────────────────────────────────────
    const requestedTitle = req.query.name || req.query.title; // z. B. ?name=Midnight Neon Drive 🌌
    const useCustomName = !!requestedTitle && requestedTitle.trim().length > 0;

    const DEFAULT_TITLE = "TuneVote Radio – Live for everyone";

    let sessionId;
    let autoStarted = false;

    // Fall 1: Expliziter Name → immer neue Session erstellen
    if (useCustomName) {
      sessionId = await createNewPublicSession(requestedTitle.trim());
      autoStarted = true;
    }
    // Fall 2: Kein Name → wie bisher: älteste live Session nehmen oder Standard-Session erstellen
    else {
      // Älteste öffentliche live Session suchen
      const [existing] = await pool.query(`
        SELECT id
        FROM sessions
        WHERE is_private = 0 AND is_live = 1
        ORDER BY created_at ASC
        LIMIT 1
      `);

      if (existing.length > 0) {
        sessionId = existing[0].id;
      } else {
        sessionId = await createNewPublicSession(DEFAULT_TITLE);
        autoStarted = true;
      }
    }

    // 3. Redirect zum Frontend
    res.json({
      redirect: `https://app.tunevote.com/session/${sessionId}`,
    });

    // ─────────────────────────────────────────────
    // Auto-Start nur bei neu erstellter Session
    // ─────────────────────────────────────────────
    if (autoStarted) {
      setTimeout(async () => {
        try {
          await axios.post(`https://api.tunevote.com/sessions/${sessionId}/start`);
          console.log(`[AUTO] Session ${sessionId} gestartet (Titel: ${requestedTitle || DEFAULT_TITLE})`);
        } catch (err) {
          console.error("[AUTO] Start fehlgeschlagen:", err.response?.data || err.message);
        }
      }, 800);
    }

  } catch (err) {
    console.error("Fehler in /join:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// Hilfsfunktion – erstellt immer eine neue öffentliche Session + Voting-Round + Initial-Queue
async function createNewPublicSession(title) {
  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    // Session erstellen
    const [sessionResult] = await connection.query(`
      INSERT INTO sessions
        (user_id, title, is_private, is_live, created_at)
      VALUES
        (1, ?, 0, 0, NOW())
    `, [title]);

    const sessionId = sessionResult.insertId;

    // Voting-Round
    const [roundResult] = await connection.query(`
      INSERT INTO voting_rounds
        (session_id, status, phase, phase_ends_at,
         suggestion_duration, voting_duration, created_at)
      VALUES
        (?, 'open', 'suggestion', DATE_ADD(NOW(), INTERVAL 90 SECOND),
         90, 60, NOW())
    `, [sessionId]);

    const votingRoundId = roundResult.insertId;

    // Zufällige Songs holen (Fallback-Queue)
const [songs] = await connection.query(`
  SELECT DISTINCT
    yvc.youtube_id AS video_id,
    yvc.title,
    yvc.duration,
    yvc.thumbnail
  FROM youtube_video_cache yvc
  JOIN queue_items qi ON qi.video_id = yvc.youtube_id
  ORDER BY RAND()
  LIMIT 7
`);

if (songs.length < 2) {
  throw new Error("Nicht genügend Songs für Auto-Queue");
}

    // Erste 2 = bereits gespielt
    for (const song of songs.slice(0, 2)) {
      await connection.query(`
        INSERT INTO queue_items
          (session_id, video_id,
           status, playedAt,
           item_type, item_source, voting_round_id, created_at)
        VALUES
          (?, ?,
           'played', NOW(),
           'music', 'user', ?, NOW())
      `, [
        sessionId,
        song.video_id,
        votingRoundId,
      ]);
    }

    // Rest = in der Queue
    for (const song of songs.slice(2)) {
      await connection.query(`
        INSERT INTO queue_items
          (session_id, video_id, added_by,
           status,
           item_type, item_source, voting_round_id, created_at)
        VALUES
          (?, ?, 1,
           'queued',
           'music', 'user', ?, NOW())
      `, [
        sessionId,
        song.video_id,
        votingRoundId,
      ]);
    }

    await connection.commit();
    return sessionId;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// GET /sessions/:id/current-voting-phase
app.get("/sessions/:id/current-voting-phase", async (req, res) => {
  const sessionId = parseInt(req.params.id);

  try {
    const [[round]] = await pool.query(`
      SELECT 
        id AS roundId,
        phase,
        UNIX_TIMESTAMP(phase_ends_at) * 1000 AS endsAtMs,
        CASE 
          WHEN phase = 'suggestion' THEN suggestion_duration 
          WHEN phase = 'voting' THEN voting_duration 
          ELSE 90 
        END AS durationSeconds
      FROM voting_rounds
      WHERE session_id = ?
        AND status = 'open'
      ORDER BY id DESC
      LIMIT 1
    `, [sessionId]);

    if (!round) {
      return res.json({ phase: null, endsAt: null, duration: 0, roundId: null });
    }

    res.json({
      phase: round.phase,
      endsAt: round.endsAtMs,
      duration: round.durationSeconds,
      roundId: round.roundId
    });
  } catch (err) {
    console.error("Current phase fetch error:", err);
    res.status(500).json({ error: "Failed to get current phase" });
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

// === PATCH: Session-Namen ändern (nur Host!) ===
app.patch("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  // Authentifizierung
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Nur angemeldete User (keine Gäste!) dürfen Session-Namen ändern
  if (!user) {
    return res
      .status(403)
      .json({ error: "Gäste dürfen den Session-Namen nicht ändern" });
  }

  // Validierung
  if (
    !title ||
    typeof title !== "string" ||
    title.trim().length < 1 ||
    title.trim().length > 100
  ) {
    return res.status(400).json({ error: "Ungültiger Name (1–100 Zeichen)" });
  }

  const cleanTitle = title.trim();

  try {
    // Prüfen, ob Session existiert und der User der Host ist
    const [rows] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Session nicht gefunden" });
    }

    if (rows[0].user_id !== user.id) {
      return res
        .status(403)
        .json({ error: "Nur der Host darf den Namen ändern" });
    }

    // Update durchführen
    await pool.query("UPDATE sessions SET title = ? WHERE id = ?", [
      cleanTitle,
      id,
    ]);

    res.json({ success: true, title: cleanTitle });
  } catch (err) {
    console.error("Fehler beim Umbenennen der Session:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// === Queue endpoints ===
app.get("/sessions/:id/queue", async (req, res) => {
  const { id } = req.params;

  const [queue] = await pool.query(
    `
    SELECT
      qi.id,
      qi.session_id,
      qi.video_id,
      qi.added_by,
      qi.guest_id,
      qi.status,
      qi.created_at,
      qi.playedAt,
      qi.startedAt,
      qi.pause_duration_seconds,
      qi.description,
      qi.item_type,
      qi.item_source,
      qi.voting_round_id,
      qi.item_type AS itemType,
      COALESCE(yvc.title, qi.description)               AS title,
      yvc.thumbnail                                     AS thumbnail,
      COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
      COALESCE(u.username, g.nickname, 'Gast')          AS addedBy
    FROM queue_items qi
    LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
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

  console.log("[Recommendations AUTH DEBUG] Eingehender guestToken:", guestToken);

  let user = null;
  let guest = null;

  if (token) {
    user = await getUserFromToken(token);
    console.log("[Recommendations AUTH] User-Token erkannt → user:", user ? user.id : "null");
  } else if (guestToken) {
    guest = await getGuestFromToken(guestToken);
    console.log("[Recommendations AUTH] Guest-Token erkannt → guest:", guest ? guest.id : "null");
  }

  if (!user && !guest) {
    console.warn("[Recommendations AUTH] Unauthorized – weder User noch Guest gefunden");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[Recommendations AUTH] Headers:", req.headers);
  console.log("[Recommendations AUTH] x-guest-token raw:", req.headers["x-guest-token"]);
  console.log("[Recommendations AUTH] Nach trim:", req.headers["x-guest-token"]?.trim());
  console.log("[Recommendations BLUFF AUTH] x-guest-token raw:", guestToken);
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
    ORDER BY qi.id DESC
    `,
    [id],
  );

  const titles = queueRows.map((r) => r.title);

  // ---- Voting-Round & AI Suggestion Check ----
  const [votingRoundRows] = await pool.query(
    `SELECT id FROM voting_rounds 
     WHERE session_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [id],
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
    [currentRoundId],
  );

  const numItems = suggestedRows[0].count;

  // === 1. Alle aktuellen KI-Vorschläge laden ===
  let existingAi = await pool.query(
    `SELECT qi.id, yvc.title, qi.video_id AS youtubeId, yvc.thumbnail
     FROM queue_items qi
     LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
     WHERE qi.session_id = ?
       AND qi.voting_round_id = ?
       AND qi.item_source = 'ai'
       AND qi.status = 'suggested'
     ORDER BY qi.id ASC`,
    [id, currentRoundId],
  );
  existingAi = existingAi[0]; // [[rows], fields] → nur rows

  console.log(
    `[AI] Runde ${currentRoundId}: Gefunden ${existingAi.length} bestehende AI-Vorschläge`
  );

  // === 2. Falls mehr als 3 KI-Vorschläge existieren → überschüssige löschen ===
  if (existingAi.length > 3) {
    const toDelete = existingAi.slice(3).map((item) => item.id);
    await pool.query(
      `DELETE FROM queue_items WHERE id IN (?) AND item_source = 'ai'`,
      [toDelete],
    );
    console.log(
      `[AI] Cleaned up ${toDelete.length} excess AI suggestions → keeping only the oldest 3`
    );

    // Nach dem Löschen neu laden
    const [cleaned] = await pool.query(
      `SELECT qi.id, yvc.title, qi.video_id AS youtubeId, yvc.thumbnail
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
       WHERE qi.session_id = ? AND qi.voting_round_id = ? AND qi.item_source = 'ai' AND qi.status = 'suggested'
       ORDER BY qi.id ASC`,
      [id, currentRoundId],
    );
    existingAi = cleaned;
  }

  // === 3. Genau auf 3 KI-Vorschläge bringen ===
  const currentCount = existingAi.length;
  const needed = 3 - currentCount;

  let finalAiSuggestions = [...existingAi];

  try {
    if (needed > 0) {
      console.log(
        `[AI] ${numItems} total suggested items. Generating ${needed} new AI suggestion(s) to reach exactly 3...`
      );

      // ---- Get suggested titles to avoid duplicates ----
      const [suggestedTitleRows] = await pool.query(
        `
        SELECT yvc.title
        FROM queue_items qi
        JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
        WHERE qi.voting_round_id = ? AND qi.status = 'suggested'
        `,
        [currentRoundId],
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
          ((longer.length - levenshteinDistance(longer, shorter)) / longer.length) *
            100,
        );
      };

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
          const normalizedCache = normalize(row.title_norm);
          const score = levenshteinRatio(normalizedAI, normalizedCache);
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
                },
              );

              const durIso = ytDetails.data.items?.[0]?.contentDetails?.duration;
              if (durIso) {
                const match = durIso.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
                const mins = parseInt(match?.[1] ?? 0, 10);
                const secs = parseInt(match?.[2] ?? 0, 10);
                durationSeconds = mins * 60 + secs;
                await pool.query(
                  `UPDATE youtube_video_cache SET duration = ? WHERE youtube_id = ?`,
                  [durationSeconds, bestMatch.youtube_id],
                );
              }
            } catch (err) {
              console.warn(
                "[YouTube] Failed to fetch duration from cache match:",
                err.message,
              );
            }
          }
          results.push({
            title: bestMatch.title,
            youtubeId: bestMatch.youtube_id,
            thumbnail: bestMatch.thumbnail || "",
            duration: durationSeconds,
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
              },
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

          results.push({
            title,
            youtubeId: videoId,
            thumbnail,
            duration: durationSeconds,
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
            (session_id, video_id, status, item_source, item_type, voting_round_id)
           VALUES (?, ?, 'suggested', 'ai', 'music', ?)`,
          [
            id,
            item.youtubeId,
            currentRoundId,
          ],
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

      finalAiSuggestions = [...finalAiSuggestions, ...created];

      console.log(
        `[AI] Erfolgreich ${created.length} neue Vorschläge hinzugefügt → jetzt insgesamt ${finalAiSuggestions.length}`
      );
    } else {
      console.log(
        `[AI] Bereits ${currentCount} AI-Vorschläge vorhanden → keine Neugenerierung nötig`
      );
    }

    // === Finale Rückgabe ===
    return res.json(finalAiSuggestions);
  } catch (err) {
    console.error("[Recommendation Error]", err);
    // Fallback: trotzdem die bestehenden zurückgeben
    console.warn(
      `[AI] Generierung fehlgeschlagen – gebe trotzdem die ${finalAiSuggestions.length} vorhandenen zurück`
    );
    return res.json(finalAiSuggestions);
  }
});

// ---------------------------------------------------------------
// 5. NEW ENDPOINT – ADD RECOMMENDED SONG (click → queue)
// ---------------------------------------------------------------
app.post("/sessions/:id/recommendations/add", async (req, res) => {
  const { id: sessionId } = req.params;
  const { youtubeId } = req.body; // nur youtubeId vom Client nötig

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  try {
    // =================================================
    // Session-Status holen (wie in /proposals)
    // =================================================
    const [[sessionRow]] = await pool.query(
      "SELECT user_id, is_live FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isSessionLive = sessionRow.is_live === 1;

    let votingRoundId = null;
    let status = "suggested"; // Default für Empfehlungen: immer suggested

    // =================================================
    // STRIKTE Phase-Prüfung – genau wie in /proposals
    // =================================================
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, phase 
         FROM voting_rounds 
         WHERE session_id = ? 
           AND status = 'open' 
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );

      if (!round) {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber KEINE offene Runde → 403`);
        return res.status(403).json({ 
          error: "Keine aktive Voting-Runde – Empfehlungen momentan nicht möglich" 
        });
      }

      if (round.phase !== "suggestion") {
        console.log(`[RECOMMENDATIONS/ADD] Session ${sessionId} live, aber falsche Phase (${round.phase}) → 403`);
        return res.status(403).json({ 
          error: `Nur in der Vorschlagsphase möglich (aktuell: ${round.phase})` 
        });
      }

      // Alles korrekt → verknüpfen
      votingRoundId = round.id;
      status = "suggested";
    }

    // =================================================
    // Video-Infos aus Cache holen
    // =================================================
    const [rows] = await pool.query(
      `SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ? LIMIT 1`,
      [youtubeId],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Video nicht gefunden im Cache" });
    }

    const { title, thumbnail, duration } = rows[0];

    // =================================================
    // Doppelte-Prüfung (optional – nur bei suggested)
    // =================================================
    if (status === "suggested" && votingRoundId) {
      const [existing] = await pool.query(
        `SELECT id FROM queue_items 
         WHERE session_id = ? 
           AND voting_round_id = ? 
           AND video_id = ? 
           AND status = 'suggested' 
         LIMIT 1`,
        [sessionId, votingRoundId, youtubeId]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "Dieser Song wurde in dieser Runde bereits vorgeschlagen"
        });
      }
    }

    // =================================================
    // Insert – jetzt MIT voting_round_id
    // =================================================
    await pool.query(
      `INSERT INTO queue_items
       (session_id, item_type, video_id, added_by, guest_id,
        status, voting_round_id, item_source)
       VALUES (?, 'music', ?, ?, ?, ?, ?, 'ai')`,
      [
        sessionId,
        youtubeId,
        user?.id || null,
        guest?.id || null,
        status,
        votingRoundId
      ]
    );

    // Broadcast
    io.to(sessionId).emit("proposals_updated", {}); // da suggested

    console.log(`[RECOMMENDATIONS/ADD] Erfolgreich hinzugefügt: ${title} (Round ${votingRoundId || 'none'})`);

    res.json({ 
      success: true, 
      youtubeId, 
      title, 
      thumbnail, 
      duration,
      status,
      votingRoundId 
    });

  } catch (err) {
    console.error("Add recommendation error:", err);
    res.status(500).json({ error: "Failed to add song" });
  }
});

app.get("/sessions/:id/invites/accepted", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  // === 1. Token prüfen (genau wie in deinen anderen Routes) ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
  const guestToken = req.headers["x-guest-token"];

  let user = null;
  if (token) {
    user = await getUserFromToken(token);
  }
  // Gäste dürfen diese Route NICHT nutzen
  if (!user || guestToken) {
    return res
      .status(401)
      .json({
        error: "Nur eingeloggte User (keine Gäste) dürfen diese Route nutzen",
      });
  }

  try {
    // === 2. Session direkt per SQL holen + Berechtigung prüfen ===
    const [sessionRows] = await pool.query(
      `SELECT id, user_id, title, is_private, is_live 
       FROM sessions 
       WHERE id = ? 
       LIMIT 1`,
      [sessionId],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Session nicht gefunden" });
    }

    const session = sessionRows[0];

    if (session.is_private !== 1) {
      return res.status(400).json({ message: "Session ist nicht privat" });
    }

    if (session.user_id !== user.id) {
      return res
        .status(403)
        .json({
          message: "Nur der Host darf die akzeptierten Einladungen sehen",
        });
    }

    // === 3. Akzeptierte Einladungen holen ===
    const [invites] = await pool.query(
      `SELECT 
          si.id,
          si.email AS invitee_email,
          u.imageType,
          u.imageData,
          si.invited_user_id,
          u.username AS invitee_name,
          si.accepted_at
       FROM session_invites si
       LEFT JOIN users u ON si.invited_user_id = u.id
       WHERE si.session_id = ?
         AND si.status = 'accepted'
       ORDER BY si.accepted_at DESC`,
      [sessionId],
    );

    // === 4. Perfektes Format für dein Frontend ===
    const formatted = invites.map((invite) => {
      let imageData = null;

      if (invite.imageData && invite.imageType) {
        imageData = `data:${invite.imageType};base64,${invite.imageData.toString("base64")}`;
      }

      return {
        id: invite.id,
        invitee_email: invite.invitee_email,
        invitee_name: invite.invitee_name || null,
        accepted_at: invite.accepted_at,
        imageData,
      };
    });

    return res.json(formatted);
  } catch (err) {
    console.error("Fehler in GET /sessions/:id/invites/accepted:", err);
    return res.status(500).json({ message: "Interner Serverfehler" });
  }
});

app.delete("/sessions/:id/invites/:inviteId", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const inviteId = parseInt(req.params.inviteId);

  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [session] = await pool.query(
    "SELECT user_id FROM sessions WHERE id = ?",
    [sessionId],
  );
  if (!session || session[0].user_id !== user.id) {
    return res.status(403).json({ message: "Nur Host" });
  }

  await pool.query(
    "UPDATE session_invites SET status = 'revoked', revoked_at = NOW() WHERE id = ? AND session_id = ?",
    [inviteId, sessionId],
  );

  res.json({ success: true });
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
    // 1. Session-Status holen
    const [[sessionRow]] = await pool.query(
      "SELECT user_id, is_live FROM sessions WHERE id = ?",
      [sessionId]
    );
    if (!sessionRow) return res.status(404).json({ error: "Session not found" });

    const isHost = user && sessionRow.user_id === user.id;
    const isSessionLive = sessionRow.is_live === 1;

    let votingRoundId = null;
    let status = "queued";

    // 2. Wenn Session live ist → STRIKTE Phase-Prüfung
    if (isSessionLive) {
      const [[round]] = await pool.query(
        `SELECT id, phase 
         FROM voting_rounds 
         WHERE session_id = ? 
           AND status = 'open' 
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );

      // Keine offene Runde → komplett verbieten
      if (!round) {
        return res.status(403).json({ 
          error: "Keine aktive Voting-Runde – Vorschläge/Pausen momentan nicht möglich" 
        });
      }

      // Runde existiert, aber nicht suggesting → verbieten
      if (round.phase !== "suggestion") {
        return res.status(403).json({ 
          error: "Aktuell läuft die Abstimmung – Vorschläge/Pausen erst in der nächsten Vorschlagsphase möglich" 
        });
      }

      // Alles korrekt → suggested + round verknüpfen
      votingRoundId = round.id;
      status = "suggested";
    } else {
      // Session nicht live → nur Host darf direkt queued einfügen
      if (!isHost) {
        return res.status(403).json({ 
          error: "Nur der Host darf Vorschläge machen, solange die Session nicht live ist" 
        });
      }
      // status bleibt "queued" (wie vorher)
    }

    // =================================================
    // Pause-Handling
    // =================================================
    if (item_type === "pause") {
      const duration = Number(pauseDuration) || 30;
      if (duration < 5 || duration > 600) {
        return res.status(400).json({ 
          error: "Pausendauer muss zwischen 5 und 600 Sekunden liegen" 
        });
      }

      const desc = (description || "Kurze Pause").trim().slice(0, 100);

      await pool.query(
        `INSERT INTO queue_items
         (session_id, item_type, description, pause_duration_seconds,
          added_by, guest_id, status, item_source, voting_round_id)
         VALUES (?, 'pause', ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          desc,
          duration,
          user?.id || null,
          guest?.id || null,
          status,
          user ? "user" : "guest",
          votingRoundId   // ← jetzt immer gesetzt, wenn suggesting läuft
        ]
      );

      // Broadcast
      if (status === "suggested") {
        io.to(sessionId).emit("proposals_updated", {});
      } else {
        io.to(sessionId).emit("queue_updated", {});
      }

      return res.status(201).json({ 
        success: true, 
        type: "pause", 
        status,
        votingRoundId 
      });
    }

    // =================================================
    // Musik-Handling
    // =================================================
    if (!videoId) {
      return res.status(400).json({ error: "Missing videoId" });
    }

    let title, thumbnail, duration;

    // Cache oder ytdl
    const [cachedRows] = await pool.query(
      "SELECT title, thumbnail, duration FROM youtube_video_cache WHERE youtube_id = ?",
      [videoId]
    );

    if (cachedRows.length > 0) {
      ({ title, thumbnail, duration } = cachedRows[0]);
    } else {
      try {
        const info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const videoDetails = info.videoDetails;

        title = videoDetails.title || clientTitle || "Unbekannter Titel";
        thumbnail =
          videoDetails.thumbnails?.[0]?.url ||
          clientThumbnail ||
          `https://i.ytimg.com/vi/${videoId}/default.jpg`;
        duration = parseInt(videoDetails.lengthSeconds) || 0;

        await pool.query(
          `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration)
           VALUES (?, ?, ?, ?, ?)`,
          [videoId, title, normalize(title), thumbnail, duration]
        );
      } catch (ytdlErr) {
        console.error("ytdl failed:", ytdlErr);
        return res.status(400).json({ error: "Video nicht verfügbar" });
      }
    }

    // Doppelte-Prüfung nur wenn suggested
    if (status === "suggested" && votingRoundId) {
      const [existing] = await pool.query(
        `SELECT id FROM queue_items 
         WHERE session_id = ? 
           AND voting_round_id = ? 
           AND video_id = ? 
           AND status = 'suggested' 
         LIMIT 1`,
        [sessionId, votingRoundId, videoId]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          error: "Dieser Song wurde in dieser Runde bereits vorgeschlagen"
        });
      }
    }

    await pool.query(
      `INSERT INTO queue_items
       (session_id, item_type, video_id, added_by, guest_id,
        status, voting_round_id, item_source)
       VALUES (?, 'music', ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        videoId,
        user?.id || null,
        guest?.id || null,
        status,
        votingRoundId,          // ← jetzt garantiert korrekt gesetzt
        user ? "user" : "guest"
      ]
    );

    // Broadcast
    if (status === "suggested") {
      io.to(sessionId).emit("proposals_updated", {});
    } else {
      io.to(sessionId).emit("queue_updated", {});
    }

    res.status(201).json({
      success: true,
      type: "music",
      status,
      votingRoundId
    });

  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Interner Fehler" });
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
        COALESCE(yvc.title, q.description)               AS title,
        yvc.thumbnail                                    AS thumbnail,
        q.status,
        q.video_id,
        q.voting_round_id,
        q.item_type,        -- NEU
        q.item_source,      -- NEU
        q.description,      -- für Pausen
        COALESCE(yvc.duration, q.pause_duration_seconds) AS duration,
        COALESCE(v.vote_count, 0) AS votes,
        u.username AS addedByUser,
        g.nickname AS addedByGuest
      FROM queue_items q
      LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = q.video_id
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

// GET /sessions/:id/current-phase
app.get("/sessions/:id/current-phase", async (req, res) => {
  const { id } = req.params;

  try {
    const [[round]] = await pool.query(
      `SELECT phase, phase_ends_at, 
              TIMESTAMPDIFF(SECOND, created_at, phase_ends_at) AS duration
       FROM voting_rounds 
       WHERE session_id = ? AND status = 'open' 
       ORDER BY id DESC LIMIT 1`,
      [id],
    );

    if (!round || !round.phase_ends_at) {
      return res.status(404).json({ error: "No active phase" });
    }

    res.json({
      phase: round.phase,
      endsAt: new Date(round.phase_ends_at).toISOString(),
      duration: round.duration || 90,
      roundId: round.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// === Voting ===
// POST /sessions/:id/proposals/:propId/vote
app.post("/sessions/:id/proposals/:propId/vote", async (req, res) => {
  const { id, propId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];
  const user = await getUserFromToken(token);
  const guest = await getGuestFromToken(guestToken);
  if (!user && !guest) return res.status(401).json({ error: "Unauthorized" });

  // Session live?
  const [[sessionRow]] = await pool.query(
    "SELECT is_live FROM sessions WHERE id = ?",
    [id],
  );
  if (!sessionRow || sessionRow.is_live !== 1) {
    return res.status(403).json({ error: "Session nicht live" });
  }

  // Nur in Voting-Phase erlaubt
  const [[currentRound]] = await pool.query(
    `SELECT phase, id AS roundId 
     FROM voting_rounds 
     WHERE session_id = ? AND status = 'open' 
     ORDER BY id DESC LIMIT 1`,
    [id],
  );

  if (!currentRound || currentRound.phase !== "voting") {
    return res.status(403).json({ error: "Aktuell läuft keine Abstimmung" });
  }

  // Proposal existiert und ist suggested?
  const [[proposal]] = await pool.query(
    `SELECT voting_round_id FROM queue_items 
     WHERE id = ? AND session_id = ? AND status = 'suggested'`,
    [propId, id],
  );
  if (!proposal || proposal.voting_round_id !== currentRound.roundId) {
    return res.status(404).json({ error: "Vorschlag nicht abstimmbar" });
  }

  const voterId = user?.id || guest?.id;
  const voterColumn = user ? "user_id" : "guest_id";

  // Toggle Vote (Upvote / Widerruf)
  const [[existing]] = await pool.query(
    `SELECT id FROM votes WHERE queue_item_id = ? AND ${voterColumn} = ?`,
    [propId, voterId],
  );

  if (existing) {
    await pool.query(`DELETE FROM votes WHERE id = ?`, [existing.id]);
  } else {
    await pool.query(
      `INSERT INTO votes (queue_item_id, user_id, guest_id) VALUES (?, ?, ?)`,
      [propId, user?.id || null, guest?.id || null],
    );
  }

  // Immer nur UI updaten – KEINE vorzeitige Auswertung mehr!
  io.to(id).emit("proposals_updated");

  // 🔥 NEU: Top-Charts aktualisieren (Votes zählen ja mit!)
  await broadcastTodayTopArtists(io);

  res.json({ success: true });
});

// DELETE /sessions/:sessionId/proposals/:proposalId
app.delete("/sessions/:sessionId/proposals/:proposalId", async (req, res) => {
  const { sessionId, proposalId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  let userId = null;
  let guestId = null;

  // === Authentifizierung ===
  if (token) {
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Ungültiger Token" });
    userId = user.id;
  } else if (guestToken) {
    const guest = await getGuestFromToken(guestToken);
    if (!guest) return res.status(401).json({ error: "Ungültiger Gast-Token" });
    guestId = guest.id;
  } else {
    return res.status(401).json({ error: "Kein Zugriffstoken" });
  }

  try {
    // 1. Den suggested queue_item + Host-ID der Session holen
    const [rows] = await pool.query(
      `SELECT qi.*, s.user_id AS host_user_id 
       FROM queue_items qi
       JOIN sessions s ON qi.session_id = s.id
       WHERE qi.id = ? 
         AND qi.session_id = ? 
         AND qi.status = 'suggested'`,
      [proposalId, sessionId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Vorschlag nicht gefunden oder nicht mehr löschbar",
      });
    }

    const item = rows[0];

    // 2. Aktuelle Voting-Phase prüfen
    const [phaseRows] = await pool.query(
      `SELECT phase FROM voting_rounds 
       WHERE session_id = ? AND status = 'open' 
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );

    const currentPhase = phaseRows[0]?.phase || null;

    if (currentPhase !== "suggestion") {
      return res.status(403).json({
        message: "Löschen nur in der Vorschlagsphase möglich",
      });
    }

    // 3. Berechtigung prüfen: Eigentümer ODER Host
    const isOwner =
      (userId && item.added_by === userId) ||
      (guestId && item.guest_id === guestId);

    const isHost = userId && item.host_user_id === userId;

    if (!isOwner && !isHost) {
      return res.status(403).json({
        message: "Du kannst nur deinen eigenen Vorschlag entfernen",
      });
    }

    // 4. Löschen
    await pool.query("DELETE FROM queue_items WHERE id = ?", [proposalId]);

    // 5. Echtzeit-Update an alle
    req.io?.to(`session_${sessionId}`).emit("proposals_updated");
    req.io?.to(`session_${sessionId}`).emit("queue_updated");

    return res.json({ message: "Vorschlag erfolgreich entfernt" });
  } catch (err) {
    console.error("Fehler beim Löschen des Vorschlags:", err);
    return res.status(500).json({ message: "Serverfehler" });
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
      },
    );
    const durationIso = ytRes.data.items[0]?.contentDetails.duration;
    const duration = parseIsoDuration(durationIso);

    // Ensure the cache row exists before inserting into queue_items —
    // queue_items.video_id is now an FK to youtube_video_cache.youtube_id.
    await pool.query(
      `INSERT INTO youtube_video_cache (youtube_id, title, title_norm, thumbnail, duration)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         title_norm = VALUES(title_norm),
         thumbnail = COALESCE(VALUES(thumbnail), thumbnail),
         duration = COALESCE(VALUES(duration), duration)`,
      [videoId, title, normalize(title), thumbnail, duration],
    );

    await pool.query(
      "INSERT INTO queue_items (session_id, video_id, added_by, status, item_type) VALUES (?, ?, ?, 'queued', 'music')",
      [id, videoId, user.id],
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

  const [[sess]] = await pool.query(
    "SELECT is_live FROM sessions WHERE id = ?",
    [id],
  );
  if (!sess) return res.status(404).json({ error: "Session not found" });
  if (sess.is_live) {
    return res.status(400).json({ error: "Session already live" });
  }

  // 🧹 Reset playback_sync
  await pool.query(`DELETE FROM playback_sync WHERE session_id = ?`, [id]);

  // Alle bisherigen "suggested" Vorschläge in die Queue übernehmen
  await pool.query(
    `
    UPDATE queue_items 
    SET status = 'queued', voting_round_id = NULL 
    WHERE session_id = ? AND status = 'suggested'
  `,
    [id],
  );

  // 🚀 Session live setzen
  await pool.query("UPDATE sessions SET is_live = 1 WHERE id = ?", [id]);

  // 🎵 Prüfen, ob Songs in der Queue sind → sofort abspielen
  const [first] = await pool.query(
    `SELECT qi.id, qi.video_id,
            COALESCE(yvc.duration, qi.pause_duration_seconds) AS duration,
            COALESCE(yvc.title, qi.description)               AS title
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      WHERE qi.session_id = ? AND qi.status = 'queued'
      ORDER BY qi.id ASC LIMIT 1`,
    [id],
  );

  let firstSongStarted = false;
  if (first[0]) {
    const firstId = first[0].id;
    const firstVideoId = first[0].video_id;
    const duration = first[0].duration || 180;
    const startTime = Date.now();

    // 🕒 Ersten Song auf "playing" setzen
    await pool.query(
      `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
      [firstId],
    );

    // 🧩 playback_sync setzen
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
      `[Playback] Session ${id} STARTED with first song: videoId=${firstVideoId} – "${first[0].title}"`,
    );

    io.to(id).emit("session_started", {
      autoStarted: true,
      firstVideoId,
      video_start_time: startTime,
    });

    io.to(id).emit("playback_sync", {
      current_queue_item_id: firstId,
      current_video_id: firstVideoId,
      video_start_time: startTime,
      is_playing: true,
    });

    if (sessionTimers[id]) clearTimeout(sessionTimers[id]);
    sessionTimers[id] = setTimeout(() => advanceToNext(id), duration * 1000);

    firstSongStarted = true;
  } else {
    io.to(id).emit("queue_empty");
    console.log(`[Session ${id}] Gestartet – aber Queue ist leer`);
  }

  // ===============================================
  // Erste Voting-Runde mit Phasen starten
  // ===============================================
  const suggestionDuration = 90; // Sekunden
  const votingDuration = 60; // Sekunden
  const suggestionEndsAt = new Date(Date.now() + suggestionDuration * 1000);

  const [roundResult] = await pool.query(
    `INSERT INTO voting_rounds 
      (session_id, status, phase, phase_ends_at, suggestion_duration, voting_duration)
     VALUES (?, 'open', 'suggestion', ?, ?, ?)`,
    [id, suggestionEndsAt, suggestionDuration, votingDuration],
  );

  const votingRoundId = roundResult.insertId;

  startPhaseTimer(id, votingRoundId, "suggestion", suggestionDuration);

  io.to(id).emit("voting_phase_changed", {
    phase: "suggestion",
    endsAt: suggestionEndsAt.getTime(),
    roundId: votingRoundId,
    duration: suggestionDuration,
  });

  io.to(id).emit("proposals_updated");
  io.to(id).emit("queue_updated");

  console.log(
    `[Session ${id}] Radio gestartet! Erste Voting-Runde #${votingRoundId} (Vorschläge: ${suggestionDuration}s, Voting: ${votingDuration}s)`,
  );

  res.json({
    success: true,
    firstSongStarted,
    votingRoundStarted: true,
    votingRoundId,
  });
});

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
      body: req.body,
    });

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];

    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    console.log("🔍 [JOIN-LIVE] Decoded tokens:", {
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      guest: guest ? { id: guest.id, tempName: guest.tempName } : null,
    });

    if (!user && !guest) {
      console.warn(
        "❌ [JOIN-LIVE] Unauthorized — no valid token or guest token",
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [sess] = await pool.query(
      "SELECT user_id FROM sessions WHERE id = ?",
      [id],
    );

    if (!sess[0]) {
      console.warn("⚠️ [JOIN-LIVE] Session not found in DB:", id);
      return res.status(404).json({ error: "Session not found" });
    }

    const column = user ? "user_id" : "guest_id";
    const participantId = user ? user.id : guest.id;
    const role = user
      ? sess[0].user_id === user.id
        ? "host"
        : "user"
      : "guest";

    console.log("👤 [JOIN-LIVE] Participant info:", {
      sessionId: id,
      participantId,
      type: user ? "user" : "guest",
      role,
      sessionOwnerId: sess[0].user_id,
    });

    // === Check existing participant ===
    const [existing] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [parseInt(id, 10), parseInt(participantId, 10)],
    );

    if (existing.length > 0) {
      console.log(
        "♻️ [JOIN-LIVE] Participant already exists. Reactivating is_live=1",
        existing[0],
      );
      await pool.query(
        `
  UPDATE session_participants 
  SET 
    is_live = 1,
    role = ?,
    left_at = NULL
  WHERE session_id = ? AND ${column} = ?
  `,
        [role, id, participantId],
      );
    } else {
      console.log(
        "🆕 [JOIN-LIVE] Participant not found in DB. Inserting new record.",
      );
      await pool.query(
        `
  INSERT INTO session_participants 
    (session_id, ${column}, role, is_live, joined_at)
  VALUES (?, ?, ?, 1, NOW())
  `,
        [id, participantId, role],
      );
    }

    // === Final DB check ===
    const [check] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [parseInt(id, 10), parseInt(participantId, 10)],
    );

    console.log("📝 [JOIN-LIVE] DB state after join:", check);

    console.log("✅ [JOIN-LIVE] Join successful for participant:", {
      sessionId: parseInt(id, 10),
      participantId: parseInt(participantId, 10),
      role,
    });

    await broadcastLiveParticipants(parseInt(id, 10));

    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND is_live = 1",
      [parseInt(id, 10)],
    );

    io.emit("participant_count_update", {
      sessionId: parseInt(id, 10),
      count: count || 0,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [JOIN-LIVE] Error occurred:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === Leave Live ===
app.post("/sessions/:id/leave-live", async (req, res) => {
  try {
    const sessionIdInt = parseInt(req.params.id, 10);

    console.log("📤 [LEAVE-LIVE] Incoming request:", {
      sessionId: sessionIdInt,
      headersAuth: req.headers.authorization,
      headersGuest: req.headers["x-guest-token"],
      ip: req.ip,
      cookies: req.headers.cookie,
      body: req.body,
    });

    const token = req.headers.authorization?.split(" ")[1];
    const guestToken = req.headers["x-guest-token"];
    const user = await getUserFromToken(token);
    const guest = await getGuestFromToken(guestToken);

    console.log("🔍 [LEAVE-LIVE] Decoded tokens:", {
      user: user ? { id: user.id, name: user.name } : null,
      guest: guest ? { id: guest.id, tempName: guest.tempName } : null,
    });

    if (!user && !guest) {
      console.warn(
        "❌ [LEAVE-LIVE] Unauthorized — no valid token or guest token",
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    const column = user ? "user_id" : "guest_id";
    const participantIdInt = parseInt(user ? user.id : guest.id, 10);

    console.log("👤 [LEAVE-LIVE] Participant leaving:", {
      sessionId: sessionIdInt,
      participantId: participantIdInt,
      type: user ? "user" : "guest",
    });

    const [beforeUpdate] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    console.log("📝 [LEAVE-LIVE] DB state before leaving:", beforeUpdate);

    await pool.query(
      `UPDATE session_participants SET left_at = NOW(), is_live = 0 WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    const [afterUpdate] = await pool.query(
      `SELECT * FROM session_participants WHERE session_id = ? AND ${column} = ?`,
      [sessionIdInt, participantIdInt],
    );

    console.log("📝 [LEAVE-LIVE] DB state after leaving:", afterUpdate);

    io.to(sessionIdInt).emit("participant_left", {
      participantId: participantIdInt,
      isGuest: !!guest,
    });

    console.log(
      "✅ [LEAVE-LIVE] Participant left successfully, event emitted.",
    );

    await broadcastLiveParticipants(sessionIdInt);

    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND is_live = 1",
      [sessionIdInt],
    );

    io.emit("participant_count_update", {
      sessionId: sessionIdInt,
      count: count || 0,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ [LEAVE-LIVE] Error occurred:", err);
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
  const { email: rawEmail } = req.body;
  const email = rawEmail?.trim().toLowerCase();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res
      .status(400)
      .json({ error: "Gültige E-Mail-Adresse erforderlich" });
  }

  try {
    const [[user]] = await pool.query(
      "SELECT id, username FROM users WHERE LOWER(email) = LOWER(?)",
      [email],
    );

    // Wichtig: Kein Hinweis, ob die E-Mail existiert oder nicht (Sicherheit gegen Enumeration)
    if (!user) {
      // Wir geben trotzdem Erfolg zurück – so kann niemand prüfen, welche E-Mails registriert sind
      return res.json({
        message:
          "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
      });
    }

    // Token generieren (empfohlen: crypto.randomBytes(32).toString('hex'))
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 Stunde gültig

    await pool.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expiry = ? 
       WHERE id = ?`,
      [resetToken, expiry, user.id],
    );

    // Korrekter Reset-Link
    const baseUrl = process.env.FRONTEND_URL || "https://app.tunevote.com/ ";
    const resetLink = `${baseUrl}/reset-password/${resetToken}`;

    const primaryColor = "#4f46e5";

    const htmlTemplate = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Passwort zurücksetzen – TuneVote</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <!-- Header -->
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">
                Passwort zurücksetzen angefordert
              </h2>

              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo${user.username ? ` ${user.username}` : ""}!<br><br>
                Wir haben eine Anfrage erhalten, das Passwort für dein TuneVote-Konto zurückzusetzen.
              </p>

              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Falls du diese Anfrage <strong>nicht</strong> gestellt hast, kannst du diese E-Mail einfach ignorieren – dein Passwort bleibt unverändert.
              </p>

              <div style="background:#fef3c7;padding:16px;border-radius:8px;border-left:4px solid #f59e0b;margin:24px 0;">
                <p style="margin:0;font-size:15px;color:#92400e;">
                  <strong>Hinweis:</strong> Dieser Link läuft in <strong>1 Stunde</strong> ab.
                </p>
              </div>

              <!-- CTA Button -->
              <div style="text-align:center;margin:36px 0;">
                <a href="${resetLink}"
                   style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:16px 36px;border-radius:8px;text-decoration:none;box-shadow:0 4px 12px rgba(79,70,229,0.3);">
                  Neues Passwort festlegen
                </a>
              </div>

              <p style="font-size:14px;color:#6b7280;text-align:center;margin-top:32px;">
                Oder kopiere diesen Link in deinen Browser:<br>
                <a href="${resetLink}" style="color:${primaryColor};word-break:break-all;">${resetLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese E-Mail wurde gesendet, weil jemand das Zurücksetzen des Passworts für<br>
                <strong>${email}</strong> angefordert hat.<br><br>
                 TuneVote • Deine Musik. Deine Stimme.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // E-Mail versenden
    try {
      await transporter.sendMail({
        from: `"TuneVote" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: "🔑 Passwort zurücksetzen – TuneVote",
        text: `Klicke hier, um dein Passwort zurückzusetzen (gültig für 1 Stunde): ${resetLink}\n\nFalls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.`,
        html: htmlTemplate,
      });
    } catch (mailErr) {
      console.error(
        "Passwort-Reset-Mail konnte nicht gesendet werden:",
        mailErr,
      );
      // Auch bei Mail-Fehler geben wir Erfolg zurück (aus Sicherheitsgründen kein Unterschied!)
      return res.json({
        message:
          "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
      });
    }

    return res.json({
      message:
        "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// GET /reset-password/:token
app.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  if (!token || token.length < 20) {
    return res.status(400).send(`
      <h2>Ungültiger Link</h2>
      <p>Dieser Passwort-Reset-Link ist ungültig oder wurde bereits verwendet.</p>
      <a href="/forgot-password">Neuen Link anfordern</a>
    `);
  }

  try {
    const [[user]] = await pool.query(
      `SELECT id, reset_token_expiry 
       FROM users 
       WHERE reset_token = ? AND reset_token_expiry > NOW()`,
      [token],
    );

    if (!user) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="de">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Link abgelaufen – TuneVote</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
            h1 { color: #dc2626; }
            a { color: #4f46e5; text-decoration: none; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Link abgelaufen oder ungültig</h1>
            <p>Der Link zum Zurücksetzen deines Passworts ist nicht mehr gültig.</p>
            <p><a href="${process.env.FRONTEND_URL || ""}/forgot-password">Neuen Link anfordern</a></p>
          </div>
        </body>
        </html>
      `);
    }

    // Token ist gültig → React-Seite rendern
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Passwort zurücksetzen – TuneVote</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; }
    #root { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.RESET_TOKEN = "${token}";
  </script>
  <script type="module" src="/src/pages/ResetPassword.jsx"></script>
</body>
</html>
    `);
  } catch (err) {
    console.error("Reset page error:", err);
    res.status(500).send("Interner Serverfehler");
  }
});

// POST /api/reset-password
app.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword || newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: "Ungültiges Passwort oder Token fehlt" });
  }

  try {
    const [[user]] = await pool.query(
      `SELECT id FROM users 
       WHERE reset_token = ? AND reset_token_expiry > NOW()`,
      [token],
    );

    if (!user) {
      return res.status(400).json({ error: "Token ungültig oder abgelaufen" });
    }

    const password_hash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users 
       SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL 
       WHERE id = ?`,
      [password_hash, user.id],
    );

    res.json({ message: "Passwort erfolgreich geändert!" });
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

app.post("/sessions/:sessionId/invite", async (req, res) => {
  const { sessionId } = req.params;
  const { email: rawEmail } = req.body;

  // === Authentifizierung ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  // === E-Mail Validierung & Normalisierung ===
  const email = rawEmail?.trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  // Selbst-Einladung verhindern
  if (email === user.email) {
    return res
      .status(400)
      .json({ error: "Du kannst dich nicht selbst einladen." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // === 1. Session + Host-Validierung (inkl. host_email) ===
    const [[session]] = await conn.query(
      `SELECT s.title, s.user_id, s.is_private, u.username AS host_name, u.email AS host_email
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ?`,
      [sessionId],
    );

    if (!session) {
      await conn.rollback();
      return res.status(404).json({ error: "Session nicht gefunden" });
    }
    if (session.is_private === 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Nur private Sessions können Einladungen versenden" });
    }
    if (session.user_id !== user.id) {
      await conn.rollback();
      return res
        .status(403)
        .json({ error: "Nur der Host darf Einladungen verschicken" });
    }
    if (email === session.host_email?.toLowerCase()) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Der Session-Host kann nicht eingeladen werden." });
    }

    const sessionTitle =
      session.title?.trim() || "Eine private TuneVote Session";
    const hostName = session.host_name || "Der Host";

    // === 2. Prüfen, ob der Benutzer bereits registriert ist ===
    const [[existingUser]] = await conn.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email],
    );
    const invitedUserId = existingUser ? existingUser.id : null;
    const userExists = !!invitedUserId;

    // === 3. Existierende Einladung prüfen & ggf. reaktivieren/neu anlegen ===
    const [inviteRows] = await conn.query(
      `SELECT * FROM session_invites 
       WHERE session_id = ? AND LOWER(email) = LOWER(?) 
       LIMIT 1 FOR UPDATE`,
      [sessionId, email],
    );
    const existingInvite = inviteRows[0] || null;

    if (existingInvite) {
      if (
        existingInvite.status === "revoked" ||
        existingInvite.status === "rejected"
      ) {
        await conn.query(
          `UPDATE session_invites 
           SET status = 'pending',
               invited_user_id = ?,
               invited_by_user_id = ?,
               updated_at = NOW(),
               accepted_at = NULL,
               rejected_at = NULL,
               revoked_at = NULL
           WHERE id = ?`,
          [invitedUserId, user.id, existingInvite.id],
        );
      }
    } else {
      await conn.query(
        `INSERT INTO session_invites 
         (session_id, email, invited_by_user_id, invited_user_id, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [sessionId, email, user.id, invitedUserId],
      );
    }

    await conn.commit();

    // === 4. E-Mail-Inhalte je nach Registrierungsstatus unterscheiden ===
    const baseUrl = process.env.FRONTEND_URL || "https://app.tunevote.com/ ";
    const dashboardLink = `${baseUrl}/dashboard`;
    const primaryColor = "#4f46e5";

    // Zwei komplett unterschiedliche Templates – klar getrennt
    const htmlForExistingUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Neue Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du hast eine neue Einladung!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zur privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Da du bereits ein TuneVote-Konto hast, findest du die Einladung direkt in deinem Dashboard.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Einladung im Dashboard ansehen
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const htmlForNewUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du wurdest zu einer Session eingeladen!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zu einer privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Erstelle jetzt kostenlos ein Konto, um der Session beizutreten und mit abzustimmen!
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Registrieren & Session beitreten
                </a>
              </div>
              <p style="font-size:14px;color:#6b7280;text-align:center;margin-top:32px;">
                Oder direkt hier klicken:<br>
                <a href="${dashboardLink}" style="color:${primaryColor};">${dashboardLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const subject = userExists
      ? `Neue Einladung: ${sessionTitle}`
      : `${hostName} hat dich zu "${sessionTitle}" eingeladen`;

    const html = userExists ? htmlForExistingUser : htmlForNewUser;

    // === 5. E-Mail versenden ===
    try {
      await transporter.sendMail({
        from: `"TuneVote" <${process.env.GMAIL_USER}>`,
        to: email,
        subject,
        text: userExists
          ? `Du hast eine neue Einladung zu "${sessionTitle}". Öffne dein Dashboard: ${dashboardLink}`
          : `Du wurdest zu "${sessionTitle}" eingeladen! Erstelle ein Konto: ${dashboardLink}`,
        html,
      });
    } catch (mailErr) {
      console.error("E-Mail-Versand fehlgeschlagen:", mailErr);
      return res.status(500).json({
        success: true,
        message:
          "Einladung gespeichert, aber E-Mail konnte nicht gesendet werden.",
        emailError: true,
        alreadyRegistered: userExists,
      });
    }

    return res.json({
      success: true,
      message: "Einladung erfolgreich versendet",
      alreadyRegistered: userExists,
    });
  } catch (err) {
    console.error("Invite error:", err);
    if (conn) await conn.rollback().catch(() => {});
    return res
      .status(500)
      .json({ error: "Fehler beim Versenden der Einladung" });
  } finally {
    if (conn) conn.release();
  }
});

// GET: Einladungen, die du verschickt hast (nur offene)
app.get("/invites/sent", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
      si.id,
      si.email,

      -- Dynamischer Status
      si.status,
      si.created_at,
      si.accepted_at,
      si.rejected_at,
      si.revoked_at,
      si.updated_at,
      s.title AS session_title
      FROM session_invites si
      JOIN sessions s ON si.session_id = s.id
      WHERE si.invited_by_user_id = ? AND si.status = 'pending'
      ORDER BY si.created_at DESC
  `,
    [user.id],
  );

  res.json(invites);
});

// GET: Einladungen, die du erhalten hast (nur unbearbeitet / pending)
app.get("/invites/received", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
       si.id, si.email, si.created_at, si.accepted_at, si.rejected_at, si.revoked_at,
       si.status,
       s.title AS session_title, 
       u.username AS host_name
     FROM session_invites si
     JOIN sessions s ON si.session_id = s.id
     JOIN users u ON s.user_id = u.id
     WHERE (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       AND si.status = 'pending'
     ORDER BY si.created_at DESC`,
    [user.email, user.id],
  );

  res.json(invites);
});

// POST: Einladung annehmen + Socket.IO Event an Host schicken
app.post("/invites/:inviteId/accept", async (req, res) => {
  const inviteId = parseInt(req.params.inviteId, 10);
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Invite mit Session-Info und aktuellem Status holen + sperren
    const [invites] = await connection.query(
      `SELECT si.*, s.user_id AS host_id 
       FROM session_invites si
       JOIN sessions s ON si.session_id = s.id
       WHERE si.id = ? 
         AND si.status = 'pending'
         AND (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       FOR UPDATE`,
      [inviteId, user.email, user.id],
    );

    if (invites.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        error:
          "Einladung nicht gefunden, bereits bearbeitet oder nicht für dich",
      });
    }

    const invite = invites[0];

    // 2. Einladung als akzeptiert markieren
    await connection.query(
      `UPDATE session_invites 
       SET status = 'accepted',
           accepted_at = NOW(),
           invited_user_id = COALESCE(invited_user_id, ?),
           updated_at = NOW()
       WHERE id = ?`,
      [user.id, inviteId],
    );

    await connection.commit();

    // 3. Fertiges Objekt für Frontend + Socket.IO bauen
    const formattedInvite = {
      id: invite.id,
      invitee_email: invite.email,
      invitee_name: user.username || null, // wichtig!
      accepted_at: new Date().toISOString(),
    };

    // 4. Socket.IO Event nur an den Host der Session schicken
    io.to(`session-host-${invite.session_id}`).emit(
      "invite:accepted",
      formattedInvite,
    );

    // Optional: auch global an alle im Session-Raum (falls Co-Hosts etc.)
    // io.to(`session-${invite.session_id}`).emit("invite:accepted", formattedInvite);

    // 5. Erfolgreiche Antwort ans Frontend (kann der Client ignorieren, weil er ja eh updatet)
    return res.json({ success: true, invite: formattedInvite });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Fehler beim Akzeptieren der Einladung:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/invites/:inviteId/reject", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'rejected',
         rejected_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND status = 'pending'
       AND (LOWER(email) = LOWER(?) OR invited_user_id = ?)`,
    [inviteId, user.email, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder bereits verarbeitet",
    });
  }

  res.json({ success: true });
});

// POST: Einladung ablehnen
app.post("/invites/:inviteId/revoke", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'revoked',
         revoked_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND invited_by_user_id = ?
       AND status = 'pending'`,
    [inviteId, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder nicht mehr widerrufbar",
    });
  }

  res.json({ success: true });
});

// ============================================================
// GET /sessions/:sessionId/participants → Nur live Teilnehmer (is_live = 1)
// + Echtzeit-Updates über Socket.IO
// ============================================================

app.get("/sessions/:sessionId/participants", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId, 10);

  if (isNaN(sessionId)) {
    return res.status(400).json({ error: "Ungültige Session-ID" });
  }

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  try {
    // Prüfen, ob der Aufrufer überhaupt zur Session gehört (Sicherheit)
    const column = user ? "user_id" : "guest_id";
    const id = user ? user.id : guest.id;

    const [allowed] = await pool.query(
      `SELECT 1 FROM session_participants 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionId, id],
    );

    if (allowed.length === 0) {
      return res
        .status(403)
        .json({ error: "Du bist nicht Teil dieser Session" });
    }

    // Alle LIVE Teilnehmer holen
    const [participants] = await pool.query(
      `SELECT 
         sp.id,
         sp.role,
         COALESCE(u.username, g.nickname, 'Gast') AS name,
         (sp.role = 'host') AS isHost,
        u.imageType,
        u.imageData
       FROM session_participants sp
       LEFT JOIN users u ON sp.user_id = u.id
       LEFT JOIN guest_users g ON sp.guest_id = g.id
       WHERE sp.session_id = ? AND sp.is_live = 1
       ORDER BY sp.joined_at DESC`,
      [sessionId],
    );

    const formatted = participants.map((p) => {
      let profileImage = null;

      if (p.imageType && p.imageData) {
        profileImage = `data:${p.imageType};base64,${p.imageData.toString("base64")}`;
      }

      return {
        name: p.name,
        isHost: !!p.isHost,
        profileImage,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Fehler beim Laden der Live-Teilnehmer:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// ============================================================
// GET /api/profile → Aktuelle Profildaten des eingeloggten Users
// ============================================================
app.get("/profile", async (req, res) => {
  console.log("\n=== GET /profile aufgerufen ===");
  console.log("Vollständige Request-Headers:", req.headers);
  console.log("User-Agent:", req.headers["user-agent"]);
  console.log("IP:", req.ip || req.connection.remoteAddress);

  // 1. Authorization Header prüfen
  const authHeader = req.headers.authorization;
  console.log("Authorization Header:", authHeader || "FEHLT");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("Kein oder falscher Authorization-Header → 401");
    return res
      .status(401)
      .json({ error: "Unauthenticated – kein gültiger Token" });
  }

  const token = authHeader.split(" ")[1];
  console.log(
    "Extrahierter JWT-Token:",
    token ? `${token.slice(0, 15)}...${token.slice(-10)}` : "LEER",
  );

  // 2. Token dekodieren / User holen
  let user;
  try {
    user = await getUserFromToken(token);
  } catch (err) {
    console.log("Token ungültig oder abgelaufen:", err.message);
    return res.status(401).json({ error: "Unauthenticated – Token ungültig" });
  }

  if (!user) {
    console.log("getUserFromToken hat null zurückgegeben");
    return res.status(401).json({ error: "Unauthenticated" });
  }

  console.log("Erfolgreich authentifizierter User aus Token:", {
    id: user.id,
    username: user.username || "(nicht im Token)",
    email: user.email || "(nicht im Token)",
    iat: user.iat,
    exp: user.exp,
  });

  // 3. Datenbankabfrage – jetzt MIT Profilbild-Daten
  try {
    console.log(`Führe DB-Query aus für user.id = ${user.id}`);
    const [userRow] = await pool.query(
      `SELECT 
       id, 
       username, 
       email, 
       created_at,
       imageType,
       imageData 
     FROM users 
     WHERE id = ?`,
      [user.id],
    );

    console.log("Roh-Ergebnis der DB-Abfrage:", userRow);

    if (!userRow || userRow.length === 0) {
      console.log("User mit ID", user.id, "nicht in DB gefunden → 404");
      return res.status(404).json({ error: "User not found" });
    }

    const dbUser = userRow[0];
    console.log("Gefundener User in DB (inkl. Bild):", {
      id: dbUser.id,
      username: dbUser.username,
      email: dbUser.email,
      hasImage: !!(dbUser.imageType && dbUser.imageData),
    });

    // 4. Antwort an Frontend – jetzt mit imageType und imageData
    console.log("Sende erfolgreiche Antwort an Frontend → 200");
    console.log("imageData type:", typeof dbUser.imageData);
    console.log("imageData is Buffer:", Buffer.isBuffer(dbUser.imageData));
    console.log("imageData length:", dbUser.imageData?.length);

    res.json({
      username: dbUser.username,
      email: dbUser.email,
      imageType: dbUser.imageType || null,
      imageData: dbUser.imageData
        ? dbUser.imageData.toString("base64") // Direkt vom Buffer → Base64
        : null,
    });
  } catch (err) {
    console.error("Schwerer Fehler beim Laden des Profils:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: "Interner Serverfehler" });
  }

  console.log("=== GET /profile Ende ===\n");
});

// ============================================================
// POST /profile → Profil + Passwort ändern
// ============================================================
app.post("/profile", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  if (!user) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  const { username, email, currentPassword, newPassword, confirmPassword } =
    req.body;

  // Validierung
  if (!username || !email) {
    return res
      .status(400)
      .json({ error: "Benutzername und E-Mail sind erforderlich" });
  }

  if (username.length < 3 || username.length > 50) {
    return res
      .status(400)
      .json({ error: "Benutzername muss 3–50 Zeichen haben" });
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  try {
    // Prüfen, ob Username oder E-Mail bereits von anderem Nutzer verwendet wird
    const [existing] = await pool.query(
      `SELECT id FROM users WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)) AND id != ?`,
      [username, email, user.id],
    );

    if (existing.length > 0) {
      const field =
        existing[0].username?.toLowerCase() === username.toLowerCase()
          ? "Benutzername"
          : "E-Mail";
      return res.status(409).json({ error: `${field} bereits vergeben` });
    }

    // Passwort ändern?
    if (newPassword) {
      if (!currentPassword) {
        return res
          .status(400)
          .json({ error: "Aktuelles Passwort erforderlich" });
      }
      if (newPassword !== confirmPassword) {
        return res
          .status(400)
          .json({ error: "Neue Passwörter stimmen nicht überein" });
      }
      if (newPassword.length < 8) {
        return res
          .status(400)
          .json({ error: "Neues Passwort muss mind. 8 Zeichen haben" });
      }

      // Aktuelles Passwort prüfen
      const [currentUser] = await pool.query(
        `SELECT password_hash FROM users WHERE id = ?`,
        [user.id],
      );

      const validPassword = await bcrypt.compare(
        currentPassword,
        currentUser[0].password_hash,
      );
      if (!validPassword) {
        return res.status(400).json({ error: "Aktuelles Passwort ist falsch" });
      }

      // Neues Passwort hashen
      const password_hash = await bcrypt.hash(newPassword, 12);

      // Update mit Passwort
      await pool.query(
        `UPDATE users 
         SET username = ?, email = ?, password_hash = ?, updated_at = NOW()
         WHERE id = ?`,
        [username, email, password_hash, user.id],
      );
    } else {
      // Nur Name + E-Mail ändern
      await pool.query(
        `UPDATE users 
         SET username = ?, email = ?, updated_at = NOW()
         WHERE id = ?`,
        [username, email, user.id],
      );
    }

    // Optional: Token neu generieren oder Session aktualisieren (falls du JWT nutzt)
    // Hier einfach Erfolg zurückgeben
    res.json({ success: true, message: "Profil erfolgreich aktualisiert" });
  } catch (err) {
    console.error("Fehler beim Aktualisieren des Profils:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

app.get("/profile/user-stats", async (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    // Hilfsfunktion: Extrahiere Zahl aus [rows, fields] → rows[0]?.value || 0
    const getValue = (result, field = "count") => {
      return result && result[0] && result[0][0]
        ? Number(result[0][0][field] || 0)
        : 0;
    };

    const getSingleRowValue = (result, field) => {
      if (!result || !result[0] || result[0].length === 0) return 0;
      return Number(result[0][0][field] || 0);
    };

    const [
      votesOnOwnSuggestionsRes,
      winsAgainstQueueRes,
      maxStreakWinsRes,
      votesOnOwnButLostRes,
      votesOnOthersAndWonRes,
      votesOnOthersAndLostRes,
      streaksForeignVotesRes,
      sessionsWithoutVoteRes,
      maxStreakNoVoteRes,
    ] = await Promise.all([
      // 1. Wie oft wurde über eigene Vorschläge abgestimmt?
      pool.query(
        `
        SELECT COUNT(DISTINCT v.queue_item_id) AS count
        FROM votes v
        JOIN queue_items qi ON v.queue_item_id = qi.id
        WHERE qi.added_by = ?
      `,
        [userId],
      ),

      // 2. Wie oft hat der User mit eigenem Vorschlag gewonnen?
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM voting_rounds vr
        JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
        WHERE qi.added_by = ?
      `,
        [userId],
      ),

      // 3. Längster Gewinn-Streak (aufeinanderfolgende Siege mit eigenem Song)
      pool.query(
        `
        WITH wins AS (
          SELECT vr.started_at
          FROM voting_rounds vr
          JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
          WHERE qi.added_by = ?
          ORDER BY vr.started_at
        ),
        ranked AS (
          SELECT 
            started_at,
            ROW_NUMBER() OVER (ORDER BY started_at) AS rn,
            ROW_NUMBER() OVER (ORDER BY started_at) AS grp
          FROM wins
        )
        SELECT MAX(rn - grp + 1) AS max_streak
        FROM ranked
      `,
        [userId],
      ),

      // 4. Eigener Song bekam Votes, hat aber NICHT gewonnen
      pool.query(
        `
        SELECT COUNT(DISTINCT qi.id) AS count
        FROM queue_items qi
        JOIN votes v ON v.queue_item_id = qi.id
        LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id AND vr.winner_queue_item_id = qi.id
        WHERE qi.added_by = ? AND vr.winner_queue_item_id IS NULL
      `,
        [userId],
      ),

      // 5. Auf fremden Song gevotet → der hat gewonnen

      // Gewonnen heisst wenn queued_items status auf "queued", "playing", "played" ist
      // added_by NOT logged IN User ID
      // votes WHERE user_id = logged IN User ID
      // AND queue_items equals to votes.queue_items_id = queued_items.id
      pool.query(
        `
  SELECT COUNT(*) AS count
  FROM votes v
  JOIN queue_items qi ON v.queue_item_id = qi.id
  WHERE v.user_id = ?
    AND qi.added_by != ?
    AND qi.added_by IS NOT NULL                    -- kein AI-Vorschlag
    AND qi.voting_round_id IS NOT NULL             -- war definitiv ein Voting-Vorschlag
    AND qi.status IN ('queued', 'playing', 'played')  -- hat es in die echte Queue geschafft → gewonnen
`,
        [userId, userId],
      ),

      // 6. Auf fremden Song gevotet → der hat verloren
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM votes v
        JOIN queue_items qi ON v.queue_item_id = qi.id
        JOIN voting_rounds vr ON qi.voting_round_id = vr.id
        WHERE v.user_id = ? 
          AND qi.added_by != ? 
          AND (vr.winner_queue_item_id != qi.id OR vr.winner_queue_item_id IS NULL)
      `,
        [userId, userId],
      ),

      // 7+8. Streaks: aufeinanderfolgende erfolgreiche / erfolglose Votes auf fremde Songs
      pool.query(
        `
        WITH foreign_votes AS (
          SELECT 
            v.created_at,
            (vr.winner_queue_item_id = qi.id) AS did_win
          FROM votes v
          JOIN queue_items qi ON v.queue_item_id = qi.id
          LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id
          WHERE v.user_id = ? AND qi.added_by != ?
          ORDER BY v.created_at
        ),
        ranked AS (
          SELECT 
            did_win,
            ROW_NUMBER() OVER (ORDER BY created_at) AS rn,
            ROW_NUMBER() OVER (PARTITION BY did_win ORDER BY created_at) AS grp
          FROM foreign_votes
        ),
        streaks AS (
          SELECT did_win, MAX(rn - grp + 1) AS streak_length
          FROM ranked
          GROUP BY did_win
        )
        SELECT 
          MAX(CASE WHEN did_win = 1 THEN streak_length ELSE 0 END) AS max_winning_streak,
          MAX(CASE WHEN did_win = 0 THEN streak_length ELSE 0 END) AS max_losing_streak
        FROM streaks
      `,
        [userId, userId],
      ),

      // 9. Anzahl Sessions, in denen der User gar nicht gevotet hat
      pool.query(
        `
        SELECT COUNT(*) AS count
        FROM sessions s
        WHERE s.user_id = ?
          AND NOT EXISTS (
            SELECT 1 
            FROM votes v 
            JOIN queue_items qi ON v.queue_item_id = qi.id 
            WHERE v.user_id = ? AND qi.session_id = s.id
          )
      `,
        [userId, userId],
      ),

      // 10. Längster Streak von Sessions ohne Vote
      pool.query(
        `
        WITH session_activity AS (
          SELECT 
            s.created_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM votes v
              JOIN queue_items qi ON v.queue_item_id = qi.id
              WHERE v.user_id = ? AND qi.session_id = s.id
            ) THEN 1 ELSE 0 END AS has_voted
          FROM sessions s
          WHERE s.user_id = ?
          ORDER BY s.created_at
        ),
        ranked AS (
          SELECT 
            has_voted,
            ROW_NUMBER() OVER (ORDER BY created_at) AS rn,
            ROW_NUMBER() OVER (PARTITION BY has_voted ORDER BY created_at) AS grp
          FROM session_activity
        )
        SELECT MAX(CASE WHEN has_voted = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_streak
        FROM ranked
      `,
        [userId, userId],
      ),
    ]);

    const stats = {
      votesOnOwnSuggestions: getValue(votesOnOwnSuggestionsRes),
      winsAgainstQueue: getValue(winsAgainstQueueRes),
      maxStreakWinsAgainstQueue: getSingleRowValue(
        maxStreakWinsRes,
        "max_streak",
      ),
      votesOnOwnButLost: getValue(votesOnOwnButLostRes),
      votesOnOthersAndWon: getValue(votesOnOthersAndWonRes),
      votesOnOthersAndLost: getValue(votesOnOthersAndLostRes),
      maxStreakVotesOnWinningOthers: getSingleRowValue(
        streaksForeignVotesRes,
        "max_winning_streak",
      ),
      maxStreakVotesOnLosingOthers: getSingleRowValue(
        streaksForeignVotesRes,
        "max_losing_streak",
      ),
      sessionsWithoutVote: getValue(sessionsWithoutVoteRes),
      maxStreakSessionsWithoutVote: getSingleRowValue(
        maxStreakNoVoteRes,
        "max_streak",
      ),
    };

    res.json(stats);
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res
      .status(500)
      .json({ error: "Interner Serverfehler beim Laden der Statistiken" });
  }
});

// 📊 Listening Summary: Aggregierte Stats, Top-Songs, Top-Artists
app.get("/profile/listening-summary", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  let user;
  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    const [[listeningMinutesRows], [topHeardSongsRows], [topArtistsRows]] =
      await Promise.all([
        pool.query(
          `SELECT
           FLOOR(SUM(listen_seconds) / 60) AS total_minutes,
           COUNT(DISTINCT session_id) AS sessions_count,
           COUNT(*) AS song_listens
         FROM session_song_listens
         WHERE user_id = ?`,
          [userId],
        ),
        pool.query(
          `SELECT
           y.title,
           y.thumbnail,
           SUM(s.listen_seconds) AS total_seconds,
           COUNT(*) AS listens
         FROM session_song_listens s
         JOIN queue_items q ON q.id = s.queue_item_id
         LEFT JOIN youtube_video_cache y ON y.youtube_id = q.video_id
         WHERE s.user_id = ?
         GROUP BY y.title, y.thumbnail
         ORDER BY total_seconds DESC
         LIMIT 10`,
          [userId],
        ),
        pool.query(
          `SELECT
            a.id AS artist_id,
           a.name,
           a.image_url,
           SUM(s.listen_seconds) AS total_seconds
         FROM session_song_listens s
         JOIN queue_items q ON q.id = s.queue_item_id
         JOIN youtube_video_cache y ON y.youtube_id = q.video_id
         JOIN artists a ON a.id = y.artist_id
         WHERE s.user_id = ?
         GROUP BY a.id
         ORDER BY total_seconds DESC
         LIMIT 5`,
          [userId],
        ),
      ]);

    res.json({
      stats: listeningMinutesRows[0] || {
        total_minutes: 0,
        sessions_count: 0,
        song_listens: 0,
      },
      topSongs: topHeardSongsRows,
      topArtists: topArtistsRows,
    });
  } catch (err) {
    console.error("Error fetching listening summary:", err);
    res.status(500).json({ error: "Fehler beim Laden der Hörstatistiken" });
  }
});

// 🕒 Recent Listens: Letzte gehörte Songs
app.get("/profile/recent-listens", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated – kein Token" });
  }

  const token = authHeader.split(" ")[1];

  let user;
  try {
    user = await getUserFromToken(token);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Ungültiger Token" });
    }
  } catch (err) {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  const userId = user.id;

  try {
    const [recentListensRows] = await pool.query(
      `SELECT
         y.title,
         y.thumbnail,
         s.listened_from,
         s.listen_seconds,
         s.completed
       FROM session_song_listens s
       JOIN queue_items q ON q.id = s.queue_item_id
       LEFT JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE s.user_id = ?
       ORDER BY s.listened_from DESC
       LIMIT 20`,
      [userId],
    );

    res.json({ recentListens: recentListensRows });
  } catch (err) {
    console.error("Error fetching recent listens:", err);
    res
      .status(500)
      .json({ error: "Fehler beim Laden der zuletzt gehörten Songs" });
  }
});

app.get("/artist/:artistId", async (req, res) => {
  const { artistId } = req.params;

  try {
    //-- Artist-Basisinfos + aggregierte Hördaten über alle User
    const [[artist]] = await pool.query(
      `
      SELECT
        a.id,
        a.name,
        a.image_url,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM artists a
      LEFT JOIN youtube_video_cache y ON y.artist_id = a.id
      LEFT JOIN queue_items q ON q.video_id = y.youtube_id
      LEFT JOIN session_song_listens s ON s.queue_item_id = q.id
      WHERE a.id = ?
      GROUP BY a.id
      `,
      [artistId],
    );

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    //-- Top Songs nach aggregierter Hördauer über alle Nutzer
    const [topSongs] = await pool.query(
      `
      SELECT
        y.youtube_id AS id,
        y.title,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM youtube_video_cache y
      JOIN queue_items q ON q.video_id = y.youtube_id
      LEFT JOIN session_song_listens s ON s.queue_item_id = q.id
      WHERE y.artist_id = ?
        AND q.status IN ('played','playing','queued')
      GROUP BY y.youtube_id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId],
    );

    //-- Top User nach gesamter Hördauer für diesen Artist
    const [topUsersRaw] = await pool.query(
      `
      SELECT
        u.id,
        u.username,
        u.imageType,
        u.imageData,
        COALESCE(SUM(s.listen_seconds),0) AS total_seconds
      FROM users u
      JOIN session_song_listens s ON s.user_id = u.id
      JOIN queue_items q ON q.id = s.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND q.status IN ('played','playing','queued')
      GROUP BY u.id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId],
    );

    // Base64-Profilbilder generieren
    const topUsers = topUsersRaw.map((u) => {
      let profileImage = null;
      if (u.imageType && u.imageData) {
        profileImage = `data:${u.imageType};base64,${u.imageData.toString("base64")}`;
      }
      return {
        id: u.id,
        username: u.username,
        total_seconds: u.total_seconds,
        profileImage,
      };
    });

    res.json({ artist, topSongs, topUsers });
  } catch (err) {
    console.error("Artist page failed:", err);
    res.status(500).json({ error: "Failed to load artist details" });
  }
});

// Hilfsfunktion zum sicheren Extrahieren von Skalarwerten aus Query-Ergebnissen
const getScalar = (result, field = "count") => result?.[0]?.[field] ?? 0;

// Hilfsfunktion für einzelne Zeile mit benanntem Feld
const getSingleValue = (result, field) => result?.[0]?.[field] ?? 0;

/**
 * Holt alle relevanten Statistiken eines Users parallel
 * @param {number} userId
 * @returns {Promise<Object>} Statistiken-Objekt
 */
async function fetchUserStats(userId) {
  const [
    [topSongs],
    [topCoListeners],
    [sessionCount],
    [liveSessionsCount],
    [activeSessionResult],
    // === Voting-Statistiken ===
    [votesOnOwnSuggestions],
    [winsOfOwnSuggestions],
    [maxWinStreakOwn],
    [ownSuggestionsLost],
    [votesOnOthersWon],
    [votesOnOthersLost],
    [foreignVoteStreaks],
    [sessionsWithoutAnyVote],
    [maxStreakNoVote],
    // === Zusätzliche Metriken ===
    [songsHeardCount],
    [votesOnOwnByOthers],
  ] = await Promise.all([
    // 1. Top 10 Songs (nach Hördauer)
    pool.query(
      `SELECT
         q.video_id,
         MAX(y.title)          AS title,
         MAX(y.thumbnail)      AS thumbnail,
         SUM(l.listen_seconds) AS total_seconds,
         COUNT(*)              AS listen_count
       FROM session_song_listens l
       JOIN queue_items q ON q.id = l.queue_item_id
       JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE l.user_id = ?
       GROUP BY q.video_id
       ORDER BY total_seconds DESC
       LIMIT 10`,
      [userId],
    ),

    // 2. Top 10 Mit-Hörer
    pool.query(
      `SELECT 
         u.id,
         u.username,
         u.imageData,
         u.imageType,
         SUM(l.listen_seconds) AS total_seconds
       FROM session_song_listens l
       JOIN session_song_listens l2 
         ON l.session_id = l2.session_id 
         AND l2.user_id = ? 
         AND l.user_id != l2.user_id
       JOIN users u ON u.id = l.user_id
       GROUP BY u.id
       ORDER BY total_seconds DESC
       LIMIT 10`,
      [userId],
    ),

    // 3. Anzahl eindeutiger Sessions
    pool.query(
      `SELECT COUNT(DISTINCT session_id) AS count 
       FROM session_song_listens 
       WHERE user_id = ?`,
      [userId],
    ),

    // 4. Anzahl aktuell live Sessions (als Host)
    pool.query(
      `SELECT COUNT(*) AS count 
       FROM sessions 
       WHERE user_id = ? AND is_live = 1`,
      [userId],
    ),

    // 5. Aktuelle Session, in der der User gerade ist (als Teilnehmer)
    pool.query(
      `SELECT 
         s.id,
         s.title,
         s.is_private,
         COUNT(sp2.id) AS participant_count
       FROM session_participants sp
       JOIN sessions s ON s.id = sp.session_id
       LEFT JOIN session_participants sp2 
         ON sp2.session_id = s.id AND sp2.is_live = 1
       WHERE sp.user_id = ? 
         AND sp.is_live = 1
         AND s.is_active = 1
       GROUP BY s.id
       LIMIT 1`,
      [userId],
    ),

    // === Voting Stats ===
    pool.query(
      `SELECT COUNT(DISTINCT v.queue_item_id) AS count FROM votes v JOIN queue_items qi ON v.queue_item_id = qi.id WHERE qi.added_by = ?`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count FROM voting_rounds vr JOIN queue_items qi ON vr.winner_queue_item_id = qi.id WHERE qi.added_by = ?`,
      [userId],
    ),

    pool.query(
      `WITH wins AS (
         SELECT vr.started_at
         FROM voting_rounds vr
         JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
         WHERE qi.added_by = ?
         ORDER BY vr.started_at
       )
       SELECT MAX(rn - grp + 1) AS max_streak
       FROM (
         SELECT 
           started_at,
           ROW_NUMBER() OVER (ORDER BY started_at) AS rn,
           ROW_NUMBER() OVER (ORDER BY started_at) AS grp
         FROM wins
       ) ranked`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(DISTINCT qi.id) AS count
       FROM queue_items qi
       JOIN votes v ON v.queue_item_id = qi.id
       LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id AND vr.winner_queue_item_id = qi.id
       WHERE qi.added_by = ? AND vr.winner_queue_item_id IS NULL`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       WHERE v.user_id = ?
         AND qi.added_by != ?
         AND qi.added_by IS NOT NULL
         AND qi.voting_round_id IS NOT NULL
         AND qi.status IN ('queued', 'playing', 'played')`,
      [userId, userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       JOIN voting_rounds vr ON qi.voting_round_id = vr.id
       WHERE v.user_id = ? 
         AND qi.added_by != ? 
         AND (vr.winner_queue_item_id != qi.id OR vr.winner_queue_item_id IS NULL)`,
      [userId, userId],
    ),

    pool.query(
      `WITH foreign_votes AS (
         SELECT 
           v.created_at,
           (vr.winner_queue_item_id = qi.id) AS did_win
         FROM votes v
         JOIN queue_items qi ON v.queue_item_id = qi.id
         LEFT JOIN voting_rounds vr ON qi.voting_round_id = vr.id
         WHERE v.user_id = ? AND qi.added_by != ?
         ORDER BY v.created_at
       ),
       ranked AS (
         SELECT 
           did_win,
           ROW_NUMBER() OVER (ORDER BY created_at) rn,
           ROW_NUMBER() OVER (PARTITION BY did_win ORDER BY created_at) grp
         FROM foreign_votes
       )
       SELECT 
         MAX(CASE WHEN did_win = 1 THEN (rn - grp + 1) ELSE 0 END) AS max_winning_streak,
         MAX(CASE WHEN did_win = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_losing_streak
       FROM ranked`,
      [userId, userId],
    ),

    pool.query(
      `SELECT COUNT(*) AS count
       FROM sessions s
       WHERE s.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM votes v 
           JOIN queue_items qi ON v.queue_item_id = qi.id 
           WHERE v.user_id = ? AND qi.session_id = s.id
         )`,
      [userId, userId],
    ),

    pool.query(
      `WITH session_activity AS (
         SELECT 
           s.created_at,
           CASE WHEN EXISTS (
             SELECT 1 FROM votes v
             JOIN queue_items qi ON v.queue_item_id = qi.id
             WHERE v.user_id = ? AND qi.session_id = s.id
           ) THEN 1 ELSE 0 END AS has_voted
         FROM sessions s
         WHERE s.user_id = ?
         ORDER BY s.created_at
       ),
       ranked AS (
         SELECT 
           has_voted,
           ROW_NUMBER() OVER (ORDER BY created_at) rn,
           ROW_NUMBER() OVER (PARTITION BY has_voted ORDER BY created_at) grp
         FROM session_activity
       )
       SELECT MAX(CASE WHEN has_voted = 0 THEN (rn - grp + 1) ELSE 0 END) AS max_streak
       FROM ranked`,
      [userId, userId],
    ),

    // Zusätzliche Metriken
    pool.query(
      `SELECT COUNT(DISTINCT queue_item_id) AS count FROM session_song_listens WHERE user_id = ?`,
      [userId],
    ),

    pool.query(
      `SELECT COUNT(DISTINCT v.queue_item_id) AS count
       FROM votes v
       JOIN queue_items qi ON v.queue_item_id = qi.id
       WHERE qi.added_by = ? AND v.user_id != qi.added_by`,
      [userId],
    ),
  ]);

  const normalizedTopCoListeners = topCoListeners.map((u) => ({
    id: u.id,
    username: u.username,
    total_seconds: u.total_seconds,
    image_url: u.imageData
      ? `data:${u.imageType};base64,${u.imageData.toString("base64")}`
      : null,
  }));

  return {
    topSongs,
    topCoListeners: normalizedTopCoListeners,
    sessionCount: getScalar(sessionCount),
    isCurrentlyLiveHost: getScalar(liveSessionsCount) > 0,
    activeSession: activeSessionResult[0]
      ? {
          id: activeSessionResult[0].id,
          is_private: !!activeSessionResult[0].is_private,
          name: activeSessionResult[0].is_private
            ? null
            : activeSessionResult[0].title,
          participant_count: activeSessionResult[0].is_private
            ? null
            : activeSessionResult[0].participant_count,
          join_url: activeSessionResult[0].is_private
            ? null
            : `/session/${activeSessionResult[0].id}`,
        }
      : null,

    stats: {
      totalSongsHeard: getScalar(songsHeardCount),
      votesOnOwnSuggestions: getScalar(votesOnOwnSuggestions),
      votesOnOwnByOthers: getScalar(votesOnOwnByOthers),
      winsOfOwnSuggestions: getScalar(winsOfOwnSuggestions),
      maxWinStreakOwn: getSingleValue(maxWinStreakOwn, "max_streak"),
      ownSuggestionsLost: getScalar(ownSuggestionsLost),
      votesOnOthersAndWon: getScalar(votesOnOthersWon),
      votesOnOthersAndLost: getScalar(votesOnOthersLost),
      maxWinningStreakForeign: getSingleValue(
        foreignVoteStreaks,
        "max_winning_streak",
      ),
      maxLosingStreakForeign: getSingleValue(
        foreignVoteStreaks,
        "max_losing_streak",
      ),
      sessionsWithoutAnyVote: getScalar(sessionsWithoutAnyVote),
      maxStreakNoVote: getSingleValue(maxStreakNoVote, "max_streak"),
    },
  };
}

app.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    // 1. Basis-Userdaten inkl. Gesamt-Hördauer
    const [[user]] = await pool.query(
      `SELECT 
         u.id,
         u.username,
         u.imageData,
         SUM(l.listen_seconds) AS total_seconds
       FROM users u
       LEFT JOIN session_song_listens l ON l.user_id = u.id
       WHERE u.id = ?
       GROUP BY u.id`,
      [userId],
    );

    if (!user) {
      return res.status(404).json({ error: "User nicht gefunden" });
    }

    // 2. Alle weiteren Statistiken parallel holen
    const statsData = await fetchUserStats(userId);

    // 3. Antwort zusammenbauen
    res.json({
      user: {
        id: user.id,
        username: user.username,
        image_url: user.imageData
          ? `data:image/jpeg;base64,${user.imageData.toString("base64")}`
          : null,
        total_listen_seconds: user.total_seconds || 0,
        is_live_host: statsData.isCurrentlyLiveHost,
        active_session: statsData.activeSession,
      },
      top_songs: statsData.topSongs,
      top_co_listeners: statsData.topCoListeners,
      session_count: statsData.sessionCount,
      stats: statsData.stats,
    });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ error: "Interner Serverfehler" });
  }
});

app.get("/top-today", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
        a.id AS artist_id,
        a.name AS artist_name,
        a.image_url,
        COUNT(v.id) AS vote_count
      FROM votes v
      JOIN queue_items qi ON qi.id = v.queue_item_id
      JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      JOIN artists a ON a.id = yvc.artist_id
      WHERE DATE(v.created_at) = CURDATE()
      GROUP BY a.id, a.name, a.image_url
      ORDER BY vote_count DESC
       LIMIT 10`,
    );
    res.json(rows);
  } catch (err) {
    console.error("Top Today error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

app.get("/top-weekly-songs", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        yvc.youtube_id,
        yvc.title AS song_title,
        yvc.thumbnail,
        a.id AS artist_id,
        a.name AS artist_name,
        COUNT(qi.id) AS queue_count
      FROM queue_items qi
      JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      JOIN artists a ON a.id = yvc.artist_id
      WHERE
        qi.status IN ('played', 'queued')
        AND YEARWEEK(qi.created_at, 1) = YEARWEEK(CURDATE(), 1)
      GROUP BY
        yvc.youtube_id,
        yvc.title,
        yvc.thumbnail,
        a.id,
        a.name
      ORDER BY queue_count DESC
      LIMIT 10
      `,
    );

    res.json(rows);
  } catch (err) {
    console.error("Top Weekly Songs error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// Multer: Nur eine Datei mit dem Feldnamen "profileImage" akzeptieren
const upload = multer({
  storage: multer.memoryStorage(), // Wir speichern temporär im RAM, da wir es direkt als Base64 in die DB schreiben
  limits: {
    fileSize: 5 * 1024 * 1024, // Max. 5 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Nur Bilddateien (JPEG, PNG, GIF, WebP) sind erlaubt"));
    }
  },
});

// Der Endpunkt – Authentifizierung manuell, wie in deinem /sessions-Beispiel
app.post("/profile/image", upload.single("profileImage"), async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // 2. Ab hier ist der User authentifiziert → user.id verfügbar
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Keine Bilddatei hochgeladen" });
    }

    const imageType = req.file.mimetype; // z. B. "image/jpeg"
    const imageData = req.file.buffer; // ← Roh-Bytes, kein Base64!

    // Update in der users-Tabelle
    const query = `
      UPDATE users 
      SET imageType = ?, imageData = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `;

    await pool.query(query, [imageType, imageData, user.id]);
    // ← pool.query, wie in deinem Beispiel (nicht db.query)

    // Rückgabe für das Frontend
    res.json({
      imageType,
      imageData: imageData.toString("base64"),
    });
  } catch (err) {
    console.error("Fehler beim Hochladen des Profilbilds:", err);

    if (err.message === "Nur Bilddateien sind erlaubt") {
      return res.status(400).json({ error: "Nur Bilddateien sind erlaubt" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Bilddatei zu groß (max. 5 MB)" });
    }

    res
      .status(500)
      .json({ error: "Interner Serverfehler beim Speichern des Bildes" });
  }
});

app.get("/profile/artist/:artistId/insights", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const userId = user.id;
  const artistId = parseInt(req.params.artistId, 10);

  try {
    const [[artist]] = await pool.query(
      `SELECT id, name, image_url FROM artists WHERE id = ?`,
      [artistId],
    );

    if (!artist) {
      return res.status(404).json({ error: "Artist not found" });
    }

    const [[summary]] = await pool.query(
      `
      SELECT
        SUM(l.listen_seconds)        AS total_seconds,
        COUNT(*)                    AS listen_events,
        COUNT(DISTINCT q.video_id)  AS song_count,
        COUNT(DISTINCT l.session_id) AS session_count,
        SUM(l.completed) / COUNT(*) AS completion_rate
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      `,
      [artistId, userId],
    );

    const [topSongs] = await pool.query(
      `
      SELECT
        q.video_id,
        MAX(y.title)          AS title,
        MAX(y.thumbnail)      AS thumbnail,
        SUM(l.listen_seconds) AS total_seconds,
        COUNT(*)              AS listen_count
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY q.video_id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId, userId],
    );

    const [dailySessionsRaw] = await pool.query(
      `
      SELECT
        DATE(l.listened_from) AS date,
        s.id                  AS session_id,
        s.title               AS session_title,
        s.created_at          AS session_started_at,
        SUM(l.listen_seconds) AS session_seconds
      FROM session_song_listens l
      JOIN sessions s ON s.id = l.session_id
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND l.listened_from >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY DATE(l.listened_from), s.id
      ORDER BY date ASC, s.created_at ASC
      `,
      [artistId, userId],
    );

    const [dailyRaw] = await pool.query(
      `
      SELECT
        DATE(l.listened_from) AS date,
        SUM(l.listen_seconds) AS seconds
      FROM session_song_listens l
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND l.listened_from >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY DATE(l.listened_from)
      ORDER BY date ASC
      `,
      [artistId, userId],
    );

    const daily = dailyRaw.map((d) => ({
      date: d.date,
      seconds: Number(d.seconds) || 0,
    }));

    const maxDailySeconds = daily.length
      ? Math.max(...daily.map((d) => d.seconds))
      : 0;

    const [sessions] = await pool.query(
      `
      SELECT
        s.id                  AS session_id,
        s.title,
        s.created_at          AS started_at,
        SUM(l.listen_seconds) AS total_seconds
      FROM session_song_listens l
      JOIN sessions s ON s.id = l.session_id
      JOIN queue_items q ON q.id = l.queue_item_id
      JOIN youtube_video_cache y ON y.youtube_id = q.video_id
      WHERE y.artist_id = ?
        AND EXISTS (
          SELECT 1
          FROM session_participants sp
          WHERE sp.session_id = l.session_id
            AND sp.user_id = ?
        )
      GROUP BY s.id
      ORDER BY total_seconds DESC
      LIMIT 10
      `,
      [artistId, userId],
    );

    const dailySessionsMap = {};

    dailySessionsRaw.forEach((row) => {
      const date = row.date;
      if (!dailySessionsMap[date]) {
        dailySessionsMap[date] = { date, sessions: [], total_seconds: 0 };
      }

      const seconds = Number(row.session_seconds) || 0;

      dailySessionsMap[date].sessions.push({
        session_id: row.session_id,
        title: row.session_title,
        started_at: row.session_started_at,
        seconds,
        minutes: Math.floor(seconds / 60),
      });

      dailySessionsMap[date].total_seconds += seconds;
    });

    const dailySessions = Object.values(dailySessionsMap).sort(
      (a, b) => new Date(a.date) - new Date(b.date),
    );

    res.json({
      artist,
      total_minutes: Math.floor((summary.total_seconds || 0) / 60),
      song_count: summary.song_count || 0,
      session_count: summary.session_count || 0,
      avg_minutes_per_song: Math.floor(
        (summary.total_seconds || 0) /
          Math.max(summary.song_count || 1, 1) /
          60,
      ),
      completion_rate: summary.completion_rate,
      top_songs: topSongs,
      daily_listens: daily,
      max_daily_seconds: maxDailySeconds,
      sessions,
      daily_sessions: dailySessions,
    });
  } catch (err) {
    console.error("Artist insights failed:", err);
    res.status(500).json({ error: "Failed to load artist insights" });
  }
});

app.post("/artist/:artistId/shouts", async (req, res) => {
  const { artistId } = req.params;
  const { message, parent_id } = req.body;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  try {
    // Prüfen, ob parent_id existiert und zum gleichen Künstler gehört
    if (parent_id) {
      const [[parent]] = await pool.query(
        `SELECT id FROM shouts WHERE id = ? AND artist_id = ?`,
        [parent_id, artistId],
      );
      if (!parent) {
        return res.status(400).json({ error: "Invalid parent shout" });
      }
    }

    const [result] = await pool.query(
      `
      INSERT INTO shouts (artist_id, user_id, parent_id, message, created_at)
      VALUES (?, ?, ?, ?, NOW())
      `,
      [artistId, user.id, parent_id || null, message],
    );

    res.json({
      success: true,
      shout: {
        id: result.insertId,
        artist_id: artistId,
        user_id: user.id,
        parent_id: parent_id || null,
        message,
        username: user.username,
        created_at: new Date(),
      },
    });
  } catch (err) {
    console.error("Failed to post shout:", err);
    res.status(500).json({ error: "Failed to post shout" });
  }
});

app.get("/artist/:artistId/shouts", async (req, res) => {
  const { artistId } = req.params;

  const authHeader = req.headers.authorization;
  let currentUserId = null;

  // Wenn Token vorhanden, User-ID extrahieren (für is_own_shout)
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const user = await getUserFromToken(authHeader.split(" ")[1]);
      currentUserId = user.id;
      console.log(`[GET shouts] Token ok – currentUserId = ${currentUserId}`); // ← NEU
    } catch {
      // Invalid token → kein Problem, is_own_shout wird null/0
      console.log(`[GET shouts] Token invalid: ${err.message}`); // ← NEU
    }
  }

  try {
    // Alle Shouts für diesen Artist inkl. Usernamen, Profilbilder, Likes + is_own_shout + is_deleted
    const [shouts] = await pool.query(
      `
      SELECT 
        s.id,
        s.artist_id,
        s.user_id,
        u.username,
        u.imageType,
        u.imageData,
        s.parent_id,
        s.message,
        s.created_at,
        s.is_deleted,
        COALESCE(SUM(sl.user_id IS NOT NULL), 0) AS likes,
        CASE WHEN s.user_id = ? THEN 1 ELSE 0 END AS is_own_shout
      FROM shouts s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN shout_likes sl ON sl.shout_id = s.id
      WHERE s.artist_id = ?
      GROUP BY s.id
      ORDER BY s.created_at ASC
      `,
      [currentUserId, artistId], // ← currentUserId als 1. Parameter für CASE WHEN
    );

    // Profilbilder als Data-URLs konvertieren
    const formattedShouts = shouts.map((s) => {
      let profileImage = null;
      if (s.imageType && s.imageData) {
        profileImage = `data:${s.imageType};base64,${s.imageData.toString("base64")}`;
      }
      return {
        ...s,
        profileImage,
        is_own_shout: Boolean(s.is_own_shout), // ← Als Boolean für Frontend
      };
    });

    res.json(formattedShouts);
  } catch (err) {
    console.error("Failed to fetch shouts:", err);
    res.status(500).json({ error: "Failed to fetch shouts" });
  }
});

app.post("/shouts/:shoutId/like", async (req, res) => {
  const { shoutId } = req.params;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    // Prüfen, ob Shout existiert
    const [[shout]] = await pool.query("SELECT id FROM shouts WHERE id = ?", [
      shoutId,
    ]);
    if (!shout) {
      return res.status(404).json({ error: "Shout not found" });
    }

    // Prüfen, ob Like bereits existiert
    const [existingLike] = await pool.query(
      "SELECT id FROM shout_likes WHERE shout_id = ? AND user_id = ?",
      [shoutId, user.id],
    );

    if (existingLike.length) {
      // Like existiert → entfernen (Unlike)
      await pool.query("DELETE FROM shout_likes WHERE id = ?", [
        existingLike[0].id,
      ]);
      return res.json({ success: true, liked: false });
    }

    // Like hinzufügen
    await pool.query(
      "INSERT INTO shout_likes (shout_id, user_id, created_at) VALUES (?, ?, NOW())",
      [shoutId, user.id],
    );

    res.json({ success: true, liked: true });
  } catch (err) {
    console.error("Failed to toggle like:", err);
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

app.delete("/shouts/:shoutId", async (req, res) => {
  const { shoutId } = req.params;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  let user;
  try {
    user = await getUserFromToken(authHeader.split(" ")[1]);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const [[shout]] = await pool.query("SELECT * FROM shouts WHERE id = ?", [
      shoutId,
    ]);
    if (!shout) return res.status(404).json({ error: "Shout not found" });
    if (shout.user_id !== user.id)
      return res.status(403).json({ error: "Not allowed" });

    const now = new Date();
    const createdAt = new Date(shout.created_at);
    const deleteWindowMinutes = 30; // z.B. 30 Minuten Zeitfenster
    const diffMinutes = (now - createdAt) / (1000 * 60);

    if (diffMinutes <= deleteWindowMinutes) {
      // Vollständig löschen inkl. Likes & Unterkommentare (Cascade)
      await pool.query("DELETE FROM shout_likes WHERE shout_id = ?", [shoutId]);
      await pool.query("DELETE FROM shouts WHERE id = ? OR parent_id = ?", [
        shoutId,
        shoutId,
      ]);
    } else {
      // Soft Delete: Text ersetzen, Likes löschen, Unterkommentare bleiben
      await pool.query(
        "UPDATE shouts SET message = '[Kommentar gelöscht]', is_deleted = 1, deleted_at = NOW() WHERE id = ?",
        [shoutId],
      );
      await pool.query("DELETE FROM shout_likes WHERE shout_id = ?", [shoutId]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete shout:", err);
    res.status(500).json({ error: "Failed to delete shout" });
  }
});

app.delete("/profile/image", async (req, res) => {
  // gleiche Authentifizierung wie bei /profile/image
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  await pool.query(
    "UPDATE users SET imageType = NULL, imageData = NULL WHERE id = ?",
    [user.id],
  );
  res.json({ imageType: null, imageData: null });
});

// Irgendwo zentral, z. B. in deiner socket.io oder utils Datei
// Direkt nach der io-Definition (z. B. nach const io = new Server(...))
let topArtistsBroadcastTimeout = null;

async function broadcastTodayTopArtists(io) {
  // Debounce: Max. alle 2 Sekunden broadcasten (verhindert Spam bei vielen Votes)
  if (topArtistsBroadcastTimeout) {
    clearTimeout(topArtistsBroadcastTimeout);
  }

  topArtistsBroadcastTimeout = setTimeout(async () => {
    try {
      const [rows] = await pool.query(`
        SELECT
          a.id AS artist_id,
          a.name AS artist_name,
          a.image_url,
          COUNT(v.id) AS vote_count
        FROM votes v
        JOIN queue_items qi ON qi.id = v.queue_item_id
        JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
        JOIN artists a ON a.id = yvc.artist_id
        WHERE DATE(v.created_at) = CURDATE()
          AND qi.status IN ('queued', 'playing', 'played')
        GROUP BY a.id, a.name, a.image_url
        ORDER BY vote_count DESC
        LIMIT 10
      `);

      // Nur senden, wenn es überhaupt Artists gibt (vermeidet unnötige Events)
      if (rows.length > 0 || true) {
        // immer senden, damit Frontend leere Liste erkennt
        io.emit("today_top_artists_updated", {
          date: new Date().toISOString().slice(0, 10),
          artists: rows,
        });
        console.log(
          "[Live Charts] Top Artists broadcasted →",
          rows.length,
          "artists",
        );
      }
    } catch (err) {
      console.error("Error broadcasting today top artists:", err);
    } finally {
      topArtistsBroadcastTimeout = null;
    }
  }, 1500); // 1,5 Sekunden warten → sammelt mehrere Änderungen
}

// ─── Google Login URL generieren ───
app.get('/auth/google', (req, res) => {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.GOOGLE_CALLBACK_URL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

// ─── Google Callback ───
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("https://app.tunevote.com/login?error=no_code");
  }

  try {
    // 1. Code gegen Tokens tauschen
    const { data } = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      },
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token } = data;

    // 2. User-Info holen
    const { data: userInfo } = await axios.get(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    const { sub: googleId, email, name, picture } = userInfo;
    const newUsername = name || email.split("@")[0];
    const newImageUrl = picture || null;

    // 3. User in DB suchen (Zweistufige Suche zur Verknüpfung)
    let [rows] = await pool.query("SELECT * FROM users WHERE google_id = ?", [googleId]);
    let user = rows[0];

    if (!user && email) {
      // Falls Google-ID unbekannt: Suche nach E-Mail (z.B. von Facebook-Account)
      let [emailRows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
      user = emailRows[0];

      if (user) {
        // Verknüpfung: Google-ID beim bestehenden User nachtragen
        await pool.query("UPDATE users SET google_id = ? WHERE id = ?", [googleId, user.id]);
        user.google_id = googleId;
      }
    }

    if (!user) {
      // ─── Neuer User ───
      const [result] = await pool.query(
        "INSERT INTO users (google_id, email, username, imageUrl) VALUES (?, ?, ?, ?)",
        [googleId, email, newUsername, newImageUrl]
      );

      user = {
        id: result.insertId,
        google_id: googleId,
        email,
        username: newUsername,
        imageUrl: newImageUrl,
      };
    } else {
      // ─── Bestehender User → Daten bei Bedarf aktualisieren ───
      // COALESCE sorgt dafür, dass ein vorhandenes Bild nicht durch NULL überschrieben wird
      const shouldUpdate = 
        user.username !== newUsername || 
        (user.imageUrl === null && newImageUrl !== null);

      if (shouldUpdate) {
        await pool.query(
          "UPDATE users SET username = ?, imageUrl = COALESCE(imageUrl, ?) WHERE id = ?",
          [newUsername, newImageUrl, user.id]
        );
        user.username = newUsername;
        user.imageUrl = user.imageUrl || newImageUrl;
      }
    }

    // 4. JWT erstellen
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 5. Redirect zum Frontend
    const redirectUrl = `https://app.tunevote.com/google-callback?token=${token}&username=${encodeURIComponent(
      user.username
    )}&userId=${user.id}`;

    res.redirect(redirectUrl);
  } catch (err) {
    console.error("Google Callback Fehler:", err.response?.data || err.message);
    res.redirect("https://app.tunevote.com/login?error=google_auth_failed");
  }
});

// ─── Facebook Login URL generieren ───
app.get('/auth/facebook', (req, res) => {
  const rootUrl = 'https://www.facebook.com/v18.0/dialog/oauth';
  const options = {
    client_id: process.env.FACEBOOK_CLIENT_ID,
    redirect_uri: process.env.FACEBOOK_CALLBACK_URL,
    scope: ['email', 'public_profile'].join(','),
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

// ─── Facebook Callback ───
app.get("/auth/facebook/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("https://app.tunevote.com/login?error=no_code");
  }

  try {
    // 1. Code gegen Access Token tauschen
    const tokenResponse = await axios.get(
      "https://graph.facebook.com/v18.0/oauth/access_token",
      {
        params: {
          client_id: process.env.FACEBOOK_CLIENT_ID,
          client_secret: process.env.FACEBOOK_CLIENT_SECRET,
          redirect_uri: process.env.FACEBOOK_CALLBACK_URL,
          code,
        },
      }
    );

    const { access_token } = tokenResponse.data;

    // 2. User-Info holen
    const userInfoResponse = await axios.get(
      "https://graph.facebook.com/me",
      {
        params: {
          fields: "id,name,email,picture",
          access_token,
        },
      }
    );

    const { id: facebookId, name, email, picture } = userInfoResponse.data;
    const newUsername = name || (email ? email.split("@")[0] : `user_${facebookId}`);
    const newImageUrl = picture?.data?.url || null;

    // 3. Strategische Suche in der DB
    // Zuerst prüfen: Gibt es jemanden mit dieser Facebook-ID?
    let [rows] = await pool.query("SELECT * FROM users WHERE facebook_id = ?", [facebookId]);
    let user = rows[0];

    if (!user && email) {
      // Wenn nicht: Gibt es jemanden mit dieser E-Mail (z.B. via Google registriert)?
      let [emailRows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
      user = emailRows[0];
      
      if (user) {
        // Verknüpfung: Facebook-ID beim bestehenden User nachtragen
        await pool.query("UPDATE users SET facebook_id = ? WHERE id = ?", [facebookId, user.id]);
        user.facebook_id = facebookId;
      }
    }

    if (!user) {
      // ─── Neuer User (weder Facebook-ID noch E-Mail bekannt) ───
      const [result] = await pool.query(
        "INSERT INTO users (facebook_id, email, username, imageUrl) VALUES (?, ?, ?, ?)",
        [facebookId, email, newUsername, newImageUrl]
      );

      user = {
        id: result.insertId,
        facebook_id: facebookId,
        email,
        username: newUsername,
        imageUrl: newImageUrl,
      };
    } else {
      // ─── Bestehender User → Daten bei Bedarf aktualisieren ───
      // Wir aktualisieren das Bild nur, wenn der User noch kein lokales Bild hat
      const shouldUpdate = user.username !== newUsername || (user.imageUrl === null && newImageUrl !== null);

      if (shouldUpdate) {
        await pool.query(
          "UPDATE users SET username = ?, imageUrl = COALESCE(imageUrl, ?) WHERE id = ?",
          [newUsername, newImageUrl, user.id]
        );
        user.username = newUsername;
        user.imageUrl = user.imageUrl || newImageUrl;
      }
    }

    // 4. JWT erstellen
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 5. Redirect zum Frontend
    const redirectUrl = `https://app.tunevote.com/facebook-callback?token=${token}&username=${encodeURIComponent(
      user.username
    )}&userId=${user.id}`;

    res.redirect(redirectUrl);

  } catch (err) {
    console.error("Facebook Callback Fehler:", err.response?.data || err.message);
    res.redirect("https://app.tunevote.com/login?error=facebook_auth_failed");
  }
});