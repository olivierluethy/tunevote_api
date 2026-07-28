#!/usr/bin/env node
/**
 * repair-encoding.js — one-off data repair for UTF-8 → CP1252 double-encoding.
 *
 * BACKGROUND
 * ----------
 * A legacy bulk import wrote YouTube titles into the database over a *latin1*
 * client connection. MySQL therefore re-encoded the incoming UTF-8 bytes as if
 * they were its latin1 (Windows-1252) characters, storing e.g. the apostrophe
 * U+2019 ('’', bytes E2 80 99) as the three characters â € ™  → utf8mb4 bytes
 * C3A2 E282AC E284A2. The DB connection is now utf8mb4 (db.js / knexfile.js), so
 * NEW rows are correct; this script repairs the EXISTING corrupted rows.
 *
 * THE REPAIR — and why it MUST be done with MySQL's latin1
 * -------------------------------------------------------
 * The corruption is exactly:  utf8_bytes --interpreted-as--> MySQL-latin1 chars.
 * The inverse is therefore:   re-encode the stored chars back to MySQL-latin1
 * bytes, then decode those bytes as UTF-8:
 *
 *     CONVERT(BINARY(CONVERT(col USING latin1)) USING utf8mb4)
 *
 * MySQL's `latin1` is a full, symmetric 256-value table (the 5 CP1252-undefined
 * bytes 0x81/0x8D/0x8F/0x90/0x9D map to U+0081/…/U+009D and back). A third-party
 * "windows-1252" codec (e.g. iconv-lite) maps those 5 bytes asymmetrically and
 * silently fails to reverse ~half the corpus — every double-encoded curly quote
 * ”/“ (whose 3rd byte is 0x9D). So the repair is driven entirely by MySQL's own
 * CONVERT, guaranteeing it is the precise inverse of the corruption.
 *
 * SAFETY (mandatory properties)
 * -----------------------------
 *  1. Backup-gated: --apply refuses to run unless a fresh dump exists.
 *  2. Dry-run by default: prints affected tables, row counts and before/after
 *     samples. Writing requires the explicit --apply flag.
 *  3. Byte-level repair via MySQL latin1 (NOT iso-8859-1, which lacks € 0x80 and
 *     ™ 0x99 and would corrupt further; NOT a JS cp1252 lib, see above).
 *  4. Idempotent & safe: a row is touched ONLY when
 *       (a) reinterpreting its latin1 bytes as UTF-8 yields a VALID string
 *           (repaired IS NOT NULL), AND
 *       (b) that string DIFFERS from the current value, AND
 *       (c) the current value is losslessly latin1-encodable
 *           (HEX(latin1->utf8mb4 round-trip) = HEX(col)).
 *     Guard (c) excludes every row containing a genuine non-latin1 character
 *     (real emoji, CJK, correctly-stored accents/quotes), so they are never
 *     damaged. After repair, the fixed value's latin1 bytes are no longer valid
 *     UTF-8 → guard (a) fails → a second run changes zero rows (idempotent).
 *  5. Detection over blind conversion: selection is the round-trip test above,
 *     not a hardcoded string list.
 *  6. Verifiable: re-runs the HEX() check on the Rag'n'Bone Man rows and prints a
 *     scanned / changed / clean summary. Applies loop-until-dry so multi-level
 *     (triple-)encoded rows fully converge in a single invocation.
 *  7. Covers every user-visible text column found in diagnosis (see TARGETS).
 *
 * USAGE
 * -----
 *   node scripts/repair-encoding.js                 # dry-run (read-only)
 *   node scripts/repair-encoding.js --apply         # apply (needs a fresh dump)
 *   node scripts/repair-encoding.js --apply --backup /path/to/dump.sql
 *
 * Options:
 *   --apply                 Actually write changes (default: dry-run).
 *   --backup <file>         Use this dump file as the required backup.
 *   --backup-dir <dir>      Extra directory to search for a fresh dump.
 *   --max-age-hours <n>     How fresh the dump must be (default 24).
 *   --samples <n>           Number of before/after samples to print (default 20).
 *
 * Exit codes: 0 = ok, 1 = runtime error, 3 = missing/failed backup gate.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const mysql = require("mysql2/promise");

// ---------------------------------------------------------------------------
// Targets — every user-visible text column identified in the Step-1 diagnosis.
// Only youtube_video_cache.title actually holds mojibake today, but the repair
// is a no-op on clean columns, so we scan all of them for completeness and to
// harden against any future re-occurrence. Every table here has an `id` PK.
// (URL/token/enum/email columns and the emoji-seeded `badges` table are
// deliberately excluded — they are not an ingestion vector for this bug.)
// ---------------------------------------------------------------------------
const TARGETS = [
  { table: "youtube_video_cache", column: "title" },
  { table: "youtube_video_cache", column: "title_norm" },
  { table: "artists", column: "name" },
  { table: "artists", column: "name_norm" },
  { table: "sessions", column: "title" },
  { table: "users", column: "username" },
  { table: "guest_users", column: "nickname" },
  { table: "shouts", column: "message" },
  { table: "queue_items", column: "description" },
];

const CHUNK = 1000;

// ---------------------------------------------------------------------------
// SQL fragments. `c` is a backticked column reference, e.g. "`title`".
// ---------------------------------------------------------------------------
const repaired = (c) => `CONVERT(BINARY(CONVERT(${c} USING latin1)) USING utf8mb4)`;
const latin1Lossless = (c) =>
  `HEX(CONVERT(CONVERT(${c} USING latin1) USING utf8mb4)) = HEX(${c})`;
// A row is mojibake iff its latin1 bytes decode to a DIFFERENT, VALID utf8mb4
// string and the value is losslessly latin1-encodable. HEX comparisons avoid
// collation-mix errors (shouts.message is utf8mb4_unicode_ci).
const mojibakeCond = (c) =>
  `${c} IS NOT NULL AND ${repaired(c)} IS NOT NULL ` +
  `AND HEX(${repaired(c)}) <> HEX(${c}) AND ${latin1Lossless(c)}`;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { apply: false, backup: null, backupDir: null, maxAgeHours: 24, samples: 20 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--apply") a.apply = true;
    else if (t === "--backup") a.backup = argv[++i];
    else if (t === "--backup-dir") a.backupDir = argv[++i];
    else if (t === "--max-age-hours") a.maxAgeHours = Number(argv[++i]);
    else if (t === "--samples") a.samples = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${t}`);
      process.exit(1);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Backup gate (only enforced for --apply)
// ---------------------------------------------------------------------------
function expectedDumpCommand() {
  const ts = "$(date +%Y%m%d-%H%M%S)";
  return [
    "  set -a; . /var/www/tunevote_api/.env; set +a",
    "  mkdir -p ~/tunevote-backups",
    '  docker exec mysql mysqldump -u"$DB_USER" -p"$DB_PASSWORD" \\',
    '    --single-transaction --routines "$DB_NAME" \\',
    `    > ~/tunevote-backups/tunevote-pre-encoding-repair-${ts}.sql`,
  ].join("\n");
}

function findFreshBackup(opts) {
  const dirs = [
    opts.backupDir,
    process.env.REPAIR_BACKUP_DIR,
    path.join(os.homedir(), "tunevote-backups"),
    "/root/tunevote-backups",
    "/home/salade/tunevote-backups",
  ].filter(Boolean);

  const maxAgeMs = opts.maxAgeHours * 3600 * 1000;
  const now = Date.now();
  const check = (file) => {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size < 10_000) return null;
      const ageMs = now - st.mtimeMs;
      return { file, size: st.size, ageMs, tooOld: ageMs > maxAgeMs };
    } catch {
      return null;
    }
  };

  if (opts.backup) {
    const info = check(opts.backup);
    if (!info) return { ok: false, reason: `--backup file missing or too small: ${opts.backup}` };
    return { ok: true, info, explicit: true };
  }

  const candidates = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.sql(\.gz)?$/.test(name)) continue;
      const info = check(path.join(dir, name));
      if (info) candidates.push(info);
    }
  }
  candidates.sort((a, b) => a.ageMs - b.ageMs);
  const fresh = candidates.find((c) => !c.tooOld);
  if (fresh) return { ok: true, info: fresh };
  return { ok: false, reason: "no fresh dump found", searched: dirs, newest: candidates[0] || null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  const dbName = process.env.DB_NAME || "tunevote";

  console.log("========================================================");
  console.log(" TuneVote encoding repair (UTF-8 ← MySQL-latin1 double-encode)");
  console.log("========================================================");
  console.log(`Mode        : ${opts.apply ? "APPLY (writes changes)" : "DRY-RUN (read-only)"}`);
  console.log(`Database    : ${dbName} @ ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  console.log(`Targets     : ${TARGETS.map((t) => `${t.table}.${t.column}`).join(", ")}`);
  console.log("");

  if (opts.apply) {
    const gate = findFreshBackup(opts);
    if (!gate.ok) {
      console.error("✋ BACKUP REQUIRED — refusing to --apply without a fresh dump.");
      console.error(`   Reason: ${gate.reason}`);
      if (gate.searched) console.error(`   Searched: ${gate.searched.join(", ")}`);
      if (gate.newest) {
        console.error(
          `   Newest found: ${gate.newest.file} (${Math.round(gate.newest.ageMs / 3600000)}h old — older than --max-age-hours=${opts.maxAgeHours})`,
        );
      }
      console.error("\n   Take a backup first (run on the VPS as root):\n");
      console.error(expectedDumpCommand());
      console.error("\n   Then re-run with --apply (optionally --backup <that file>).");
      process.exit(3);
    }
    console.log(
      `Backup OK   : ${gate.info.file} ` +
        `(${(gate.info.size / 1e6).toFixed(1)} MB, ${Math.round(gate.info.ageMs / 60000)} min old)` +
        `${gate.explicit ? " [explicit]" : ""}`,
    );
    console.log("");
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: dbName,
    charset: "utf8mb4", // CRITICAL: read/write as utf8mb4, never latin1.
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
  });

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(os.tmpdir(), `repair-encoding-${runId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const logLine = (o) => logStream.write(JSON.stringify(o) + "\n");

  const totals = { scanned: 0, toChange: 0, changed: 0 };
  const samples = [];

  try {
    for (const { table, column } of TARGETS) {
      const c = `\`${column}\``;
      const t = `\`${table}\``;

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM ${t} WHERE ${column} IS NOT NULL`,
      );
      const [[{ n: toChange }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM ${t} WHERE ${mojibakeCond(c)}`,
      );
      totals.scanned += total;
      totals.toChange += toChange;

      // Collect a few before/after samples for the report.
      if (toChange > 0 && samples.length < opts.samples) {
        const [rows] = await pool.query(
          `SELECT id, ${c} AS before_val, ${repaired(c)} AS after_val
             FROM ${t} WHERE ${mojibakeCond(c)} ORDER BY id LIMIT ?`,
          [opts.samples - samples.length],
        );
        for (const r of rows) samples.push({ table, id: r.id, before: r.before_val, after: r.after_val });
      }

      let changed = 0;
      let passes = 0;
      if (opts.apply && toChange > 0) {
        // Loop-until-dry: repeat the full chunked pass until a pass changes zero
        // rows. This converges multi-level (triple-)encoding — one pass peels one
        // layer — and mops up any row skipped by the concurrency guard. Bounded
        // by MAX_PASSES as a safety backstop.
        const MAX_PASSES = 12;
        for (;;) {
          passes++;
          let changedThisPass = 0;
          let lastId = 0;
          // Chunked, byte-exact, concurrency-guarded repair. SELECT a batch, log
          // each (id, before, after) for a reversible audit trail, then UPDATE by
          // PK with a HEX() guard so a row edited underneath us is never clobbered.
          // The UPDATE recomputes the value with MySQL's own CONVERT so the written
          // bytes are exactly the detected repair.
          for (;;) {
            const [rows] = await pool.query(
              `SELECT id, ${c} AS before_val, HEX(${c}) AS hexbefore, ${repaired(c)} AS after_val
                 FROM ${t} WHERE ${mojibakeCond(c)} AND id > ? ORDER BY id LIMIT ?`,
              [lastId, CHUNK],
            );
            if (rows.length === 0) break;
            const conn = await pool.getConnection();
            try {
              await conn.beginTransaction();
              for (const r of rows) {
                const [res] = await conn.query(
                  `UPDATE ${t} SET ${c} = ${repaired(c)} WHERE id = ? AND HEX(${c}) = ?`,
                  [r.id, r.hexbefore],
                );
                if (res.affectedRows === 1) {
                  changedThisPass++;
                  logLine({ kind: "changed", pass: passes, table, column, id: r.id, before: r.before_val, after: r.after_val });
                } else {
                  logLine({ kind: "skip-concurrent", pass: passes, table, column, id: r.id });
                }
              }
              await conn.commit();
            } catch (e) {
              await conn.rollback();
              throw e;
            } finally {
              conn.release();
            }
            lastId = rows[rows.length - 1].id;
          }
          changed += changedThisPass;
          if (changedThisPass > 0) console.log(`   … ${table}.${column}: pass ${passes} changed ${changedThisPass}`);
          if (changedThisPass === 0) break;
          if (passes >= MAX_PASSES) {
            console.warn(`   ⚠ ${table}.${column}: stopped after ${MAX_PASSES} passes (still converging?)`);
            break;
          }
        }
      }
      totals.changed += changed;

      const verb = opts.apply ? "changed" : "would change";
      console.log(
        `• ${table}.${column}: scanned ${total}, ${verb} ${opts.apply ? changed : toChange}` +
          (opts.apply && passes > 1 ? ` (over ${passes - 1} pass${passes - 1 === 1 ? "" : "es"}, multi-level)` : ""),
      );
    }

    // -------- samples --------
    console.log("");
    console.log(`Sample of ${samples.length} ${opts.apply ? "applied" : "proposed"} repairs:`);
    for (const s of samples) {
      console.log(`  [${s.table}#${s.id}]`);
      console.log(`    before: ${s.before}`);
      console.log(`    after : ${s.after}`);
    }

    // -------- verification (Rag'n'Bone Man HEX check) --------
    console.log("");
    console.log("Verification — Rag'n'Bone Man titles (state of the apostrophe bytes):");
    const [bone] = await pool.query(
      `SELECT id, title, HEX(title) AS hex_title
         FROM youtube_video_cache
        WHERE title LIKE '%Bone Man%'
          AND (HEX(title) LIKE '%C3A2E282AC%' OR HEX(title) LIKE '%E28099%')
        ORDER BY id LIMIT 6`,
    );
    for (const r of bone) {
      const state = r.hex_title.includes("C3A2E282AC")
        ? "STILL MOJIBAKE"
        : r.hex_title.includes("E28099")
          ? "OK (E28099)"
          : "clean";
      console.log(`  #${r.id} [${state}] ${r.title}`);
    }

    // -------- remaining-mojibake recount on the primary column --------
    const [[{ n: remaining }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM youtube_video_cache WHERE ${mojibakeCond("`title`")}`,
    );

    console.log("");
    console.log("========================= SUMMARY =========================");
    console.log(`Rows scanned          : ${totals.scanned}`);
    console.log(`Rows ${opts.apply ? "changed          " : "to change        "}: ${opts.apply ? totals.changed : totals.toChange}`);
    console.log(`Rows clean (untouched): ${totals.scanned - totals.toChange}`);
    console.log(`Remaining mojibake in youtube_video_cache.title: ${remaining}`);
    console.log(`Log file              : ${logPath}`);
    if (!opts.apply) {
      console.log("");
      console.log("DRY-RUN only — no rows were written. Re-run with --apply to repair.");
    }
    console.log("===========================================================");
  } finally {
    logStream.end();
    await pool.end();
  }
}

// Exported for tests; only auto-run when invoked directly as a script.
module.exports = { TARGETS, mojibakeCond, repaired };

if (require.main === module) {
  main().catch((e) => {
    console.error("\n❌ repair-encoding failed:", e.stack || e.message);
    process.exit(1);
  });
}
