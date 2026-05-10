/**
 * GST Invoice Generator — Razorpay Payment Server
 *
 * Endpoints:
 *   POST /api/checkout/create-order      → returns Razorpay order for one-time payment
 *   POST /api/checkout/create-subscription → returns Razorpay subscription for monthly tiers
 *   POST /api/checkout/verify             → verifies payment signature, creates licence
 *   POST /api/webhook/razorpay            → handles Razorpay webhooks (auth via signature)
 *   GET  /api/download/:token             → time-limited deliverable download
 *   GET  /api/health                      → liveness probe
 *
 * Run:  node server.js
 * Env:  see .env.example
 */

import express from 'express';
import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import morgan from 'morgan';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import { Resend } from 'resend';
import {
  welcomeEmail,
  quotaWarningEmail,
  quotaHitEmail,
  lifetimeActivatedEmail,
} from './lib/email-templates.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- env validation ----------
const required = [
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET', 'RESEND_API_KEY',
  'JWT_SECRET', 'PUBLIC_BASE_URL',
];
for (const k of required) {
  if (!process.env[k] || process.env[k].includes('REPLACE_ME')) {
    console.error(`❌ Missing or placeholder env: ${k}. See .env.example`);
    process.exit(1);
  }
}

// ---------- DB ----------
fs.mkdirSync(path.dirname(process.env.DB_PATH || './data/payments.sqlite'), { recursive: true });
const db = new Database(process.env.DB_PATH || './data/payments.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT,
    razorpay_subscription_id TEXT,
    tier TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    currency TEXT DEFAULT 'INR',
    status TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    customer_gstin TEXT,
    license_key TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    refunded_at INTEGER,
    raw_event TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(customer_email);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(razorpay_subscription_id);

  CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,
    invoice_count INTEGER DEFAULT 0,
    period_start INTEGER NOT NULL,
    max_invoices INTEGER DEFAULT 5,
    quota_first_hit_at INTEGER,
    upgraded_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    ip_address TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
  CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
`);

// ---------- third-party clients ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const resend = new Resend(process.env.RESEND_API_KEY);

// ---------- Express ----------
const app = express();

// Helmet first
app.use(helmet({ contentSecurityPolicy: false })); // CSP off because checkout iframe needs Razorpay

// Webhook needs raw body — register BEFORE json middleware
app.use('/api/webhook/razorpay', express.raw({ type: 'application/json' }));

// JSON middleware for everything else
app.use(express.json({ limit: '50kb' }));

app.use(morgan('combined'));

// CORS
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // mobile apps, curl
    if (corsOrigins.length === 0 || corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

// Serve static files from public/ (landing page, checkout, free-trial, blogs, install-guide.pdf, legal docs, etc.)
// Must be registered BEFORE API routes so files like /checkout.html, /free-trial.html resolve as files first.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  maxAge: '1h',
}));

// Root redirect: / → /index.html (served by static above) — fall back to /checkout.html if no landing page.
app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) return next();  // let static serve index.html
  return res.redirect('/checkout.html');
});

// Rate limit on checkout endpoints to prevent abuse
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 min
  max: 10,                // 10 req / min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Aggressive limiter for free-license signup — abuse vector (one license / email,
// but a script could still hit POST /v1/license/new from many IPs to enumerate
// or saturate Resend). 5/IP/hr is plenty for legit signup.
const licenseSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,                      // 5 req / IP / hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Try again in an hour.' },
});

// Lighter limiter for read-only license status / check endpoints.
const licenseReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// ---------- helpers ----------
const TIERS = {
  starter:    { name: 'Starter (Monthly)',    type: 'subscription', plan_id: process.env.RAZORPAY_PLAN_STARTER_MONTHLY, amount: parseInt(process.env.PRICE_STARTER_MONTHLY) },
  pro:        { name: 'Pro (Monthly)',        type: 'subscription', plan_id: process.env.RAZORPAY_PLAN_PRO_MONTHLY,     amount: parseInt(process.env.PRICE_PRO_MONTHLY) },
  lifetime:   { name: 'Lifetime',             type: 'one_time',                                                          amount: parseInt(process.env.PRICE_LIFETIME) },
  commercial: { name: 'Commercial Licence',   type: 'one_time',                                                          amount: parseInt(process.env.PRICE_COMMERCIAL_LICENSE) },
  whitelabel: { name: 'White-Label Licence',  type: 'one_time',                                                          amount: parseInt(process.env.PRICE_WHITELABEL_LICENSE) },
};

function generateLicenseKey() {
  // Format: GST-XXXX-XXXX-XXXX-XXXX
  const r = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `GST-${r()}-${r()}-${r()}-${r()}`;
}

function signDownloadToken(paymentId) {
  const exp = Math.floor(Date.now() / 1000) + parseInt(process.env.DOWNLOAD_LINK_TTL || 604800);
  const payload = `${paymentId}.${exp}`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyDownloadToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [paymentId, exp, sig] = decoded.split('.');
    if (!paymentId || !exp || !sig) return null;
    if (parseInt(exp) < Math.floor(Date.now() / 1000)) return null;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET)
      .update(`${paymentId}.${exp}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return paymentId;
  } catch { return null; }
}

