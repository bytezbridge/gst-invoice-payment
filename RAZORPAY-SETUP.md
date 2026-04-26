# Razorpay Setup — Step-by-Step Walkthrough

> **Goal:** Go from zero to accepting your first ₹9,999 payment in ~90 minutes.
> Everything below is in the order you must do it. Don't skip steps — Razorpay's KYC has a specific sequence.

---

## What you need before starting

- [ ] **PAN card** (yours, if proprietorship; or company PAN if pvt ltd)
- [ ] **GSTIN** (recommended — gets you lower fees + invoicing)
- [ ] **Bank account** (current account preferred; savings works for proprietorship)
- [ ] **Cancelled cheque OR bank statement** (front page)
- [ ] **Aadhaar** (linked with PAN — verified via UIDAI online)
- [ ] **Address proof** (Aadhaar / utility bill / rental agreement)
- [ ] **Business website live** (Razorpay needs to see a real site — your Vercel-deployed `landing-page.html` is enough)
- [ ] **All four legal pages** (`terms`, `privacy`, `refund`, `contact`) live on the website — Razorpay rejects without these

If you don't have all of the above yet, fix them first. Razorpay KYC takes 2–4 business days; you don't want to redo it.

---

## Phase 1: Create Razorpay account & get TEST keys (10 min)

