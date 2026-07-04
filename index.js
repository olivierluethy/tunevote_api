require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { init: initIO } = require("./lib/io");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const crypto = require("crypto");
const ytdl = require("@distube/ytdl-core");
const multer = require("multer");

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const transporter = require("./services/mailer");
const { openai, safeParseOpenAI } = require("./services/openai");
const {
  stripe,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  APP_PUBLIC_URL,
} = require("./services/stripe");
const {
  JWT_SECRET,
  getUserFromToken,
  hasActiveSubscription,
  getGuestFromToken,
  ensureParticipant,
} = require("./services/auth");
const { broadcastTodayTopArtists } = require("./services/broadcast");
const {
  sessionTimers,
  phaseTimers,
  startPhaseTimer,
  finalizeListeningForCurrentSong,
  advanceToNext,
  broadcastLiveParticipants,
  createNewPublicSession,
  checkQuorum,
} = require("./services/playback");

const {
  generateResetToken,
  hashPassword,
  parseIsoDuration,
  normalize,
  getScalar,
  getSingleValue,
} = require("./utils/helpers");

const app = express();
app.use(cors());

// ---------------------------------------------------------------
// Stripe billing webhook — mounted with a raw body parser BEFORE
// app.use(express.json()) below, because the Stripe SDK verifies webhook
// signatures byte-for-byte against the untouched request body.
// ---------------------------------------------------------------
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

const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const httpServer = app.listen(4000, () =>
  console.log("Server läuft auf https://app.tunevote.com/"),
);
const io = initIO(httpServer);

// === Route modules ===
app.use(require("./routes/billing"));
app.use(require("./routes/youtube"));
app.use(require("./routes/oauth"));
app.use(require("./routes/auth"));
app.use(require("./routes/password"));
app.use(require("./routes/profile"));
app.use(require("./routes/sessions"));

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
