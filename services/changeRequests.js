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
const loops = require("./loops");

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

// Ordered "what's coming up" window: the playing item (if any) first, then queued
// items by sort_order. Powers the before/after previews (#67 §5) so voters see
// exactly what a change does before backing it.
async function queueWindow(conn, sessionId, limit = 8) {
  const [rows] = await conn.query(
    `SELECT qi.id, qi.item_type, qi.status,
            COALESCE(yvc.title, qi.description, 'Song') AS title,
            COALESCE(qi.sort_order, qi.id) AS ord
       FROM queue_items qi
       LEFT JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
      WHERE qi.session_id = ? AND qi.status IN ('playing','queued')
      ORDER BY (qi.status = 'playing') DESC, COALESCE(qi.sort_order, qi.id) ASC
      LIMIT ?`,
    [sessionId, limit],
  );
  return rows;
}

const labelOf = (it) =>
  !it ? "" : it.item_type === "pause" ? "⏸ Pause" : it.title || "Song";

// Execute the inverse operation(s) recorded on an applied event (used by Undo).
async function applyInverse(conn, session, inverse) {
  if (!inverse) return;
  const ops = Array.isArray(inverse) ? inverse : [inverse];
  for (const op of ops) {
    switch (op.op) {
      case "archive_item":
        await conn.query(
          `UPDATE queue_items SET status = 'archived' WHERE id = ? AND session_id = ?`,
          [op.queue_item_id, session.id],
        );
        break;
      case "requeue_item":
        await conn.query(
          `UPDATE queue_items SET status = 'queued' WHERE id = ? AND session_id = ?`,
          [op.queue_item_id, session.id],
        );
        break;
      case "archive_items":
        if (op.queue_item_ids?.length) {
          await conn.query(
            `UPDATE queue_items SET status = 'archived'
              WHERE session_id = ? AND id IN (${op.queue_item_ids.map(() => "?").join(",")})`,
            [session.id, ...op.queue_item_ids],
          );
        }
        break;
      case "restore_sort_order":
        await conn.query(
          `UPDATE queue_items SET sort_order = ? WHERE id = ? AND session_id = ?`,
          [op.sort_order, op.queue_item_id, session.id],
        );
        break;
      case "archive_loop":
        await loops.archiveLoop(conn, session.id, op.loop_id);
        break;
      case "restore_loop_runs":
        await loops.restoreRuns(conn, session.id, op.loop_id, op.total_runs ?? null);
        break;
      case "restore_rule":
        await upsertRule(conn, session.id, op.key, op.value ?? null);
        break;
      default:
        console.warn(`[change-request] unknown inverse op: ${op.op}`);
    }
  }
}

