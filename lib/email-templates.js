/**
 * Resend email templates for the freemium licensing flow.
 *
 * Each function returns { subject, html, text } and is consumed by server.js
 * via `resend.emails.send({ from: '...', to, ...template })`.
 *
 * Branding: Indigo #4F46E5 / Purple #4338CA — matches checkout.html and
 * free-trial.html. Tables for layout (Outlook), max-width 600px, plaintext
 * fallback included.
 *
 * Logo image is hosted at https://gstinvoice.app/icon-512.png.
 */

const LOGO_URL = 'https://gstinvoice.app/icon-512.png';
const SITE = 'https://gstinvoice.app';

// Tiny escaper for any user-supplied string we drop into HTML (e.g. email).
// License keys are UUIDs and prices are integers — safe — but we escape
// defensively anyway.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shared shell — keeps the look consistent across all 3 emails.
function shell({ preheader, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>ByteZBridge</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:16px;box-shadow:0 10px 40px -10px rgba(15,23,42,.08);overflow:hidden;">
      <tr><td style="padding:28px 32px 8px 32px;border-top:4px solid #4F46E5;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="middle" style="vertical-align:middle;">
              <img src="${LOGO_URL}" alt="ByteZBridge" width="36" height="36" style="display:block;border-radius:8px;">
            </td>
            <td valign="middle" style="vertical-align:middle;padding-left:12px;">
              <span style="font-size:14px;font-weight:700;color:#4F46E5;letter-spacing:.2px;">ByteZBridge</span>
              <div style="font-size:12px;color:#64748B;">GST Invoice Generator</div>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:24px 32px 32px 32px;font-size:15px;line-height:1.6;color:#0F172A;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="background:#F8FAFC;padding:18px 32px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;text-align:center;">
        ByteZBridge &middot; Built solo, in Chennai &middot; <a href="${SITE}" style="color:#4F46E5;text-decoration:none;">gstinvoice.app</a><br>
        Reply to this email any time &mdash; I read every one. <strong>Bala</strong>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function ctaButton(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
    <tr><td bgcolor="#4F46E5" style="border-radius:10px;">
      <a href="${href}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;background:linear-gradient(135deg,#4F46E5 0%,#4338CA 100%);">${label}</a>
    </td></tr>
  </table>`;
}

function keyBox(licenseKey) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;">
    <tr><td style="background:#F1F5F9;border:1px solid #E2E8F0;border-radius:10px;padding:14px 16px;">
      <div style="font-size:11px;font-weight:700;color:#64748B;letter-spacing:.6px;text-transform:uppercase;">License key</div>
      <code style="display:block;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:14px;color:#0F172A;margin-top:6px;word-break:break-all;">${esc(licenseKey)}</code>
    </td></tr>
  </table>`;
}

// =====================================================================
// 1) Welcome — sent on POST /v1/license/new
// =====================================================================
export function welcomeEmail({ email, license_key }) {
  const subject = 'Your ByteZBridge GST Invoice Generator license is ready';
  const preheader = 'Install in 60 seconds — 5 free GST invoices every month.';

  const ccCmd1 = '/plugin marketplace add rbalaganapathi-coder/gst-invoice-payment';
  const ccCmd2 = '/plugin install gst-invoice-generator@bytezbridge';

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;letter-spacing:-.3px;color:#0F172A;">Welcome aboard ${esc(email)} &mdash; you're in.</h1>
    <p style="margin:0 0 14px 0;color:#334155;">Your free license for the <strong>GST Invoice Generator</strong> is active. You can raise <strong>5 GST-compliant invoices every month</strong>, free, with all v1.2 features unlocked &mdash; multi-currency, bulk import, GSTR-1 export.</p>

    ${keyBox(license_key)}

    <h2 style="margin:24px 0 8px 0;font-size:16px;color:#4F46E5;">Install in Claude Code</h2>
    <p style="margin:0 0 8px 0;color:#334155;">Paste these two commands, in order:</p>
    <pre style="background:#0F172A;color:#E2E8F0;padding:14px 16px;border-radius:10px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;line-height:1.5;overflow-x:auto;margin:0 0 14px 0;">${esc(ccCmd1)}
${esc(ccCmd2)}</pre>

    <h2 style="margin:20px 0 8px 0;font-size:16px;color:#4F46E5;">Install in Claude Cowork</h2>
    <ol style="margin:0 0 14px 18px;padding:0;color:#334155;">
      <li>Open Cowork &rarr; Plugins &rarr; <em>Add marketplace</em></li>
      <li>Paste <code style="background:#F1F5F9;padding:1px 6px;border-radius:4px;">rbalaganapathi-coder/gst-invoice-payment</code></li>
      <li>Click <strong>Install</strong> on <em>gst-invoice-generator@bytezbridge</em></li>
      <li>Paste your license key when prompted</li>
    </ol>

    <p style="margin:20px 0 0 0;color:#334155;">Full step-by-step PDF: <a href="${SITE}/install-guide.pdf" style="color:#4F46E5;">install-guide.pdf</a></p>

    ${ctaButton(`${SITE}/install-guide.pdf`, 'Open install guide')}

    <p style="margin:24px 0 0 0;font-size:13px;color:#64748B;">Need to upgrade later? Lifetime is a flat <strong>&#8377;9,999</strong>, one-time, unlimited invoices forever. No recurring fees.</p>
    <p style="margin:18px 0 0 0;color:#0F172A;">&mdash; Bala<br><span style="color:#64748B;font-size:13px;">founder, ByteZBridge</span></p>
  `;

  const text = [
    `Welcome aboard ${email} — you're in.`,
    ``,
    `Your free license for the GST Invoice Generator is active.`,
    `5 GST-compliant invoices every month, free, all v1.2 features unlocked.`,
    ``,
    `License key: ${license_key}`,
    ``,
    `Install in Claude Code (paste both commands):`,
    `  ${ccCmd1}`,
    `  ${ccCmd2}`,
    ``,
    `Install in Claude Cowork:`,
    `  1. Cowork → Plugins → Add marketplace`,
    `  2. Paste: rbalaganapathi-coder/gst-invoice-payment`,
    `  3. Click Install on gst-invoice-generator@bytezbridge`,
    `  4. Paste your license key when prompted`,
    ``,
    `Full PDF guide: ${SITE}/install-guide.pdf`,
    ``,
    `Upgrade to Lifetime any time: ₹9,999 one-time, unlimited invoices forever.`,
    ``,
    `— Bala, founder, ByteZBridge`,
    `${SITE}`,
  ].join('\n');

  return { subject, html: shell({ preheader, bodyHtml }), text };
}

// =====================================================================
// 2) Quota warning — sent when user uses 4 of 5 (one left)
// =====================================================================
export function quotaWarningEmail({ email, license_key, used, remaining }) {
  const subject = '1 free invoice left this month — upgrade to Lifetime ₹9,999 →';
  const preheader = `You've raised ${used} of 5 free invoices. One more, then quota resets next month.`;
  const upgradeUrl = `${SITE}/checkout.html?email=${encodeURIComponent(email)}&price=9999&license=${encodeURIComponent(license_key)}`;

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;letter-spacing:-.3px;color:#0F172A;">Heads-up &mdash; <span style="color:#4F46E5;">${esc(remaining)} free invoice left</span> this month.</h1>
    <p style="margin:0 0 14px 0;color:#334155;">You've raised <strong>${esc(used)} of 5</strong> free invoices on this license. One more and your free quota for this month is up &mdash; it resets automatically at the start of the next monthly window.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0;">
      <tr><td style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:18px;">
        <div style="font-size:13px;font-weight:700;color:#4F46E5;text-transform:uppercase;letter-spacing:.6px;">Lifetime tier</div>
        <div style="font-size:24px;font-weight:800;color:#0F172A;margin:6px 0;">&#8377;9,999 <span style="font-size:13px;font-weight:500;color:#64748B;">one-time</span></div>
        <ul style="margin:8px 0 0 18px;padding:0;color:#334155;font-size:14px;line-height:1.6;">
          <li>Unlimited invoices forever</li>
          <li>All features unlocked &mdash; multi-currency, bulk import, GSTR-1 export</li>
          <li>No recurring fees, no surprises</li>
        </ul>
      </td></tr>
    </table>

    ${ctaButton(upgradeUrl, 'Upgrade to Lifetime — ₹9,999')}

    <p style="margin:16px 0 0 0;font-size:13px;color:#64748B;">Or just keep using the free tier &mdash; quota resets every 30 days. No pressure.</p>

    ${keyBox(license_key)}

    <p style="margin:18px 0 0 0;color:#0F172A;">&mdash; Bala<br><span style="color:#64748B;font-size:13px;">founder, ByteZBridge</span></p>
  `;

  const text = [
    `Heads-up — ${remaining} free invoice left this month.`,
    ``,
    `You've raised ${used} of 5 free invoices on this license.`,
    `One more and your free quota is up — it resets next month.`,
    ``,
    `Lifetime tier: ₹9,999 one-time`,
    `  - Unlimited invoices forever`,
    `  - All features unlocked (multi-currency, bulk, GSTR-1 export)`,
    `  - No recurring fees`,
    ``,
    `Upgrade: ${upgradeUrl}`,
    ``,
    `License key: ${license_key}`,
    ``,
    `— Bala, founder, ByteZBridge`,
  ].join('\n');

  return { subject, html: shell({ preheader, bodyHtml }), text };
}

