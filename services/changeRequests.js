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
      let ids = Array.isArray(payload.queue_item_ids)
        ? payload.queue_item_ids.map(Number).filter(Number.isFinite)
        : [];
      if (!ids.length) {
        const playing = await currentPlaying(conn, session.id);
        if (playing) ids = [playing.id];
      }
      if (!ids.length) throw new HttpError(409, "Kein Song zum Loopen");
      const [rows] = await conn.query(
        `SELECT id FROM queue_items
          WHERE session_id = ? AND item_type = 'music' AND video_id IS NOT NULL
            AND id IN (${ids.map(() => "?").join(",")})`,
        [session.id, ...ids],
      );
      const found = new Set(rows.map((r) => r.id));
      const ordered = ids.filter((id) => found.has(id));
      if (!ordered.length) throw new HttpError(404, "Songs nicht gefunden");
      const endless = payload.endless === true || payload.repeat === "endless";
      const repeat = endless ? null : Math.max(2, Math.min(10, Number(payload.repeat) || 3));
      return { queue_item_ids: ordered, repeat, endless };
    },
    async apply(conn, session, payload, cr) {
      const ids = payload.queue_item_ids;
      const [srcRows] = await conn.query(
        `SELECT id, video_id, description FROM queue_items
          WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        [session.id, ...ids],
      );
      const byId = new Map(srcRows.map((r) => [r.id, r]));
      const recipe = ids
        .map((id) => byId.get(id))
        .filter((r) => r && r.video_id)
        .map((r) => ({ video_id: r.video_id, description: r.description }));

      // Create a live loop object; it materializes run 1 now, and playback.js
      // enqueues each following run when the previous one ends.
      const totalRuns = payload.endless ? null : payload.repeat;
      const { loopId } = await loops.createLoop(conn, session.id, recipe, totalRuns, {
        user_id: cr.proposed_by_user_id,
        guest_id: cr.proposed_by_guest_id,
      });
      return {
        eventType: "loop.created",
        eventPayload: { loop_id: loopId, total_runs: totalRuns, source_ids: ids },
        reversible: true,
        inverse: { op: "archive_loop", loop_id: loopId },
        emits: [
          { event: "queue_updated" },
          { event: "loop_updated", payload: await loops.loopStatus(conn, loopId) },
        ],
      };
    },
    describe: (p = {}) =>
      p.endless ? "Endlos-Loop erstellen" : `Loop ×${p.repeat ?? 3} erstellen`,
    preview: (win, p = {}) => {
      const before = win.map(labelOf);
      const ids = p.queue_item_ids || [];
      const names = ids.map(
        (id) => labelOf(win.find((w) => w.id === id)) || "Song",
      );
      const repeat = p.endless ? "∞" : (p.repeat ?? 3);
      const head = win[0]?.status === "playing" ? [before[0]] : [];
      const rest = win[0]?.status === "playing" ? before.slice(1) : before;
      return {
        before,
        after: [...head, `🔁 ${names.join(" → ")} ×${repeat}`, ...rest],
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
      return { loop_id: loopId };
    },
    async apply(conn, session, payload) {
      const status = await loops.endLoop(conn, session.id, payload.loop_id);
      return {
        eventType: "loop.ended",
        eventPayload: { loop_id: payload.loop_id },
        reversible: false,
        inverse: null,
        emits: [
          { event: "loop_updated", payload: status },
          { event: "queue_updated" },
        ],
      };
    },
    describe: () => "Loop beenden",
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
  if (key === "duration_seconds") return rules?.duration_seconds ?? null;
  if (key.startsWith("quorum.")) return rules?.quorum?.[key.slice(7)] ?? null;
  return null;
}

async function upsertRule(conn, sessionId, key, value) {
  const rules = await loadRules(sessionId, conn);
  if (key === "duration_seconds") {
    if (value == null) delete rules.duration_seconds;
    else rules.duration_seconds = value;
  } else if (key.startsWith("quorum.")) {
    const t = key.slice(7);
    rules.quorum = rules.quorum || {};
    if (value == null) delete rules.quorum[t];
    else rules.quorum[t] = value;
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
async function create(sessionId, type, rawPayload, proposer, options, method) {
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
      quorum,
      duration,
    ],
  );
  const crId = ins.insertId;

  // Proposing counts as the first upvote.
  await pool.query(
    `INSERT IGNORE INTO change_request_votes (change_request_id, user_id, guest_id)
     VALUES (?, ?, ?)`,
    [crId, proposer.user?.id || null, proposer.guest?.id || null],
  );

  armTimer(crId, duration * 1000);

  const row = await loadCr(crId);
  await emitCreated(row);

  // Early pass: may already meet quorum (e.g. a solo live session).
  await resolve(crId);

  return await buildDto(await loadCr(crId));
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
      approved = !!winnerOption && lead > 0 && turnout >= needed && !tie;
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
      approved = !!winnerOption && leadCount > 0 && leadCount >= needed && !tie;
    } else {
      const [[votes]] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM change_request_votes WHERE change_request_id = ?`,
        [crId],
      );
      approved = needed > 0 && votes.cnt >= needed;
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
  buildDto,
  loadCr,
  loadRules,
  computeMetrics,
};
