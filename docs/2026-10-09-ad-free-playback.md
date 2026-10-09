# TuneVote — Ad-Free Media Playback (2026-10-09)

**Issue:** #75 — *Ad-Free Media Playback Experience in TuneVote*
**Scope:** both repos — `tunevote_api` (backend) and `tunevote_frontend` (frontend).
**Status:** Implemented. Not yet runtime-verified (manual testing pending by the owner).

---

## 1. TL;DR

TuneVote sessions used to play each voted song through the **YouTube IFrame
player** in the browser. That player serves YouTube's own pre-/mid-roll
**advertising**, which interrupts a collaborative listening session.

This change moves playback **off the IFrame player**. The backend now exposes an
audio-only stream endpoint, and the frontend plays each song through a plain
`<audio>` element pointed at that endpoint. Because only the audio track is
delivered, there is **no in-stream advertising** during a session.

Everything else about playback — synchronized position across participants,
voting, the queue, mute/volume, play/pause, background/lock-screen playback — is
preserved unchanged.

## 2. How playback worked before

- **Search / resolution (backend):** `routes/proposals.js`, `services/recommendations.js`
  and `routes/sessions.js` resolve a song title to a YouTube **video id** via the
  YouTube Data API v3, cache it in `youtube_video_cache`, and enqueue it.
- **Playback (frontend):** `src/context/PlaybackContext.jsx` owned a single hidden
  `YT.Player` (IFrame API). The server broadcast `playback_sync` events; the client
  seeked the IFrame to the live position. The IFrame is where YouTube injected ads.
- `ytdl-core` was used only for **metadata** (`getBasicInfo`) — never for playback.

So the single advertising source in the listening experience was the YouTube
IFrame player on the client. TuneVote itself injects **no** ad scripts, ad SDKs,
tracking pixels or cross-site ad trackers into the playback path (verified by
grep across both repos). Google Analytics exists in the frontend but is the
owner's **intentional first-party product analytics**, is unrelated to playback,
and was deliberately left untouched.

## 3. What changed

### Backend — `routes/youtube.js`

New endpoint:

```
GET /stream/:videoId
```

- Validates the 11-char YouTube id.
- `ytdl.getInfo()` → `ytdl.chooseFormat()` picks an **audio-only** format,
  preferring **itag 140 (m4a / AAC)** for universal browser support (Safari cannot
  decode WebM/Opus), falling back to `highestaudio`.
- **Range-aware:** honors the browser `Range` header and replies `206` with a
  `Content-Range`. This is what makes `<audio>` **seeking** work, which the
  synchronized-playback logic depends on (a client seeks to the session's current
  position when it joins / resyncs).
- Streams straight from the audio format → no advertising in the bytes.

### Frontend — `src/context/PlaybackContext.jsx`

- Removed the YouTube IFrame API loader.
- `createPlayer()` now builds an **`<audio>`-backed adapter** whose method surface
  is identical to the YT player the rest of the provider calls
  (`playVideo` / `pauseVideo` / `stopVideo` / `destroy` / `mute` / `unMute` /
  `setVolume` / `seekTo` / `getCurrentTime` / `getDuration` / `getPlayerState` /
  `getVideoData`). The adapter is fed `${API}/stream/${videoId}`.
- Because the adapter keeps the same contract, **all sync, drift-correction,
  mute/volume, play/pause, Media Session and wake-lock logic is unchanged.**
- Side benefit: an audio-only stream has **no ad time**, so it no longer drifts
  against the server's duration-based clock — session sync is actually tighter.

## 4. Preserved behavior

Voting, the next-song queue, suggestions, synchronized playback, public/private
sessions, host controls, mute-per-session, background playback (Media Session +
wake lock) and the mini-player progress bar all go through the same code paths as
before — only the underlying media element changed.

## 5. Provider reality & maintenance notes

- **This is the only mechanism that actually removes the ads.** YouTube offers no
  supported parameter, SDK or API to disable ads in the embedded IFrame player;
  the only provider-sanctioned ad-free path there is YouTube Premium, tied to the
  viewer's own account and not applicable server-side. Serving the audio track
  directly is outside YouTube's intended embed/API usage and its Terms of Service.
  TuneVote is a **private, pre-launch project**; this is an accepted trade-off for
  that context. **Before any public launch, revisit this** (ToS / licensing
  exposure, and whether a properly licensed source is warranted).
- **`ytdl` is brittle.** When YouTube changes its player internals the stream can
  break until `@distube/ytdl-core` is updated. Keep the dependency current. If a
  stream fails, the endpoint returns `502` and the next server sync retries with a
  fresh player.
- **Bandwidth** now flows through the API (every song is proxied). Fine at current
  scale; worth watching if usage grows.
- **Format compatibility:** itag 140 (AAC) covers all mainstream browsers. The
  `highestaudio` fallback may yield WebM/Opus, which Safari cannot play — rare, but
  possible for videos that don't offer itag 140.
