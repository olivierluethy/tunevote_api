// Pure-logic test for the song-reaction token bucket (#18).
// Run: node test/run.js test/reaction_ratelimit.test.js
const assert = require("assert");
const { allowReaction } = require("../services/reactionRateLimit");

module.exports = async function () {
  let state;
  // 5 allowed in the first window
  for (let i = 0; i < 5; i++) {
    const r = allowReaction(state, 1000);
    assert.strictEqual(r.allowed, true, `reaction ${i + 1} allowed`);
    state = r.state;
  }
  // 6th within the same window is blocked
  const sixth = allowReaction(state, 1500);
  assert.strictEqual(sixth.allowed, false, "6th within window blocked");

  // after the window rolls over, allowed again
  const next = allowReaction(sixth.state, 2100);
  assert.strictEqual(next.allowed, true, "allowed after window reset");

  console.log("  reaction_ratelimit: allowReaction ok");
};
