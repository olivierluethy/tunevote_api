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

module.exports = { shapeGenreRanking };
