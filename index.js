// ---------------------------------------------------------------------------
// COMPOSITION ROOT
//
// index.js wires the app together and owns the load-bearing startup order:
// cors → express.json → DB check → server + io → route modules →
// socket handlers. All feature logic lives in ./routes, ./services,
// ./utils, ./lib and ./socket.js.
// ---------------------------------------------------------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { init: initIO } = require("./lib/io");
const pool = require("./db");

const app = express();
app.use(cors());

app.use(express.json());

// === DB Connection Check ===
(async () => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT DATABASE() AS db, USER() AS user, NOW() AS time",
    );
    console.log("✅ MySQL connected successfully!");
    console.log("   Database:", rows[0].db);
    console.log("   User:", rows[0].user);
    console.log("   Server time:", rows[0].time);

    // Fail fast on a non-utf8mb4 connection. A latin1 session silently
    // double-encodes non-ASCII text on write (the mojibake bug). If the charset
    // is ever wrong, refuse to serve rather than corrupt data. See
    // docs/encoding-repair.md.
    const [[cs]] = await connection.query(
      "SELECT @@character_set_client c, @@character_set_connection n, " +
        "@@character_set_results r, @@collation_connection coll",
    );
    const wrong = ["c", "n", "r"].filter((k) => !String(cs[k]).startsWith("utf8mb4"));
    if (wrong.length) {
      console.error("❌ Connection charset is NOT utf8mb4:", cs);
      console.error("   Refusing to start — a latin1 session corrupts non-ASCII text.");
      console.error("   Fix db.js `charset: \"utf8mb4\"` and/or the MySQL server charset.");
      connection.release();
      process.exit(1);
    }
    console.log(`   Charset: client=${cs.c} connection=${cs.n} results=${cs.r} (${cs.coll})`);
    connection.release();
  } catch (err) {
    console.error("❌ MySQL connection failed!");
    console.error("   Error:", err.message);
    console.error(
      "   Check your .env settings (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)",
    );
    process.exit(1); // stop server if DB not reachable
  }
})();


const httpServer = app.listen(4000, () =>
  console.log("Server läuft auf https://app.tunevote.com/"),
);
initIO(httpServer);

// Crash-safe playback reconciler (DB-authoritative; rebuilds work on boot).
require("./services/scheduler").startReconciler();

// === Route modules ===
app.use(require("./routes/youtube"));
app.use(require("./routes/oauth"));
app.use(require("./routes/auth"));
app.use(require("./routes/password"));
app.use(require("./routes/profile"));
app.use(require("./routes/artists"));
app.use(require("./routes/sessions"));
app.use(require("./routes/proposals"));
app.use(require("./routes/invites"));
app.use(require("./routes/stats"));
app.use(require("./routes/polls"));

// === Socket.IO ===
require("./socket").registerSocketHandlers();
