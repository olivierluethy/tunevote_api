const nodemailer = require("nodemailer");

// All transactional mail (password reset, new-password, invites) is sent via
// Infomaniak SMTP as `hello@tunevote.ch`. Everything is driven by environment
// variables — never hardcode the mailbox or its password here.
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
// Anything other than the literal string "false" is treated as secure (SSL).
const SMTP_SECURE = String(process.env.SMTP_SECURE).toLowerCase() !== "false";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  throw new Error(
    "SMTP_HOST, SMTP_USER and SMTP_PASS must be set in .env (Infomaniak mail).",
  );
}

// Display name + address for every outgoing mail. The address MUST live on the
// tunevote.ch domain so the SMTP envelope MAIL FROM (which nodemailer derives
// from this header) aligns with SPF/DKIM for tunevote.ch.
const FROM = `"TuneVote" <${SMTP_USER}>`;

const transporter = nodemailer.createTransport(
  {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  },
  {
    // Applied to every message unless a call overrides it. Keeping From and
    // Reply-To here guarantees consistent, aligned sender headers everywhere.
    from: FROM,
    replyTo: SMTP_USER,
  },
);

// Verify credentials once at startup (non-fatal — logs on failure).
transporter
  .verify()
  .then(() => console.log(`SMTP ready (${SMTP_HOST}:${SMTP_PORT}) as ${SMTP_USER}`))
  .catch((err) => console.error("SMTP verification failed:", err.message));

module.exports = transporter;
