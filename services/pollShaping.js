// Pure shaping for poll results (#44). Annotates each option with its integer
// percentage of the total votes. Kept pure for unit-testing; the route does the
// SQL and socket broadcast.
function pollPercents(options) {
  const opts = (options || []).map((o) => ({
    ...o,
    votes: Number(o.votes) || 0,
  }));
  const total = opts.reduce((sum, o) => sum + o.votes, 0);
  return {
    total,
    options: opts.map((o) => ({
      ...o,
      pct: total ? Math.round((o.votes / total) * 100) : 0,
    })),
  };
}

module.exports = { pollPercents };
