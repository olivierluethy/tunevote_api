// Pure-logic test for session role predicates.
// Run: node test/run.js test/permissions.test.js
const assert = require("assert");
const { isHost, isHostOrCoHost } = require("../services/permissions");

module.exports = async function () {
  // isHost
  assert.strictEqual(isHost(5, 5), true, "owner is host");
  assert.strictEqual(isHost(5, "5"), true, "owner is host (string id)");
  assert.strictEqual(isHost(5, 6), false, "non-owner is not host");
  assert.strictEqual(isHost(5, null), false, "guest (null user) not host");
  assert.strictEqual(isHost(null, 5), false, "no owner -> not host");

  // isHostOrCoHost
  assert.strictEqual(isHostOrCoHost(5, 5, "user"), true, "host regardless of role");
  assert.strictEqual(isHostOrCoHost(5, 6, "co-host"), true, "co-host allowed");
  assert.strictEqual(isHostOrCoHost(5, 6, "user"), false, "member denied");
  assert.strictEqual(isHostOrCoHost(5, 6, "guest"), false, "guest denied");
  assert.strictEqual(isHostOrCoHost(5, null, null), false, "anonymous denied");

  console.log("  permissions: isHost + isHostOrCoHost ok");
};
