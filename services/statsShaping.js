// ---------------------------------------------------------------------------
// Pure shaping helpers for stats endpoints. No DB / IO here so they can be
// unit-tested directly. The routes do the SQL, then hand rows to these.
// ---------------------------------------------------------------------------

// Shape raw [{genre, plays}] rows into a ranking sorted by plays desc, each
// annotated with `share` (fraction of total plays, 0..1, rounded to 4 dp).
// Genre ranking over a time window (#43).
function shapeGenreRanking(rows) {
  const clean = (rows || [])
    .map((r) => ({ genre: r.genre || "Other", plays: Number(r.plays) || 0 }))
    .filter((r) => r.plays > 0);
  const total = clean.reduce((sum, r) => sum + r.plays, 0);
  return clean
    .map((r) => ({
      genre: r.genre,
      plays: r.plays,
      share: total ? Math.round((r.plays / total) * 10000) / 10000 : 0,
    }))
    .sort((a, b) => b.plays - a.plays || a.genre.localeCompare(b.genre));
}

// "Polar Moment" (#50): given a leaderboard sorted by score DESC
// ([{userId, name, score}]), describe where `userId` stands relative to the
// competitor directly above them. Returns null when the user isn't on the board.
function polarMoment(sorted, userId) {
  const list = sorted || [];
  const i = list.findIndex((r) => String(r.userId) === String(userId));
  if (i === -1) return null;

  const me = list[i];
  const above = i > 0 ? list[i - 1] : null;
  const gap = above ? above.score - me.score : 0;

  let suggestion;
  if (!above) {
    suggestion = "You're #1 — nobody's ahead of you. Defend your lead!";
  } else if (gap <= 0) {
    suggestion = `You're tied with ${above.name} — one more vote pulls you ahead.`;
  } else {
    suggestion = `Cast ${gap + 1} more vote${gap + 1 === 1 ? "" : "s"} to pass ${above.name}.`;
  }

  return {
    rank: i + 1,
    myScore: me.score,
    above: above ? { name: above.name, score: above.score } : null,
    gap,
    suggestion,
  };
}

// "Most votes given" leaderboard (#42). Takes a board sorted by score DESC
// ([{userId, name, score}]) and returns the top `limit` entries (each ranked and
// flagged isMe), plus the caller's own {rank, name, score} even when they fall
// outside the top slice (or null when not on the board / not logged in).
function shapeLeaderboard(board, myUserId, limit = 10) {
  const list = board || [];
  const entries = list.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    name: r.name,
    score: r.score,
    isMe: myUserId != null && String(r.userId) === String(myUserId),
  }));

  let me = null;
  if (myUserId != null) {
    const idx = list.findIndex((r) => String(r.userId) === String(myUserId));
    if (idx !== -1) {
      me = { rank: idx + 1, name: list[idx].name, score: list[idx].score };
    }
  }
  return { entries, me };
}

module.exports = { shapeGenreRanking, polarMoment, shapeLeaderboard };
