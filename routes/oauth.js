const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

// ─── Google Login URL generieren ───
router.get('/auth/google', (req, res) => {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.GOOGLE_CALLBACK_URL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

// ─── Google Callback ───
router.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("https://app.tunevote.com/login?error=no_code");
  }

  try {
    // 1. Code gegen Tokens tauschen
    const { data } = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      },
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token } = data;

    // 2. User-Info holen
    const { data: userInfo } = await axios.get(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    const { sub: googleId, email, name, picture } = userInfo;
    const newUsername = name || email.split("@")[0];
    const newImageUrl = picture || null;

    // 3. User in DB suchen (Zweistufige Suche zur Verknüpfung)
    let [rows] = await pool.query("SELECT * FROM users WHERE google_id = ?", [googleId]);
    let user = rows[0];

    if (!user && email) {
      // Falls Google-ID unbekannt: Suche nach E-Mail (z.B. von Facebook-Account)
      let [emailRows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
      user = emailRows[0];

      if (user) {
        // Verknüpfung: Google-ID beim bestehenden User nachtragen
        await pool.query("UPDATE users SET google_id = ? WHERE id = ?", [googleId, user.id]);
        user.google_id = googleId;
      }
    }

    if (!user) {
      // ─── Neuer User ───
      const [result] = await pool.query(
        "INSERT INTO users (google_id, email, username, imageUrl, public_id) VALUES (?, ?, ?, ?, UUID())",
        [googleId, email, newUsername, newImageUrl]
      );

      user = {
        id: result.insertId,
        google_id: googleId,
        email,
        username: newUsername,
        imageUrl: newImageUrl,
      };
    } else {
      // ─── Bestehender User → Daten bei Bedarf aktualisieren ───
      // COALESCE sorgt dafür, dass ein vorhandenes Bild nicht durch NULL überschrieben wird
      const shouldUpdate = 
        user.username !== newUsername || 
        (user.imageUrl === null && newImageUrl !== null);

      if (shouldUpdate) {
        await pool.query(
          "UPDATE users SET username = ?, imageUrl = COALESCE(imageUrl, ?) WHERE id = ?",
          [newUsername, newImageUrl, user.id]
        );
        user.username = newUsername;
        user.imageUrl = user.imageUrl || newImageUrl;
      }
    }

    // 4. JWT erstellen
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 5. Redirect zum Frontend
    const redirectUrl = `https://app.tunevote.com/google-callback?token=${token}&username=${encodeURIComponent(
      user.username
    )}&userId=${user.id}`;

    res.redirect(redirectUrl);
  } catch (err) {
    console.error("Google Callback Fehler:", err.response?.data || err.message);
    res.redirect("https://app.tunevote.com/login?error=google_auth_failed");
  }
});

// ─── Facebook Login URL generieren ───
router.get('/auth/facebook', (req, res) => {
  const rootUrl = 'https://www.facebook.com/v18.0/dialog/oauth';
  const options = {
    client_id: process.env.FACEBOOK_CLIENT_ID,
    redirect_uri: process.env.FACEBOOK_CALLBACK_URL,
    scope: ['email', 'public_profile'].join(','),
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

// ─── Facebook Callback ───
router.get("/auth/facebook/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect("https://app.tunevote.com/login?error=no_code");
  }

  try {
    // 1. Code gegen Access Token tauschen
    const tokenResponse = await axios.get(
      "https://graph.facebook.com/v18.0/oauth/access_token",
      {
        params: {
          client_id: process.env.FACEBOOK_CLIENT_ID,
          client_secret: process.env.FACEBOOK_CLIENT_SECRET,
          redirect_uri: process.env.FACEBOOK_CALLBACK_URL,
          code,
        },
      }
    );

    const { access_token } = tokenResponse.data;

    // 2. User-Info holen
    const userInfoResponse = await axios.get(
      "https://graph.facebook.com/me",
      {
        params: {
          fields: "id,name,email,picture",
          access_token,
        },
      }
    );

    const { id: facebookId, name, email, picture } = userInfoResponse.data;
    const newUsername = name || (email ? email.split("@")[0] : `user_${facebookId}`);
    const newImageUrl = picture?.data?.url || null;

    // 3. Strategische Suche in der DB
    // Zuerst prüfen: Gibt es jemanden mit dieser Facebook-ID?
    let [rows] = await pool.query("SELECT * FROM users WHERE facebook_id = ?", [facebookId]);
    let user = rows[0];

    if (!user && email) {
      // Wenn nicht: Gibt es jemanden mit dieser E-Mail (z.B. via Google registriert)?
      let [emailRows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
      user = emailRows[0];
      
      if (user) {
        // Verknüpfung: Facebook-ID beim bestehenden User nachtragen
        await pool.query("UPDATE users SET facebook_id = ? WHERE id = ?", [facebookId, user.id]);
        user.facebook_id = facebookId;
      }
    }

    if (!user) {
      // ─── Neuer User (weder Facebook-ID noch E-Mail bekannt) ───
      const [result] = await pool.query(
        "INSERT INTO users (facebook_id, email, username, imageUrl, public_id) VALUES (?, ?, ?, ?, UUID())",
        [facebookId, email, newUsername, newImageUrl]
      );

      user = {
        id: result.insertId,
        facebook_id: facebookId,
        email,
        username: newUsername,
        imageUrl: newImageUrl,
      };
    } else {
      // ─── Bestehender User → Daten bei Bedarf aktualisieren ───
      // Wir aktualisieren das Bild nur, wenn der User noch kein lokales Bild hat
      const shouldUpdate = user.username !== newUsername || (user.imageUrl === null && newImageUrl !== null);

      if (shouldUpdate) {
        await pool.query(
          "UPDATE users SET username = ?, imageUrl = COALESCE(imageUrl, ?) WHERE id = ?",
          [newUsername, newImageUrl, user.id]
        );
        user.username = newUsername;
        user.imageUrl = user.imageUrl || newImageUrl;
      }
    }

    // 4. JWT erstellen
    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // 5. Redirect zum Frontend
    const redirectUrl = `https://app.tunevote.com/facebook-callback?token=${token}&username=${encodeURIComponent(
      user.username
    )}&userId=${user.id}`;

    res.redirect(redirectUrl);

  } catch (err) {
    console.error("Facebook Callback Fehler:", err.response?.data || err.message);
    res.redirect("https://app.tunevote.com/login?error=facebook_auth_failed");
  }
});
module.exports = router;
