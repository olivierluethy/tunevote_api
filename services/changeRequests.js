// ---------------------------------------------------------------------------
// GENERIC CHANGE-REQUEST SYSTEM (#66/#67/#68 — first slice)
//
// A votable "change request" is any structural change to a live session that the
// community approves by upvote: skip the current song, insert a pause, remove a
// queued song, end the session. It runs ALONGSIDE the existing voting_rounds
// song-selection (coexistence — those rounds are untouched).
//
// Design mirrors the playback engine's reliability model:
//   • the DB is authoritative; expires_at is a durable deadline;
//   • an in-memory timer resolves at expiry for low latency;
//   • services/scheduler.js re-drives overdue requests after a restart;
//   • every resolution's socket + external effects run AFTER the commit.
//
// New change types are added by registering a handler below — no core changes,
// no migration. Each applied change writes a session_events row carrying an
// inverse, so democratic Undo is retrofittable later.
// ---------------------------------------------------------------------------
const pool = require("../db");
const { getIO } = require("../lib/io");
const { advanceToNext, endSession } = require("./playback");

// crId -> Timeout. Low-latency expiry; the reconciler is the durable safety net.
const crTimers = {};

// --- JSON helpers (mysql2 JSON columns: stringify on write, tolerate both on read)
const toJson = (v) => (v == null ? null : JSON.stringify(v));
const fromJson = (v) => {
  if (v == null) return null;
  if (typeof v === "object") return v; // mysql2 may already parse JSON columns
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const room = (sessionId) => getIO().to(String(sessionId));

// ---------------------------------------------------------------------------
// HANDLER REGISTRY
//
// Each handler:
//   quorumPercent   fraction of live participants that must upvote (0..1)
//   durationSeconds how long the vote stays open before it expires
//   validate(conn, session, payload) -> normalized payload | throws HttpError
//   apply(conn, session, payload, cr) -> {
//       eventType, eventPayload, reversible, inverse,
//       emits?  : [{event,payload}]   fired after commit
//       after?  : async ()=>{}        external side-effect run after commit
//     }
//   describe(payload) -> short human string for the banner
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read the currently playing item (id + ordering key) for a session.
async function currentPlaying(conn, sessionId) {
  const [[row]] = await conn.query(
    `SELECT id, COALESCE(sort_order, id) AS ord
       FROM queue_items
      WHERE session_id = ? AND status = 'playing'
      LIMIT 1`,
    [sessionId],
  );
  return row || null;
}

const handlers = {
  // ------------------------------------------------------------------ skip
  skip_current: {
    quorumPercent: 0.5,
    durationSeconds: 25,
    async validate(conn, session) {
      const playing = await currentPlaying(conn, session.id);
      if (!playing) throw new HttpError(409, "Gerade läuft kein Song");
      return {};
    },
    async apply(conn, session) {
      const playing = await currentPlaying(conn, session.id);
      const currentId = playing?.id ?? null;
      return {
        eventType: "song.skipped",
        eventPayload: { queue_item_id: currentId },
        reversible: false,
        inverse: null,
        // Skip runs OUTSIDE this transaction: advanceToNext locks the session
        // row itself, and its compare-and-swap makes it a harmless no-op if the
        // song already changed. Nothing to do if nothing is playing anymore.
        after: currentId ? () => advanceToNext(session.id, currentId) : null,
      };
    },
    describe: () => "Aktuellen Song überspringen",
  },

  // ------------------------------------------------------------ insert pause
  insert_pause: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const duration = Number(payload.duration_seconds ?? payload.duration ?? 30);
      if (!Number.isFinite(duration) || duration < 5 || duration > 600) {
        throw new HttpError(400, "Pausendauer muss zwischen 5 und 600 Sekunden liegen");
      }
      let afterItemId = payload.after_item_id ?? null;
      if (afterItemId != null) {
        afterItemId = Number(afterItemId);
        const [[item]] = await conn.query(
          `SELECT id FROM queue_items WHERE id = ? AND session_id = ?`,
          [afterItemId, session.id],
        );
        if (!item) throw new HttpError(404, "Referenz-Song nicht in dieser Session");
      }
      return { duration_seconds: Math.floor(duration), after_item_id: afterItemId };
    },
    async apply(conn, session, payload, cr) {
      // Position the pause right after `after_item_id` (default: the currently
      // playing song) by giving it a sort_order between that item and the next.
      let baseOrder = null;
      if (payload.after_item_id != null) {
        const [[b]] = await conn.query(
          `SELECT COALESCE(sort_order, id) AS ord FROM queue_items
            WHERE id = ? AND session_id = ?`,
          [payload.after_item_id, session.id],
        );
        baseOrder = b ? Number(b.ord) : null;
      } else {
        const playing = await currentPlaying(conn, session.id);
        baseOrder = playing ? Number(playing.ord) : null;
      }

      let newOrder;
      if (baseOrder == null) {
        // Nothing to anchor to → append after everything still active.
        const [[m]] = await conn.query(
          `SELECT MAX(COALESCE(sort_order, id)) AS mx FROM queue_items
            WHERE session_id = ? AND status IN ('queued','playing')`,
          [session.id],
        );
        newOrder = (Number(m.mx) || 0) + 1;
      } else {
        const [[nb]] = await conn.query(
          `SELECT MIN(COALESCE(sort_order, id)) AS nb FROM queue_items
            WHERE session_id = ? AND status = 'queued'
              AND COALESCE(sort_order, id) > ?`,
          [session.id, baseOrder],
        );
        newOrder = nb.nb != null ? (baseOrder + Number(nb.nb)) / 2 : baseOrder + 0.5;
      }

      const source = cr.proposed_by_user_id
        ? "user"
        : cr.proposed_by_guest_id
          ? "guest"
          : "ai";
      const [ins] = await conn.query(
        `INSERT INTO queue_items
           (session_id, item_type, description, pause_duration_seconds,
            added_by, guest_id, status, item_source, sort_order)
         VALUES (?, 'pause', ?, ?, ?, ?, 'queued', ?, ?)`,
        [
          session.id,
          "Pause (Abstimmung)",
          payload.duration_seconds,
          cr.proposed_by_user_id || null,
          cr.proposed_by_guest_id || null,
          source,
          newOrder,
        ],
      );
      return {
        eventType: "pause.inserted",
        eventPayload: {
          queue_item_id: ins.insertId,
          duration_seconds: payload.duration_seconds,
          sort_order: newOrder,
        },
        reversible: true,
        inverse: { op: "archive_item", queue_item_id: ins.insertId },
        emits: [{ event: "queue_updated" }],
      };
    },
    describe: (p = {}) =>
      `Pause von ${p.duration_seconds ?? p.duration ?? 30}s einfügen`,
  },

  // ------------------------------------------------------- remove queued item
  remove_queued_item: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const queueItemId = Number(payload.queue_item_id);
      if (!Number.isFinite(queueItemId)) {
        throw new HttpError(400, "queue_item_id fehlt");
      }
      const [[item]] = await conn.query(
        `SELECT id FROM queue_items
          WHERE id = ? AND session_id = ? AND status = 'queued'`,
        [queueItemId, session.id],
      );
      if (!item) throw new HttpError(404, "Song ist nicht (mehr) in der Queue");
      return { queue_item_id: queueItemId };
    },
    async apply(conn, session, payload) {
      const [r] = await conn.query(
        `UPDATE queue_items SET status = 'archived'
          WHERE id = ? AND session_id = ? AND status = 'queued'`,
        [payload.queue_item_id, session.id],
      );
      if (!r.affectedRows) {
        // Raced (played/removed meanwhile) — mark the request failed, not applied.
        throw new HttpError(409, "Song ist nicht mehr in der Queue");
      }
      return {
        eventType: "item.removed",
        eventPayload: { queue_item_id: payload.queue_item_id },
        reversible: true,
        inverse: { op: "requeue_item", queue_item_id: payload.queue_item_id },
        emits: [{ event: "queue_updated" }],
      };
    },
    describe: () => "Song aus der Queue entfernen",
  },

  // -------------------------------------------------------------- end session
  end_session: {
    quorumPercent: 0.75,
    durationSeconds: 45,
    async validate() {
      return {};
    },
    async apply(conn, session) {
      return {
        eventType: "session.ended",
        eventPayload: { reason: "change_request" },
        reversible: false,
        inverse: null,
        // endSession opens its own transaction with FOR UPDATE on the session
        // row, so it must run after this transaction commits (no self-deadlock).
        after: () => endSession(session.id, "change_request"),
      };
    },
    describe: () => "Session beenden",
  },
};

