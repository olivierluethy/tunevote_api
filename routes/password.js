const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const transporter = require("../services/mailer");
const { renderEmail, LOGO_ATTACHMENT } = require("../services/emailLayout");
const { hashPassword } = require("../utils/helpers");

const router = express.Router();

// Public base URL of the web app. Trailing slashes/whitespace are trimmed so
// the reset link is always well-formed (no "https://app.tunevote.com/ /..." bug).
const APP_URL = (process.env.APP_URL || "https://app.tunevote.com")
  .trim()
  .replace(/\/+$/, "");

// Same generic reply whether the email is unknown, OAuth-only, or a real local
// account — never reveal which, to stay safe against account enumeration.
const GENERIC_RESET_MESSAGE =
  "If an account with that email address exists, we've sent a password reset link.";

router.post("/forgot-password", async (req, res) => {
  const { email: rawEmail } = req.body;
  const email = rawEmail?.trim().toLowerCase();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  try {
    const [[user]] = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE LOWER(email) = LOWER(?)",
      [email],
    );

    // Send nothing (but reply the same) when the account doesn't exist OR is
    // OAuth-only (Google/Facebook, no local password_hash) — those users have
    // no password to reset.
    if (!user || !user.password_hash) {
      return res.json({ message: GENERIC_RESET_MESSAGE });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // valid for 1 hour

    await pool.query(
      `UPDATE users
       SET reset_token = ?, reset_token_expiry = ?
       WHERE id = ?`,
      [resetToken, expiry, user.id],
    );

    const resetLink = `${APP_URL}/reset-password/${resetToken}`;

    const html = renderEmail({
      title: "Reset your TuneVote password",
      heading: "Reset your password",
      bodyHtml: `
        <p style="margin:0 0 16px;">Hi${user.username ? ` ${user.username}` : ""},</p>
        <p style="margin:0 0 16px;">We received a request to reset the password for your TuneVote account. Click the button below to choose a new one.</p>
        <p style="margin:0;">If you didn't request this, you can safely ignore this email — your password stays the same.</p>`,
      button: { label: "Set a new password", url: resetLink },
      footerNote: `This link expires in 1 hour. If the button doesn't work, copy and paste this URL into your browser:<br /><a href="${resetLink}" style="color:#a78bfa;word-break:break-all;">${resetLink}</a>`,
    });

    const text = `Hi${user.username ? ` ${user.username}` : ""},

We received a request to reset the password for your TuneVote account.
Open this link to set a new password (valid for 1 hour):

${resetLink}

If you didn't request this, you can safely ignore this email.

— TuneVote`;

    try {
      await transporter.sendMail({
        to: email,
        subject: "Reset your TuneVote password",
        text,
        html,
        attachments: [LOGO_ATTACHMENT],
      });
    } catch (mailErr) {
      console.error("Password reset email could not be sent:", mailErr);
      // Same generic reply even on mail failure — no observable difference.
      return res.json({ message: GENERIC_RESET_MESSAGE });
    }

    return res.json({ message: GENERIC_RESET_MESSAGE });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reset-password/:token — server-rendered bootstrap for the reset page.
router.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  if (!token || token.length < 20) {
    return res.status(400).send(`
      <h2>Invalid link</h2>
      <p>This password reset link is invalid or has already been used.</p>
      <a href="${APP_URL}/forgot-password">Request a new link</a>
    `);
  }

  try {
    const [[user]] = await pool.query(
      `SELECT id, reset_token_expiry
       FROM users
       WHERE reset_token = ? AND reset_token_expiry > NOW()`,
      [token],
    );

    if (!user) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Link expired – TuneVote</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070312; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #120a24; padding: 40px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); text-align: center; max-width: 420px; }
            h1 { color: #f87171; }
            a { color: #a78bfa; text-decoration: none; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Link expired or invalid</h1>
            <p>The link to reset your password is no longer valid.</p>
            <p><a href="${APP_URL}/forgot-password">Request a new link</a></p>
          </div>
        </body>
        </html>
      `);
    }

    // Token is valid → render the React reset page.
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Reset your password – TuneVote</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #070312; }
    #root { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.RESET_TOKEN = "${token}";
  </script>
  <script type="module" src="/src/pages/ResetPassword.jsx"></script>
</body>
</html>
    `);
  } catch (err) {
    console.error("Reset page error:", err);
    res.status(500).send("Internal server error");
  }
});

// POST /api/reset-password
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Invalid password or missing token" });
  }

  try {
    const [[user]] = await pool.query(
      `SELECT id, password_hash FROM users
       WHERE reset_token = ? AND reset_token_expiry > NOW()`,
      [token],
    );

    if (!user) {
      return res.status(400).json({ error: "Token is invalid or has expired" });
    }

    // Defence in depth: OAuth-only accounts (no local password) never receive a
    // reset token, but reject gracefully if one ever targets such an account
    // rather than setting a password on it.
    if (!user.password_hash) {
      return res.status(400).json({
        error: "This account uses social login and has no password to reset",
      });
    }

    const password_hash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users
       SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL
       WHERE id = ?`,
      [password_hash, user.id],
    );

    res.json({ message: "Password changed successfully!" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
