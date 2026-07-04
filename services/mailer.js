const nodemailer = require("nodemailer");

// Shared Gmail transporter for password-reset and invite emails.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD, // App password (with spaces)!
  },
});

// Verify credentials once at startup.
transporter
  .verify()
  .then(() => console.log("Gmail ready"))
  .catch(console.error);

module.exports = transporter;
