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

// Cold-email batch sender (admin-only, single-use). Remove after launch batch.
app.post('/api/admin/send-cold-batch', express.json({ limit: '500kb' }), async (req, res) => {
  const token = req.get('X-Admin-Token');
  if (token !== 'BALA_COLD_2026_05_01_KX9F2P7Q') return res.status(401).json({ error: 'unauthorized' });
  const payloads = req.body && req.body.payloads;
  if (!Array.isArray(payloads)) return res.status(400).json({ error: 'expected payloads array' });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  const results = [];
  for (const p of payloads) {
    const clean = Object.assign({}, p);
    delete clean._meta;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(clean)
      });
      const j = await r.json().catch(() => ({}));
      results.push({ to: p.to[0], ok: r.ok, status: r.status, id: j.id || '', error: j.message || j.name || '' });
    } catch (e) {
      results.push({ to: p.to[0], ok: false, status: 0, error: String(e).slice(0, 200) });
    }
    await new Promise((rs) => setTimeout(rs, 600));
  }
  const sent = results.filter((x) => x.ok).length;
  res.json({ total: results.length, sent, failed: results.length - sent, results });
});

// AI Sales Chatbot — proxies to Claude API (Haiku 4.5) for free-text questions
app.post('/api/chat', express.json({ limit: '50kb' }), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    const userMessage = (req.body && req.body.message) || '';
    const history = (req.body && req.body.history) || [];
    if (!userMessage || userMessage.length > 1000) return res.status(400).json({ error: 'invalid message' });
    const systemPrompt = "You are ByteZBridge's AI sales assistant for gstinvoice.app — a Claude plugin that generates GST-compliant Indian tax invoices in 30 seconds for ₹9,999 lifetime (one-time, no subscriptions). Your job: qualify the visitor, answer their question concisely (under 80 words), and route them toward the checkout. Key facts you can cite: (1) Auto CGST/SGST/IGST split from GSTIN state code. (2) 500+ pre-loaded HSN/SAC codes. (3) Indian-numbering words (Lakh/Crore). (4) Auto-updated dashboard + GSTR-1 ready CSV. (5) Local-first — data never leaves user's device. (6) Works inside Claude Pro/Max/Team accounts. (7) 30-day money-back guarantee. (8) Pricing: ₹9,999 lifetime for first 100 customers, then ₹12,999. (9) Saves ₹15K+/yr vs Tally. NEVER invent features we don't have. If asked about features not in this list (e.g. multi-currency, recurring invoices, e-invoice IRP), say 'shipping in v1.2 next week — buy now and get it free.' If they want to buy: send them to /checkout.html. If they want demo: send them to /#video. If they want install help: /install.html. If they want a call with the founder: https://calendly.com/balaganapathi/30min. Always end with a clear next-step CTA. Tone: friendly, direct, no corporate-speak, light Indian English warmth.";
    const messages = [];
    history.slice(-6).forEach(function (h) {
      if (h && h.role && h.text) messages.push({ role: h.role === 'bot' ? 'assistant' : 'user', content: h.text });
    });
    messages.push({ role: 'user', content: userMessage });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 250,
        system: systemPrompt,
        messages: messages,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (j && j.error && j.error.message) || 'upstream error' });
    const answer = (j.content && j.content[0] && j.content[0].text) || '';
    res.json({ answer: answer, model: j.model || 'claude-haiku-4-5' });
  } catch (e) {
    res.status(500).json({ error: String(e).slice(0, 200) });
  }
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

// ============================================================================
// SEO routes — paste before app.listen(...)
// ============================================================================