// ---------------------------------------------------------------------------
// DTO / read helpers
// ---------------------------------------------------------------------------

async function liveCount(sessionId, conn = pool) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM session_participants
      WHERE session_id = ? AND is_live = 1`,
    [sessionId],
  );
  return row.cnt;
}

function neededVotes(live, quorumPercent) {
  if (!live) return 0;
  return Math.max(1, Math.ceil(live * Number(quorumPercent)));
}

// Build the client-facing shape for one change request (banner + list).
async function buildDto(crRow, conn = pool) {
  const [[votes]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM change_request_votes WHERE change_request_id = ?`,
    [crRow.id],
  );
  const live = await liveCount(crRow.session_id, conn);
  const payload = fromJson(crRow.payload);
  const handler = handlers[crRow.type];
  return {
    id: crRow.id,
    session_id: crRow.session_id,
    type: crRow.type,
    status: crRow.status,
    payload,
    description: handler ? handler.describe(payload || {}) : crRow.type,
    quorum_percent: Number(crRow.quorum_percent),
    votes: votes.cnt,
    live,
    needed: neededVotes(live, crRow.quorum_percent),
    proposed_by_user_id: crRow.proposed_by_user_id,
    proposed_by_guest_id: crRow.proposed_by_guest_id,
    expires_at: crRow.expires_at,
    created_at: crRow.created_at,
    resolution: crRow.resolution,
  };
}