// Choose a sort_order that places an item right after `baseOrder` and before the
// next queued item. Shared by insert_pause / move_item / create_loop.
async function orderAfter(conn, sessionId, baseOrder, excludeId = null) {
  if (baseOrder == null) {
    const [[m]] = await conn.query(
      `SELECT MAX(COALESCE(sort_order, id)) AS mx FROM queue_items
        WHERE session_id = ? AND status IN ('queued','playing')`,
      [sessionId],
    );
    return (Number(m.mx) || 0) + 1;
  }
  const [[nb]] = await conn.query(
    `SELECT MIN(COALESCE(sort_order, id)) AS nb FROM queue_items
      WHERE session_id = ? AND status = 'queued'
        AND COALESCE(sort_order, id) > ?
        AND (? IS NULL OR id <> ?)`,
    [sessionId, baseOrder, excludeId, excludeId],
  );
  return nb.nb != null ? (baseOrder + Number(nb.nb)) / 2 : baseOrder + 0.5;
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
    preview: (win) => ({
      before: win.map(labelOf),
      after: win.filter((w) => w.status !== "playing").map(labelOf),
    }),
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
    preview: (win, p = {}) => {
      const secs = p.duration_seconds ?? p.duration ?? 30;
      const labels = win.map(labelOf);
      const insertAt = win[0]?.status === "playing" ? 1 : 0;
      const after = [...labels];
      after.splice(insertAt, 0, `⏸ Pause ${secs}s`);
      return { before: labels, after };
    },
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
    preview: (win, p = {}) => ({
      before: win.map(labelOf),
      after: win.filter((w) => w.id !== p.queue_item_id).map(labelOf),
    }),
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

  // -------------------------------------------------------------- move item
  move_item: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const queueItemId = Number(payload.queue_item_id);
      if (!Number.isFinite(queueItemId)) throw new HttpError(400, "queue_item_id fehlt");
      const [[item]] = await conn.query(
        `SELECT id FROM queue_items
          WHERE id = ? AND session_id = ? AND status = 'queued'`,
        [queueItemId, session.id],
      );
      if (!item) throw new HttpError(404, "Song ist nicht (mehr) in der Queue");
      let afterItemId = payload.after_item_id ?? null;
      if (afterItemId != null) {
        afterItemId = Number(afterItemId);
        if (afterItemId === queueItemId)
          throw new HttpError(400, "Song kann nicht hinter sich selbst verschoben werden");
        const [[anchor]] = await conn.query(
          `SELECT id FROM queue_items
            WHERE id = ? AND session_id = ? AND status IN ('queued','playing')`,
          [afterItemId, session.id],
        );
        if (!anchor) throw new HttpError(404, "Zielposition nicht gefunden");
      }
      return { queue_item_id: queueItemId, after_item_id: afterItemId };
    },
    async apply(conn, session, payload) {
      const [[cur]] = await conn.query(
        `SELECT COALESCE(sort_order, id) AS ord FROM queue_items
          WHERE id = ? AND session_id = ?`,
        [payload.queue_item_id, session.id],
      );
      if (!cur) throw new HttpError(409, "Song ist nicht mehr in der Queue");
      const oldOrder = Number(cur.ord);

      let newOrder;
      if (payload.after_item_id == null) {
        // Move to the front of the queue (plays next).
        const [[m]] = await conn.query(
          `SELECT MIN(COALESCE(sort_order, id)) AS mn FROM queue_items
            WHERE session_id = ? AND status = 'queued' AND id <> ?`,
          [session.id, payload.queue_item_id],
        );
        newOrder = m.mn != null ? Number(m.mn) - 1 : oldOrder;
      } else {
        const [[a]] = await conn.query(
          `SELECT COALESCE(sort_order, id) AS ord FROM queue_items
            WHERE id = ? AND session_id = ?`,
          [payload.after_item_id, session.id],
        );
        newOrder = await orderAfter(
          conn,
          session.id,
          a ? Number(a.ord) : null,
          payload.queue_item_id,
        );
      }
      await conn.query(
        `UPDATE queue_items SET sort_order = ? WHERE id = ? AND session_id = ?`,
        [newOrder, payload.queue_item_id, session.id],
      );
      return {
        eventType: "item.moved",
        eventPayload: { queue_item_id: payload.queue_item_id, from: oldOrder, to: newOrder },
        reversible: true,
        inverse: {
          op: "restore_sort_order",
          queue_item_id: payload.queue_item_id,
          sort_order: oldOrder,
        },
        emits: [{ event: "queue_updated" }],
      };
    },
    describe: () => "Song in der Queue verschieben",
    preview: (win, p = {}) => {
      const before = win.map(labelOf);
      const moving = win.find((w) => w.id === p.queue_item_id);
      if (!moving) return { before, after: before };
      const rest = win.filter((w) => w.id !== p.queue_item_id);
      let idx;
      if (p.after_item_id == null) {
        idx = rest[0]?.status === "playing" ? 1 : 0;
      } else {
        const anchor = rest.findIndex((w) => w.id === p.after_item_id);
        idx = anchor >= 0 ? anchor + 1 : rest.length;
      }
      const after = rest.map(labelOf);
      after.splice(idx, 0, labelOf(moving));
      return { before, after };
    },
  },

  // ------------------------------------------------------------- create loop
  create_loop: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      // Normalize an ordered step list: music (queue_item_id) or pause, in any
      // order/repetition. Falls back to queue_item_ids, then the current song.
      let raw = [];
      if (Array.isArray(payload.steps) && payload.steps.length) {
        raw = payload.steps;
      } else if (Array.isArray(payload.queue_item_ids) && payload.queue_item_ids.length) {
        raw = payload.queue_item_ids.map((id) => ({ queue_item_id: id }));
      } else {
        const playing = await currentPlaying(conn, session.id);
        if (playing) raw = [{ queue_item_id: playing.id }];
      }
      if (!raw.length) throw new HttpError(409, "Kein Song zum Loopen");
      if (raw.length > 20) throw new HttpError(400, "Loop-Sequenz zu lang (max. 20 Schritte)");

      const musicIds = raw
        .filter((s) => s.kind !== "pause" && s.pause_seconds == null)
        .map((s) => Number(s.queue_item_id))
        .filter(Number.isFinite);
      let found = new Set();
      if (musicIds.length) {
        const [rows] = await conn.query(
          `SELECT id FROM queue_items
            WHERE session_id = ? AND item_type = 'music' AND video_id IS NOT NULL
              AND id IN (${musicIds.map(() => "?").join(",")})`,
          [session.id, ...musicIds],
        );
        found = new Set(rows.map((r) => r.id));
      }

      const steps = [];
      for (const s of raw) {
        if (s.kind === "pause" || s.pause_seconds != null) {
          const dur = Number(s.pause_seconds ?? s.duration_seconds);
          if (!Number.isFinite(dur) || dur < 5 || dur > 600) {
            throw new HttpError(400, "Pausendauer muss 5–600 Sekunden sein");
          }
          steps.push({ kind: "pause", duration_seconds: Math.floor(dur) });
        } else if (found.has(Number(s.queue_item_id))) {
          steps.push({ kind: "music", queue_item_id: Number(s.queue_item_id) });
        }
      }
      if (!steps.some((s) => s.kind === "music")) {
        throw new HttpError(404, "Kein gültiger Song im Loop");
      }
      const endless = payload.endless === true || payload.repeat === "endless";
      const repeat = endless ? null : Math.max(2, Math.min(10, Number(payload.repeat) || 3));
      const on_complete = payload.on_complete === "propose_pause" ? "propose_pause" : "none";
      return { steps, repeat, endless, on_complete };
    },
    async apply(conn, session, payload, cr) {
      const steps = payload.steps;
      const musicIds = steps.filter((s) => s.kind === "music").map((s) => s.queue_item_id);
      const byId = new Map();
      if (musicIds.length) {
        const [srcRows] = await conn.query(
          `SELECT id, video_id, description FROM queue_items
            WHERE session_id = ? AND id IN (${musicIds.map(() => "?").join(",")})`,
          [session.id, ...musicIds],
        );
        for (const r of srcRows) byId.set(r.id, r);
      }
      const recipe = steps
        .map((s) => {
          if (s.kind === "pause") {
            return { kind: "pause", duration_seconds: s.duration_seconds };
          }
          const r = byId.get(s.queue_item_id);
          return r && r.video_id
            ? { kind: "music", video_id: r.video_id, description: r.description }
            : null;
        })
        .filter(Boolean);

      // Create a live loop object; it materializes run 1 now, and playback.js
      // enqueues each following run when the previous one ends.
      const totalRuns = payload.endless ? null : payload.repeat;
      const { loopId } = await loops.createLoop(
        conn,
        session.id,
        recipe,
        totalRuns,
        payload.on_complete,
        { user_id: cr.proposed_by_user_id, guest_id: cr.proposed_by_guest_id },
      );
      return {
        eventType: "loop.created",
        eventPayload: {
          loop_id: loopId,
          total_runs: totalRuns,
          steps: recipe.length,
          on_complete: payload.on_complete,
        },
        reversible: true,
        inverse: { op: "archive_loop", loop_id: loopId },
        emits: [
          { event: "queue_updated" },
          { event: "loop_updated", payload: await loops.loopStatus(conn, loopId) },
        ],
      };
    },
    describe: (p = {}) => {
      const steps = p.steps || [];
      const pauses = steps.filter((s) => s.kind === "pause").length;
      const base = p.endless ? "Endlos-Loop" : `Loop ×${p.repeat ?? 3}`;
      return pauses
        ? `${base} (${steps.length} Schritte, ${pauses} Pause${pauses > 1 ? "n" : ""})`
        : base;
    },
    preview: (win, p = {}) => {
      const before = win.map(labelOf);
      const names = (p.steps || []).map((s) =>
        s.kind === "pause"
          ? `⏸ ${s.duration_seconds}s`
          : labelOf(win.find((w) => w.id === s.queue_item_id)) || "Song",
      );
      const repeat = p.endless ? "∞" : (p.repeat ?? 3);
      const head = win[0]?.status === "playing" ? [before[0]] : [];
      const rest = win[0]?.status === "playing" ? before.slice(1) : before;
      const tail =
        p.on_complete === "propose_pause" ? ["→ danach Pause vorschlagen"] : [];
      return {
        before,
        after: [...head, `🔁 ${names.join(" → ")} ×${repeat}`, ...tail, ...rest],
      };
    },
  },

  // --------------------------------------------------------------- end loop
  end_loop: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const loopId = Number(payload.loop_id);
      if (!Number.isFinite(loopId)) throw new HttpError(400, "loop_id fehlt");
      const [[loop]] = await conn.query(
        `SELECT id, status FROM loops WHERE id = ? AND session_id = ?`,
        [loopId, session.id],
      );
      if (!loop) throw new HttpError(404, "Loop nicht gefunden");
      if (loop.status !== "active") throw new HttpError(409, "Loop ist nicht aktiv");
      return { loop_id: loopId, hard: payload.hard === true };
    },
    async apply(conn, session, payload) {
      // Graceful: the current run's queued copies still play. Hard: archive the
      // remaining queued copies now so the loop stops immediately.
      const status = payload.hard
        ? (await loops.archiveLoop(conn, session.id, payload.loop_id),
          await loops.loopStatus(conn, payload.loop_id))
        : await loops.endLoop(conn, session.id, payload.loop_id);
      return {
        eventType: payload.hard ? "loop.aborted" : "loop.ended",
        eventPayload: { loop_id: payload.loop_id },
        reversible: false,
        inverse: null,
        emits: [
          { event: "loop_updated", payload: status },
          { event: "queue_updated" },
        ],
      };
    },
    describe: (p = {}) => (p.hard ? "Loop sofort abbrechen" : "Loop beenden"),
  },

  // ---------------------------------------------------------- set loop runs
  set_loop_runs: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const loopId = Number(payload.loop_id);
      if (!Number.isFinite(loopId)) throw new HttpError(400, "loop_id fehlt");
      const endless = payload.endless === true || payload.total_runs == null;
      let totalRuns = null;
      if (!endless) {
        totalRuns = Number(payload.total_runs);
        if (!Number.isInteger(totalRuns) || totalRuns < 1 || totalRuns > 50) {
          throw new HttpError(400, "Anzahl muss zwischen 1 und 50 liegen");
        }
      }
      const [[loop]] = await conn.query(
        `SELECT id, status FROM loops WHERE id = ? AND session_id = ?`,
        [loopId, session.id],
      );
      if (!loop) throw new HttpError(404, "Loop nicht gefunden");
      if (loop.status !== "active") throw new HttpError(409, "Loop ist nicht aktiv");
      return { loop_id: loopId, total_runs: totalRuns };
    },
    async apply(conn, session, payload) {
      const res = await loops.setRuns(conn, session.id, payload.loop_id, payload.total_runs);
      return {
        eventType: "loop.runs_changed",
        eventPayload: { loop_id: payload.loop_id, total_runs: payload.total_runs },
        reversible: true,
        inverse: {
          op: "restore_loop_runs",
          loop_id: payload.loop_id,
          total_runs: res?.previous_total_runs ?? null,
        },
        emits: [{ event: "loop_updated", payload: res?.status }],
      };
    },
    describe: (p = {}) =>
      p.total_runs == null ? "Loop auf endlos setzen" : `Loop auf ×${p.total_runs} setzen`,
  },

  // -------------------------------------------------------------- undo event
  undo_event: {
    quorumPercent: 0.5,
    durationSeconds: 45,
    async validate(conn, session, payload = {}) {
      const eventId = Number(payload.event_id);
      if (!Number.isFinite(eventId)) throw new HttpError(400, "event_id fehlt");
      const [[ev]] = await conn.query(
        `SELECT id, reversible, inverse, undone_at FROM session_events
          WHERE id = ? AND session_id = ?`,
        [eventId, session.id],
      );
      if (!ev) throw new HttpError(404, "Ereignis nicht gefunden");
      if (!ev.reversible) throw new HttpError(409, "Diese Änderung ist nicht umkehrbar");
      if (ev.undone_at) throw new HttpError(409, "Bereits rückgängig gemacht");
      if (!ev.inverse) throw new HttpError(409, "Keine Umkehr-Daten vorhanden");
      return { event_id: eventId };
    },
    async apply(conn, session, payload) {
      const [[ev]] = await conn.query(
        `SELECT id, inverse, undone_at FROM session_events
          WHERE id = ? AND session_id = ? FOR UPDATE`,
        [payload.event_id, session.id],
      );
      if (!ev || ev.undone_at) throw new HttpError(409, "Bereits rückgängig gemacht");
      await applyInverse(conn, session, fromJson(ev.inverse));
      await conn.query(`UPDATE session_events SET undone_at = NOW() WHERE id = ?`, [ev.id]);
      return {
        eventType: "change.undone",
        eventPayload: { undone_event_id: ev.id },
        reversible: false,
        inverse: null,
        emits: [{ event: "queue_updated" }],
      };
    },
    describe: () => "Änderung rückgängig machen",
  },

  // ------------------------------------------------------- multi-option poll
  // A poll never applies directly; the winning OPTION's handler does. Only a
  // describe() is needed (the option payloads are validated at create time).
  poll: {
    quorumPercent: 0.5,
    durationSeconds: 60,
    describe: (p = {}) => p.question || "Abstimmung",
  },

  // "No change" — the losing branch of a yes/no, or an explicit abstain option.
  none: {
    quorumPercent: 0.5,
    durationSeconds: 60,
    async validate() {
      return {};
    },
    async apply() {
      return {
        eventType: "poll.no_change",
        eventPayload: {},
        reversible: false,
        inverse: null,
      };
    },
    describe: () => "Keine Änderung",
  },

  // ------------------------------------------------------- votable session rule
  set_rule: {
    quorumPercent: 0.66,
    durationSeconds: 60,
    async validate(conn, session, payload = {}) {
      const key = String(payload.key || "");
      if (!ALLOWED_RULE_KEYS.has(key)) throw new HttpError(400, "Unbekannte Regel");
      let value = payload.value;
      if (value != null) {
        value = Number(value);
        if (key === "duration_seconds") {
          if (!Number.isInteger(value) || value < 10 || value > 600) {
            throw new HttpError(400, "Dauer muss 10–600 Sekunden sein");
          }
        } else if (key === "auto_pause_after_songs") {
          if (!Number.isInteger(value) || value < 2 || value > 50) {
            throw new HttpError(400, "Wert muss 2–50 Songs sein");
          }
        } else if (key === "poll_decide_on_expiry") {
          value = value ? 1 : 0; // boolean flag
        } else if (!(value > 0 && value <= 1)) {
          throw new HttpError(400, "Quorum muss zwischen 0 und 1 liegen");
        }
      }
      return { key, value: value ?? null };
    },
    async apply(conn, session, payload) {
      const rules = await loadRules(session.id, conn);
      const old = getRuleValue(rules, payload.key);
      await upsertRule(conn, session.id, payload.key, payload.value);
      return {
        eventType: "rule.changed",
        eventPayload: { key: payload.key, value: payload.value },
        reversible: true,
        inverse: { op: "restore_rule", key: payload.key, value: old },
        emits: [{ event: "rules_updated" }],
      };
    },
    describe: (p = {}) =>
      `Regel ändern: ${p.key} → ${p.value == null ? "Standard" : p.value}`,
  },
};

