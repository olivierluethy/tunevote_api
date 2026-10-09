const express = require("express");
const ytdl = require("@distube/ytdl-core");
const pool = require("../db");
const { normalize } = require("../utils/helpers");
const { classifyGenre } = require("../services/genres");

const router = express.Router();

// Assign a genre to a freshly-cached video WITHOUT blocking the request.
// classifyGenre never throws (falls back to "Other"); a failed UPDATE is logged
// and ignored so genre tagging can never break search/caching. Powers the host
// genre selector (#39) and genre ranking (#43).
function tagGenreInBackground(youtubeId, title) {
  if (!youtubeId || !title) return;
  classifyGenre(title)
    .then((genre) =>
      pool.query(
        `UPDATE youtube_video_cache SET genre = ?
          WHERE youtube_id = ? AND (genre IS NULL OR genre = '')`,
        [genre, youtubeId],
      ),
    )
    .catch((err) => console.warn("genre tagging failed:", err.message));
}

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
      INSERT INTO youtube_video_cache (title_norm, title, youtube_id, thumbnail, public_id)
      VALUES (?, ?, ?, ?, UUID())
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        thumbnail = VALUES(thumbnail)
    `,
      [title_norm, title, youtube_id, thumbnail],
    );
    tagGenreInBackground(youtube_id, title);
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
       (youtube_id, title, thumbnail, title_norm, duration, public_id)
       VALUES (?, ?, ?, ?, ?, UUID())`,
      [
        id,
        title,
        thumbnail,
        normalize(title), // deine normalize-Funktion
        info.videoDetails.lengthSeconds || 0,
      ],
    );
    tagGenreInBackground(id, title);

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


// ===========================================================================
// GET /stream/:videoId — ad-free audio proxy (issue #75)
// ===========================================================================
//
// Streams ONLY the audio track of a YouTube video through the API so the
// frontend can play it in a plain <audio> element instead of the YouTube
// IFrame player. Because the bytes come straight from the audio format, there
// is no pre-/mid-roll advertising in the stream — playback in a TuneVote
// session stays continuous.
//
// Range-aware: honors the browser's `Range` header and replies 206 with a
// `Content-Range`, which is what makes <audio> seeking work. That is required
// for synchronized playback (the client seeks to the session's current
// position when it (re)joins a live song).
//
// NOTE (maintenance): this relies on @distube/ytdl-core resolving YouTube's
// audio formats. YouTube occasionally changes its player internals and can
// break ytdl until the library is updated — keep the dependency current.
const YT_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

router.get("/stream/:videoId", async (req, res) => {
  const { videoId } = req.params;
  if (!YT_VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: "Invalid video id" });
  }

  try {
    const info = await ytdl.getInfo(
      `https://www.youtube.com/watch?v=${videoId}`,
    );
    // Prefer itag 140 (m4a / AAC) — the one audio format every browser can play,
    // Safari included (which cannot decode WebM/Opus). Fall back to the best
    // available audio-only format if 140 isn't offered for this video.
    let format;
    try {
      format = ytdl.chooseFormat(info.formats, {
        quality: "140",
        filter: "audioonly",
      });
    } catch {
      /* itag 140 not available → fall through */
    }
    if (!format) {
      format = ytdl.chooseFormat(info.formats, {
        quality: "highestaudio",
        filter: "audioonly",
      });
    }
    if (!format) {
      return res.status(404).json({ error: "No audio stream available" });
    }

    const mime = (format.mimeType || "audio/webm").split(";")[0];
    const totalLength = format.contentLength
      ? parseInt(format.contentLength, 10)
      : null;

    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");

    const pipeStream = (ytdlOptions) => {
      const stream = ytdl.downloadFromInfo(info, ytdlOptions);
      stream.on("error", (err) => {
        console.warn(`[stream] ytdl error for ${videoId}:`, err.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      });
      // Stop pulling bytes if the listener navigates away / song changes.
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    };

    const rangeHeader = req.headers.range;
    if (rangeHeader && totalLength) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = match && match[1] ? parseInt(match[1], 10) : 0;
      let end = match && match[2] ? parseInt(match[2], 10) : totalLength - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= totalLength) end = totalLength - 1;
      if (start > end) {
        start = 0;
        end = totalLength - 1;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalLength}`);
      res.setHeader("Content-Length", end - start + 1);
      pipeStream({ format, range: { start, end } });
    } else {
      if (totalLength) res.setHeader("Content-Length", totalLength);
      pipeStream({ format });
    }
  } catch (err) {
    console.error(`[stream] failed for ${videoId}:`, err.message);
    if (!res.headersSent) res.status(502).json({ error: "Stream unavailable" });
  }
});

module.exports = router;
