const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const transporter = require("../services/mailer");
const { hashPassword } = require("../utils/helpers");

const router = express.Router();

router.post("/forgot-password", async (req, res) => {
  const { email: rawEmail } = req.body;
  const email = rawEmail?.trim().toLowerCase();

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res
      .status(400)
      .json({ error: "Gültige E-Mail-Adresse erforderlich" });
  }

  try {
    const [[user]] = await pool.query(
      "SELECT id, username FROM users WHERE LOWER(email) = LOWER(?)",
      [email],
    );

    // Wichtig: Kein Hinweis, ob die E-Mail existiert oder nicht (Sicherheit gegen Enumeration)
    if (!user) {
      // Wir geben trotzdem Erfolg zurück – so kann niemand prüfen, welche E-Mails registriert sind
      return res.json({
        message:
          "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
      });
    }

    // Token generieren (empfohlen: crypto.randomBytes(32).toString('hex'))
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 Stunde gültig

    await pool.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expiry = ? 
       WHERE id = ?`,
      [resetToken, expiry, user.id],
    );

    // Korrekter Reset-Link
    const baseUrl = process.env.FRONTEND_URL || "https://app.tunevote.com/ ";
    const resetLink = `${baseUrl}/reset-password/${resetToken}`;

    const primaryColor = "#4f46e5";

    const htmlTemplate = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Passwort zurücksetzen – TuneVote</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <!-- Header -->
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">
                Passwort zurücksetzen angefordert
              </h2>

              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo${user.username ? ` ${user.username}` : ""}!<br><br>
                Wir haben eine Anfrage erhalten, das Passwort für dein TuneVote-Konto zurückzusetzen.
              </p>

              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Falls du diese Anfrage <strong>nicht</strong> gestellt hast, kannst du diese E-Mail einfach ignorieren – dein Passwort bleibt unverändert.
              </p>

              <div style="background:#fef3c7;padding:16px;border-radius:8px;border-left:4px solid #f59e0b;margin:24px 0;">
                <p style="margin:0;font-size:15px;color:#92400e;">
                  <strong>Hinweis:</strong> Dieser Link läuft in <strong>1 Stunde</strong> ab.
                </p>
              </div>

              <!-- CTA Button -->
              <div style="text-align:center;margin:36px 0;">
                <a href="${resetLink}"
                   style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:16px 36px;border-radius:8px;text-decoration:none;box-shadow:0 4px 12px rgba(79,70,229,0.3);">
                  Neues Passwort festlegen
                </a>
              </div>

              <p style="font-size:14px;color:#6b7280;text-align:center;margin-top:32px;">
                Oder kopiere diesen Link in deinen Browser:<br>
                <a href="${resetLink}" style="color:${primaryColor};word-break:break-all;">${resetLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese E-Mail wurde gesendet, weil jemand das Zurücksetzen des Passworts für<br>
                <strong>${email}</strong> angefordert hat.<br><br>
                 TuneVote • Deine Musik. Deine Stimme.<br>
                © ${new Date().getFullYear()} TuneVote – Alle Rechte vorbehalten.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    // E-Mail versenden
    try {
      await transporter.sendMail({
        to: email,
        subject: "🔑 Passwort zurücksetzen – TuneVote",
        text: `Klicke hier, um dein Passwort zurückzusetzen (gültig für 1 Stunde): ${resetLink}\n\nFalls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.`,
        html: htmlTemplate,
      });
    } catch (mailErr) {
      console.error(
        "Passwort-Reset-Mail konnte nicht gesendet werden:",
        mailErr,
      );
      // Auch bei Mail-Fehler geben wir Erfolg zurück (aus Sicherheitsgründen kein Unterschied!)
      return res.json({
        message:
          "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
      });
    }

    return res.json({
      message:
        "Falls die E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.",
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
});

// GET /reset-password/:token
router.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  if (!token || token.length < 20) {
    return res.status(400).send(`
      <h2>Ungültiger Link</h2>
      <p>Dieser Passwort-Reset-Link ist ungültig oder wurde bereits verwendet.</p>
      <a href="/forgot-password">Neuen Link anfordern</a>
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
        <html lang="de">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Link abgelaufen – TuneVote</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; max-width: 420px; }
            h1 { color: #dc2626; }
            a { color: #4f46e5; text-decoration: none; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Link abgelaufen oder ungültig</h1>
            <p>Der Link zum Zurücksetzen deines Passworts ist nicht mehr gültig.</p>
            <p><a href="${process.env.FRONTEND_URL || ""}/forgot-password">Neuen Link anfordern</a></p>
          </div>
        </body>
        </html>
      `);
    }

    // Token ist gültig → React-Seite rendern
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Passwort zurücksetzen – TuneVote</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; }
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
    res.status(500).send("Interner Serverfehler");
  }
});

// POST /api/reset-password
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword || newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: "Ungültiges Passwort oder Token fehlt" });
  }

  try {
    const [[user]] = await pool.query(
      `SELECT id FROM users 
       WHERE reset_token = ? AND reset_token_expiry > NOW()`,
      [token],
    );

    if (!user) {
      return res.status(400).json({ error: "Token ungültig oder abgelaufen" });
    }

    const password_hash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users 
       SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL 
       WHERE id = ?`,
      [password_hash, user.id],
    );

    res.json({ message: "Passwort erfolgreich geändert!" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});


module.exports = router;
