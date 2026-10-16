export type OtpEmailPurpose = "register" | "login" | "password_reset" | "email_change" | "verify";

const SITE = "https://listifys.com";
/** Public wordmark on listifys.com. /icons/logo.png 404s, so mail clients showed a broken image. */
const LOGO = `${SITE}/images/nav-logo.jpeg`;
const SUPPORT = "contact@listifys.com";

const COPY: Record<
  OtpEmailPurpose,
  { subject: string; title: string; intro: string; ignore: string }
> = {
  register: {
    subject: "Verify your Listifys account",
    title: "Confirm your email",
    intro: "Use this code to finish creating your Listifys account.",
    ignore: "If you did not create a Listifys account, you can ignore this email.",
  },
  login: {
    subject: "Your Listifys sign-in code",
    title: "Sign in to Listifys",
    intro: "Use this code to sign in to your Listifys account.",
    ignore: "If you did not try to sign in, you can ignore this email.",
  },
  password_reset: {
    subject: "Reset your Listifys password",
    title: "Reset your password",
    intro: "Use this code to choose a new password for your Listifys account.",
    ignore: "If you did not ask to reset your password, you can ignore this email.",
  },
  email_change: {
    subject: "Confirm your new Listifys email",
    title: "Confirm this email address",
    intro: "Use this code to update the email address on your Listifys account.",
    ignore: "If you did not request this change, you can ignore this email.",
  },
  verify: {
    subject: "Your Listifys verification code",
    title: "Your verification code",
    intro: "Use this code to continue on Listifys.",
    ignore: "If you did not request this code, you can ignore this email.",
  },
};

export function renderOtpEmail(input: {
  code: string;
  purpose?: OtpEmailPurpose;
  expiresMinutes: number;
}) {
  const copy = COPY[input.purpose || "verify"];
  const minutes = Math.max(1, input.expiresMinutes);
  const text = [
    copy.title,
    "",
    copy.intro,
    "",
    `Verification code: ${input.code}`,
    "",
    `This code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    copy.ignore,
    "",
    `Listifys · ${SITE}`,
    `Support: ${SUPPORT}`,
  ].join("\n");

  const html = renderBrandedEmail({
    preheader: `${copy.title}: ${input.code}`,
    title: copy.title,
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;" class="text">${copy.intro}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
        <tr>
          <td align="center" bgcolor="#eef4ff" class="code-box" style="border-radius:12px;padding:18px 12px;background-color:#eef4ff;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;" class="muted">Verification code</p>
            <p style="margin:0;font-size:32px;line-height:1.2;font-weight:800;letter-spacing:0.28em;color:#0056D2;" class="code">${input.code}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.6;" class="text">This code expires in <strong>${minutes} minute${minutes === 1 ? "" : "s"}</strong>.</p>
      <p style="margin:0;font-size:13px;line-height:1.6;" class="muted">${copy.ignore}</p>
    `,
  });

  return { subject: copy.subject, text, html };
}

export function renderBrandedEmail(input: { preheader: string; title: string; bodyHtml: string }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) {
      .page { background-color: #0b1220 !important; }
      .card { background-color: #111827 !important; border-color: #1f2937 !important; }
      .text, .title { color: #f8fafc !important; }
      .muted, .footer { color: #94a3b8 !important; }
      .code-box { background-color: #172554 !important; }
      .code { color: #93c5fd !important; }
      .logo-fallback { color: #f8fafc !important; }
    }
  </style>
</head>
<body class="page" bgcolor="#f4f7fb" style="margin:0;padding:0;background-color:#f4f7fb;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="page" bgcolor="#f4f7fb" style="background-color:#f4f7fb;">
    <tr>
      <td align="center" style="padding:28px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;">
          <tr>
            <td align="left" style="padding:0 4px 16px;">
              <a href="${SITE}" style="text-decoration:none;">
                <img src="${LOGO}" width="140" height="47" alt="Listifys" style="display:block;border:0;outline:none;height:auto;max-width:140px;background-color:#ffffff;border-radius:8px;" />
              </a>
            </td>
          </tr>
          <tr>
            <td class="card" bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:28px 24px;">
              <h1 class="title" style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:1.3;color:#0f172a;">${escapeHtml(input.title)}</h1>
              <div class="text" style="font-family:Arial,Helvetica,sans-serif;color:#334155;">
                ${input.bodyHtml}
              </div>
            </td>
          </tr>
          <tr>
            <td class="footer" style="padding:18px 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#64748b;">
              <p style="margin:0 0 6px;">Listifys — buy, sell, and discover nearby.</p>
              <p style="margin:0 0 6px;"><a href="${SITE}" style="color:#0056D2;text-decoration:none;">listifys.com</a> · <a href="mailto:${SUPPORT}" style="color:#0056D2;text-decoration:none;">${SUPPORT}</a></p>
              <p style="margin:0;">© ${year} Listifys. You received this email because of an action on your account.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderNoticeEmail(input: { title: string; text: string }) {
  const bodyHtml = input.text
    .split("\n")
    .map((line) =>
      line
        ? `<p style="margin:0 0 8px;font-size:15px;line-height:1.6;" class="text">${escapeHtml(line)}</p>`
        : `<p style="margin:0 0 8px;">&nbsp;</p>`,
    )
    .join("");
  return renderBrandedEmail({
    preheader: input.title,
    title: input.title,
    bodyHtml,
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
