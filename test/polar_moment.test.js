// Pure-logic test for the Polar Moment rank-gap stat (#50).
// Run: node test/run.js test/polar_moment.test.js
const assert = require("assert");
const { polarMoment } = require("../services/statsShaping");

module.exports = async function () {
  const board = [
    { userId: 1, name: "Ada", score: 20 },
    { userId: 2, name: "Bo", score: 14 },
    { userId: 3, name: "Cy", score: 10 },
  ];

  // Mid-board: correct rank, competitor above, and gap.
  const mid = polarMoment(board, 3);
  assert.strictEqual(mid.rank, 3, "rank is 3");
  assert.strictEqual(mid.myScore, 10);
  assert.strictEqual(mid.above.name, "Bo", "competitor directly above");
  assert.strictEqual(mid.gap, 4, "gap is 4");

  // Top of the board: no one above.
  const top = polarMoment(board, 1);
  assert.strictEqual(top.rank, 1);
  assert.strictEqual(top.above, null, "no competitor above #1");
  assert.strictEqual(top.gap, 0);

  // Not on the board.
  assert.strictEqual(polarMoment(board, 99), null, "absent user -> null");

  console.log("  polar_moment: polarMoment ok");
};