### Step 1.1 — Sign up
1. Go to [razorpay.com](https://razorpay.com) → "Sign Up"
2. Use the email you'll actually monitor (`r.balaganapathi@gmail.com`)
3. Choose business type: **"Individual / Proprietorship"** (cheapest, fastest KYC) unless you have a registered company
4. Fill business name (your own name if proprietorship), website URL (your Vercel landing page), industry: "Software / SaaS"

### Step 1.2 — Grab TEST keys (instant, no KYC needed)
1. Dashboard → top-right → switch to **Test Mode**
2. Settings → API Keys → **"Generate Test Key"**
3. Copy both `key_id` (starts with `rzp_test_`) and `key_secret`
4. Paste into `payment/.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_YOUR_KEY
   RAZORPAY_KEY_SECRET=YOUR_SECRET
   ```

You can now run the server in test mode. Razorpay's test cards (in their docs) work; no real money moves.

### Step 1.3 — Test the integration end-to-end
```bash
cd payment
npm install
node server.js
```

In another terminal, hit the health endpoint:
```bash
curl http://localhost:3000/api/health
```

Open `http://localhost:3000/checkout.html` (you'll need to wire static serving — see "Static files" section below) and try a test purchase using:
- Card: `4111 1111 1111 1111` · CVV any · Expiry any future date
- UPI: `success@razorpay`

If the success page loads and you got an email — celebrate. The plumbing works.

---

## Phase 2: Complete KYC for LIVE mode (2–4 business days)

This is the longest step but the most important. Don't try to skip — Razorpay's compliance is strict because they're RBI-regulated.

### Step 2.1 — Submit KYC documents
Dashboard → "Activate Account" → step-by-step form. You'll upload:

| Document | What it is |
|---|---|
| PAN card | Front photo, clear |
| Aadhaar | Front + back; UIDAI auto-verifies |
| Cancelled cheque | Front page with name + IFSC visible |
| GST certificate | If you have GSTIN |
| Address proof | Utility bill / Aadhaar / rental agreement (last 3 months) |

### Step 2.2 — Verify your business website
Razorpay reviews your live site. **Common rejection reasons:**

❌ No "Refund Policy" page → use `legal/refund-policy.md`
❌ No "Privacy Policy" page → use `legal/privacy-policy.md`
❌ No "Terms & Conditions" page → use `legal/terms-and-conditions.md`
❌ No "Contact Us" with physical address → add to your landing page footer
❌ Pricing not visible without login → Razorpay must see prices upfront
❌ No clear product description → your landing page already has this

✅ **Solution:** Deploy `legal/` folder pages alongside your landing page. Sample URL structure:
- `your-landing-page.com` (landing)
- `your-landing-page.com/terms` (terms-and-conditions.md → terms.html)
- `your-landing-page.com/privacy` (privacy-policy.md → privacy.html)
- `your-landing-page.com/refund` (refund-policy.md → refund.html)
- `your-landing-page.com/contact` (with email + address)

### Step 2.3 — Wait
Razorpay reviews in 1–4 business days. They email if anything is missing. Approval status visible in dashboard.

While waiting:
- Build the rest of your launch (Phase 3 below)
- Test more in TEST mode
- Polish your landing page

---

## Phase 3: Configure plans & webhooks (15 min, after KYC approved)

### Step 3.1 — Create Subscription Plans
Recurring billing for Starter and Pro tiers.

1. Dashboard → **Subscriptions → Plans → Create Plan**
2. Create **two plans:**

**Starter Monthly:**
- Plan name: `GST Invoice Starter`
- Plan ID (auto): copy this — looks like `plan_PXXXXXXX`
- Billing frequency: Monthly
- Amount: ₹799
- Period: 1 Month
- Total billing cycles: 120 (10 years cap; users cancel any time)

**Pro Monthly:**
- Plan name: `GST Invoice Pro`
- Plan ID: copy
- Amount: ₹2,499
- Period: 1 Month
- Total billing cycles: 120

3. Paste the plan IDs into `.env`:
```
RAZORPAY_PLAN_STARTER_MONTHLY=plan_PYZ123
RAZORPAY_PLAN_PRO_MONTHLY=plan_PYZ456
```

### Step 3.2 — Create Webhook
This is how renewals, refunds, and failures notify your server.

1. Dashboard → **Settings → Webhooks → Add New Webhook**
2. Webhook URL: `https://api.your-landing-page.com/api/webhook/razorpay`
   (Use your live HTTPS URL. For testing, use ngrok: `ngrok http 3000` → use the https URL it gives you.)
3. Active events (check ALL of these):
   - `payment.captured`
   - `payment.failed`
   - `subscription.charged`
   - `subscription.cancelled`
   - `subscription.halted`
   - `subscription.completed`
   - `refund.processed`
4. Webhook Secret: Generate a long random string:
   ```bash
   openssl rand -hex 32
   ```
   Copy the output. Paste it into BOTH:
   - The Razorpay webhook setup form
   - Your `.env`:
     ```
     RAZORPAY_WEBHOOK_SECRET=<the random string>
     ```
5. Save webhook → Razorpay sends a "webhook.test" ping to verify the URL is reachable.

### Step 3.3 — Switch to LIVE keys
1. Dashboard → top-right → switch to **Live Mode**
2. Settings → API Keys → **Generate Live Key** (visible only once — copy carefully!)
3. Update `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_live_YOUR_KEY
   RAZORPAY_KEY_SECRET=YOUR_LIVE_SECRET
   ```
4. Restart `node server.js` — startup log should print `💵 LIVE`

---

## Phase 4: Set up payouts (5 min)

By default Razorpay holds your money for 2–7 days then deposits to your bank.

1. Dashboard → **Settings → Banking → Bank Accounts**
2. Add your bank account (must match the cancelled cheque you uploaded for KYC)
3. Verify with the auto-deposit (Razorpay sends ₹1; you confirm the amount)
4. **Optional:** Settings → Banking → **Settlement Schedule** → set to "T+2" (Daily, 2 days after capture). T+1 requires "Smart Settlements" upgrade.

### Fees you'll pay (good to know)
- **UPI / RuPay debit:** 0% (RBI-mandated)
- **Domestic credit/debit cards:** 2% + GST
- **Net banking:** 1.9% + GST
- **International cards:** 3% + GST + cross-border fee
- **GST invoice from Razorpay:** monthly auto-issued

If you have GSTIN registered, claim ITC on Razorpay fees in your GSTR-3B — saves ~18% on fees.

---

## Phase 5: Production deployment (30 min)

### Step 5.1 — Deploy server.js
**Option A: Railway** (easiest, free tier sufficient for first 100 sales)
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Push your `payment/` folder to a private GitHub repo
3. Connect Railway → auto-detects Node.js → deploys
4. Add environment variables (everything from `.env`) in Railway dashboard
5. Get the public URL: `your-app.up.railway.app`

**Option B: Render** (similar UX)
1. [render.com](https://render.com) → New Web Service → Connect GitHub
2. Build command: `npm install`
3. Start command: `node server.js`
4. Add env vars

**Option C: VPS (DigitalOcean / Hetzner)** (if you want full control)
- Cheapest: Hetzner CX22, ~₹400/mo
- Use PM2 to run + nginx for SSL
- See `payment/scripts/deploy-vps.sh` (TODO: not included; ask if you want it)

### Step 5.2 — Set up custom domain
1. In Railway/Render → "Custom Domain" → enter `api.your-landing-page.com`
2. Add a CNAME record in your DNS provider:
   ```
   api    CNAME    your-app.up.railway.app
   ```
3. Wait 5–10 min for DNS + auto-SSL provisioning

### Step 5.3 — Update Razorpay webhook URL
Razorpay dashboard → Webhooks → edit → change to `https://api.your-landing-page.com/api/webhook/razorpay`

### Step 5.4 — Update PUBLIC_BASE_URL
In Railway/Render env vars, update:
```
PUBLIC_BASE_URL=https://api.your-landing-page.com
```

### Step 5.5 — Deploy the deliverable zip
The buyer-facing zip (the actual plugin) needs to live on the server.

```bash
cd /path/to/gst-invoice-generator-plugin
# Build the buyer zip (excludes /payment, /distribution, .env)
zip -r deliverables/gst-invoice-generator-v1.0.0.zip \
  SKILL.md plugin.json README.md \
  scripts/ templates/ data/ samples/sample_invoice.json \
  -x "*.pyc" "__pycache__/*"
```

Upload to your server's `payment/deliverables/` folder. Verify:
```bash
curl -I https://api.your-landing-page.com/api/health
# Should return 200
```

---

## Phase 6: Live test purchase (5 min)

Before launching publicly, do a real ₹9,999 purchase on yourself (you can refund it after).

1. Open `https://your-landing-page.com/checkout.html`
2. Select Lifetime tier
3. Use your real card / UPI
4. Verify:
   - [ ] Razorpay popup appears
   - [ ] Payment succeeds
   - [ ] Success page shows licence key + download button
   - [ ] Email arrives within 30 seconds with the same info
   - [ ] Download link works → `gst-invoice-generator.zip` downloads
   - [ ] Razorpay dashboard → Payments → shows the captured payment
   - [ ] Slack/Discord webhook fires (if configured)
5. Refund yourself: Razorpay dashboard → click the payment → Refund → Process now

If anything fails, debug before launching.

---

## Phase 7: Launch playbook (next document)

Once you've completed Phases 1–6, you have a fully operational payment + delivery pipeline.

Read **`LAUNCH-GUIDE.md`** in the root of this package for the actual go-to-market playbook (ProductHunt, Twitter, IndieHackers, Reddit, WhatsApp, content calendar).

---

## Common errors & fixes

| Error | Cause | Fix |
|---|---|---|
| "Webhook signature mismatch" | `RAZORPAY_WEBHOOK_SECRET` differs from dashboard | Re-copy from Razorpay dashboard |
| "Payment captured but no email" | `RESEND_API_KEY` invalid | Check Resend dashboard, regenerate key |
| "Plan ID not found" | `RAZORPAY_PLAN_STARTER_MONTHLY` placeholder | Create plan in Razorpay dashboard, paste real ID |
| "CORS error" in browser | `CORS_ORIGINS` doesn't include your site | Add `https://your-landing-page.com` |
| "Rate limited" on `/checkout/create-order` | More than 10 requests/min/IP | Either real abuse or your testing — adjust the limiter |
| KYC rejected | Missing legal page or unreachable phone | Fix and resubmit (no penalty) |
| Webhook URL "verification failed" | Server not publicly reachable | Use ngrok for local; deploy to live for prod |
| "Invalid signature" on `/checkout/verify` | Test/Live key mismatch | Make sure server and frontend both use TEST or both use LIVE |

---

## Pre-launch checklist

- [ ] Test mode working end-to-end
- [ ] KYC submitted and approved
- [ ] Live keys configured
- [ ] Webhook live URL configured + Razorpay confirms healthy
- [ ] Subscription plans created in dashboard, IDs in `.env`
- [ ] Server deployed at `api.your-landing-page.com` with HTTPS
- [ ] All 4 legal pages live (terms / privacy / refund / contact)
- [ ] One real ₹9,999 self-test purchase succeeded + refunded
- [ ] Email delivery tested (Resend)
- [ ] Bank settlements going through

When all 9 boxes are checked, you're ready to launch.
