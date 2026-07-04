// Minimal integration-test runner: `node test/run.js test/<file>.js`
// Runs against the LOCAL MySQL container (never prod). Each test file exports
// an async function; it throws on failure.
require("dotenv").config();
const http = require("http");
const path = require("path");

// Initialise Socket.IO against a non-listening server so the playback engine's
// getIO().to(...).emit(...) calls are harmless no-ops during tests.
require("../lib/io").init(http.createServer());

const file = process.argv[2];
if (!file) {
  console.error("usage: node test/run.js <testfile>");
  process.exit(2);
}

(async () => {
  try {
    await require(path.resolve(file))();
    console.log("\n✅ PASS:", file);
    process.exit(0);
  } catch (e) {
    console.error("\n❌ FAIL:", file, "\n", e.stack || e.message);
    process.exit(1);
  }
})();