function verifyRazorpayPaymentSignature({ order_id, payment_id, signature }) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function verifyRazorpayWebhookSignature(rawBody, signature) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

async function sendLicenseEmail({ to, name, tier, licenseKey, downloadUrl, paymentId }) {
  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>Your GST Invoice Generator licence</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 30px auto; padding: 20px; color: #1A202C;">
  <div style="border-left: 4px solid #4F46E5; padding: 8px 16px; margin-bottom: 24px;">
    <h1 style="margin: 0; color: #4F46E5; font-size: 22px;">Welcome aboard! 🎉</h1>
  </div>
  <p>Hi ${name || 'there'},</p>
  <p>Your <strong>${tier}</strong> licence is active. Here's everything you need to start generating GST-compliant invoices in the next 3 minutes:</p>

  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <tr><td style="padding: 10px; background: #F3F4F6; border-radius: 6px;">
      <strong>Licence key:</strong>
      <code style="display: block; background: #fff; padding: 12px; border-radius: 4px; font-size: 14px; margin-top: 6px; border: 1px solid #E5E7EB;">${licenseKey}</code>
    </td></tr>
  </table>

  <h2 style="color: #4F46E5; font-size: 18px;">3-step setup</h2>
  <ol style="line-height: 1.8;">
    <li><a href="${downloadUrl}" style="color: #4F46E5;"><strong>Download the plugin zip</strong></a> (link valid 7 days; email us if expired)</li>
    <li>Unzip into <code>~/.claude/skills/</code> on Mac/Linux or <code>%USERPROFILE%\\.claude\\skills\\</code> on Windows</li>
    <li>Open Claude Code or Cowork and say: <em>"raise an invoice for [client], [what you sold]"</em></li>
  </ol>

  <p style="margin-top: 24px;">📚 <a href="${process.env.PUBLIC_BASE_URL}/docs" style="color: #4F46E5;">Full documentation</a> · 💬 reply to this email for direct support</p>

  <hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 28px 0;">
  <p style="font-size: 13px; color: #64748B;">
    Order #${paymentId}<br>
    Built solo, in Chennai 🇮🇳<br>
    Reply with feedback — I read every email.<br>
    Bala
  </p>
</body></html>`;

  return resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    reply_to: process.env.EMAIL_REPLY_TO,
    subject: `Your GST Invoice Generator ${tier} is ready ⚡`,
    html,
  });
}

// =====================================================================
// LICENSING HELPERS (freemium tier)
// =====================================================================

const LICENSE_FREE_QUOTA = 5;
const LICENSE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days rolling
const LICENSE_DISCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LICENSE_REGULAR_PRICE_INR = 9999;
const LICENSE_DISCOUNT_PRICE_INR = 4999;

// Sane email regex — not full RFC 5322. Rejects obviously bad input,
// accepts normal user@domain.tld addresses (with + tags, dots, etc.).
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function isValidEmail(s) {
  return typeof s === 'string' && s.length >= 5 && s.length <= 254 && EMAIL_RE.test(s);
}

function newLicenseKey() {
  // Node 20 ships crypto.randomUUID — no extra dependency needed.
  return crypto.randomUUID();
}

function publicBase() {
  return process.env.PUBLIC_BASE_URL || 'https://gstinvoice.app';
}

function buildUpgradeUrl({ email, license_key, price }) {
  const u = new URL('/checkout.html', publicBase());
  u.searchParams.set('email', email);
  u.searchParams.set('price', String(price));
  u.searchParams.set('license', license_key);
  return u.toString();
}

// Single source of truth for "from" header on lifecycle emails.
const LICENSE_FROM = process.env.LICENSE_EMAIL_FROM || 'Bala from ByteZBridge <hello@gstinvoice.app>';

// Send-with-template helper — fire-and-forget. We log failures but don't
// fail the request, because the license action (signup / check) succeeded
// on disk and re-sending is cheap.
async function sendLicenseTemplate(template, to) {
  try {
    await resend.emails.send({
      from: LICENSE_FROM,
      to,
      reply_to: process.env.EMAIL_REPLY_TO || 'hello@gstinvoice.app',
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (err) {
    console.error('[license-email] send failed:', err?.message || err);
  }
}

// Look up a license by key. Returns row or null.
function getLicenseByKey(license_key) {
  return db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(license_key) || null;
}

function getLicenseByEmail(email) {
  return db.prepare('SELECT * FROM licenses WHERE email = ?').get(email) || null;
}

// Check whether the rolling 30-day window has elapsed; if so, reset
// invoice_count, period_start and clear quota_first_hit_at. Returns the
// possibly-updated license row.
function rolloverIfNeeded(license, now) {
  if (license.status !== 'free') return license;
  if (now - license.period_start < LICENSE_PERIOD_MS) return license;

  db.prepare(`
    UPDATE licenses
       SET invoice_count = 0,
           period_start = ?,
           quota_first_hit_at = NULL
     WHERE id = ?
  `).run(now, license.id);

  return {
    ...license,
    invoice_count: 0,
    period_start: now,
    quota_first_hit_at: null,
  };
}

function periodEnd(license) {
  return license.period_start + LICENSE_PERIOD_MS;
}

async function notifyAdmin(text) {
  // Optional Slack/Discord notification
  if (process.env.SLACK_WEBHOOK_URL) {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }
  if (process.env.DISCORD_WEBHOOK_URL) {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    }).catch(() => {});
  }
}

// ====================================================================
// ROUTES
// ====================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Pricing endpoint (so the frontend never hardcodes prices)
app.get('/api/pricing', (req, res) => {
  const tiers = Object.fromEntries(
    Object.entries(TIERS).map(([k, v]) => [k, {
      name: v.name, type: v.type, amount_inr: v.amount / 100, amount_paise: v.amount,
    }])
  );
  res.json({ tiers });
});

// ====================================================================
// LICENSING (freemium) ROUTES
// ====================================================================

// ---------- L1. POST /v1/license/new — issue a free license ----------
app.post('/v1/license/new', licenseSignupLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Please provide a valid email address.' });
    }

    // Reject duplicate email — one free license per email.
    const existing = getLicenseByEmail(email);
    if (existing) {
      console.log(`[license] duplicate signup blocked: ${email}`);
      return res.status(409).json({
        error: 'EMAIL_ALREADY_REGISTERED',
        message: 'This email already has a license. Check your inbox or reply to hello@gstinvoice.app.',
      });
    }

    const now = Date.now();
    const license_key = newLicenseKey();
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);

    db.prepare(`
      INSERT INTO licenses
        (license_key, email, status, invoice_count, period_start, max_invoices,
         created_at, ip_address, user_agent)
      VALUES (?, ?, 'free', 0, ?, ?, ?, ?, ?)
    `).run(license_key, email, now, LICENSE_FREE_QUOTA, now, ip || null, ua || null);

    console.log(`[license] new free license issued: ${email} → ${license_key}`);

    // Fire-and-forget welcome email
    sendLicenseTemplate(welcomeEmail({ email, license_key }), email);

    return res.json({
      license_key,
      status: 'free',
      max_invoices: LICENSE_FREE_QUOTA,
      period_end: now + LICENSE_PERIOD_MS,
    });
  } catch (e) {
    console.error('[license] /new error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not create license.' });
  }
});

// ---------- L2. POST /v1/license/check — increment-and-validate ----------
//
// Called by the plugin every time it raises an invoice.
// Body: { license_key, invoice_id? }
//
// Decisioning:
//   - status='banned'    → 403 BANNED
//   - status='lifetime'  → OK, remaining='unlimited'
//   - status='free':
//       * roll over period if >30d since period_start
//       * if invoice_count >= max → PAY_REQUIRED (sets quota_first_hit_at on
//         first such hit, fires the quota-hit email exactly once)
//       * else increment, set last_used_at, fire warning email at 4-of-5
app.post('/v1/license/check', licenseReadLimiter, async (req, res) => {
  try {
    const license_key = String(req.body?.license_key || '').trim();
    if (!license_key) {
      return res.status(400).json({ error: 'MISSING_LICENSE_KEY' });
    }

    let license = getLicenseByKey(license_key);
    if (!license) {
      console.log(`[license] check: unknown key ${license_key.slice(0, 8)}…`);
      return res.status(404).json({ error: 'INVALID_LICENSE', status: 'INVALID_LICENSE' });
    }

    if (license.status === 'banned') {
      console.warn(`[license] check: banned license used: ${license.email}`);
      return res.status(403).json({ error: 'BANNED', status: 'BANNED' });
    }

    const now = Date.now();

    if (license.status === 'lifetime') {
      db.prepare('UPDATE licenses SET last_used_at = ? WHERE id = ?').run(now, license.id);
      return res.json({ status: 'OK', remaining: 'unlimited' });
    }

    // Free tier — handle rolling 30-day window.
    license = rolloverIfNeeded(license, now);

    // Out of quota?
    if (license.invoice_count >= license.max_invoices) {
      // Stamp first-hit timestamp the very first time quota is exhausted in
      // this window. Subsequent calls within the window keep the original
      // stamp so the 24-hour discount really is 24 hours from first hit.
      let firstHit = license.quota_first_hit_at;
      let justHit = false;
      if (!firstHit) {
        firstHit = now;
        justHit = true;
        db.prepare('UPDATE licenses SET quota_first_hit_at = ? WHERE id = ?').run(firstHit, license.id);
      }

      const isWithin24hr = !!firstHit && (now - firstHit) < LICENSE_DISCOUNT_WINDOW_MS;
      const discount_price_inr = isWithin24hr ? LICENSE_DISCOUNT_PRICE_INR : null;
      const price = isWithin24hr ? LICENSE_DISCOUNT_PRICE_INR : LICENSE_REGULAR_PRICE_INR;
      const upgrade_url = buildUpgradeUrl({ email: license.email, license_key, price });

      console.log(`[license] PAY_REQUIRED for ${license.email} (within24hr=${isWithin24hr}, justHit=${justHit})`);

      // Fire the "quota hit" email exactly once per window (only on the
      // first call that triggered the stamp).
      if (justHit) {
        sendLicenseTemplate(
          quotaHitEmail({
            email: license.email,
            license_key,
            regular_price: LICENSE_REGULAR_PRICE_INR,
            discount_price: LICENSE_DISCOUNT_PRICE_INR,
            discount_expires_at: firstHit + LICENSE_DISCOUNT_WINDOW_MS,
          }),
          license.email,
        );
      }

      return res.json({
        status: 'PAY_REQUIRED',
        upgrade_url,
        discount_price_inr,
        regular_price_inr: LICENSE_REGULAR_PRICE_INR,
        discount_expires_at: firstHit + LICENSE_DISCOUNT_WINDOW_MS,
        period_end: periodEnd(license),
      });
    }

    // Increment under a transaction so concurrent calls don't double-count
    // and we observe the new value atomically. better-sqlite3 is sync, so
    // a transaction() closure is the right tool here.
    const incrementTxn = db.transaction((licId) => {
      db.prepare(`
        UPDATE licenses
           SET invoice_count = invoice_count + 1,
               last_used_at  = ?
         WHERE id = ?
      `).run(now, licId);
      return db.prepare('SELECT invoice_count, max_invoices FROM licenses WHERE id = ?').get(licId);
    });

    const updated = incrementTxn(license.id);
    const remaining = updated.max_invoices - updated.invoice_count;

    console.log(`[license] OK ${license.email} count=${updated.invoice_count}/${updated.max_invoices} remaining=${remaining}`);

    // Send the "1 left" warning when user just consumed their (max-1)th
    // invoice, i.e. invoice_count == max_invoices - 1.
    if (updated.invoice_count === updated.max_invoices - 1) {
      sendLicenseTemplate(
        quotaWarningEmail({
          email: license.email,
          license_key,
          used: updated.invoice_count,
          remaining: 1,
        }),
        license.email,
      );
    }

    return res.json({
      status: 'OK',
      remaining,
      used: updated.invoice_count,
      max: updated.max_invoices,
      period_end: periodEnd(license),
    });
  } catch (e) {
    console.error('[license] /check error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ---------- L3. GET /v1/license/status — read-only mirror of /check ----------
app.get('/v1/license/status', licenseReadLimiter, (req, res) => {
  try {
    const license_key = String(req.query?.license_key || '').trim();
    if (!license_key) return res.status(400).json({ error: 'MISSING_LICENSE_KEY' });

    let license = getLicenseByKey(license_key);
    if (!license) return res.status(404).json({ error: 'INVALID_LICENSE', status: 'INVALID_LICENSE' });
    if (license.status === 'banned') return res.status(403).json({ error: 'BANNED', status: 'BANNED' });

    const now = Date.now();

    if (license.status === 'lifetime') {
      return res.json({
        status: 'OK',
        tier: 'lifetime',
        remaining: 'unlimited',
        upgraded_at: license.upgraded_at,
      });
    }

    // Free tier — apply rollover so status reads are consistent with /check.
    license = rolloverIfNeeded(license, now);

    if (license.invoice_count >= license.max_invoices) {
      const firstHit = license.quota_first_hit_at;
      const isWithin24hr = !!firstHit && (now - firstHit) < LICENSE_DISCOUNT_WINDOW_MS;
      const discount_price_inr = isWithin24hr ? LICENSE_DISCOUNT_PRICE_INR : null;
      const price = isWithin24hr ? LICENSE_DISCOUNT_PRICE_INR : LICENSE_REGULAR_PRICE_INR;
      return res.json({
        status: 'PAY_REQUIRED',
        tier: 'free',
        used: license.invoice_count,
        max: license.max_invoices,
        remaining: 0,
        period_end: periodEnd(license),
        upgrade_url: buildUpgradeUrl({ email: license.email, license_key, price }),
        regular_price_inr: LICENSE_REGULAR_PRICE_INR,
        discount_price_inr,
        discount_expires_at: firstHit ? firstHit + LICENSE_DISCOUNT_WINDOW_MS : null,
      });
    }

    return res.json({
      status: 'OK',
      tier: 'free',
      used: license.invoice_count,
      max: license.max_invoices,
      remaining: license.max_invoices - license.invoice_count,
      period_end: periodEnd(license),
    });
  } catch (e) {
    console.error('[license] /status error:', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ---------- L4. POST /v1/license/upgrade-webhook — internal upgrade hook ----------
//
// Called from inside the Razorpay webhook handler when a 'lifetime' payment
// is captured. Also reachable directly by an admin token for manual fixups.
//
// Body: { email, license_key? }
function upgradeLicenseToLifetime({ email, license_key }) {
  email = String(email || '').trim().toLowerCase();
  let license = null;
  if (license_key) license = getLicenseByKey(license_key);
  if (!license && email) license = getLicenseByEmail(email);

  const now = Date.now();

  // No license on file? Auto-create one. This covers the case where someone
  // pays via /checkout.html without first signing up for a free license.
  if (!license) {
    if (!isValidEmail(email)) {
      console.warn('[license] upgrade: no license + invalid email; cannot self-create');
      return { ok: false, reason: 'NO_LICENSE_AND_INVALID_EMAIL' };
    }
    const newKey = license_key || newLicenseKey();
    db.prepare(`
      INSERT INTO licenses
        (license_key, email, status, invoice_count, period_start, max_invoices,
         upgraded_at, created_at)
      VALUES (?, ?, 'lifetime', 0, ?, 999999, ?, ?)
    `).run(newKey, email, now, now, now);
    console.log(`[license] upgrade: auto-created LIFETIME license for ${email}`);
    sendLicenseTemplate(lifetimeActivatedEmail({ email, license_key: newKey }), email);
    return { ok: true, license_key: newKey, created: true };
  }

  if (license.status === 'lifetime') {
    console.log(`[license] upgrade: ${license.email} already lifetime — no-op`);
    return { ok: true, license_key: license.license_key, already: true };
  }

  db.prepare(`
    UPDATE licenses
       SET status='lifetime',
           upgraded_at=?,
           max_invoices=999999,
           quota_first_hit_at=NULL
     WHERE id=?
  `).run(now, license.id);

  console.log(`[license] upgrade: ${license.email} → LIFETIME`);
  sendLicenseTemplate(
    lifetimeActivatedEmail({ email: license.email, license_key: license.license_key }),
    license.email,
  );

  return { ok: true, license_key: license.license_key };
}

app.post('/v1/license/upgrade-webhook', (req, res) => {
  // Loopback / admin auth — this endpoint is not meant for the public,
  // but the same logic is callable in-process from the Razorpay handler.
  const token = req.headers['x-admin-token'] || '';
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const { email, license_key } = req.body || {};
  const result = upgradeLicenseToLifetime({ email, license_key });
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// ---------- 1. Create one-time payment order (Lifetime, Commercial, White-Label) ----------
app.post('/api/checkout/create-order', checkoutLimiter, async (req, res) => {
  try {
    const { tier, name, email, phone, gstin, license_key } = req.body;

    if (!TIERS[tier] || TIERS[tier].type !== 'one_time') {
      return res.status(400).json({ error: 'Invalid tier or wrong type' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const t = TIERS[tier];
    let amount = t.amount;

    // Freemium 24-hour discount: only valid for the 'lifetime' tier and only
    // if the caller's license is genuinely inside its 24-hour window. We
    // never trust the client's price — we recompute from the license row.
    if (tier === 'lifetime' && license_key) {
      const lic = getLicenseByKey(String(license_key));
      const now = Date.now();
      if (
        lic && lic.status === 'free' &&
        lic.quota_first_hit_at &&
        (now - lic.quota_first_hit_at) < LICENSE_DISCOUNT_WINDOW_MS
      ) {
        amount = LICENSE_DISCOUNT_PRICE_INR * 100;   // paise
        console.log(`[license] discount applied for ${lic.email} — ₹${LICENSE_DISCOUNT_PRICE_INR}`);
      }
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `gst_${tier}_${Date.now()}`,
      notes: {
        tier, email, name: name || '', phone: phone || '', gstin: gstin || '',
        license_key: license_key || '',
      },
    });

    db.prepare(`
      INSERT INTO payments (razorpay_order_id, tier, amount_paise, status, customer_email, customer_name, customer_phone, customer_gstin, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)
    `).run(order.id, tier, amount, email, name || '', phone || '', gstin || '', Date.now());

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      tier_name: t.name,
    });
  } catch (e) {
    console.error('create-order error:', e);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// ---------- 2. Create subscription (Starter / Pro Monthly) ----------
app.post('/api/checkout/create-subscription', checkoutLimiter, async (req, res) => {
  try {
    const { tier, name, email, phone, gstin } = req.body;

    if (!TIERS[tier] || TIERS[tier].type !== 'subscription') {
      return res.status(400).json({ error: 'Invalid tier or wrong type' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const t = TIERS[tier];
    if (!t.plan_id || t.plan_id.includes('REPLACE_ME')) {
      return res.status(500).json({ error: `Razorpay plan ID for "${tier}" not configured. Create the plan in dashboard and set the env var.` });
    }

    const sub = await razorpay.subscriptions.create({
      plan_id: t.plan_id,
      total_count: 120, // 10-year cap; users cancel any time
      customer_notify: 1,
      notes: { tier, email, name: name || '', phone: phone || '', gstin: gstin || '' },
    });

    db.prepare(`
      INSERT INTO payments (razorpay_subscription_id, tier, amount_paise, status, customer_email, customer_name, customer_phone, customer_gstin, created_at)
      VALUES (?, ?, ?, 'subscription_created', ?, ?, ?, ?, ?)
    `).run(sub.id, tier, t.amount, email, name || '', phone || '', gstin || '', Date.now());

    res.json({
      subscription_id: sub.id,
      key_id: process.env.RAZORPAY_KEY_ID,
      tier_name: t.name,
    });
  } catch (e) {
    console.error('create-subscription error:', e);
    res.status(500).json({ error: 'Could not create subscription' });
  }
});

// ---------- 3. Verify one-time payment signature (called from frontend after Razorpay popup closes) ----------
app.post('/api/checkout/verify', checkoutLimiter, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment fields' });
    }

    const ok = verifyRazorpayPaymentSignature({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      signature: razorpay_signature,
    });
    if (!ok) return res.status(400).json({ error: 'Invalid signature' });

    const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(razorpay_order_id);
    if (!payment) return res.status(404).json({ error: 'Order not found' });

    if (payment.status === 'paid') {
      // Idempotent — already processed
      const downloadUrl = `${process.env.PUBLIC_BASE_URL}/api/download/${signDownloadToken(payment.id)}`;
      return res.json({ status: 'paid', license_key: payment.license_key, download_url: downloadUrl });
    }

    const licenseKey = generateLicenseKey();
    db.prepare(`
      UPDATE payments
         SET razorpay_payment_id = ?, status = 'paid', license_key = ?, paid_at = ?
       WHERE razorpay_order_id = ?
    `).run(razorpay_payment_id, licenseKey, Date.now(), razorpay_order_id);

    const downloadUrl = `${process.env.PUBLIC_BASE_URL}/api/download/${signDownloadToken(payment.id)}`;

    // Fire-and-forget email + admin notification
    sendLicenseEmail({
      to: payment.customer_email,
      name: payment.customer_name,
      tier: TIERS[payment.tier].name,
      licenseKey,
      downloadUrl,
      paymentId: razorpay_payment_id,
    }).catch(err => console.error('email send failed:', err));

    notifyAdmin(`💰 New sale: ${TIERS[payment.tier].name} — ₹${payment.amount_paise / 100} from ${payment.customer_email}`);

    // Freemium bridge — if this was a Lifetime upgrade, mark the matching
    // freemium license (or auto-create one) as 'lifetime'. We pull
    // license_key from the request body if the checkout page passed it
    // through, falling back to email lookup. Idempotent.
    if (payment.tier === 'lifetime') {
      try {
        upgradeLicenseToLifetime({
          email: payment.customer_email,
          license_key: req.body?.license_key,
        });
      } catch (err) {
        console.error('[license] upgrade-from-verify failed:', err);
      }
    }

    res.json({ status: 'paid', license_key: licenseKey, download_url: downloadUrl });
  } catch (e) {
    console.error('verify error:', e);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ---------- 4. Razorpay Webhook (subscription events, refunds, etc.) ----------
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.body; // Buffer because of express.raw
    if (!signature || !rawBody) return res.status(400).end();

    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      console.warn('webhook: invalid signature');
      return res.status(400).json({ error: 'Bad signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const { event: eventName, payload } = event;
    console.log('webhook event:', eventName);

    switch (eventName) {
      case 'payment.captured': {
        // For one-time orders, verify endpoint already handled it.
        // For subscriptions, this fires every successful charge.
        const payment = payload.payment.entity;
        const subId = payment.subscription_id;

        // Freemium bridge: webhook is the safety net for one-time Lifetime
        // payments — if verify never fired (user closed the tab), this
        // still upgrades the license. Idempotent because
        // upgradeLicenseToLifetime() short-circuits when status is already
        // 'lifetime'.
        if (!subId && payment.order_id) {
          const orderRow = db.prepare('SELECT * FROM payments WHERE razorpay_order_id = ?').get(payment.order_id);
          if (orderRow && orderRow.tier === 'lifetime') {
            try {
              upgradeLicenseToLifetime({
                email: orderRow.customer_email,
                license_key: payment.notes?.license_key,
              });
            } catch (err) {
              console.error('[license] upgrade-from-webhook failed:', err);
            }
          }
        }

        if (subId) {
          const row = db.prepare('SELECT * FROM payments WHERE razorpay_subscription_id = ?').get(subId);
          if (row && row.status !== 'paid') {
            const licenseKey = row.license_key || generateLicenseKey();
            db.prepare(`
              UPDATE payments SET status='paid', license_key=?, paid_at=?, raw_event=? WHERE razorpay_subscription_id=?
            `).run(licenseKey, Date.now(), JSON.stringify(event), subId);

            const downloadUrl = `${process.env.PUBLIC_BASE_URL}/api/download/${signDownloadToken(row.id)}`;
            await sendLicenseEmail({
              to: row.customer_email, name: row.customer_name,
              tier: TIERS[row.tier].name, licenseKey, downloadUrl,
              paymentId: payment.id,
            });
            notifyAdmin(`💰 New subscription: ${TIERS[row.tier].name} — ${row.customer_email}`);
          }
        }
        break;
      }
      case 'subscription.charged': {
        // Recurring renewal — log it, do nothing user-facing
        const sub = payload.subscription.entity;
        db.prepare(`UPDATE payments SET raw_event=? WHERE razorpay_subscription_id=?`)
          .run(JSON.stringify(event), sub.id);
        notifyAdmin(`🔄 Subscription renewed: ${sub.id}`);
        break;
      }
      case 'subscription.cancelled':
      case 'subscription.halted': {
        const sub = payload.subscription.entity;
        db.prepare(`UPDATE payments SET status='cancelled' WHERE razorpay_subscription_id=?`).run(sub.id);
        notifyAdmin(`⏹️ Subscription cancelled: ${sub.id}`);
        break;
      }
      case 'payment.failed': {
        const p = payload.payment.entity;
        if (p.order_id) {
          db.prepare(`UPDATE payments SET status='failed', raw_event=? WHERE razorpay_order_id=?`)
            .run(JSON.stringify(event), p.order_id);
        }
        break;
      }
      case 'refund.processed': {
        const refund = payload.refund.entity;
        db.prepare(`UPDATE payments SET status='refunded', refunded_at=?, raw_event=? WHERE razorpay_payment_id=?`)
          .run(Date.now(), JSON.stringify(event), refund.payment_id);
        notifyAdmin(`↩️ Refund processed: ${refund.payment_id} — ₹${refund.amount / 100}`);
        break;
      }
      default:
        // Unhandled events are logged but we still ack
        break;
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook error:', e);
    res.status(500).end();
  }
});

// ---------- 5. Download endpoint (time-limited token) ----------
app.get('/api/download/:token', (req, res) => {
  const paymentId = verifyDownloadToken(req.params.token);
  if (!paymentId) return res.status(403).send('Link expired or invalid. Email us for a fresh link.');

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment || payment.status !== 'paid') return res.status(403).send('Payment not found or not paid.');

  const zipPath = path.resolve(__dirname, process.env.DELIVERABLE_ZIP_PATH || './deliverables/gst-invoice-generator-v1.0.0.zip');
  if (!fs.existsSync(zipPath)) {
    console.error('Deliverable zip missing at', zipPath);
    return res.status(500).send('Deliverable temporarily unavailable. We have been notified.');
  }

  res.download(zipPath, 'gst-invoice-generator.zip');
});

// ---------- 6. Admin: list recent sales (basic auth via env token, optional) ----------
app.get('/api/admin/sales', (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(403).end();
  }
  const rows = db.prepare(`
    SELECT id, tier, amount_paise, currency, status, customer_email, customer_name, license_key,
           datetime(created_at/1000, 'unixepoch') AS created,
           datetime(paid_at/1000, 'unixepoch')    AS paid
      FROM payments
     ORDER BY id DESC LIMIT 100
  `).all();
  res.json(rows);
});

// ---------- 7. Admin: license signups dashboard data ----------
// Auth via ?token= query param OR x-admin-token header so it works from a static HTML page too.
app.get('/api/admin/licenses', (req, res) => {
  const provided = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || provided !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                             AS total,
      SUM(CASE WHEN status='free'     THEN 1 ELSE 0 END)   AS free,
      SUM(CASE WHEN status='lifetime' THEN 1 ELSE 0 END)   AS lifetime,
      SUM(CASE WHEN status='banned'   THEN 1 ELSE 0 END)   AS banned,
      SUM(invoice_count)                                   AS total_invoices_raised
      FROM licenses
  `).get();
  const recent = db.prepare(`
    SELECT email, status, invoice_count, max_invoices,
           datetime(created_at/1000, 'unixepoch')    AS created,
           datetime(last_used_at/1000, 'unixepoch')  AS last_used,
           datetime(period_start/1000, 'unixepoch')  AS period_start,
           datetime(quota_first_hit_at/1000, 'unixepoch') AS quota_hit_at,
           datetime(upgraded_at/1000, 'unixepoch')   AS upgraded_at,
           ip_address
      FROM licenses
     ORDER BY id DESC
     LIMIT 500
  `).all();
  // Conversion rate (lifetime / free signups)
  const conversion_rate = totals.total > 0
    ? ((totals.lifetime / totals.total) * 100).toFixed(1) + '%'
    : '0%';
  res.json({
    totals,
    conversion_rate,
    fetched_at: new Date().toISOString(),
    recent,
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Payment server listening on :${PORT}`);
  console.log(`   Mode: ${process.env.RAZORPAY_KEY_ID.startsWith('rzp_test') ? '🧪 TEST' : '💵 LIVE'}`);
  console.log(`   Public base: ${process.env.PUBLIC_BASE_URL}`);
});
