// Pure-logic test for 7-day trend momentum (#46).
// Run: node test/run.js test/trend_momentum.test.js
const assert = require("assert");
const { momentum } = require("../services/trendMomentum");

module.exports = async function () {
  assert.deepStrictEqual(momentum(10, 5), { pct: 100, dir: "up" }, "doubled");
  assert.deepStrictEqual(momentum(5, 10), { pct: -50, dir: "down" }, "halved");
  assert.deepStrictEqual(momentum(10, 10), { pct: 0, dir: "flat" }, "unchanged");
  assert.deepStrictEqual(momentum(7, 0), { pct: 100, dir: "up" }, "new activity");
  assert.deepStrictEqual(momentum(0, 0), { pct: 0, dir: "flat" }, "no activity");
  // within deadband -> flat
  assert.strictEqual(momentum(103, 100).dir, "flat", "+3% is flat");
  assert.strictEqual(momentum(100, 103).dir, "flat", "-3% is flat");
  console.log("  trend_momentum: momentum ok");
};
