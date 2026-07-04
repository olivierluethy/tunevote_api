const express = require("express");
const axios = require("axios");
const ytdl = require("@distube/ytdl-core");
const pool = require("../db");
const { getIO } = require("../lib/io");
const {
  getUserFromToken,
  getGuestFromToken,
  ensureParticipant,
  hasActiveSubscription,
} = require("../services/auth");
const transporter = require("../services/mailer");
const { openai, safeParseOpenAI } = require("../services/openai");
const { broadcastTodayTopArtists } = require("../services/broadcast");
const {
  sessionTimers,
  startPhaseTimer,
  advanceToNext,
  broadcastLiveParticipants,
  createNewPublicSession,
} = require("../services/playback");
const { normalize, parseIsoDuration } = require("../utils/helpers");

const YOUTUBE_KEY = process.env.YOUTUBE_KEY;

const router = express.Router();

router.get("/sessions/:id/invites/accepted", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);

  // === 1. Token prüfen (genau wie in deinen anderen Routes) ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
  const guestToken = req.headers["x-guest-token"];

  let user = null;
  if (token) {
    user = await getUserFromToken(token);
  }
  // Gäste dürfen diese Route NICHT nutzen
  if (!user || guestToken) {
    return res
      .status(401)
      .json({
        error: "Nur eingeloggte User (keine Gäste) dürfen diese Route nutzen",
      });
  }

  try {
    // === 2. Session direkt per SQL holen + Berechtigung prüfen ===
    const [sessionRows] = await pool.query(
      `SELECT id, user_id, title, is_private
       FROM sessions
       WHERE id = ?
       LIMIT 1`,
      [sessionId],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Session nicht gefunden" });
    }

    const session = sessionRows[0];

    if (session.is_private !== 1) {
      return res.status(400).json({ message: "Session ist nicht privat" });
    }

    if (session.user_id !== user.id) {
      return res
        .status(403)
        .json({
          message: "Nur der Host darf die akzeptierten Einladungen sehen",
        });
    }

    // === 3. Akzeptierte Einladungen holen ===
    const [invites] = await pool.query(
      `SELECT 
          si.id,
          si.email AS invitee_email,
          u.imageType,
          u.imageData,
          si.invited_user_id,
          u.username AS invitee_name,
          si.accepted_at
       FROM session_invites si
       LEFT JOIN users u ON si.invited_user_id = u.id
       WHERE si.session_id = ?
         AND si.status = 'accepted'
       ORDER BY si.accepted_at DESC`,
      [sessionId],
    );

    // === 4. Perfektes Format für dein Frontend ===
    const formatted = invites.map((invite) => {
      let imageData = null;

      if (invite.imageData && invite.imageType) {
        imageData = `data:${invite.imageType};base64,${invite.imageData.toString("base64")}`;
      }

      return {
        id: invite.id,
        invitee_email: invite.invitee_email,
        invitee_name: invite.invitee_name || null,
        accepted_at: invite.accepted_at,
        imageData,
      };
    });

    return res.json(formatted);
  } catch (err) {
    console.error("Fehler in GET /sessions/:id/invites/accepted:", err);
    return res.status(500).json({ message: "Interner Serverfehler" });
  }
});


router.delete("/sessions/:id/invites/:inviteId", async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const inviteId = parseInt(req.params.inviteId);

  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [session] = await pool.query(
    "SELECT user_id FROM sessions WHERE id = ?",
    [sessionId],
  );
  if (!session || session[0].user_id !== user.id) {
    return res.status(403).json({ message: "Nur Host" });
  }

  await pool.query(
    "UPDATE session_invites SET status = 'revoked', revoked_at = NOW() WHERE id = ? AND session_id = ?",
    [inviteId, sessionId],
  );

  res.json({ success: true });
});

// === Proposals endpoint (POST) ===