// =====================================================================
// 3) Quota hit — sent the moment quota is fully exhausted
// =====================================================================
export function quotaHitEmail({ email, license_key, regular_price, discount_price, discount_expires_at }) {
  const subject = 'Free quota used — upgrade with 24-hr discount, ₹4,999 (save ₹5,000) →';
  const preheader = 'Your 24-hour upgrade discount is active — ₹4,999 vs ₹9,999 regular.';

  const price = discount_price ?? regular_price;
  const upgradeUrl = `${SITE}/checkout.html?email=${encodeURIComponent(email)}&price=${price}&license=${encodeURIComponent(license_key)}`;

  // discount_expires_at is a unix-ms timestamp; format as readable IST.
  const expiresStr = discount_expires_at
    ? new Date(discount_expires_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
    : '24 hours from now';

  const savings = regular_price - (discount_price ?? regular_price);

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;letter-spacing:-.3px;color:#0F172A;">You've raised <span style="color:#4F46E5;">5 GST invoices</span> for free this month.</h1>
    <p style="margin:0 0 14px 0;color:#334155;">Nice run. To keep going right now &mdash; instead of waiting for next month's reset &mdash; upgrade to Lifetime. Your <strong>24-hour discount window is open</strong>.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;">
      <tr><td style="background:linear-gradient(135deg,#4F46E5 0%,#4338CA 100%);border-radius:14px;padding:24px;color:#FFFFFF;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;opacity:.85;">Your price for the next 24 hours</div>
        <div style="font-size:36px;font-weight:800;margin:6px 0;">&#8377;${esc(discount_price ?? regular_price)}</div>
        <div style="font-size:14px;opacity:.9;">Regular price <s>&#8377;${esc(regular_price)}</s> &mdash; you save <strong>&#8377;${esc(savings)}</strong></div>
        <div style="margin-top:10px;font-size:13px;opacity:.85;">Discount expires <strong>${esc(expiresStr)}</strong></div>
      </td></tr>
    </table>

    ${ctaButton(upgradeUrl, `Upgrade now — ₹${discount_price ?? regular_price}`)}

    <p style="margin:16px 0 0 0;color:#334155;font-size:14px;">Lifetime gets you unlimited GST invoices forever, every feature unlocked, no recurring fees. One payment, done.</p>

    <p style="margin:18px 0 0 0;padding:14px 16px;background:#F8FAFC;border-radius:10px;font-size:13px;color:#64748B;border-left:3px solid #E2E8F0;">
      Not ready? No worries &mdash; your quota <strong>resets every 30 days</strong> and you'll get another 5 free invoices automatically. The Lite tier stays free forever.
    </p>

    ${keyBox(license_key)}

    <p style="margin:18px 0 0 0;color:#0F172A;">Built this whole thing solo from Chennai. Every Lifetime sale lets me keep shipping.</p>
    <p style="margin:8px 0 0 0;color:#0F172A;">&mdash; Bala<br><span style="color:#64748B;font-size:13px;">founder, ByteZBridge</span></p>
  `;

  const text = [
    `You've raised 5 GST invoices for free this month.`,
    ``,
    `To keep going right now, upgrade to Lifetime.`,
    `Your 24-hour discount window is open.`,
    ``,
    `Your price for the next 24 hours: ₹${discount_price ?? regular_price}`,
    `Regular price: ₹${regular_price}  (you save ₹${savings})`,
    `Discount expires: ${expiresStr}`,
    ``,
    `Upgrade: ${upgradeUrl}`,
    ``,
    `Or wait — your quota resets every 30 days, another 5 free invoices automatically.`,
    `The Lite tier stays free forever.`,
    ``,
    `License key: ${license_key}`,
    ``,
    `— Bala, founder, ByteZBridge`,
  ].join('\n');

  return { subject, html: shell({ preheader, bodyHtml }), text };
}

