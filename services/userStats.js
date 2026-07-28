const pool = require("../db");
const { getScalar, getSingleValue } = require("../utils/helpers");

// Aggregate public profile stats for a user: top songs, co-listeners, session
// count, live/active session, and the full voting-statistics block. Used by the
// public /user/:userId endpoint (routes/artists.js).
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
    // 1. Top 10 Songs (nach Hördauer) — only songs actually listened to.
    pool.query(
      `SELECT
         MAX(y.public_id)      AS video_id,
         MAX(y.title)          AS title,
         MAX(y.thumbnail)      AS thumbnail,
         SUM(l.listen_seconds) AS total_seconds,
         COUNT(*)              AS listen_count
       FROM session_song_listens l
       JOIN queue_items q ON q.id = l.queue_item_id
       JOIN youtube_video_cache y ON y.youtube_id = q.video_id
       WHERE l.user_id = ?
       GROUP BY q.video_id
       HAVING total_seconds > 0
       ORDER BY total_seconds DESC
       LIMIT 10`,
      [userId],
    ),

    // 2. Top 10 Mit-Hörer
    pool.query(
      `SELECT
         u.public_id AS id,
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
       WHERE user_id = ? AND status = 'live'`,
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
       SELECT MAX(CAST(rn AS SIGNED) - CAST(grp AS SIGNED) + 1) AS max_streak
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
         MAX(CASE WHEN did_win = 1 THEN (CAST(rn AS SIGNED) - CAST(grp AS SIGNED) + 1) ELSE 0 END) AS max_winning_streak,
         MAX(CASE WHEN did_win = 0 THEN (CAST(rn AS SIGNED) - CAST(grp AS SIGNED) + 1) ELSE 0 END) AS max_losing_streak
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
       SELECT MAX(CASE WHEN has_voted = 0 THEN (CAST(rn AS SIGNED) - CAST(grp AS SIGNED) + 1) ELSE 0 END) AS max_streak
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

module.exports = { fetchUserStats };