router.post("/sessions/:sessionId/invite", async (req, res) => {
  const { sessionId } = req.params;
  const { email: rawEmail } = req.body;

  // === Authentifizierung ===
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  // === E-Mail Validierung & Normalisierung ===
  const email = rawEmail?.trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Ungültige E-Mail-Adresse" });
  }

  // Selbst-Einladung verhindern
  if (email === user.email) {
    return res
      .status(400)
      .json({ error: "Du kannst dich nicht selbst einladen." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // === 1. Session + Host-Validierung (inkl. host_email) ===
    const [[session]] = await conn.query(
      `SELECT s.title, s.user_id, s.is_private, u.username AS host_name, u.email AS host_email
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ?`,
      [sessionId],
    );

    if (!session) {
      await conn.rollback();
      return res.status(404).json({ error: "Session nicht gefunden" });
    }
    if (session.is_private === 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Nur private Sessions können Einladungen versenden" });
    }
    if (session.user_id !== user.id) {
      await conn.rollback();
      return res
        .status(403)
        .json({ error: "Nur der Host darf Einladungen verschicken" });
    }
    if (email === session.host_email?.toLowerCase()) {
      await conn.rollback();
      return res
        .status(400)
        .json({ error: "Der Session-Host kann nicht eingeladen werden." });
    }

    const sessionTitle =
      session.title?.trim() || "Eine private TuneVote Session";
    const hostName = session.host_name || "Der Host";

    // === 2. Prüfen, ob der Benutzer bereits registriert ist ===
    const [[existingUser]] = await conn.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email],
    );
    const invitedUserId = existingUser ? existingUser.id : null;
    const userExists = !!invitedUserId;

    // === 3. Existierende Einladung prüfen & ggf. reaktivieren/neu anlegen ===
    const [inviteRows] = await conn.query(
      `SELECT * FROM session_invites 
       WHERE session_id = ? AND LOWER(email) = LOWER(?) 
       LIMIT 1 FOR UPDATE`,
      [sessionId, email],
    );
    const existingInvite = inviteRows[0] || null;

    if (existingInvite) {
      if (
        existingInvite.status === "revoked" ||
        existingInvite.status === "rejected"
      ) {
        await conn.query(
          `UPDATE session_invites 
           SET status = 'pending',
               invited_user_id = ?,
               invited_by_user_id = ?,
               updated_at = NOW(),
               accepted_at = NULL,
               rejected_at = NULL,
               revoked_at = NULL
           WHERE id = ?`,
          [invitedUserId, user.id, existingInvite.id],
        );
      }
    } else {
      await conn.query(
        `INSERT INTO session_invites 
         (session_id, email, invited_by_user_id, invited_user_id, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [sessionId, email, user.id, invitedUserId],
      );
    }

    await conn.commit();

    // === 4. E-Mail-Inhalte je nach Registrierungsstatus unterscheiden ===
    const baseUrl = process.env.FRONTEND_URL || "https://app.tunevote.com/ ";
    const dashboardLink = `${baseUrl}/dashboard`;
    const primaryColor = "#4f46e5";

    // Zwei komplett unterschiedliche Templates – klar getrennt
    const htmlForExistingUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Neue Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du hast eine neue Einladung!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zur privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Da du bereits ein TuneVote-Konto hast, findest du die Einladung direkt in deinem Dashboard.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Einladung im Dashboard ansehen
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
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

    const htmlForNewUser = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Einladung zu "${sessionTitle}"</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600;">TuneVote</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;color:#1f2937;">
              <h2 style="margin-top:0;font-size:22px;color:#111827;">Du wurdest zu einer Session eingeladen!</h2>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Hallo!<br><br>
                <strong>${hostName}</strong> hat dich zu einer privaten TuneVote-Session eingeladen:
              </p>
              <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:24px 0;">
                <h3 style="margin:0;font-size:18px;color:#111827;">${sessionTitle}</h3>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;">
                Erstelle jetzt kostenlos ein Konto, um der Session beizutreten und mit abzustimmen!
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${dashboardLink}" style="display:inline-block;background:${primaryColor};color:#ffffff;font-weight:600;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none;">
                  Registrieren & Session beitreten
                </a>
              </div>
              <p style="font-size:14px;color:#6b7280;text-align:center;margin-top:32px;">
                Oder direkt hier klicken:<br>
                <a href="${dashboardLink}" style="color:${primaryColor};">${dashboardLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:30px;background:#f3f4f6;text-align:center;color:#9ca3af;font-size:13px;">
              <p style="margin:0;">
                Diese Einladung wurde über <strong>TuneVote</strong> versendet.<br>
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

    const subject = userExists
      ? `Neue Einladung: ${sessionTitle}`
      : `${hostName} hat dich zu "${sessionTitle}" eingeladen`;

    const html = userExists ? htmlForExistingUser : htmlForNewUser;

    // === 5. E-Mail versenden ===
    try {
      await transporter.sendMail({
        from: `"TuneVote" <${process.env.GMAIL_USER}>`,
        to: email,
        subject,
        text: userExists
          ? `Du hast eine neue Einladung zu "${sessionTitle}". Öffne dein Dashboard: ${dashboardLink}`
          : `Du wurdest zu "${sessionTitle}" eingeladen! Erstelle ein Konto: ${dashboardLink}`,
        html,
      });
    } catch (mailErr) {
      console.error("E-Mail-Versand fehlgeschlagen:", mailErr);
      return res.status(500).json({
        success: true,
        message:
          "Einladung gespeichert, aber E-Mail konnte nicht gesendet werden.",
        emailError: true,
        alreadyRegistered: userExists,
      });
    }

    return res.json({
      success: true,
      message: "Einladung erfolgreich versendet",
      alreadyRegistered: userExists,
    });
  } catch (err) {
    console.error("Invite error:", err);
    if (conn) await conn.rollback().catch(() => {});
    return res
      .status(500)
      .json({ error: "Fehler beim Versenden der Einladung" });
  } finally {
    if (conn) conn.release();
  }
});

// GET: Einladungen, die du verschickt hast (nur offene)

router.get("/invites/sent", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;

  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
      si.id,
      si.email,

      -- Dynamischer Status
      si.status,
      si.created_at,
      si.accepted_at,
      si.rejected_at,
      si.revoked_at,
      si.updated_at,
      s.title AS session_title
      FROM session_invites si
      JOIN sessions s ON si.session_id = s.id
      WHERE si.invited_by_user_id = ? AND si.status = 'pending'
      ORDER BY si.created_at DESC
  `,
    [user.id],
  );

  res.json(invites);
});

// GET: Einladungen, die du erhalten hast (nur unbearbeitet / pending)

router.get("/invites/received", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [invites] = await pool.query(
    `SELECT 
       si.id, si.email, si.created_at, si.accepted_at, si.rejected_at, si.revoked_at,
       si.status,
       s.title AS session_title, 
       u.username AS host_name
     FROM session_invites si
     JOIN sessions s ON si.session_id = s.id
     JOIN users u ON s.user_id = u.id
     WHERE (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       AND si.status = 'pending'
     ORDER BY si.created_at DESC`,
    [user.email, user.id],
  );

  res.json(invites);
});

