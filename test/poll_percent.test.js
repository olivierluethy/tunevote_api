// Pure-logic test for poll percentage shaping (#44).
// Run: node test/run.js test/poll_percent.test.js
const assert = require("assert");
const { pollPercents } = require("../services/pollShaping");

module.exports = async function () {
  const r = pollPercents([
    { id: 1, label: "A", votes: 3 },
    { id: 2, label: "B", votes: 1 },
  ]);
  assert.strictEqual(r.total, 4, "total votes");
  assert.strictEqual(r.options[0].pct, 75, "A is 75%");
  assert.strictEqual(r.options[1].pct, 25, "B is 25%");

  const empty = pollPercents([
    { id: 1, label: "A", votes: 0 },
    { id: 2, label: "B", votes: 0 },
  ]);
  assert.strictEqual(empty.total, 0, "no votes -> total 0");
  assert.strictEqual(empty.options[0].pct, 0, "no votes -> 0%");

  assert.deepStrictEqual(pollPercents([]), { total: 0, options: [] }, "empty");
  console.log("  poll_percent: pollPercents ok");
};
