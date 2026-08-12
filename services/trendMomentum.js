// Pure 7-day momentum for a song (#46). Compares an activity count in the recent
// window against the previous window and returns a signed percentage plus a
// direction with a small deadband so tiny wiggles read as "flat".
function momentum(recent, previous) {
  recent = Number(recent) || 0;
  previous = Number(previous) || 0;
  let pct;
  if (previous > 0) pct = Math.round(((recent - previous) / previous) * 100);
  else pct = recent > 0 ? 100 : 0;
  const dir = pct > 5 ? "up" : pct < -5 ? "down" : "flat";
  return { pct, dir };
}

module.exports = { momentum };