// POST: Einladung annehmen + Socket.IO Event an Host schicken

router.post("/invites/:inviteId/accept", async (req, res) => {
  const inviteId = parseInt(req.params.inviteId, 10);
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Invite mit Session-Info und aktuellem Status holen + sperren
    const [invites] = await connection.query(
      `SELECT si.*, s.user_id AS host_id 
       FROM session_invites si
       JOIN sessions s ON si.session_id = s.id
       WHERE si.id = ? 
         AND si.status = 'pending'
         AND (LOWER(si.email) = LOWER(?) OR si.invited_user_id = ?)
       FOR UPDATE`,
      [inviteId, user.email, user.id],
    );

    if (invites.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        error:
          "Einladung nicht gefunden, bereits bearbeitet oder nicht für dich",
      });
    }

    const invite = invites[0];

    // 2. Einladung als akzeptiert markieren
    await connection.query(
      `UPDATE session_invites 
       SET status = 'accepted',
           accepted_at = NOW(),
           invited_user_id = COALESCE(invited_user_id, ?),
           updated_at = NOW()
       WHERE id = ?`,
      [user.id, inviteId],
    );

    await connection.commit();

    // 3. Fertiges Objekt für Frontend + Socket.IO bauen
    const formattedInvite = {
      id: invite.id,
      invitee_email: invite.email,
      invitee_name: user.username || null, // wichtig!
      accepted_at: new Date().toISOString(),
    };

    // 4. Socket.IO Event nur an den Host der Session schicken
    getIO().to(`session-host-${invite.session_id}`).emit(
      "invite:accepted",
      formattedInvite,
    );

    // Optional: auch global an alle im Session-Raum (falls Co-Hosts etc.)
    // getIO().to(`session-${invite.session_id}`).emit("invite:accepted", formattedInvite);

    // 5. Erfolgreiche Antwort ans Frontend (kann der Client ignorieren, weil er ja eh updatet)
    return res.json({ success: true, invite: formattedInvite });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("Fehler beim Akzeptieren der Einladung:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  } finally {
    if (connection) connection.release();
  }
});