// =====================================================================
// 4) (Bonus, used by the Razorpay webhook bridge) Lifetime activated
// =====================================================================
export function lifetimeActivatedEmail({ email, license_key }) {
  const subject = 'Lifetime activated — unlimited GST invoices, forever';
  const preheader = 'Your upgrade is live. Same license key, no quota.';

  const bodyHtml = `
    <h1 style="margin:0 0 8px 0;font-size:22px;letter-spacing:-.3px;color:#0F172A;">Lifetime is live. Thank you. 🙏</h1>
    <p style="margin:0 0 14px 0;color:#334155;">Your license is now <strong>Lifetime</strong> &mdash; unlimited GST-compliant invoices, every feature, forever, no recurring fees. Same license key, just no cap.</p>
    ${keyBox(license_key)}
    <p style="margin:14px 0 0 0;color:#334155;">If anything ever breaks, reply to this email. I'll fix it personally.</p>
    <p style="margin:18px 0 0 0;color:#0F172A;">&mdash; Bala<br><span style="color:#64748B;font-size:13px;">founder, ByteZBridge</span></p>
  `;

  const text = [
    `Lifetime is live. Thank you.`,
    ``,
    `Your license is now Lifetime — unlimited invoices, every feature, forever.`,
    `Same license key, no cap.`,
    ``,
    `License key: ${license_key}`,
    ``,
    `Reply if anything breaks. I'll fix it personally.`,
    ``,
    `— Bala, founder, ByteZBridge`,
  ].join('\n');

  return { subject, html: shell({ preheader, bodyHtml }), text };
}
