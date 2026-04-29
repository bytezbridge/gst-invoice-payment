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

// Serve static files (checkout.html, success.html) from /public
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/checkout.html'));

// CORS
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // mobile apps, curl
    if (corsOrigins.length === 0 || corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

// Rate limit on checkout endpoints to prevent abuse
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 min
  max: 10,                // 10 req / min / IP
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

// ---------- 1. Create one-time payment order (Lifetime, Commercial, White-Label) ----------
app.post('/api/checkout/create-order', checkoutLimiter, async (req, res) => {
  try {
    const { tier, name, email, phone, gstin } = req.body;

    if (!TIERS[tier] || TIERS[tier].type !== 'one_time') {
      return res.status(400).json({ error: 'Invalid tier or wrong type' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const t = TIERS[tier];
    const order = await razorpay.orders.create({
      amount: t.amount,
      currency: 'INR',
      receipt: `gst_${tier}_${Date.now()}`,
      notes: { tier, email, name: name || '', phone: phone || '', gstin: gstin || '' },
    });

    db.prepare(`
      INSERT INTO payments (razorpay_order_id, tier, amount_paise, status, customer_email, customer_name, customer_phone, customer_gstin, created_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)
    `).run(order.id, tier, t.amount, email, name || '', phone || '', gstin || '', Date.now());

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

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Payment server listening on :${PORT}`);
  console.log(`   Mode: ${process.env.RAZORPAY_KEY_ID.startsWith('rzp_test') ? '🧪 TEST' : '💵 LIVE'}`);
  console.log(`   Public base: ${process.env.PUBLIC_BASE_URL}`);
});