router.post("/invites/:inviteId/reject", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'rejected',
         rejected_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND status = 'pending'
       AND (LOWER(email) = LOWER(?) OR invited_user_id = ?)`,
    [inviteId, user.email, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder bereits verarbeitet",
    });
  }

  res.json({ success: true });
});

// POST: Einladung ablehnen

router.post("/invites/:inviteId/revoke", async (req, res) => {
  const { inviteId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = token ? await getUserFromToken(token) : null;
  if (!user) return res.status(401).json({ error: "Unauthenticated" });

  const [result] = await pool.query(
    `UPDATE session_invites
     SET status = 'revoked',
         revoked_at = NOW(),
         updated_at = NOW()
     WHERE id = ?
       AND invited_by_user_id = ?
       AND status = 'pending'`,
    [inviteId, user.id],
  );

  if (result.affectedRows === 0) {
    return res.status(400).json({
      error: "Einladung nicht gefunden oder nicht mehr widerrufbar",
    });
  }

  res.json({ success: true });
});

// ============================================================
// GET /sessions/:sessionId/participants → Nur live Teilnehmer (is_live = 1)
// + Echtzeit-Updates über Socket.IO
// ============================================================


router.get("/sessions/:sessionId/participants", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId, 10);

  if (isNaN(sessionId)) {
    return res.status(400).json({ error: "Ungültige Session-ID" });
  }

  const token = req.headers.authorization?.split(" ")[1];
  const guestToken = req.headers["x-guest-token"];

  const user = token ? await getUserFromToken(token) : null;
  const guest = guestToken ? await getGuestFromToken(guestToken) : null;

  if (!user && !guest) {
    return res.status(401).json({ error: "Unauthenticated" });
  }

  try {
    // Prüfen, ob der Aufrufer überhaupt zur Session gehört (Sicherheit)
    const column = user ? "user_id" : "guest_id";
    const id = user ? user.id : guest.id;

    const [allowed] = await pool.query(
      `SELECT 1 FROM session_participants 
       WHERE session_id = ? AND ${column} = ?`,
      [sessionId, id],
    );

    if (allowed.length === 0) {
      return res
        .status(403)
        .json({ error: "Du bist nicht Teil dieser Session" });
    }

    // Alle LIVE Teilnehmer holen
    const [participants] = await pool.query(
      `SELECT 
         sp.id,
         sp.role,
         COALESCE(u.username, g.nickname, 'Gast') AS name,
         (sp.role = 'host') AS isHost,
        u.imageType,
        u.imageData
       FROM session_participants sp
       LEFT JOIN users u ON sp.user_id = u.id
       LEFT JOIN guest_users g ON sp.guest_id = g.id
       WHERE sp.session_id = ? AND sp.is_live = 1
       ORDER BY sp.joined_at DESC`,
      [sessionId],
    );

    const formatted = participants.map((p) => {
      let profileImage = null;

      if (p.imageType && p.imageData) {
        profileImage = `data:${p.imageType};base64,${p.imageData.toString("base64")}`;
      }

      return {
        name: p.name,
        isHost: !!p.isHost,
        profileImage,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error("Fehler beim Laden der Live-Teilnehmer:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});



module.exports = router;
