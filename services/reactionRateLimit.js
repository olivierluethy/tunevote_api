// Pure fixed-window token bucket for ephemeral song reactions (#18). Limits a
// single socket to `max` reactions per `windowMs`. Returns the decision plus the
// next state (no mutation), so it is trivially unit-testable; socket.js keeps
// one state object per connection.
function allowReaction(state, nowMs, max = 5, windowMs = 1000) {
  let { count = 0, windowStart = 0 } = state || {};
  if (nowMs - windowStart >= windowMs) {
    count = 0;
    windowStart = nowMs;
  }
  if (count >= max) {
    return { allowed: false, state: { count, windowStart } };
  }
  return { allowed: true, state: { count: count + 1, windowStart } };
}

module.exports = { allowReaction };
