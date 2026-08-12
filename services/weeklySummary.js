// ---------------------------------------------------------------------------
// Weekly TuneVote session summary email (#25).
//
// buildUserSummary()  — aggregates a user's last-7-days activity.
// renderSummaryEmail() — renders it with the shared dark email layout.
// sendWeeklySummaries() — mails every user who was active in the last week.
// startWeeklySummaryScheduler() — fires sendWeeklySummaries once a week.
//
// The scheduler is OFF unless WEEKLY_SUMMARY_ENABLED=true, because it sends real
// mail to real users; the on-demand GET /session/summary endpoint always works.
// ---------------------------------------------------------------------------
const pool = require("../db");
const transporter = require("./mailer");
const { renderEmail, LOGO_ATTACHMENT, APP_URL } = require("./emailLayout");

// Aggregate one user's activity over the last 7 days. Pure-ish: only reads.
async function buildUserSummary(userId) {
  const [[listen]] = await pool.query(
    `SELECT
        COALESCE(SUM(listen_seconds), 0)      AS seconds,
        COUNT(*)                              AS songs,
        COUNT(DISTINCT session_id)            AS sessions
       FROM session_song_listens
      WHERE user_id = ? AND created_at >= (NOW() - INTERVAL 7 DAY)`,
    [userId],
  );

  const [[votes]] = await pool.query(
    `SELECT COUNT(*) AS votesGiven
       FROM votes
      WHERE user_id = ? AND created_at >= (NOW() - INTERVAL 7 DAY)`,
    [userId],
  );

  const [[wins]] = await pool.query(
    `SELECT COUNT(*) AS wins
       FROM voting_rounds vr
       JOIN queue_items qi ON vr.winner_queue_item_id = qi.id
      WHERE qi.added_by = ? AND vr.created_at >= (NOW() - INTERVAL 7 DAY)`,
    [userId],
  );

  const [genreRows] = await pool.query(
    `SELECT COALESCE(yvc.genre, 'Other') AS genre, COUNT(*) AS plays
       FROM session_song_listens ssl
       JOIN queue_items qi ON ssl.queue_item_id = qi.id
       JOIN youtube_video_cache yvc ON qi.video_id = yvc.youtube_id
      WHERE ssl.user_id = ? AND ssl.created_at >= (NOW() - INTERVAL 7 DAY)
      GROUP BY COALESCE(yvc.genre, 'Other')
      ORDER BY plays DESC
      LIMIT 1`,
    [userId],
  );

  return {
    minutes: Math.round(Number(listen.seconds) / 60),
    songs: Number(listen.songs),
    sessions: Number(listen.sessions),
    votesGiven: Number(votes.votesGiven),
    wins: Number(wins.wins),
    topGenre: genreRows[0]?.genre || null,
  };
}

// True when there's anything worth emailing about.
function hasActivity(s) {
  return s.minutes > 0 || s.songs > 0 || s.votesGiven > 0;
}

function renderSummaryEmail(user, s) {
  const row = (label, value) =>
    `<tr>
       <td style="padding:8px 0;color:#c7c3d4;font-size:15px;">${label}</td>
       <td style="padding:8px 0;color:#ffffff;font-size:15px;font-weight:700;text-align:right;">${value}</td>
     </tr>`;

  const rows = [
    row("Minutes listened", s.minutes),
    row("Songs heard", s.songs),
    row("Sessions joined", s.sessions),
    row("Votes given", s.votesGiven),
    row("Your suggestions that won", s.wins),
    s.topGenre ? row("Top genre", s.topGenre) : "",
  ].join("");

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${user.username || "there"}, here's your week on TuneVote:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="border-collapse:collapse;margin:8px 0 4px;">
      ${rows}
    </table>`;

  return renderEmail({
    title: "Your weekly TuneVote summary",
    heading: "Your week in music",
    bodyHtml,
    button: { label: "Open TuneVote", url: APP_URL },
    footerNote: "You're receiving this because you were active on TuneVote this week.",
  });
}

// Mail every user who was active in the last 7 days. Best-effort per user.
async function sendWeeklySummaries() {
  const [users] = await pool.query(
    `SELECT DISTINCT u.id, u.username, u.email
       FROM users u
       JOIN session_song_listens ssl ON ssl.user_id = u.id
      WHERE u.email IS NOT NULL AND u.email <> ''
        AND ssl.created_at >= (NOW() - INTERVAL 7 DAY)`,
  );

  let sent = 0;
  for (const user of users) {
    try {
      const summary = await buildUserSummary(user.id);
      if (!hasActivity(summary)) continue;
      await transporter.sendMail({
        to: user.email,
        subject: "Your weekly TuneVote summary 🎧",
        html: renderSummaryEmail(user, summary),
        attachments: [LOGO_ATTACHMENT],
      });
      sent += 1;
    } catch (err) {
      console.error(`[weekly-summary] failed for user ${user.id}:`, err.message);
    }
  }
  console.log(`[weekly-summary] sent ${sent}/${users.length} summaries`);
  return sent;
}

// Schedule sendWeeklySummaries() to run once a week (Mondays ~09:00 server time).
// No-op unless WEEKLY_SUMMARY_ENABLED=true.
function startWeeklySummaryScheduler() {
  if (process.env.WEEKLY_SUMMARY_ENABLED !== "true") {
    console.log("[weekly-summary] disabled (set WEEKLY_SUMMARY_ENABLED=true to enable)");
    return;
  }
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const msUntilNextRun = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    // Advance to the next Monday (getDay(): 0=Sun..1=Mon).
    const daysUntilMonday = (8 - now.getDay()) % 7 || 7;
    next.setDate(now.getDate() + daysUntilMonday);
    return next.getTime() - now.getTime();
  };

  const run = () =>
    sendWeeklySummaries().catch((e) =>
      console.error("[weekly-summary] run failed:", e.message),
    );

  setTimeout(() => {
    run();
    const interval = setInterval(run, WEEK_MS);
    if (interval.unref) interval.unref();
  }, msUntilNextRun());
  console.log("📧 Weekly summary scheduler armed");
}

module.exports = {
  buildUserSummary,
  renderSummaryEmail,
  sendWeeklySummaries,
  startWeeklySummaryScheduler,
};
