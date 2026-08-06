// Shared HTML layout for all transactional emails (password reset,
// new-password, ...). Keeping one template guarantees consistent branding:
// the TuneVote logo, one heading, one body, one primary action, one footer.
//
// Styling is inline and table-based for email-client compatibility, and uses
// the app's dark palette so the mail matches the product.

// Public base URL of the web app, used for the absolutely-referenced logo so
// it loads inside email clients. No trailing slash.
const APP_URL = (process.env.APP_URL || "https://app.tunevote.com").replace(
  /\/+$/,
  "",
);

const LOGO_URL = `${APP_URL}/icons/icon-192.png`;
const SUPPORT_EMAIL = "hello@tunevote.ch";

/**
 * Render a transactional email as a full HTML document.
 *
 * @param {object} opts
 * @param {string} opts.title      - <title> / inbox preheader text.
 * @param {string} opts.heading    - Main heading shown in the body.
 * @param {string} opts.bodyHtml   - Trusted HTML for the message body.
 * @param {{label: string, url: string}} [opts.button] - Optional primary CTA.
 * @param {string} [opts.footerNote] - Optional extra line above the footer.
 * @returns {string} Complete HTML document.
 */
function renderEmail({ title, heading, bodyHtml, button, footerNote }) {
  const year = new Date().getFullYear();

  const buttonHtml = button
    ? `
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px auto;">
                <tr>
                  <td align="center" style="border-radius:12px;background:#7c3aed;">
                    <a href="${button.url}"
                       style="display:inline-block;padding:15px 34px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">
                      ${button.label}
                    </a>
                  </td>
                </tr>
              </table>`
    : "";

  const footerNoteHtml = footerNote
    ? `<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#8b86a0;">${footerNote}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#070312;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${title}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070312;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#120a24;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
          <!-- Logo header -->
          <tr>
            <td align="center" style="padding:36px 40px 8px;">
              <img src="${LOGO_URL}" width="56" height="56" alt="TuneVote"
                   style="display:block;border:0;width:56px;height:56px;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:16px 40px 8px;color:#c7c3d4;">
              <h1 style="margin:0 0 20px;font-size:23px;font-weight:700;color:#ffffff;text-align:center;">
                ${heading}
              </h1>
              <div style="font-size:16px;line-height:1.65;color:#c7c3d4;">
                ${bodyHtml}
              </div>
              ${buttonHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 40px 36px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
              ${footerNoteHtml}
              <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#8b86a0;">
                Questions? Reach us at
                <a href="mailto:${SUPPORT_EMAIL}" style="color:#a78bfa;text-decoration:none;">${SUPPORT_EMAIL}</a>.
              </p>
              <p style="margin:0;font-size:12px;color:#6b6580;">
                TuneVote — your music, your vote.<br />
                &copy; ${year} TuneVote. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { renderEmail, SUPPORT_EMAIL, APP_URL, LOGO_URL };
