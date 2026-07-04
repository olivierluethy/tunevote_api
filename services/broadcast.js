const pool = require("../db");
const { getIO } = require("../lib/io");

// Debounced live-charts broadcast: at most one "today top artists" emit every
// ~1.5s, so a burst of votes collapses into a single socket event.
let topArtistsBroadcastTimeout = null;

async function broadcastTodayTopArtists() {
  if (topArtistsBroadcastTimeout) {
    clearTimeout(topArtistsBroadcastTimeout);
  }

  topArtistsBroadcastTimeout = setTimeout(async () => {
    try {
      const [rows] = await pool.query(`
        SELECT
          a.id AS artist_id,
          a.name AS artist_name,
          a.image_url,
          COUNT(v.id) AS vote_count
        FROM votes v
        JOIN queue_items qi ON qi.id = v.queue_item_id
        JOIN youtube_video_cache yvc ON yvc.youtube_id = qi.video_id
        JOIN artists a ON a.id = yvc.artist_id
        WHERE DATE(v.created_at) = CURDATE()
          AND qi.status IN ('queued', 'playing', 'played')
        GROUP BY a.id, a.name, a.image_url
        ORDER BY vote_count DESC
        LIMIT 10
      `);

      // Always send (even an empty list) so the frontend can clear its view.
      getIO().emit("today_top_artists_updated", {
        date: new Date().toISOString().slice(0, 10),
        artists: rows,
      });
      console.log(
        "[Live Charts] Top Artists broadcasted →",
        rows.length,
        "artists",
      );
    } catch (err) {
      console.error("Error broadcasting today top artists:", err);
    } finally {
      topArtistsBroadcastTimeout = null;
    }
  }, 1500); // wait 1.5s → coalesce multiple changes
}

module.exports = { broadcastTodayTopArtists };