// ---------------------------------------------------------------------------
// SESSION RULES — per-session, democratically changeable overrides on the
// handler defaults (quorum per type, default vote duration). Changed via set_rule.
// ---------------------------------------------------------------------------

const ALLOWED_RULE_KEYS = new Set([
  "quorum.skip_current",
  "quorum.insert_pause",
  "quorum.remove_queued_item",
  "quorum.end_session",
  "quorum.create_loop",
  "quorum.end_loop",
  "quorum.set_loop_runs",
  "quorum.move_item",
  "quorum.poll",
  "duration_seconds",
  "auto_pause_after_songs",
  "poll_decide_on_expiry",
]);

async function loadRules(sessionId, conn = pool) {
  const [[row]] = await conn.query(
    `SELECT rules FROM session_rules WHERE session_id = ?`,
    [sessionId],
  );
  return (row && fromJson(row.rules)) || {};
}

function quorumFor(type, rules) {
  const v = rules?.quorum?.[type];
  return typeof v === "number" ? v : handlers[type]?.quorumPercent ?? 0.5;
}

function durationFor(type, rules) {
  const v = rules?.duration_seconds;
  return typeof v === "number" ? v : handlers[type]?.durationSeconds ?? 45;
}

function getRuleValue(rules, key) {
  if (key.startsWith("quorum.")) return rules?.quorum?.[key.slice(7)] ?? null;
  return rules?.[key] ?? null;
}