async function loadCr(crId, conn = pool) {
  const [[row]] = await conn.query(`SELECT * FROM change_requests WHERE id = ?`, [
    crId,
  ]);
  return row || null;
}

async function emitCreated(crRow) {
  room(crRow.session_id).emit("change_request_created", await buildDto(crRow));
}
async function emitUpdated(crId) {
  const row = await loadCr(crId);
  if (row) room(row.session_id).emit("change_request_updated", await buildDto(row));
}

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

function armTimer(crId, ms) {
  if (crTimers[crId]) clearTimeout(crTimers[crId]);
  crTimers[crId] = setTimeout(() => {
    delete crTimers[crId];
    resolve(crId).catch((e) =>
      console.error(`[change-request ${crId}] expiry resolve failed:`, e.message),
    );
  }, ms);
}

function clearTimer(crId) {
  if (crTimers[crId]) {
    clearTimeout(crTimers[crId]);
    delete crTimers[crId];
  }
}

// Create a new change request. proposer = { user, guest }. The proposer's own
// upvote is recorded immediately (proposing is endorsing), then we try to resolve
// right away so a request that already meets quorum applies without waiting.
async function create(sessionId, type, rawPayload, proposer) {
  const handler = handlers[type];
  if (!handler) throw new HttpError(400, `Unbekannter Change-Type: ${type}`);

  const [[session]] = await pool.query(
    `SELECT id, status FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) throw new HttpError(404, "Session nicht gefunden");
  if (session.status !== "live") throw new HttpError(403, "Session ist nicht live");

  const payload = await handler.validate(pool, session, rawPayload || {});

  const [ins] = await pool.query(
    `INSERT INTO change_requests
       (session_id, type, payload, proposed_by_user_id, proposed_by_guest_id,
        status, quorum_percent, expires_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      sessionId,
      type,
      toJson(payload),
      proposer.user?.id || null,
      proposer.guest?.id || null,
      handler.quorumPercent,
      handler.durationSeconds,
    ],
  );
  const crId = ins.insertId;

  // Proposing counts as the first upvote.
  await pool.query(
    `INSERT IGNORE INTO change_request_votes (change_request_id, user_id, guest_id)
     VALUES (?, ?, ?)`,
    [crId, proposer.user?.id || null, proposer.guest?.id || null],
  );

  armTimer(crId, handler.durationSeconds * 1000);

  const row = await loadCr(crId);
  await emitCreated(row);

  // Early pass: may already meet quorum (e.g. a solo live session).
  await resolve(crId);

  return await buildDto(await loadCr(crId));
}

// Record an approve vote (idempotent), then try to resolve early.
async function vote(crId, voter) {
  const cr = await loadCr(crId);
  if (!cr) throw new HttpError(404, "Change Request nicht gefunden");
  if (cr.status !== "open") throw new HttpError(409, "Abstimmung ist bereits beendet");

  await pool.query(
    `INSERT IGNORE INTO change_request_votes (change_request_id, user_id, guest_id)
     VALUES (?, ?, ?)`,
    [crId, voter.user?.id || null, voter.guest?.id || null],
  );

  await emitUpdated(crId);
  await resolve(crId); // applies immediately if quorum is now met
  return await buildDto(await loadCr(crId));
}

