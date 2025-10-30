// email.js
require("dotenv").config();
const nodemailer = require("nodemailer");

// --- VALIDIERUNG ---
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
  throw new Error("EMAIL_USER und EMAIL_PASSWORD müssen in .env gesetzt sein!");
}

console.log("SMTP-Config (cPanel):");
console.log("  Host: tunevote.com");
console.log("  Port: 465 (SSL)");
console.log("  User:", process.env.EMAIL_USER);

// --- TRANSPORTER (SSL, Port 465) ---
const transporter = nodemailer.createTransport({
  host: "tunevote.com",      // AUS cPanel!
  port: 465,                 // SSL
  secure: true,              // SSL direkt
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: true,  // Nur für localhost, später true
  },
  debug: true,
  logger: true,
});

// --- VERBINDUNG TESTEN ---
transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP-Verbindung FEHLGESCHLAGEN:", error);
  } else {
    console.log("SMTP-Server bereit (tunevote.com:465) – Auth OK!");
  }
});

// --- SEND EMAIL ---
const sendEmail = async (to, subject, text, html = null) => {
  try {
    const info = await transporter.sendMail({
      from: `"TuneVote" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html: html || text.replace(/\n/g, "<br>"),
    });
    console.log(`E-Mail an ${to} gesendet | ID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error("E-Mail-Versand fehlgeschlagen:", {
      to,
      code: error.code,
      response: error.response,
      responseCode: error.responseCode,
    });
    throw error;
  }
};

module.exports = { sendEmail };