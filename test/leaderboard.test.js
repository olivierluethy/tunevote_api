// Pure-logic test for the votes-given leaderboard shaping (#42).
// Run: node test/run.js test/leaderboard.test.js
const assert = require("assert");
const { shapeLeaderboard } = require("../services/statsShaping");

module.exports = async function () {
  const board = [
    { userId: 1, name: "Ada", score: 20 },
    { userId: 2, name: "Bo", score: 14 },
    { userId: 3, name: "Cy", score: 10 },
    { userId: 4, name: "Di", score: 4 },
  ];

  // Top 2, caller is #3 (outside the slice) -> still reported via `me`.
  const r = shapeLeaderboard(board, 3, 2);
  assert.strictEqual(r.entries.length, 2, "limit respected");
  assert.strictEqual(r.entries[0].rank, 1);
  assert.strictEqual(r.entries[0].isMe, false, "Ada is not me");
  assert.strictEqual(r.me.rank, 3, "my rank reported");
  assert.strictEqual(r.me.name, "Cy");

  // Caller inside the slice is flagged isMe.
  const r2 = shapeLeaderboard(board, 1, 3);
  assert.strictEqual(r2.entries[0].isMe, true, "Ada is me");
  assert.strictEqual(r2.me.rank, 1);

  // Anonymous / not on board.
  const r3 = shapeLeaderboard(board, null, 10);
  assert.strictEqual(r3.me, null, "no caller -> no me");
  assert.strictEqual(r3.entries.length, 4, "all shown when under limit");
  assert.strictEqual(shapeLeaderboard(board, 99, 10).me, null, "absent -> null");

  console.log("  leaderboard: shapeLeaderboard ok");
};