async function upsertRule(conn, sessionId, key, value) {
  const rules = await loadRules(sessionId, conn);
  if (key.startsWith("quorum.")) {
    const t = key.slice(7);
    rules.quorum = rules.quorum || {};
    if (value == null) delete rules.quorum[t];
    else rules.quorum[t] = value;
  } else if (value == null) {
    delete rules[key];
  } else {
    rules[key] = value;
  }
  await conn.query(
    `INSERT INTO session_rules (session_id, rules) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE rules = VALUES(rules), updated_at = NOW()`,
    [sessionId, toJson(rules)],
  );
}

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

  // Multi-option polls: attach each option with its live vote tally.
  const rawOptions = fromJson(crRow.options);
  let options = null;
  if (rawOptions && rawOptions.length) {
    if (crRow.vote_method === "ranking") {
      // Show each option's current Borda score.
      const [rows] = await conn.query(
        `SELECT ranking FROM change_request_votes
          WHERE change_request_id = ? AND ranking IS NOT NULL`,
        [crRow.id],
      );
      const N = rawOptions.length;
      const score = {};
      for (const o of rawOptions) score[o.id] = 0;
      for (const r of rows) {
        const rk = fromJson(r.ranking);
        if (Array.isArray(rk)) {
          rk.forEach((id, idx) => {
            if (id in score) score[id] += N - 1 - idx;
          });
        }
      }
      options = rawOptions.map((o) => ({
        id: o.id,
        label: o.label,
        votes: score[o.id] || 0,
      }));
    } else {
      const [orows] = await conn.query(
        `SELECT option_id, COUNT(*) AS cnt FROM change_request_votes
          WHERE change_request_id = ? GROUP BY option_id`,
        [crRow.id],
      );
      const counts = {};
      for (const r of orows) counts[r.option_id] = r.cnt;
      options = rawOptions.map((o) => ({
        id: o.id,
        label: o.label,
        votes: counts[o.id] || 0,
      }));
    }
  }

  // Live "Jetzt → Danach" preview (#67 §5) — only for still-open requests, where
  // the upcoming queue is meaningful and voters need to see the effect.
  let preview = null;
  if (crRow.status === "open" && handler?.preview) {
    try {
      const win = await queueWindow(conn, crRow.session_id);
      preview = handler.preview(win, payload || {}, crRow);
    } catch (e) {
      console.warn(`[change-request ${crRow.id}] preview failed:`, e.message);
    }
  }

  // Attribution (#68): resolve the proposer's display name.
  let proposer_name = null;
  if (crRow.proposed_by_user_id) {
    const [[u]] = await conn.query(`SELECT username FROM users WHERE id = ?`, [
      crRow.proposed_by_user_id,
    ]);
    proposer_name = u?.username || null;
  } else if (crRow.proposed_by_guest_id) {
    const [[g]] = await conn.query(
      `SELECT nickname FROM guest_users WHERE id = ?`,
      [crRow.proposed_by_guest_id],
    );
    proposer_name = g?.nickname || null;
  }

  return {
    id: crRow.id,
    session_id: crRow.session_id,
    type: crRow.type,
    status: crRow.status,
    payload,
    description: handler ? handler.describe(payload || {}) : crRow.type,
    preview,
    is_poll: !!options,
    vote_method: crRow.vote_method || "plurality",
    options,
    winner_option_id: crRow.winner_option_id || null,
    quorum_percent: Number(crRow.quorum_percent),
    votes: votes.cnt,
    live,
    needed: neededVotes(live, crRow.quorum_percent),
    // Suggestion state (#67): a suggestion needs `min_support` backers before it
    // becomes a live vote (`activated`).
    min_support: crRow.min_support || null,
    activated: !crRow.min_support || !!crRow.activated_at,
    proposed_by_user_id: crRow.proposed_by_user_id,
    proposed_by_guest_id: crRow.proposed_by_guest_id,
    proposer_name,
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
// How long a suggestion collects support before it lapses (if it never reaches
// its threshold it expires as "not_enough_support").
const GATHERING_WINDOW_SEC = 180;

async function create(sessionId, type, rawPayload, proposer, options, method, minSupport) {
  // A request with options is a multi-option poll (see createPoll).
  if (Array.isArray(options) && options.length) {
    return createPoll(sessionId, rawPayload, options, proposer, method);
  }

  const handler = handlers[type];
  if (!handler || type === "poll" || type === "none") {
    throw new HttpError(400, `Unbekannter Change-Type: ${type}`);
  }

  const [[session]] = await pool.query(
    `SELECT id, status FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) throw new HttpError(404, "Session nicht gefunden");
  if (session.status !== "live") throw new HttpError(403, "Session ist nicht live");

  const payload = await handler.validate(pool, session, rawPayload || {});
  const rules = await loadRules(sessionId);
  const quorum = quorumFor(type, rules);
  const duration = durationFor(type, rules);

  // A suggestion (min_support > 1) gathers backers first; a normal request is an
  // immediate vote. The window is shorter while gathering.
  const isSuggestion = Number(minSupport) > 1;
  const min_support = isSuggestion ? Math.floor(minSupport) : null;
  const windowSec = isSuggestion ? GATHERING_WINDOW_SEC : duration;

  const [ins] = await pool.query(
    `INSERT INTO change_requests
       (session_id, type, payload, proposed_by_user_id, proposed_by_guest_id,
        status, quorum_percent, min_support, expires_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      sessionId,
      type,
      toJson(payload),
      proposer.user?.id || null,
      proposer.guest?.id || null,
      quorum,
      min_support,
      windowSec,
    ],
  );
  const crId = ins.insertId;

  // Proposing counts as the first upvote — but only for a real person (a
  // system/AI-proposed suggestion has no phantom vote and must earn its support).
  if (proposer.user || proposer.guest) {
    await pool.query(
      `INSERT IGNORE INTO change_request_votes (change_request_id, user_id, guest_id)
       VALUES (?, ?, ?)`,
      [crId, proposer.user?.id || null, proposer.guest?.id || null],
    );
  }

  armTimer(crId, windowSec * 1000);

  const row = await loadCr(crId);
  await emitCreated(row);

  // Early pass: may already meet quorum (e.g. a solo live session). A suggestion
  // that already has enough backers activates inside resolve→vote path below.
  await maybeActivateSuggestion(crId);
  await resolve(crId);

  return await buildDto(await loadCr(crId));
}

// If a gathering suggestion has reached its support threshold, turn it into a
// normal timed vote (fresh expiry, re-armed timer). No-op otherwise.
async function maybeActivateSuggestion(crId) {
  const cr = await loadCr(crId);
  if (!cr || cr.status !== "open" || !cr.min_support || cr.activated_at) return;
  if (fromJson(cr.options)) return; // suggestions apply to single-action requests
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM change_request_votes WHERE change_request_id = ?`,
    [crId],
  );
  if (c.cnt < cr.min_support) return;
  const rules = await loadRules(cr.session_id);
  const dur = durationFor(cr.type, rules);
  await pool.query(
    `UPDATE change_requests
        SET activated_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE id = ? AND activated_at IS NULL`,
    [dur, crId],
  );
  clearTimer(crId);
  armTimer(crId, dur * 1000);
  await emitUpdated(crId);
}

// Create a multi-option poll. Each option carries one or more ACTIONS (single
// action = the usual case; several = an "alternative flow"). Voters pick one
// option ('plurality') or rank them ('ranking'/Borda); the winner's actions are
// applied. Every action's payload is validated up front.
async function createPoll(sessionId, rawPayload, options, proposer, method) {
  const voteMethod = method === "ranking" ? "ranking" : "plurality";
  const [[session]] = await pool.query(
    `SELECT id, status FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) throw new HttpError(404, "Session nicht gefunden");
  if (session.status !== "live") throw new HttpError(403, "Session ist nicht live");
  if (options.length < 2 || options.length > 6) {
    throw new HttpError(400, "Eine Abstimmung braucht 2 bis 6 Optionen");
  }

  const seen = new Set();
  const norm = [];
  for (const o of options) {
    const id = String(o?.id || "").slice(0, 64);
    if (!id || seen.has(id)) throw new HttpError(400, "Ungültige oder doppelte Option-ID");
    seen.add(id);

    // Normalize to an actions array (single {type,payload} → one action).
    let rawActions = Array.isArray(o.actions)
      ? o.actions
      : [{ type: o.type || "none", payload: o.payload }];
    if (!rawActions.length) rawActions = [{ type: "none" }];
    if (rawActions.length > 4) throw new HttpError(400, "Max. 4 Aktionen pro Option");

    const actions = [];
    for (const a of rawActions) {
      const type = a.type || "none";
      const handler = handlers[type];
      if (!handler) throw new HttpError(400, `Unbekannter Aktions-Typ: ${type}`);
      let payload = {};
      if (type !== "none" && handler.validate) {
        payload = await handler.validate(pool, session, a.payload || {});
      }
      actions.push({ type, payload });
    }
    norm.push({ id, label: String(o.label || id).slice(0, 80), actions });
  }

  const question = String(rawPayload?.question || "Abstimmung").slice(0, 140);
  const rules = await loadRules(sessionId);
  const quorumPercent = quorumFor("poll", rules);
  const durationSeconds = durationFor("poll", rules);

  const [ins] = await pool.query(
    `INSERT INTO change_requests
       (session_id, type, payload, options, vote_method,
        proposed_by_user_id, proposed_by_guest_id,
        status, quorum_percent, expires_at)
     VALUES (?, 'poll', ?, ?, ?, ?, ?, 'open', ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [
      sessionId,
      toJson({ question }),
      toJson(norm),
      voteMethod,
      proposer.user?.id || null,
      proposer.guest?.id || null,
      quorumPercent,
      durationSeconds,
    ],
  );
  const crId = ins.insertId;
  armTimer(crId, durationSeconds * 1000);
  await emitCreated(await loadCr(crId));
  await resolve(crId);
  return await buildDto(await loadCr(crId));
}

// Record a vote, then try to resolve early. For a poll, `optionId` selects an
// option and may be changed later (upsert); for a single-action request it is a
// plain approve upvote (idempotent).
async function vote(crId, voter, optionId = null, ranking = null) {
  const cr = await loadCr(crId);
  if (!cr) throw new HttpError(404, "Change Request nicht gefunden");
  if (cr.status !== "open") throw new HttpError(409, "Abstimmung ist bereits beendet");

  const options = fromJson(cr.options);
  if (options && options.length && cr.vote_method === "ranking") {
    // Ranking vote: an ordered subset of the option ids (deduped, validated).
    const valid = new Set(options.map((o) => o.id));
    const seen = new Set();
    const clean = [];
    for (const id of Array.isArray(ranking) ? ranking : []) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        clean.push(id);
      }
    }
    if (!clean.length) throw new HttpError(400, "Bitte die Optionen ordnen");
    await pool.query(
      `INSERT INTO change_request_votes (change_request_id, user_id, guest_id, ranking)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ranking = VALUES(ranking), option_id = NULL`,
      [crId, voter.user?.id || null, voter.guest?.id || null, toJson(clean)],
    );
  } else if (options && options.length) {
    if (!optionId || !options.some((o) => o.id === optionId)) {
      throw new HttpError(400, "Bitte eine gültige Option wählen");
    }
    // Upsert so a voter can switch their choice while the poll is open.
    await pool.query(
      `INSERT INTO change_request_votes (change_request_id, user_id, guest_id, option_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE option_id = VALUES(option_id)`,
      [crId, voter.user?.id || null, voter.guest?.id || null, optionId],
    );
  } else {
    await pool.query(
      `INSERT IGNORE INTO change_request_votes (change_request_id, user_id, guest_id)
       VALUES (?, ?, ?)`,
      [crId, voter.user?.id || null, voter.guest?.id || null],
    );
  }

  await maybeActivateSuggestion(crId); // a suggestion may cross its threshold now
  await emitUpdated(crId);
  await resolve(crId); // applies immediately if quorum is now met
  return await buildDto(await loadCr(crId));
}

// Apply an option's multiple actions (an "alternative flow") in order, combining
// them into one logged event. Its inverse is the list of each action's inverse in
// REVERSE order (applyInverse already handles arrays), so Undo reverts the whole
// flow cleanly. Only fully-reversible flows are marked reversible.
async function applyFlow(conn, session, cr, actions) {
  const subInverses = [];
  const emits = [];
  const afters = [];
  const types = [];
  let allReversible = true;
  for (const a of actions) {
    const handler = handlers[a.type];
    const out = await handler.apply(conn, session, a.payload || {}, cr);
    types.push(out.eventType);
    if (out.reversible && out.inverse) subInverses.push(out.inverse);
    else allReversible = false;
    if (out.emits) emits.push(...out.emits);
    if (out.after) afters.push(out.after);
  }
  return {
    eventType: "flow.applied",
    eventPayload: { actions: types },
    reversible: allReversible,
    inverse: allReversible ? subInverses.slice().reverse() : null,
    emits,
    after: afters.length
      ? async () => {
          for (const fn of afters) await fn();
        }
      : null,
  };
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

    const options = fromJson(cr.options);
    const live = await liveCount(sessionId, connection);
    const needed = neededVotes(live, cr.quorum_percent);
    const expired = !!Number(cr.is_expired);

    // Decide the outcome and which action to apply. Single-action requests apply
    // their own type/payload on approve; polls apply the WINNING option's.
    let approved = false;
    let winnerOption = null;
    let strictLeader = false; // a clear leader exists (may still lack quorum)

    if (options && options.length && cr.vote_method === "ranking") {
      // Borda count: each ballot gives an option (N-1 - position) points.
      const [rows] = await connection.query(
        `SELECT ranking FROM change_request_votes
          WHERE change_request_id = ? AND ranking IS NOT NULL`,
        [crId],
      );
      const N = options.length;
      const score = {};
      for (const o of options) score[o.id] = 0;
      let turnout = 0;
      for (const r of rows) {
        const rk = fromJson(r.ranking);
        if (!Array.isArray(rk) || !rk.length) continue;
        turnout++;
        rk.forEach((id, idx) => {
          if (id in score) score[id] += N - 1 - idx;
        });
      }
      let lead = -1;
      let tie = false;
      for (const opt of options) {
        const s = score[opt.id];
        if (s > lead) {
          winnerOption = opt;
          lead = s;
          tie = false;
        } else if (s === lead) {
          tie = true;
        }
      }
      // Enough voters ranked (turnout quorum) and there's a strict Borda winner.
      strictLeader = !!winnerOption && lead > 0 && !tie;
      approved = strictLeader && turnout >= needed;
    } else if (options && options.length) {
      const [orows] = await connection.query(
        `SELECT option_id, COUNT(*) AS cnt FROM change_request_votes
          WHERE change_request_id = ? GROUP BY option_id`,
        [crId],
      );
      const counts = {};
      for (const r of orows) counts[r.option_id] = r.cnt;
      let leadCount = -1;
      let tie = false;
      for (const opt of options) {
        const c = counts[opt.id] || 0;
        if (c > leadCount) {
          winnerOption = opt;
          leadCount = c;
          tie = false;
        } else if (c === leadCount && c > 0) {
          tie = true;
        }
      }
      strictLeader = !!winnerOption && leadCount > 0 && !tie;
      approved = strictLeader && leadCount >= needed;
    } else {
      const [[votes]] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM change_request_votes WHERE change_request_id = ?`,
        [crId],
      );
      // A suggestion can't be applied until it has crossed its support threshold.
      const activated = !cr.min_support || cr.activated_at;
      approved = !!activated && needed > 0 && votes.cnt >= needed;
    }

    // Rule "poll_decide_on_expiry" (#67): at the deadline a poll's clear leader
    // wins even below quorum, so a decision is always reached rather than lapsing.
    if (!approved && expired && options && options.length && strictLeader) {
      const rules = await loadRules(sessionId, connection);
      if (rules.poll_decide_on_expiry) approved = true;
    }

    if (!approved && !expired) {
      await connection.commit(); // still open, keep waiting
      return;
    }

    const [[session]] = await connection.query(
      `SELECT id, status FROM sessions WHERE id = ?`,
      [sessionId],
    );

    if (approved && session && session.status === "live") {
      // A poll applies its winning option's action(s); a single-action request
      // applies its own type/payload. Options may carry several actions (an
      // "alternative flow"), applied in order as one logged event.
      const actions = winnerOption
        ? winnerOption.actions
        : [{ type: cr.type, payload: fromJson(cr.payload) || {} }];
      try {
        const out =
          actions.length === 1
            ? await handlers[actions[0].type].apply(
                connection,
                session,
                actions[0].payload || {},
                cr,
              )
            : await applyFlow(connection, session, cr, actions);
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
                  resolution = 'quorum_met', applied_event_id = ?,
                  winner_option_id = ?
            WHERE id = ?`,
          [ev.insertId, winnerOption?.id || null, crId],
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
      // No clear/quorum winner by the deadline, or the session is no longer live.
      const resolution =
        options && options.length
          ? "poll_no_winner"
          : cr.min_support && !cr.activated_at
            ? "not_enough_support"
            : expired
              ? "expired_no_quorum"
              : "session_not_live";
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

// Auto-pause rule (#67): sessions with `auto_pause_after_songs` set get a pause
// SUGGESTION proposed automatically after that many songs since the last pause.
// The community still decides — it's a suggestion needing supporters, not a
// forced pause. Called each reconciler tick. Per-session cooldown avoids spam.
const autoPauseCooldown = new Map(); // sessionId -> epoch ms
const AUTO_PAUSE_COOLDOWN_MS = 120_000;

async function autoProposePauses() {
  const [rows] = await pool.query(
    `SELECT s.id AS session_id, sr.rules
       FROM sessions s
       JOIN session_rules sr ON sr.session_id = s.id
      WHERE s.status = 'live'`,
  );
  const now = Date.now();
  for (const r of rows) {
    const rules = fromJson(r.rules) || {};
    const threshold = Number(rules.auto_pause_after_songs);
    if (!Number.isInteger(threshold) || threshold < 2) continue;
    if (now < (autoPauseCooldown.get(r.session_id) || 0)) continue;

    // Don't stack pauses: skip while a pause vote is open or one is already queued.
    const [[openPause]] = await pool.query(
      `SELECT 1 AS x FROM change_requests
        WHERE session_id = ? AND type = 'insert_pause' AND status = 'open' LIMIT 1`,
      [r.session_id],
    );
    if (openPause) continue;
    const [[pending]] = await pool.query(
      `SELECT 1 AS x FROM queue_items
        WHERE session_id = ? AND item_type = 'pause'
          AND status IN ('queued','playing') LIMIT 1`,
      [r.session_id],
    );
    if (pending) continue;

    // Songs played since the last pause actually played.
    const [[cnt]] = await pool.query(
      `SELECT COUNT(*) AS c FROM queue_items
        WHERE session_id = ? AND item_type = 'music' AND status = 'played'
          AND playedAt > COALESCE(
            (SELECT MAX(playedAt) FROM queue_items
              WHERE session_id = ? AND item_type = 'pause' AND status = 'played'),
            '1970-01-01 00:00:00')`,
      [r.session_id, r.session_id],
    );
    if (cnt.c < threshold) continue;

    const [[live]] = await pool.query(
      `SELECT COUNT(*) AS c FROM session_participants
        WHERE session_id = ? AND is_live = 1`,
      [r.session_id],
    );
    if (live.c < 1) continue;

    autoPauseCooldown.set(r.session_id, now + AUTO_PAUSE_COOLDOWN_MS);
    const minSupport = Math.min(3, Math.max(1, live.c));
    try {
      await create(
        r.session_id,
        "insert_pause",
        { duration_seconds: 60 },
        { user: null, guest: null },
        null,
        null,
        minSupport,
      );
    } catch (e) {
      console.warn(`[auto-pause] session ${r.session_id}:`, e.message);
    }
  }
}

// Loop "what happens after" (#66): when a loop with on_complete='propose_pause'
// ends, propose a pause suggestion once. Called each reconciler tick.
async function processLoopCompletions() {
  const [rows] = await pool.query(
    `SELECT l.id AS loop_id, l.session_id
       FROM loops l
       JOIN sessions s ON s.id = l.session_id
      WHERE l.status = 'ended' AND l.on_complete = 'propose_pause'
        AND l.on_complete_done = 0 AND s.status = 'live'`,
  );
  for (const r of rows) {
    // Mark handled first (atomically) so a create failure can't loop forever.
    const [upd] = await pool.query(
      `UPDATE loops SET on_complete_done = 1 WHERE id = ? AND on_complete_done = 0`,
      [r.loop_id],
    );
    if (!upd.affectedRows) continue;
    const [[live]] = await pool.query(
      `SELECT COUNT(*) AS c FROM session_participants
        WHERE session_id = ? AND is_live = 1`,
      [r.session_id],
    );
    if (live.c < 1) continue;
    const minSupport = Math.min(3, Math.max(1, live.c));
    try {
      await create(
        r.session_id,
        "insert_pause",
        { duration_seconds: 60 },
        { user: null, guest: null },
        null,
        null,
        minSupport,
      );
    } catch (e) {
      console.warn(`[loop on_complete] session ${r.session_id}:`, e.message);
    }
  }
}

// Read-only session metrics (#67 §10) derived from the event log + change
// requests + queue. Powers the end-of-session summary.
async function computeMetrics(sessionId) {
  const q = (sql) => pool.query(sql, [sessionId]).then(([r]) => r);
  const [[songs]] = await pool.query(
    `SELECT COUNT(*) c FROM queue_items
      WHERE session_id = ? AND item_type = 'music' AND status = 'played'`,
    [sessionId],
  );
  const [[pauses]] = await pool.query(
    `SELECT COUNT(*) c FROM queue_items
      WHERE session_id = ? AND item_type = 'pause' AND status = 'played'`,
    [sessionId],
  );
  const [[loopsC]] = await pool.query(
    `SELECT COUNT(*) c FROM loops WHERE session_id = ?`,
    [sessionId],
  );
  const [[undone]] = await pool.query(
    `SELECT COUNT(*) c FROM session_events
      WHERE session_id = ? AND undone_at IS NOT NULL`,
    [sessionId],
  );
  const byStatusRows = await q(
    `SELECT status, COUNT(*) c FROM change_requests WHERE session_id = ? GROUP BY status`,
  );
  const byStatus = {};
  for (const r of byStatusRows) byStatus[r.status] = r.c;
  const byEventRows = await q(
    `SELECT type, COUNT(*) c FROM session_events WHERE session_id = ? GROUP BY type`,
  );
  const byEvent = {};
  for (const r of byEventRows) byEvent[r.type] = r.c;
  const influential = await q(
    `SELECT cr.id, cr.type, cr.winner_option_id,
            (SELECT COUNT(*) FROM change_request_votes v
              WHERE v.change_request_id = cr.id) AS votes
       FROM change_requests cr
      WHERE cr.session_id = ? AND cr.status = 'applied'
      ORDER BY votes DESC, cr.id DESC LIMIT 5`,
  );
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    songs_played: songs.c,
    pauses_played: pauses.c,
    loops: loopsC.c,
    change_requests: total,
    applied: byStatus.applied || 0,
    expired: byStatus.expired || 0,
    failed: byStatus.failed || 0,
    open: byStatus.open || 0,
    undone: undone.c,
    by_event: byEvent,
    most_influential: influential.map((r) => ({
      id: r.id,
      type: r.type,
      winner_option_id: r.winner_option_id,
      votes: r.votes,
    })),
  };
}

module.exports = {
  HttpError,
  handlers,
  create,
  vote,
  resolve,
  reconcileExpired,
  autoProposePauses,
  processLoopCompletions,
  buildDto,
  loadCr,
  loadRules,
  computeMetrics,
};
