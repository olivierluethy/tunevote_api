const express = require("express");
const ytdl = require("@distube/ytdl-core");
const pool = require("../db");
const { normalize } = require("../utils/helpers");

const router = express.Router();

router.get("/youtube-cache", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT title_norm, title, youtube_id AS youtubeId, thumbnail FROM youtube_video_cache",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Cache fetch failed" });
  }
});

router.post("/youtube-cache", async (req, res) => {
  const { title_norm, title, youtube_id, thumbnail } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO youtube_video_cache (title_norm, title, youtube_id, thumbnail)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        thumbnail = VALUES(thumbnail)
    `,
      [title_norm, title, youtube_id, thumbnail],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Cache save failed" });
  }
});

router.get("/youtube-info/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // 1. Erst prüfen, ob es bereits im Cache ist
    const [cached] = await pool.query(
      "SELECT * FROM youtube_video_cache WHERE youtube_id = ?",
      [id],
    );

    if (cached.length) {
      // Cache-Treffer → exakt dasselbe Format wie YouTube-API zurückgeben
      const row = cached[0];
      return res.json({
        id: { videoId: id },
        snippet: {
          title: row.title,
          description: "", // optional
          channelTitle: "", // optional
          thumbnails: {
            default: { url: row.thumbnail },
            medium: { url: row.thumbnail },
            high: { url: row.thumbnail },
          },
        },
      });
    }

    // 2. Nicht im Cache → mit ytdl holen
    const info = await ytdl.getBasicInfo(
      `https://www.youtube.com/watch?v=${id}`,
    );

    const thumbs = info.videoDetails.thumbnails || [];
    const getThumb = (size) => {
      const map = { default: 0, medium: 1, high: thumbs.length - 1 };
      return (
        thumbs[map[size]]?.url || `https://i.ytimg.com/vi/${id}/${size}.jpg`
      );
    };

    const title = info.videoDetails.title || "Unbekannter Titel";
    const thumbnail = getThumb("default"); // wir nutzen nur default im Cache

    // 3. **In Cache schreiben**
    await pool.query(
      `INSERT INTO youtube_video_cache 
       (youtube_id, title, thumbnail, title_norm, duration) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        title,
        thumbnail,
        normalize(title), // deine normalize-Funktion
        info.videoDetails.lengthSeconds || 0,
      ],
    );

    // 4. Antwort im YouTube-API-Format
    res.json({
      id: { videoId: id },
      snippet: {
        title,
        description: info.videoDetails.description || "",
        channelTitle: info.videoDetails.author?.name || "",
        thumbnails: {
          default: { url: thumbnail },
          medium: { url: getThumb("medium") },
          high: { url: getThumb("high") },
        },
      },
    });
  } catch (err) {
    console.error("YTDL error:", err);
    res.status(500).json({ error: "Failed to fetch video info" });
  }
});


module.exports = router;
