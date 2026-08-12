// ---------------------------------------------------------------------------
// Majority rule for regenerating AI song suggestions (#27). A regeneration
// fires once the number of live users who rejected the current batch exceeds
// half the live-user count. Pure so it can be unit-tested; the in-memory tally
// and the actual regeneration live in routes/proposals.js.
// ---------------------------------------------------------------------------

// True when strictly MORE than half of the live users have rejected.
function shouldRegenerate(rejections, liveUsers) {
  if (!liveUsers || liveUsers <= 0) return false;
  return rejections > liveUsers / 2;
}

module.exports = { shouldRegenerate };
