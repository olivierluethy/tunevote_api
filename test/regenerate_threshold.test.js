// Pure-logic test for the AI-regenerate majority rule (#27).
// Run: node test/run.js test/regenerate_threshold.test.js
const assert = require("assert");
const { shouldRegenerate } = require("../services/aiRegenerate");

module.exports = async function () {
  assert.strictEqual(shouldRegenerate(2, 3), true, "2 of 3 is a majority");
  assert.strictEqual(shouldRegenerate(3, 4), true, "3 of 4 is a majority");
  assert.strictEqual(shouldRegenerate(2, 4), false, "2 of 4 is exactly half");
  assert.strictEqual(shouldRegenerate(1, 3), false, "1 of 3 is a minority");
  assert.strictEqual(shouldRegenerate(1, 1), true, "1 of 1 is a majority");
  assert.strictEqual(shouldRegenerate(5, 0), false, "no live users -> never");
  assert.strictEqual(shouldRegenerate(0, 5), false, "no rejections -> never");
  console.log("  regenerate_threshold: shouldRegenerate ok");
};
