const { getIO } = require("./lib/io");
const pool = require("./db");
const { getUserFromToken, getGuestFromToken } = require("./services/auth");
const {
  broadcastLiveParticipants,
  broadcastParticipantCount,
} = require("./services/playback");

// Registers all Socket.IO connection/room/disconnect handlers. Called once
// from index.js after the io server is initialised.
function registerSocketHandlers() {
  const io = getIO();

io.on("connection", (socket) => {
  const sessionId = socket.handshake.query.sessionId;
  const sessionIdInt = parseInt(sessionId, 10);

  console.log("🔌 [WS-CONNECT] New socket connection:", {
    socketId: socket.id,
    sessionId,
    ip: socket.handshake.address,
    headers: socket.handshake.headers,
  });

  // Session-less connections (the sessions dashboard) are GLOBAL LISTENERS:
  // keep them connected so they receive global broadcasts like
  // participant_count_update and session_renamed. They join no room and carry
  // no presence/heartbeat, so we return before wiring those handlers. Previously
  // these were disconnected immediately, which is why the dashboard's live
  // counts and renames never updated without a manual refresh.
  if (!sessionId) {
    console.log("🔌 [WS-CONNECT] Global listener (no sessionId):", socket.id);
    return;
  }

  socket.join(sessionId);
  console.log(`➡️ [WS-CONNECT] Socket ${socket.id} joined room ${sessionId}`);

  // === Participant heartbeat ===
  // Resolve identity once (the frontend passes tokens via socket.io `auth`,
  // falling back to headers), then keep session_participants.last_seen fresh so
  // the reconciler's reaper can drop participants who vanish uncleanly.
  const auth = socket.handshake.auth || {};
  const hbToken =
    auth.token || socket.handshake.headers.authorization?.split(" ")[1];
  const hbGuestToken =
    auth.guestToken || socket.handshake.headers["x-guest-token"];
  let hbCol = null;
  let hbId = null;

  const touchLastSeen = async () => {
    if (!hbCol || !hbId) return;
    try {
      await pool.query(
        `UPDATE session_participants SET last_seen = NOW()
         WHERE session_id = ? AND ${hbCol} = ?`,
        [sessionIdInt, hbId],
      );
    } catch (e) {
      console.warn("[heartbeat] update failed:", e.message);
    }
  };

  (async () => {
    const u = hbToken ? await getUserFromToken(hbToken) : null;
    const g = !u && hbGuestToken ? await getGuestFromToken(hbGuestToken) : null;
    if (u) {
      hbCol = "user_id";
      hbId = u.id;
    } else if (g) {
      hbCol = "guest_id";
      hbId = g.id;
    }
    touchLastSeen(); // initial mark on connect
  })();

  socket.on("heartbeat", touchLastSeen);

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
    // Tab-close / clean disconnect: decrement the live count for everyone
    // viewing the dashboard (participant_count_update is the only event it hears).
    await broadcastParticipantCount(sessionIdInt);

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
}

module.exports = { registerSocketHandlers };