const HSN_DATA = {
  services: {
    "998311": { title: "Management consulting / business advisory", default_gst: 18 },
    "998312": { title: "Tax / accounting / auditing services", default_gst: 18 },
    "998313": { title: "Information-technology consulting", default_gst: 18 },
    "998314": { title: "Software development / IT services", default_gst: 18 },
    "998315": { title: "IT design / development / programming", default_gst: 18 },
    "998316": { title: "Hosting / IT infrastructure / SaaS", default_gst: 18 },
    "998361": { title: "Marketing & advertising services", default_gst: 18 },
    "998363": { title: "Sale of internet advertising space", default_gst: 18 },
    "998365": { title: "Public relations services", default_gst: 18 },
    "998391": { title: "Specialty design (UI/UX, graphic, product)", default_gst: 18 },
    "998399": { title: "Other professional / technical services", default_gst: 18 },
    "998722": { title: "Maintenance & repair of computers", default_gst: 18 },
    "999293": { title: "Educational / coaching services", default_gst: 18 },
    "999294": { title: "Training services", default_gst: 18 },
    "997212": { title: "Real-estate services on commission/fee", default_gst: 18 },
    "997331": { title: "Licensing services for software", default_gst: 18 },
    "996311": { title: "Hotel accommodation (room <= rupees 7500/night)", default_gst: 12 },
    "996312": { title: "Hotel accommodation (room > rupees 7500/night)", default_gst: 18 },
    "996331": { title: "Restaurant - non-AC, no liquor", default_gst: 5 },
    "996332": { title: "Restaurant - AC or liquor licence", default_gst: 5 },
    "996511": { title: "Road transport of goods", default_gst: 5 },
    "996601": { title: "Rental of vehicles with operator", default_gst: 18 },
    "997211": { title: "Insurance services - life", default_gst: 18 },
    "999511": { title: "Telecommunication services", default_gst: 18 },
    "999621": { title: "Banking & financial services", default_gst: 18 },
    "999721": { title: "Healthcare services", default_gst: 0 }
  },
  goods: {
    "01": { title: "Live animals", default_gst: 0 },
    "21": { title: "Miscellaneous edible preparations", default_gst: 12 },
    "22": { title: "Beverages, spirits and vinegar", default_gst: 18 },
    "30": { title: "Pharmaceutical products", default_gst: 12 },
    "39": { title: "Plastics and articles thereof", default_gst: 18 },
    "48": { title: "Paper, paperboard and articles", default_gst: 12 },
    "61": { title: "Apparel and clothing accessories - knitted", default_gst: 5 },
    "62": { title: "Apparel and clothing accessories - non-knitted", default_gst: 5 },
    "64": { title: "Footwear", default_gst: 5 },
    "84": { title: "Machinery and mechanical appliances", default_gst: 18 },
    "8471": { title: "Computers and laptops", default_gst: 18 },
    "8517": { title: "Mobile phones and parts", default_gst: 12 },
    "85": { title: "Electrical machinery and equipment", default_gst: 18 },
    "87": { title: "Vehicles other than railway", default_gst: 28 },
    "94": { title: "Furniture, lamps, prefab buildings", default_gst: 18 },
    "95": { title: "Toys, games, sports requisites", default_gst: 12 },
    "9618": { title: "Tailors dummies and other lay figures", default_gst: 18 },
    "9619": { title: "Sanitary towels, napkins, tampons", default_gst: 12 },
    "9701": { title: "Paintings, drawings, pastels", default_gst: 12 },
    "9702": { title: "Original engravings, prints, lithographs", default_gst: 12 }
  }
};
function flattenHsn() {
  const out = [];
  for (const cat of ['services', 'goods']) {
    for (const code of Object.keys(HSN_DATA[cat])) {
      out.push({ code, type: cat === 'services' ? 'SAC' : 'HSN', ...HSN_DATA[cat][code] });
    }
  }
  return out;
}
const STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
  "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
  "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman and Diu", "26": "Dadra and Nagar Haveli",
  "27": "Maharashtra", "28": "Andhra Pradesh (Old)", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction"
};
function slugifyState(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function pageShell(opts) {
  const { title, description, canonical, jsonLd, h1, body } = opts;
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="author" content="ByteZBridge">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Y046ED257P"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-Y046ED257P');</script>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
<style>
body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:820px;margin:0 auto;padding:24px;color:#0F172A;line-height:1.6}
header{padding:16px 0;border-bottom:1px solid #E2E8F0;margin-bottom:32px}
header a{color:#4F46E5;text-decoration:none;font-weight:700}
h1{font-size:32px;line-height:1.2;margin:0 0 8px}
h2{font-size:22px;margin:28px 0 8px}
h3{font-size:18px;margin:20px 0 6px;color:#4338CA}
.meta{color:#64748B;font-size:14px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:10px 12px;border:1px solid #E2E8F0;text-align:left}
th{background:#F8FAFC}
.cta{display:inline-block;background:#4F46E5;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0}
.breadcrumb{font-size:13px;color:#64748B;margin-bottom:16px}
.breadcrumb a{color:#4F46E5;text-decoration:none}
.faq{background:#F8FAFC;padding:16px 20px;border-radius:12px;margin:8px 0}
.faq h3{margin-top:0;color:#0F172A}
footer{margin-top:48px;padding-top:24px;border-top:1px solid #E2E8F0;color:#64748B;font-size:13px;text-align:center}
.related{background:#EEF2FF;padding:16px 20px;border-radius:12px;margin:24px 0}
.related a{color:#4338CA;text-decoration:none;font-weight:500}
</style>
</head>
<body>
<header>
<a href="/">GST Invoice Generator</a> &nbsp;|&nbsp;
<a href="/hsn">HSN Codes</a> &nbsp;|&nbsp;
<a href="/gst-state-codes">State Codes</a> &nbsp;|&nbsp;
<a href="/install.html">Setup</a>
</header>
${h1 ? `<h1>${h1}</h1>` : ''}
${body}
<footer>
<p>(c) 2026 ByteZBridge - Made in Chennai - <a href="/" style="color:#4F46E5;text-decoration:none">gstinvoice.app</a></p>
<p>For accurate compliance always verify HSN/SAC codes and GST rates with your CA or the official CBIC notification.</p>
</footer>
</body>
</html>`;
}

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/admin/\nDisallow: /checkout.html\nDisallow: /success.html\n\nSitemap: https://gstinvoice.app/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://gstinvoice.app';
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: '/', priority: 1.0, changefreq: 'weekly' },
    { loc: '/install.html', priority: 0.8, changefreq: 'monthly' },
    { loc: '/hsn', priority: 0.9, changefreq: 'weekly' },
    { loc: '/gst-state-codes', priority: 0.9, changefreq: 'weekly' },
    { loc: '/gst-calculator', priority: 0.9, changefreq: 'weekly' },
    { loc: '/gstr-1-due-date', priority: 0.8, changefreq: 'monthly' },
    { loc: '/cgst-sgst-igst', priority: 0.8, changefreq: 'monthly' },
    { loc: '/place-of-supply', priority: 0.8, changefreq: 'monthly' },
    { loc: '/tally-alternative', priority: 0.7, changefreq: 'monthly' }
  ];
  flattenHsn().forEach(h => urls.push({ loc: `/hsn/${h.code}`, priority: 0.6, changefreq: 'monthly' }));
  Object.entries(STATE_CODES).forEach(([code, name]) => {
    urls.push({ loc: `/gst/${slugifyState(name)}`, priority: 0.6, changefreq: 'monthly' });
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${base}${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority.toFixed(1)}</priority></url>`).join('\n')}\n</urlset>`;
  res.type('application/xml').send(xml);
});

app.get('/hsn', (req, res) => {
  const all = flattenHsn();
  const services = all.filter(h => h.type === 'SAC');
  const goods = all.filter(h => h.type === 'HSN');
  const body = `<p class="meta">${all.length} HSN/SAC codes covering 90% of typical Indian business invoices.</p><a class="cta" href="/checkout.html">Get the GST Invoice Generator - rupees 9,999 lifetime</a><h2>SAC Codes (Services) - ${services.length}</h2><table><thead><tr><th>SAC Code</th><th>Service Description</th><th>GST Rate</th></tr></thead><tbody>${services.map(s => `<tr><td><a href="/hsn/${s.code}">${s.code}</a></td><td>${s.title}</td><td>${s.default_gst}%</td></tr>`).join('')}</tbody></table><h2>HSN Codes (Goods) - ${goods.length}</h2><table><thead><tr><th>HSN Code</th><th>Goods Description</th><th>GST Rate</th></tr></thead><tbody>${goods.map(g => `<tr><td><a href="/hsn/${g.code}">${g.code}</a></td><td>${g.title}</td><td>${g.default_gst}%</td></tr>`).join('')}</tbody></table>`;
  res.send(pageShell({ title: 'Complete HSN/SAC Code List for India (2026) - All GST Rates', description: `Searchable list of ${all.length}+ HSN and SAC codes used in Indian GST invoicing.`, canonical: 'https://gstinvoice.app/hsn', h1: 'Complete HSN / SAC Code List for India (2026)', body, jsonLd: { "@context": "https://schema.org", "@type": "WebPage", "name": "HSN SAC Code List India", "url": "https://gstinvoice.app/hsn" } }));
});

app.get('/hsn/:code', (req, res) => {
  const code = String(req.params.code).trim();
  const match = flattenHsn().find(h => h.code === code);
  if (!match) {
    return res.status(404).send(pageShell({ title: `HSN code ${code} not found`, description: `HSN/SAC ${code} not in our list.`, canonical: `https://gstinvoice.app/hsn/${code}`, h1: `HSN code ${code} - not in database yet`, body: `<p>We don't have detailed info for ${code} yet. Our Claude plugin auto-suggests the right code from any description.</p><a class="cta" href="/checkout.html">Generate compliant invoices</a><p><a href="/hsn">All codes we cover</a></p>` }));
  }
  const isService = match.type === 'SAC';
  const gst = match.default_gst;
  const cgst = (gst / 2).toFixed(2);
  const sgst = (gst / 2).toFixed(2);
  const exampleAmount = 10000;
  const exampleTax = exampleAmount * gst / 100;
  const sampleText = isService ? `Raise an invoice for client name, rupees ${exampleAmount.toLocaleString('en-IN')}, ${match.title.toLowerCase()}, [their city]` : `Sold ${match.title.toLowerCase()} to client, rupees ${exampleAmount.toLocaleString('en-IN')}, [their city]`;
  const body = `<div class="breadcrumb"><a href="/">Home</a> &gt; <a href="/hsn">All HSN Codes</a> &gt; ${match.code}</div><p class="meta">${isService ? 'SAC' : 'HSN'} code - GST rate ${gst}% - Updated FY 2026-27</p><h2>What is ${isService ? 'SAC' : 'HSN'} code ${match.code}?</h2><p><strong>${match.code}</strong> is the official ${isService ? 'Service Accounting Code' : 'Harmonized System of Nomenclature code'} used in Indian GST returns for <strong>${match.title}</strong>. Every invoice for this ${isService ? 'service' : 'goods'} category must include this code under Rule 46 of the CGST Rules.</p><h2>GST rate for ${match.code}</h2><table><tr><th>Tax type</th><th>Rate</th><th>On rupees ${exampleAmount.toLocaleString('en-IN')}</th></tr><tr><td>CGST + SGST (intra-state)</td><td>${cgst}% + ${sgst}%</td><td>rupees ${(exampleTax/2).toFixed(2)} + rupees ${(exampleTax/2).toFixed(2)} = rupees ${exampleTax.toFixed(2)}</td></tr><tr><td>IGST (inter-state)</td><td>${gst}%</td><td>rupees ${exampleTax.toFixed(2)}</td></tr><tr><td><strong>Total invoice</strong></td><td>-</td><td><strong>rupees ${(exampleAmount + exampleTax).toFixed(2)}</strong></td></tr></table><h2>How to use ${match.code} on a tax invoice</h2><p>With our Claude AI plugin, just type:</p><div class="faq" style="font-family:monospace;font-size:14px">${sampleText}</div><p>...and the plugin auto-fills <strong>${match.code}</strong> with the correct ${gst}% GST split based on the customer's state.</p><a class="cta" href="/checkout.html">Get the plugin - rupees 9,999 lifetime</a><h2>FAQs about ${match.code}</h2><div class="faq"><h3>Is ${match.code} the same as my product/service code?</h3><p>${match.code} covers <strong>${match.title}</strong>. If your offering matches, this code applies. When in doubt, refer to the official CBIC ${isService ? 'Service Tax Schedule' : 'HSN tariff'} or ask your CA.</p></div><div class="faq"><h3>What is the GST rate I should charge?</h3><p>The standard rate for ${match.code} is <strong>${gst}%</strong> (split as ${cgst}% CGST + ${sgst}% SGST intra-state, or ${gst}% IGST inter-state).</p></div><div class="faq"><h3>Do I need to mention ${match.code} on every invoice?</h3><p>Yes - Rule 46 of the CGST Rules makes the HSN/SAC code mandatory on tax invoices if your turnover exceeds rupees 1.5 crore (4-digit min) or rupees 5 crore (6-digit min).</p></div><div class="related"><strong>Related:</strong> <a href="/cgst-sgst-igst">CGST vs SGST vs IGST</a> - <a href="/place-of-supply">Place of supply</a> - <a href="/gst-calculator">GST calculator</a> - <a href="/hsn">All HSN codes</a></div>`;
  res.send(pageShell({ title: `${isService ? 'SAC' : 'HSN'} Code ${match.code} - ${match.title} | GST Rate ${gst}% | ByteZBridge`, description: `${isService ? 'SAC' : 'HSN'} code ${match.code} (${match.title}) attracts ${gst}% GST. CGST+SGST split, sample invoice text, AI plugin that auto-fills this in 30 seconds.`, canonical: `https://gstinvoice.app/hsn/${match.code}`, h1: `${isService ? 'SAC' : 'HSN'} Code ${match.code} - ${match.title}`, body, jsonLd: { "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [{ "@type": "Question", "name": `What is the GST rate for ${match.code}?`, "acceptedAnswer": { "@type": "Answer", "text": `The GST rate for ${match.code} (${match.title}) is ${gst}%, split as ${cgst}% CGST + ${sgst}% SGST intra-state, or ${gst}% IGST inter-state.` } }] } }));
});

app.get('/gst-state-codes', (req, res) => {
  const states = Object.entries(STATE_CODES).map(([code, name]) => ({ code, name, slug: slugifyState(name) }));
  const body = `<p class="meta">All ${states.length} GST state codes used in GSTIN format and place-of-supply rules.</p><a class="cta" href="/checkout.html">Auto-detect state from GSTIN with our plugin</a><table><thead><tr><th>Code</th><th>State / UT</th><th>Detail page</th></tr></thead><tbody>${states.map(s => `<tr><td>${s.code}</td><td>${s.name}</td><td><a href="/gst/${s.slug}">View</a></td></tr>`).join('')}</tbody></table><div class="related"><strong>How is the state code used?</strong> The first 2 digits of any GSTIN tell you the state. Same state means CGST+SGST. Different state means IGST.</div>`;
  res.send(pageShell({ title: 'All Indian GST State Codes (2026) - Complete List for GSTIN | ByteZBridge', description: 'All 36 Indian state and UT codes used in GST. Code, place-of-supply rules, how to use them. Free reference.', canonical: 'https://gstinvoice.app/gst-state-codes', h1: 'Indian GST State Codes - Complete 2026 List', body }));
});

app.get('/gst/:slug', (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const entry = Object.entries(STATE_CODES).find(([_, n]) => slugifyState(n) === slug);
  if (!entry) {
    return res.status(404).send(pageShell({ title: 'State not found', description: 'State page not found.', canonical: `https://gstinvoice.app/gst/${slug}`, h1: 'State page not found', body: `<p><a href="/gst-state-codes">See all 36 Indian states</a></p>` }));
  }
  const [code, name] = entry;
  const sampleGstin = `${code}AABCT1234D1Z9`;
  const body = `<div class="breadcrumb"><a href="/">Home</a> &gt; <a href="/gst-state-codes">State Codes</a> &gt; ${name}</div><p class="meta">State code <strong>${code}</strong> - Used in GSTIN, GSTR-1, place-of-supply</p><h2>What is the GST state code for ${name}?</h2><p>The GST state code for <strong>${name}</strong> is <strong>${code}</strong>. This is the first 2 digits of every GSTIN registered in ${name}.</p><h2>Sample GSTIN with state code ${code}</h2><div class="faq" style="font-family:monospace;font-size:16px;text-align:center">${sampleGstin}</div><p style="font-size:14px;color:#64748B">First 2 digits = state code (${code}) - Next 10 = PAN - 13th = entity - 14th = Z - 15th = checksum.</p><h2>When does ${name} GST trigger CGST+SGST vs IGST?</h2><p>If your business is in ${name} and your customer GSTIN starts with <strong>${code}</strong>, supply is intra-state - charge CGST+SGST. Different code means IGST.</p><a class="cta" href="/checkout.html">Auto-detect from GSTIN - rupees 9,999 lifetime</a><div class="related"><strong>See also:</strong> <a href="/cgst-sgst-igst">CGST vs SGST vs IGST</a> - <a href="/place-of-supply">Place of supply</a> - <a href="/gst-state-codes">All state codes</a></div>`;
  res.send(pageShell({ title: `${name} GST State Code ${code} - Complete 2026 Guide | ByteZBridge`, description: `GST state code for ${name} is ${code}. Sample GSTIN, when to apply CGST+SGST vs IGST, auto-detect in invoices.`, canonical: `https://gstinvoice.app/gst/${slug}`, h1: `${name} GST State Code: ${code}`, body }));
});

app.get('/gst-calculator', (req, res) => {
  const body = `<p class="meta">Free GST calculator - instantly split CGST/SGST/IGST on any amount.</p><div style="background:#F8FAFC;padding:24px;border-radius:12px;margin:24px 0"><label style="display:block;margin-bottom:8px;font-weight:600">Amount (rupees, before GST):</label><input id="amt" type="number" value="10000" style="width:100%;padding:10px;font-size:16px;border:1px solid #E2E8F0;border-radius:8px;margin-bottom:16px" oninput="calc()"><label style="display:block;margin-bottom:8px;font-weight:600">GST rate (%):</label><select id="rate" style="width:100%;padding:10px;font-size:16px;border:1px solid #E2E8F0;border-radius:8px;margin-bottom:16px" onchange="calc()"><option value="5">5%</option><option value="12">12%</option><option value="18" selected>18%</option><option value="28">28%</option></select><label><input type="radio" name="type" value="intra" checked onchange="calc()"> Intra-state (CGST + SGST)</label> &nbsp;&nbsp;<label><input type="radio" name="type" value="inter" onchange="calc()"> Inter-state (IGST)</label><div id="out" style="background:#fff;padding:16px;border-radius:8px;margin-top:16px;font-family:monospace;font-size:15px;white-space:pre-line"></div></div><script>function calc(){const a=parseFloat(document.getElementById('amt').value)||0;const r=parseFloat(document.getElementById('rate').value);const t=document.querySelector('input[name=type]:checked').value;const tax=a*r/100;let o='';if(t==='intra'){o='Taxable: rupees '+a.toFixed(2)+'\\nCGST ('+(r/2)+'%): rupees '+(tax/2).toFixed(2)+'\\nSGST ('+(r/2)+'%): rupees '+(tax/2).toFixed(2);}else{o='Taxable: rupees '+a.toFixed(2)+'\\nIGST ('+r+'%): rupees '+tax.toFixed(2);}o+='\\n--------\\nTotal: rupees '+(a+tax).toFixed(2);document.getElementById('out').textContent=o;}calc();</script><a class="cta" href="/checkout.html">Skip calculators - get auto-invoices in 30 sec</a><h2>How does GST work in India?</h2><p>GST splits into 3 components: <strong>CGST</strong> (central), <strong>SGST</strong> (state), <strong>IGST</strong> (integrated, for inter-state). Same state means CGST+SGST. Different states means IGST.</p>`;
  res.send(pageShell({ title: 'Free GST Calculator (CGST + SGST + IGST) - Instant Split | ByteZBridge', description: 'Free Indian GST calculator. Enter amount and rate, get instant CGST/SGST split or IGST. 5%, 12%, 18%, 28% supported.', canonical: 'https://gstinvoice.app/gst-calculator', h1: 'Free GST Calculator (India)', body, jsonLd: { "@context": "https://schema.org", "@type": "WebApplication", "name": "GST Calculator", "applicationCategory": "FinanceApplication", "operatingSystem": "Web", "offers": { "@type": "Offer", "price": "0", "priceCurrency": "INR" } } }));
});

app.get('/cgst-sgst-igst', (req, res) => {
  const body = `<p class="meta">Updated FY 2026-27 - 6-min read</p><p>If you've ever raised an invoice in India and stared at the screen wondering whether to split your tax into CGST+SGST or just IGST, you're not alone. This is the #1 mistake on Indian tax invoices.</p><h2>The 30-second rule</h2><p><strong>Same state means CGST + SGST. Different states means IGST.</strong> The total tax is the same, only the split changes.</p><table><tr><th>Scenario</th><th>Supplier state</th><th>Customer state</th><th>Tax type</th></tr><tr><td>Chennai to Chennai</td><td>33 (TN)</td><td>33 (TN)</td><td>CGST + SGST</td></tr><tr><td>Chennai to Mumbai</td><td>33 (TN)</td><td>27 (MH)</td><td>IGST</td></tr><tr><td>Bangalore to US customer</td><td>29 (KA)</td><td>97 (Other)</td><td>IGST 0% (LUT)</td></tr></table><h2>The math (rupees 10,000 at 18%)</h2><table><tr><th>Type</th><th>Rate</th><th>Amount</th></tr><tr><td>CGST (intra)</td><td>9%</td><td>rupees 900</td></tr><tr><td>SGST (intra)</td><td>9%</td><td>rupees 900</td></tr><tr><td>IGST (inter)</td><td>18%</td><td>rupees 1,800</td></tr><tr><td><strong>Total tax (either way)</strong></td><td>-</td><td><strong>rupees 1,800</strong></td></tr></table><h2>How to figure out the state from a GSTIN</h2><p><strong>The first 2 digits of any GSTIN are the state code.</strong> Examples: 27AAACR5055K1ZV means 27 = Maharashtra. 33AABCT1234D1Z9 means 33 = Tamil Nadu.</p><a class="cta" href="/checkout.html">Skip the manual logic - auto-split with our plugin</a><div class="related"><strong>Related:</strong> <a href="/place-of-supply">Place of supply</a> - <a href="/gst-calculator">GST calculator</a> - <a href="/gst-state-codes">All state codes</a></div>`;
  res.send(pageShell({ title: 'CGST vs SGST vs IGST - Complete Guide with Examples (2026) | ByteZBridge', description: 'When to charge CGST + SGST vs IGST on Indian GST invoices. Complete examples, formula, and the #1 mistake to avoid. FY 2026-27.', canonical: 'https://gstinvoice.app/cgst-sgst-igst', h1: 'CGST vs SGST vs IGST - Complete Guide', body }));
});

app.get('/gstr-1-due-date', (req, res) => {
  const today = new Date();
  const m = today.getMonth();
  const y = today.getFullYear();
  const nextDue = new Date(y, m + 1, 11);
  const niceDate = nextDue.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const body = `<p class="meta">Updated daily - For monthly filers</p><div style="background:#FEF3C7;padding:20px;border-radius:12px;text-align:center;font-size:24px;font-weight:700;color:#92400E;margin:24px 0">Next GSTR-1 due: ${niceDate}</div><a class="cta" href="/checkout.html">Auto-prepare GSTR-1 ledger every month</a><h2>Standard GSTR-1 due dates</h2><table><tr><th>Filer type</th><th>Frequency</th><th>Due date</th></tr><tr><td>Turnover &gt; rupees 5 Cr (monthly)</td><td>Monthly</td><td>11th of next month</td></tr><tr><td>Turnover up to rupees 5 Cr (QRMP)</td><td>Quarterly</td><td>13th of month after quarter end</td></tr></table><h2>What if I miss the due date?</h2><p>Late fee: rupees 50/day for nil return, rupees 200/day otherwise. Capped at rupees 10,000 per return per Act.</p>`;
  res.send(pageShell({ title: `GSTR-1 Due Date for ${niceDate} - Live Countdown | ByteZBridge`, description: `Next GSTR-1 due ${niceDate}. Late fee rupees 50-200/day. Auto-prepare GSTR-1 ledger with our Claude plugin.`, canonical: 'https://gstinvoice.app/gstr-1-due-date', h1: 'GSTR-1 Due Date - Next Filing', body }));
});

app.get('/place-of-supply', (req, res) => {
  const body = `<p class="meta">10-min read - Section 10-13 of IGST Act - Updated 2026</p><p>"Place of supply" is the most-misunderstood concept in Indian GST. Get it wrong then wrong tax type then GSTR-2A mismatch then ITC blocked.</p><h2>The default rule (goods)</h2><p>Place of supply = location where goods are <em>delivered</em> (Section 10(1)(a) of IGST Act).</p><h2>The default rule (services)</h2><p>For B2B services: customer registered address (Section 12(2)(a)). For B2C services: supplier location (Section 12(2)(b)).</p><h2>The 10 special cases for services</h2><table><tr><th>Service type</th><th>Place of supply</th></tr><tr><td>Real estate / construction</td><td>Where property is located</td></tr><tr><td>Restaurant / catering</td><td>Where service performed</td></tr><tr><td>Training / events</td><td>Where event held</td></tr><tr><td>Transportation of goods</td><td>Destination of goods</td></tr><tr><td>Telecom / DTH</td><td>Customer billing address</td></tr><tr><td>Banking / insurance</td><td>Customer location on records</td></tr><tr><td>Online services to overseas customer</td><td>Overseas (97 - export)</td></tr></table><a class="cta" href="/checkout.html">Auto-detect place of supply with our plugin</a>`;
  res.send(pageShell({ title: 'Place of Supply Rules in GST - Complete Guide (Section 10-13 IGST Act)', description: 'Place of supply rules for goods and services under Indian GST. All 10 special cases, default rules, intra-state vs inter-state.', canonical: 'https://gstinvoice.app/place-of-supply', h1: 'Place of Supply Rules - Complete Guide', body }));
});

app.get('/tally-alternative', (req, res) => {
  const body = `<p class="meta">Comparison updated May 2026</p><p>Tally is the default Indian accounting software, but it is a heavy desktop install with a learning curve. Here's how the new generation compares for GST invoicing.</p><table><tr><th>Feature</th><th>Tally Prime</th><th>Zoho Books</th><th>ByteZBridge GST Generator</th></tr><tr><td>Pricing</td><td>rupees 15,000/year</td><td>rupees 6,000/year</td><td><strong>rupees 9,999 lifetime</strong></td></tr><tr><td>Setup time</td><td>1-2 days (CA)</td><td>30 min</td><td><strong>5 min</strong></td></tr><tr><td>Where it runs</td><td>Windows desktop</td><td>Cloud</td><td>Inside Claude (web/desktop/mobile)</td></tr><tr><td>Auto CGST/SGST/IGST split</td><td>Manual config</td><td>Yes</td><td><strong>Auto from GSTIN</strong></td></tr><tr><td>HSN code suggestion</td><td>Manual</td><td>Manual</td><td><strong>AI auto-suggest</strong></td></tr><tr><td>Multi-currency exports</td><td>Add-on</td><td>Yes</td><td><strong>Built-in v1.2</strong></td></tr><tr><td>GSTR-1 ready ledger</td><td>Yes</td><td>Yes</td><td><strong>Auto-appended every invoice</strong></td></tr><tr><td>Bulk CSV import</td><td>Manual</td><td>Yes</td><td><strong>40 invoices in one shot</strong></td></tr></table><h2>When to switch to ByteZBridge</h2><p>Freelancer, agency, CA managing 10-50 clients, SaaS founder - our Claude plugin is purpose-built for invoice generation. rupees 9,999 once vs rupees 75,000 over 5 years for Tally.</p><a class="cta" href="/checkout.html">Try ByteZBridge - rupees 9,999 lifetime</a>`;
  res.send(pageShell({ title: 'Best Tally Alternative for GST Invoicing in 2026 (rupees 9,999 lifetime) | ByteZBridge', description: 'Comparison: Tally vs Zoho Books vs ByteZBridge GST Generator. Pricing, features, setup. Why Indian freelancers and CAs are switching.', canonical: 'https://gstinvoice.app/tally-alternative', h1: 'Best Tally Alternative for GST Invoicing (2026)', body }));
});

// ============================================================================
// END SEO routes
// ============================================================================


app.listen(PORT, () => {
  console.log(`✅ Payment server listening on :${PORT}`);
  console.log(`   Mode: ${process.env.RAZORPAY_KEY_ID.startsWith('rzp_test') ? '🧪 TEST' : '💵 LIVE'}`);
  console.log(`   Public base: ${process.env.PUBLIC_BASE_URL}`);
});
