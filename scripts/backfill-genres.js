// ---------------------------------------------------------------------------
// Backfill youtube_video_cache.genre for rows tagged before genre classification
// existed (#39/#43). Idempotent: only touches rows where genre IS NULL. Runs in
// small batches with a short delay to stay well under OpenAI rate limits.
//
//   node scripts/backfill-genres.js [batchSize]
// ---------------------------------------------------------------------------
require("dotenv").config();
const pool = require("../db");
const { classifyGenre } = require("../services/genres");

const BATCH = Number(process.argv[2]) || 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let done = 0;
  try {
    for (;;) {
      const [rows] = await pool.query(
        `SELECT youtube_id, title FROM youtube_video_cache
          WHERE genre IS NULL OR genre = ''
          LIMIT ?`,
        [BATCH],
      );
      if (!rows.length) break;

      for (const row of rows) {
        const genre = await classifyGenre(row.title);
        await pool.query(
          `UPDATE youtube_video_cache SET genre = ? WHERE youtube_id = ?`,
          [genre, row.youtube_id],
        );
        done += 1;
        console.log(`  tagged ${row.youtube_id} -> ${genre} (${row.title})`);
        await sleep(150);
      }
    }
    console.log(`\n✅ Backfill complete. Tagged ${done} row(s).`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Backfill failed after", done, "rows:", err.message);
    process.exit(1);
  }
})();
