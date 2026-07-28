const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db");

const router = express.Router();

router.post("/register", async (req, res) => {
  // Wir erwarten jetzt nur noch email und password vom Frontend
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: "Bitte fülle alle Felder aus." });
  }

  try {
    // 1. Prüfen, ob die E-Mail bereits existiert
    const [emailRows] = await pool.query(
      "SELECT id, google_id, facebook_id, email, username, password_hash FROM users WHERE LOWER(email) = LOWER(?)",
      [email]
    );

    if (emailRows.length > 0) {
      const existingUser = emailRows[0];

      // FALL: E-Mail existiert bereits als Social-Login -> Weiterleitung
      if (!existingUser.password_hash) {
        if (existingUser.google_id) {
          return res.status(200).json({ 
            success: false,
            redirect: "google",
            message: "Konto existiert bereits via Google. Leite weiter..." 
          });
        }
        if (existingUser.facebook_id) {
          return res.status(200).json({ 
            success: false,
            redirect: "facebook",
            message: "Konto existiert bereits via Facebook. Leite weiter..." 
          });
        }
      }
      
      // FALL: E-Mail existiert bereits als normaler Account
      return res.status(409).json({ error: "Diese E-Mail-Adresse wird bereits verwendet." });
    }

    // 2. Benutzernamen automatisch generieren (Teil vor dem @)
    let baseUsername = email.split('@')[0];
    
    // Sicherstellen, dass der Username eindeutig ist
    let finalUsername = baseUsername;
    const [userRows] = await pool.query("SELECT id FROM users WHERE username = ?", [finalUsername]);
    
    if (userRows.length > 0) {
      // Wenn der Name vergeben ist, hängen wir eine kurze Zufallszahl an
      finalUsername = `${baseUsername}_${Math.floor(100 + Math.random() * 899)}`;
    }

    // 3. Neuer Benutzer anlegen
    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash, public_id) VALUES (?, ?, ?, UUID())",
      [finalUsername, email, password_hash]
    );

    const newUserId = result.insertId;

    // 4. Invites verknüpfen
    await pool.query(
      `UPDATE session_invites SET invited_user_id = ? WHERE invited_user_id IS NULL AND LOWER(email) = LOWER(?)`,
      [newUserId, email]
    );

    // 5. JWT erstellen (mit dem neuen finalUsername)
    const token = jwt.sign(
      { id: newUserId, username: finalUsername }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Registrierung erfolgreich!",
      token,
      username: finalUsername,
      userId: newUserId
    });

  } catch (err) {
    console.error("Registrierungs-Fehler:", err);
    res.status(500).json({ error: "Server-Fehler bei der Registrierung." });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Bitte gib E-Mail und Passwort an." });
  }

  try {
    // 1. User anhand der E-Mail suchen
    const [rows] = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", [email]);
    const user = rows[0];

    // 2. Prüfen, ob der User überhaupt existiert
    if (!user) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten." });
    }

    // 3. SPECIAL CASE: Social-Login Check
    // Wenn kein Passwort-Hash vorhanden ist, wurde der Account via Google oder Facebook erstellt
    if (!user.password_hash) {
      if (user.google_id) {
        return res.status(403).json({ 
          error: "Social_Login_Required", 
          message: "Dieser Account ist mit Google verknüpft. Bitte nutze 'Login mit Google'.",
          method: "google"
        });
      }
      if (user.facebook_id) {
        return res.status(403).json({ 
          error: "Social_Login_Required", 
          message: "Dieser Account ist mit Facebook verknüpft. Bitte nutze 'Login mit Facebook'.",
          method: "facebook"
        });
      }
    }

    // 4. Standard Passwort-Check
    const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten." });
    }

    // 5. JWT erstellen (Payload konsistent zu Google/Facebook halten)
    const token = jwt.sign(
      { id: user.id, username: user.username }, 
      process.env.JWT_SECRET, 
      { expiresIn: "7d" }
    );

    // 6. Erfolg
    res.json({ 
      token, 
      username: user.username,
      userId: user.id 
    });

  } catch (err) {
    console.error("Login Fehler:", err);
    res.status(500).json({ error: "Ein interner Serverfehler ist aufgetreten." });
  }
});

// === Guest join ===
router.post("/guest/join", async (req, res) => {
  const { nickname } = req.body;
  const guestToken = uuidv4();
  await pool.query(
    "INSERT INTO guest_users (guest_token, nickname) VALUES (?, ?)",
    [guestToken, nickname || "Gast"],
  );
  res.json({ guestToken, nickname: nickname || "Gast" });
});

// === Sessions (sichtbar für alle angemeldeten Nutzer + Gäste) ===

module.exports = router;