// Resolve a request: apply if quorum is met, expire if the deadline passed,
// otherwise leave it open. Safe to call from a vote, the timer, or the
// reconciler — the FOR UPDATE + status recheck make concurrent resolves apply
// at most once. Socket + external effects run only after the commit.
async function resolve(crId) {
  const connection = await pool.getConnection();
  let committed = false;
  let afterEffects = [];
  let postEmits = [];
  let resolvedStatus = null;
  let sessionId = null;

  try {
    await connection.beginTransaction();

    const [[cr]] = await connection.query(
      `SELECT *, (expires_at <= NOW()) AS is_expired
         FROM change_requests WHERE id = ? FOR UPDATE`,
      [crId],
    );
    if (!cr || cr.status !== "open") {
      await connection.commit();
      return;
    }
    sessionId = cr.session_id;

    const [[votes]] = await connection.query(
      `SELECT COUNT(*) AS cnt FROM change_request_votes WHERE change_request_id = ?`,
      [crId],
    );
    const live = await liveCount(sessionId, connection);
    const needed = neededVotes(live, cr.quorum_percent);
    const approved = needed > 0 && votes.cnt >= needed;
    const expired = !!Number(cr.is_expired);

    if (!approved && !expired) {
      await connection.commit(); // still open, keep waiting
      return;
    }

    const [[session]] = await connection.query(
      `SELECT id, status FROM sessions WHERE id = ?`,
      [sessionId],
    );

    if (approved && session && session.status === "live") {
      const handler = handlers[cr.type];
      try {
        const out = await handler.apply(
          connection,
          session,
          fromJson(cr.payload) || {},
          cr,
        );
        const [ev] = await connection.query(
          `INSERT INTO session_events
             (session_id, type, change_request_id, payload, reversible, inverse, actor)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            out.eventType,
            crId,
            toJson(out.eventPayload || null),
            out.reversible ? 1 : 0,
            toJson(out.inverse || null),
            toJson({
              proposed_by_user_id: cr.proposed_by_user_id,
              proposed_by_guest_id: cr.proposed_by_guest_id,
              decided_by: "community",
            }),
          ],
        );
        await connection.query(
          `UPDATE change_requests
              SET status = 'applied', resolved_at = NOW(),
                  resolution = 'quorum_met', applied_event_id = ?
            WHERE id = ?`,
          [ev.insertId, crId],
        );
        resolvedStatus = "applied";
        afterEffects = out.after ? [out.after] : [];
        postEmits = out.emits || [];
      } catch (applyErr) {
        // Apply failed (e.g. the target song already left the queue). Record the
        // request as failed rather than leaving it stuck open.
        await connection.query(
          `UPDATE change_requests
              SET status = 'failed', resolved_at = NOW(), resolution = ?
            WHERE id = ?`,
          [String(applyErr.message || "apply_failed").slice(0, 64), crId],
        );
        resolvedStatus = "failed";
        console.error(`[change-request ${crId}] apply failed:`, applyErr.message);
      }
    } else {
      // Expired without quorum, or the session is no longer live.
      const resolution = expired ? "expired_no_quorum" : "session_not_live";
      await connection.query(
        `UPDATE change_requests
            SET status = 'expired', resolved_at = NOW(), resolution = ?
          WHERE id = ?`,
        [resolution, crId],
      );
      resolvedStatus = "expired";
    }

    await connection.commit();
    committed = true;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      console.error(`[change-request ${crId}] rollback failed:`, rollbackErr.message);
    }
    console.error(`[change-request ${crId}] resolve error:`, err);
  } finally {
    connection.release();
  }

  if (!committed) return;

  clearTimer(crId);

  // Post-commit side effects: announce the outcome, fire queue/effect emits,
  // then run external effects (skip advance / session end) that must not share
  // the change-request lock domain.
  const dto = await buildDto(await loadCr(crId));
  room(sessionId).emit("change_request_resolved", dto);
  for (const e of postEmits) room(sessionId).emit(e.event, e.payload);
  for (const fn of afterEffects) {
    try {
      await fn();
    } catch (e) {
      console.error(`[change-request ${crId}] after-effect failed:`, e.message);
    }
  }
}

// Durable safety net: resolve every open request whose deadline has passed.
// Called each tick by services/scheduler.js so expiry survives a restart.
async function reconcileExpired() {
  const [rows] = await pool.query(
    `SELECT id FROM change_requests
      WHERE status = 'open' AND expires_at <= NOW()`,
  );
  for (const { id } of rows) {
    await resolve(id).catch((e) =>
      console.error(`[change-request ${id}] reconcile resolve failed:`, e.message),
    );
  }
  return rows.length;
}

module.exports = {
  HttpError,
  handlers,
  create,
  vote,
  resolve,
  reconcileExpired,
  buildDto,
  loadCr,
};
