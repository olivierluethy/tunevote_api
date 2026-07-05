const pool = require("../db");
const { getIO } = require("../lib/io");
const { broadcastTodayTopArtists } = require("./broadcast");

// ---------------------------------------------------------------------------
// SESSION / PLAYBACK ENGINE
//
// Owns the live playback + voting lifecycle: per-session timers, phase timing,
// advancing the queue, finalising listening stats, live-participant broadcasts,
// quorum checks, and public-session auto-creation. Socket emits go through the
// shared getIO() instance so this module is decoupled from server startup.
// ---------------------------------------------------------------------------

const sessionTimers = {};
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
          SET state = 'voting', phase_ends_at = ?
          WHERE id = ? AND session_id = ?
        `,
          [votingEnds, roundId, sessionId],
        );

        console.log(
          `[Voting] Wechsel zu Voting-Phase → ends at ${votingEnds.toISOString()}`,
        );

        getIO().to(sessionId).emit("voting_phase_changed", {
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
            const liveSocketsDebug = await getIO().in(String(sessionId)).fetchSockets();
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
       SET state = 'closed', winner_queue_item_id = NULL
       WHERE id = ?`,
                [roundId],
              );
              console.log(
                `[Voting] Runde ${roundId} geschlossen (kein Gewinner)`,
              );

              // Session beenden
              await pool.query(
                `UPDATE sessions 
       SET is_live = 0, status = 'ended', ended_at = NOW()
       WHERE id = ? AND status = 'live'`,
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
              getIO().to(sessionId).emit("session_ended", {
                reason: "no_active_participants",
                message:
                  "The session was terminated because no one was active anymore.",
              });
              console.log(`[Broadcast] session_ended gesendet`);

              // Raum räumen
              getIO().in(sessionId).socketsLeave(sessionId);
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
    SET state = 'closed', winner_queue_item_id = ?
    WHERE id = ?
    `,
          [winnerId || null, roundId],
        );
        console.log(`[Voting] Runde ${roundId} geschlossen`);

        // Top-Charts aktualisieren
        await broadcastTodayTopArtists();
        console.log(`[Broadcast] Top Artists aktualisiert`);

        // Broadcasts
        getIO().to(sessionId).emit("voting_round_completed", { winnerId, roundId });
        getIO().to(sessionId).emit("queue_updated");
        getIO().to(sessionId).emit("proposals_updated");
        console.log(
          `[Broadcast] voting_round_completed, queue_updated, proposals_updated gesendet`,
        );

        // === Neue Runde in 3 Sekunden ===
        setTimeout(async () => {
          const newEnds = new Date(Date.now() + 90 * 1000);
          const [newRound] = await pool.query(
            `
      INSERT INTO voting_rounds
        (session_id, state, phase_ends_at, suggestion_duration, voting_duration)
      VALUES (?, 'suggesting', ?, 90, 60)
      `,
            [sessionId, newEnds],
          );

          const newRoundId = newRound.insertId;

          console.log(
            `[Voting] Neue Suggestion-Runde gestartet: ${newRoundId}`,
          );

          getIO().to(sessionId).emit("suggesting_phase_started", {
            roundId: newRoundId,
            endsAt: newEnds.getTime(),
            duration: 90,
          });

          getIO().to(sessionId).emit("voting_phase_changed", {
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

async function finalizeListeningForCurrentSong(sessionId, conn = pool) {
  // 1. Aktuellen Song holen
  const [rows] = await conn.query(
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
  const [participants] = await conn.query(
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

    await conn.query(
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
const advanceToNext = async (sessionId, expectedCurrentItemId = null) => {
  // Everything that mutates state runs inside ONE locked transaction so two
  // concurrent advances (two timers, timer + reconciler, timer + manual) can
  // never double-skip or leave two rows 'playing'. Socket emits, the debounced
  // broadcast, and the next-song timer are deferred until AFTER commit.
  const connection = await pool.getConnection();
  const emits = [];
  let armTimer = null;
  let doBroadcast = false;
  let committed = false;
  try {
    await connection.beginTransaction();

    // Serialize all advances for this session.
    await connection.query(`SELECT id FROM sessions WHERE id = ? FOR UPDATE`, [
      sessionId,
    ]);

    // 🔥 Listening für aktuellen Song abschließen (Teil derselben Transaktion)
    await finalizeListeningForCurrentSong(sessionId, connection);

    // 1) Lock + read the current playing row.
    const [playingRows] = await connection.query(
      `SELECT id FROM queue_items WHERE session_id = ? AND status = 'playing' LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
    const currentId = playingRows[0]?.id ?? null;

    // Compare-and-swap: if the caller expected a specific current item and it's
    // no longer the playing row, another advance already handled it → no-op.
    if (expectedCurrentItemId !== null && currentId !== expectedCurrentItemId) {
      await connection.commit();
      return;
    }

    if (currentId !== null) {
      await connection.query(
        `UPDATE queue_items SET status = 'played', playedAt = NOW() WHERE id = ? AND status = 'playing'`,
        [currentId],
      );
      doBroadcast = true;
      console.log(`[Session ${sessionId}] Marked played: #${currentId}`);
    }

    // 2) Check if there are still queued items
    const [queuedRows] = await connection.query(
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
      const [openRound] = await connection.query(
        `SELECT id FROM voting_rounds WHERE session_id = ? AND state IN ('suggesting','voting') LIMIT 1`,
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
        const [votedSongs] = await connection.query(
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
          const [userProposal] = await connection.query(
            `
            SELECT id FROM queue_items
            WHERE voting_round_id = ? AND status = 'suggested' AND item_source IN ('user', 'guest')
            ORDER BY created_at ASC LIMIT 1
          `,
            [roundId],
          );
          if (userProposal.length > 0) winnerId = userProposal[0].id;
          else {
            // 3. Random AI song if live users exist
            const [liveCountRow] = await connection.query(
              `SELECT COUNT(*) AS cnt FROM session_participants WHERE session_id = ? AND is_live = 1`,
              [sessionId],
            );
            if (liveCountRow[0].cnt > 0) {
              const [aiRows] = await connection.query(
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
          await connection.query(
            `UPDATE queue_items SET status = 'queued' WHERE id = ?`,
            [winnerId],
          );

          // Archive others
          await connection.query(
            `UPDATE queue_items SET status = 'archived'
             WHERE voting_round_id = ? AND status = 'suggested' AND id != ?`,
            [roundId, winnerId],
          );

          // Close round early
          await connection.query(
            `UPDATE voting_rounds SET state = 'closed', winner_queue_item_id = ? WHERE id = ?`,
            [winnerId, roundId],
          );

          doBroadcast = true;
          emits.push({
            event: "voting_round_completed",
            payload: { winnerId, roundId, emergency: true },
          });
          emits.push({ event: "proposals_updated" });
          emits.push({ event: "queue_updated" });

          // Now fetch the newly queued song
          const [emergencyNext] = await connection.query(
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

    if (!next) {
      // 3) Still no song? → End session properly (with extra safety check)
      const [activeParticipants] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM session_participants WHERE session_id = ? AND is_live = 1`,
        [sessionId],
      );
      const [openRounds] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM voting_rounds WHERE session_id = ? AND state IN ('suggesting','voting')`,
        [sessionId],
      );
      const [currentlyPlaying] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM queue_items WHERE session_id = ? AND status = 'playing'`,
        [sessionId],
      );

      const noActiveUsers = activeParticipants[0].cnt === 0;
      const noOpenVoting = openRounds[0].cnt === 0;
      const nothingPlaying = currentlyPlaying[0].cnt === 0;

      if (noActiveUsers && noOpenVoting && nothingPlaying) {
        await connection.query(
          `UPDATE sessions SET is_live = 0, status = 'ended', ended_at = NOW() WHERE id = ?`,
          [sessionId],
        );
        await connection.query(
          `UPDATE session_participants SET is_live = 0 WHERE session_id = ?`,
          [sessionId],
        );
        emits.push({ event: "session_ended" });
        console.log(
          `[Session ${sessionId}] Session ended (no songs playing, no queued next, no users, no voting)`,
        );
      } else {
        const reasons = [];
        if (!noActiveUsers) reasons.push("active users");
        if (!noOpenVoting) reasons.push("open voting");
        if (!nothingPlaying) reasons.push("song currently playing");
        console.log(
          `[Session ${sessionId}] No song to play next, but session stays alive → ${reasons.join(", ")}`,
        );
      }
    } else {
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
        await connection.query(
          `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
          [nextId],
        );
        emits.push({
          event: "pause_started",
          payload: { queue_item_id: nextId, title, duration, startTime },
        });
        emits.push({
          event: "playback_sync",
          payload: {
            current_queue_item_id: nextId,
            current_video_id: null,
            current_title: title,
            video_start_time: startTime,
            server_time: startTime,
            is_playing: false,
          },
        });
        const pauseMs = Math.max(1000, (duration || 1) * 1000);
        armTimer = () => {
          if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
          sessionTimers[sessionId] = setTimeout(
            () => advanceToNext(sessionId, nextId),
            pauseMs,
          );
        };
      } else {
        await connection.query(
          `UPDATE queue_items SET status = 'playing', startedAt = NOW() WHERE id = ?`,
          [nextId],
        );
        emits.push({
          event: "playback_sync",
          payload: {
            current_queue_item_id: nextId,
            current_video_id: nextVideoId,
            current_title: title, // send the real title so the new song shows
            video_start_time: startTime, // instantly — no "Loading…"/placeholder flash
            server_time: startTime, // client clock-offset reference
            is_playing: true,
          },
        });
        const safeDurationMs = Math.max(1000, (duration || 180) * 1000);
        armTimer = () => {
          if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
          sessionTimers[sessionId] = setTimeout(
            () => advanceToNext(sessionId, nextId),
            safeDurationMs,
          );
        };
        console.log(
          `[Session ${sessionId}] Now playing: "${title}" (#${nextId})`,
        );
      }

      // Durable deadline so the reconciler can advance this session even if the
      // in-memory timer is lost (crash/restart).
      await connection.query(
        `UPDATE sessions SET current_plays_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?`,
        [Math.max(1, Math.floor(next.duration || 180)), sessionId],
      );

      emits.push({ event: "queue_updated" });
    }

    await connection.commit();
    committed = true;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      console.error(
        `[Session ${sessionId}] rollback failed:`,
        rollbackErr.message,
      );
    }
    console.error(`[Session ${sessionId}] advanceToNext error:`, err);
  } finally {
    connection.release();
  }

  if (!committed) return;

  // Side effects run only after the transaction has committed.
  if (doBroadcast) broadcastTodayTopArtists();
  for (const e of emits) getIO().to(sessionId).emit(e.event, e.payload);
  if (armTimer) armTimer();
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
    getIO().to(sessionId.toString()).emit("live_participants_updated", formatted);
  } catch (err) {
    console.error("Fehler beim Broadcast von Live-Teilnehmern:", err);
  }
};

// Presence-derived live viewer count. Recomputes from session_participants
// (is_live = 1) — never a stored counter — and broadcasts it globally so every
// dashboard viewer updates without a refresh. Emitted globally (not scoped to a
// room) because the sessions overview socket isn't joined to any session room.
// Call this on every presence transition: join, clean leave, tab-close
// (disconnect) and the reconciler's stale-heartbeat reap.
const broadcastParticipantCount = async (sessionId) => {
  try {
    const sid = parseInt(sessionId, 10);
    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND is_live = 1",
      [sid],
    );
    getIO().emit("participant_count_update", { sessionId: sid, count: count || 0 });
    return count || 0;
  } catch (err) {
    console.error("Fehler beim Broadcast der Teilnehmerzahl:", err);
  }
};

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
        (session_id, state, phase_ends_at,
         suggestion_duration, voting_duration, created_at)
      VALUES
        (?, 'suggesting', DATE_ADD(NOW(), INTERVAL 90 SECOND),
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
        'UPDATE voting_rounds SET state = \'closed\', winner_queue_item_id = ? WHERE id = ?',
        [v.queue_item_id, votingRoundId],
      );
      getIO().to(sessionId).emit("voting_round_completed", {
        winner: v.queue_item_id,
      });
      break;
    }
  }
}

module.exports = {
  sessionTimers,
  phaseTimers,
  startPhaseTimer,
  finalizeListeningForCurrentSong,
  advanceToNext,
  broadcastLiveParticipants,
  broadcastParticipantCount,
  createNewPublicSession,
  checkQuorum,
};
