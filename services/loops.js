// ---------------------------------------------------------------------------
// LIVE LOOP OBJECTS (#66/#68)
//
// A loop repeats a recipe of songs N times (or endlessly). It is driven LAZILY:
// only one run is materialized into the queue at a time. When the playback engine
// finishes the last song of the current run (playback.js calls onItemPlayed), the
// next run is enqueued — as long as the loop is active and runs remain. This gives
// endless loops, "end after this run", extend/change-count, and a live run-x/y
// status, without pre-inserting huge numbers of rows.
//
// Standalone module (depends only on the DB) so playback.js can require it without
// a circular dependency (playback → loops, changeRequests → loops + playback).
// ---------------------------------------------------------------------------
const pool = require("../db");

const toJson = (v) => (v == null ? null : JSON.stringify(v));
const fromJson = (v) => {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const sourceOf = (loop) =>
  loop.created_by_user_id ? "user" : loop.created_by_guest_id ? "guest" : "ai";

// A recipe step is a pause or a music item. Legacy recipes (no `kind`, just a
// video_id) are treated as music.
const stepIsPause = (s) => s?.kind === "pause";
const stepIsValid = (s) => (stepIsPause(s) ? Number(s.duration_seconds) > 0 : !!s?.video_id);
const stepLabel = (s) =>
  stepIsPause(s) ? `⏸ ${s.duration_seconds || 30}s` : s?.description || "Song";

// Insert one run of `recipe` right after the currently playing song, spread evenly
// between it and the next queued item so ordering stays stable. Returns the new ids.
async function insertRunAfterCurrent(conn, sessionId, recipe, loopId, runNumber, loop) {
  const steps = (recipe || []).filter(stepIsValid);
  if (!steps.length) return [];

  const [[playing]] = await conn.query(
    `SELECT COALESCE(sort_order, id) AS ord FROM queue_items
      WHERE session_id = ? AND status = 'playing' LIMIT 1`,
    [sessionId],
  );
  let anchor;
  let boundary;
  if (playing) {
    anchor = Number(playing.ord);
    const [[nb]] = await conn.query(
      `SELECT MIN(COALESCE(sort_order, id)) AS nb FROM queue_items
        WHERE session_id = ? AND status = 'queued' AND COALESCE(sort_order, id) > ?`,
      [sessionId, anchor],
    );
    boundary = nb.nb != null ? Number(nb.nb) : anchor + steps.length + 1;
  } else {
    const [[m]] = await conn.query(
      `SELECT MAX(COALESCE(sort_order, id)) AS mx FROM queue_items
        WHERE session_id = ? AND status IN ('queued','playing')`,
      [sessionId],
    );
    anchor = Number(m.mx) || 0;
    boundary = anchor + steps.length + 1;
  }
  const step = (boundary - anchor) / (steps.length + 1);
  const src = sourceOf(loop);
  const uid = loop.created_by_user_id || null;
  const gid = loop.created_by_guest_id || null;
  const sid = loop.section_id || null; // loop-as-block: items join the loop's section
  const ids = [];
  let slot = 0;
  for (const s of steps) {
    slot++;
    const so = anchor + step * slot;
    if (stepIsPause(s)) {
      const dur = Math.max(5, Math.min(600, Number(s.duration_seconds) || 30));
      const [ins] = await conn.query(
        `INSERT INTO queue_items
           (session_id, item_type, description, pause_duration_seconds,
            added_by, guest_id, status, item_source, sort_order, loop_id, loop_run, section_id)
         VALUES (?, 'pause', ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        [sessionId, "Pause (Loop)", dur, uid, gid, src, so, loopId, runNumber, sid],
      );
      ids.push(ins.insertId);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO queue_items
           (session_id, video_id, description, added_by, guest_id,
            status, item_type, item_source, sort_order, loop_id, loop_run, section_id)
         VALUES (?, ?, ?, ?, ?, 'queued', 'music', ?, ?, ?, ?, ?)`,
        [sessionId, s.video_id, s.description || null, uid, gid, src, so, loopId, runNumber, sid],
      );
      ids.push(ins.insertId);
    }
  }
  return ids;
}

// Build the client-facing status for a loop (banner + socket).
async function loopStatus(conn, loopId) {
  const [[loop]] = await conn.query(`SELECT * FROM loops WHERE id = ?`, [loopId]);
  if (!loop) return null;
  const recipe = fromJson(loop.recipe) || [];
  return {
    id: loop.id,
    session_id: loop.session_id,
    status: loop.status,
    total_runs: loop.total_runs, // null = endless
    completed_runs: loop.completed_runs,
    current_run: loop.status === "active" ? loop.completed_runs + 1 : loop.completed_runs,
    songs: recipe.map(stepLabel),
    on_complete: loop.on_complete || "none",
  };
}

// Create a loop object and materialize its first run. Called from the create_loop
// change request's apply (inside its transaction). Returns { loopId, insertedIds }.
async function createLoop(conn, sessionId, recipe, totalRuns, onComplete, proposer, sectionId) {
  const [ins] = await conn.query(
    `INSERT INTO loops
       (session_id, recipe, total_runs, completed_runs, status, on_complete,
        section_id, created_by_user_id, created_by_guest_id)
     VALUES (?, ?, ?, 0, 'active', ?, ?, ?, ?)`,
    [
      sessionId,
      toJson(recipe),
      totalRuns ?? null,
      onComplete || "none",
      sectionId ?? null,
      proposer?.user_id || null,
      proposer?.guest_id || null,
    ],
  );
  const loopId = ins.insertId;
  const [[loop]] = await conn.query(`SELECT * FROM loops WHERE id = ?`, [loopId]);
  const insertedIds = await insertRunAfterCurrent(conn, sessionId, recipe, loopId, 1, loop);
  return { loopId, insertedIds };
}

// End a loop gracefully: no further runs are materialized, but the copies already
// queued for the current run play out. Returns the fresh status (or null).
async function endLoop(conn, sessionId, loopId) {
  await conn.query(
    `UPDATE loops SET status = 'ended' WHERE id = ? AND session_id = ?`,
    [loopId, sessionId],
  );
  return loopStatus(conn, loopId);
}

// Change the target run count (null = endless). If the new target is already met,
// the loop ends after the current run. Returns { status, previous_total_runs }.
async function setRuns(conn, sessionId, loopId, totalRuns) {
  const [[loop]] = await conn.query(
    `SELECT * FROM loops WHERE id = ? AND session_id = ?`,
    [loopId, sessionId],
  );
  if (!loop) return null;
  const previous = loop.total_runs;
  const stillActive = totalRuns == null || loop.completed_runs < totalRuns;
  await conn.query(
    `UPDATE loops SET total_runs = ?, status = ? WHERE id = ?`,
    [totalRuns ?? null, stillActive ? "active" : "ended", loopId],
  );
  return { status: await loopStatus(conn, loopId), previous_total_runs: previous };
}

// Undo helpers used by changeRequests.applyInverse:
async function archiveLoop(conn, sessionId, loopId) {
  await conn.query(`UPDATE loops SET status = 'ended' WHERE id = ? AND session_id = ?`, [
    loopId,
    sessionId,
  ]);
  await conn.query(
    `UPDATE queue_items SET status = 'archived' WHERE loop_id = ? AND status = 'queued'`,
    [loopId],
  );
}

async function restoreRuns(conn, sessionId, loopId, totalRuns) {
  const [[loop]] = await conn.query(
    `SELECT completed_runs FROM loops WHERE id = ? AND session_id = ?`,
    [loopId, sessionId],
  );
  if (!loop) return;
  const stillActive = totalRuns == null || loop.completed_runs < totalRuns;
  await conn.query(`UPDATE loops SET total_runs = ?, status = ? WHERE id = ?`, [
    totalRuns ?? null,
    stillActive ? "active" : "ended",
    loopId,
  ]);
}

// Called by advanceToNext right after marking an item 'played', inside the same
// transaction. If the item belonged to a loop and its run is now exhausted,
// advance the loop: bump completed_runs and materialize the next run (or end it).
// Returns socket emits to fire after the engine commits.
async function onItemPlayed(conn, sessionId, itemId) {
  if (!itemId) return [];
  const [[it]] = await conn.query(`SELECT loop_id FROM queue_items WHERE id = ?`, [itemId]);
  const loopId = it?.loop_id;
  if (!loopId) return [];

  const [[loop]] = await conn.query(`SELECT * FROM loops WHERE id = ? FOR UPDATE`, [loopId]);
  if (!loop) return [];

  // Any copies of this loop still to play? Then the run isn't finished yet.
  const [[rem]] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM queue_items
      WHERE loop_id = ? AND status IN ('queued','playing')`,
    [loopId],
  );
  if (rem.cnt > 0) return [];

  const completed = loop.completed_runs + 1;
  const endless = loop.total_runs == null;
  const moreRuns = loop.status === "active" && (endless || completed < loop.total_runs);

  if (moreRuns) {
    await conn.query(`UPDATE loops SET completed_runs = ? WHERE id = ?`, [completed, loopId]);
    await insertRunAfterCurrent(
      conn,
      sessionId,
      fromJson(loop.recipe),
      loopId,
      completed + 1,
      loop,
    );
  } else {
    await conn.query(`UPDATE loops SET completed_runs = ?, status = 'ended' WHERE id = ?`, [
      completed,
      loopId,
    ]);
  }
  return [{ event: "loop_updated", payload: await loopStatus(conn, loopId) }];
}

async function activeLoops(sessionId, conn = pool) {
  const [rows] = await conn.query(
    `SELECT id FROM loops WHERE session_id = ? AND status = 'active' ORDER BY id ASC`,
    [sessionId],
  );
  const out = [];
  for (const { id } of rows) out.push(await loopStatus(conn, id));
  return out.filter(Boolean);
}

module.exports = {
  createLoop,
  endLoop,
  setRuns,
  archiveLoop,
  restoreRuns,
  onItemPlayed,
  loopStatus,
  activeLoops,
};
