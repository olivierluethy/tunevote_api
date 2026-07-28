// db_charset_guard.test.js — static guard against re-introducing the mojibake
// bug. Any source file that opens a MySQL connection (mysql2 createPool /
// createConnection) or configures Knex MUST pin charset: "utf8mb4". A latin1
// session silently double-encodes non-ASCII text on write.
//
// Pure source scan — no database needed.
// Run: node test/run.js test/db_charset_guard.test.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["", "routes", "services", "lib", "utils", "scripts", "migrations"];
const CONNECTION_MARKERS = /createPool\s*\(|createConnection\s*\(/;
const UTF8MB4 = /charset\s*:\s*["']utf8mb4["']/;

function jsFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".js")) files.push(path.join(abs, e.name));
    }
  }
  // knexfile also opens connections (via the `connection` block).
  files.push(path.join(ROOT, "knexfile.js"));
  return [...new Set(files)];
}

module.exports = async () => {
  const offenders = [];
  for (const file of jsFiles()) {
    const src = fs.readFileSync(file, "utf8");
    const opensConnection = CONNECTION_MARKERS.test(src) || /knexfile\.js$/.test(file);
    if (opensConnection && !UTF8MB4.test(src)) {
      offenders.push(path.relative(ROOT, file));
    }
  }

  if (offenders.length) {
    throw new Error(
      "These files open a DB connection without charset: \"utf8mb4\" " +
        "(a latin1 session double-encodes non-ASCII text):\n  - " +
        offenders.join("\n  - "),
    );
  }
  console.log("✓ every DB connection in the codebase pins charset: utf8mb4");
};
