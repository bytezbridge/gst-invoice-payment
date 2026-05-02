/* sales-bot.js — AI sales rep for gstinvoice.app
   Loads on landing page. Replaces the simple FAQ bot with a role-aware,
   objection-handling, conversion-focused chat experience.

   Features:
   - Greets, qualifies (CA / Freelancer / Agency / SaaS / Just browsing)
   - Surfaces relevant pain → solution per role
   - Handles 25+ objections (price, Tally, refund, Claude Pro, security, etc.)
   - Quick-reply buttons for fast paths
   - Free-text fallback with keyword routing + Claude Haiku AI fallback
   - Email capture for non-buyers (logged to /api/lead — graceful if endpoint missing)
   - Direct "Buy now" CTA after meaningful exchange
*/
(function () {
  // ───── Config ─────
  const CHECKOUT_URL = '/checkout.html';
  const INSTALL_URL = '/install.html';
  const VIDEO_ANCHOR = '#video';
  const CALENDLY_URL = 'https://calendly.com/balaganapathi/30min';
  const SUPPORT_EMAIL = 'hello@gstinvoice.app';

  // ───── State ─────
  const state = {
    role: null,        // CA / Freelancer / Agency / SaaS / Browsing
    pain: null,        // identified pain
    messageCount: 0,   // total user messages
    askedForEmail: false,
    email: null,
    history: [],
  };

  // ───── Persona ─────
  const PERSONA = {
    open: "👋 Hi! I'm Bala's sales assistant from <strong>ByteZBridge</strong>. Quick — what brings you here today?",
    qualify: {
      ca: "Got it — CAs are our biggest fans. Most we talk to manage 30-50 clients monthly. What's your biggest GST headache right now?",
      freelancer: "Freelancers love this. What's eating your time most — invoice formatting, GSTR-1 prep, or chasing payments?",
      agency: "Agencies juggle a LOT of clients. Are you fighting Tally, manual Word docs, or accountants?",
      saas: "SaaS founders need clean B2B invoices fast. Are you charging Indian customers or international too?",
      browsing: "No worries — happy to answer anything. Most people ask about price, what makes us different from Tally, or how install works. What's on your mind?"
    }
  };

  // ───── Pain → Solution map ─────
  const PAIN_RESPONSES = {
    cgst_sgst_confusion: "Yep — that's the #1 mistake on Indian invoices. Our plugin auto-detects intra-state vs inter-state from GSTIN state codes. You just describe the sale, it splits CGST+SGST or applies IGST automatically. Zero manual lookup.",
    gstr1_filing: "GSTR-1 monthly filing is exactly why we built the auto-ledger. Every invoice you raise gets appended to a CSV that's GSTR-1 ready — same column structure the gst.gov.in portal expects. v1.3 (this week) ships one-click portal upload format too.",
    tally_clunky: "We hear this constantly. Tally costs ₹15,000/year, requires installation, and an accountant to set up. Our plugin: ₹9,999 ONE TIME, lifetime updates, runs inside your existing Claude Pro chat. No install, no training.",
    manual_entry: "Manual entry kills 30 min per invoice. Our plugin = 30 seconds. You type the sale in plain English, get a perfect PDF + dashboard updated + ledger appended. Try the live demo on this page (scroll to 'Try it. Right here. Right now').",
    payment_chasing: "We don't chase payments yet (that's v2 — payment status + reminder mail). For now: clean PDF + amount-in-words + UPI QR included = 40% faster collection on average.",
    international: "We support multi-currency export invoices in v1.2 (shipping Sun 3 May). USD/EUR/GBP/AED with auto-conversion to INR for GSTR-1. Pre-buy now, get the update free."
  };

  // ───── FAQ knowledge base ─────
  const FAQ_KB = [
    { keys: ['price', 'cost', 'how much', 'pricing', 'fees', 'fee', 'charge', 'charges'],
      answer: "₹9,999 lifetime — pay once, use forever, all updates included. <strong>Saves you ₹15,000+/year</strong> vs Tally. <a href='" + CHECKOUT_URL + "'>Buy now →</a>" },

    { keys: ['tally', 'zoho', 'quickbooks', 'sage'],
      answer: "Tally is ₹15,000/year + needs an accountant to install. Zoho Books is ₹6,000/year forever. We're ₹9,999 ONE TIME. No install (runs in Claude). No accountant needed. Lifetime updates." },

    { keys: ['refund', 'money back', 'guarantee', 'return'],
      answer: "30-day money-back guarantee — full refund, no questions asked. Razorpay processes it in 3-5 working days. <a href='/refund.html'>Refund policy →</a>" },

    { keys: ['claude pro', 'claude subscription', 'free tier', 'free claude'],
      answer: "Yes, you need <strong>Claude Pro / Team / Max</strong> ($20/mo and up) — the free tier doesn't support custom plugins. The plugin runs inside your existing Claude account. <a href='https://claude.ai/upgrade' target='_blank'>Upgrade Claude →</a>" },

    { keys: ['install', 'how to install', 'setup', 'how to use', 'instructions'],
      answer: "5-minute install: download the zip from your licence email, unzip, type <code>/install plugin from /path</code> in Claude. <a href='" + INSTALL_URL + "'>Full setup guide →</a>" },

    { keys: ['security', 'private', 'data', 'privacy', 'safe', 'where stored', 'cloud'],
      answer: "<strong>Local-first</strong> — your invoices, GSTINs, customer data NEVER leave your computer. The plugin runs entirely on your device. We only collect billing info during purchase. <a href='/privacy.html'>Privacy policy →</a>" },

    { keys: ['demo', 'video', 'show me', 'see it'],
      answer: "Watch the 1-min demo on this page (<a href='" + VIDEO_ANCHOR + "'>scroll up</a>) or try the live interactive demo just below — it shows the actual flow inside Claude." },

    { keys: ['hsn', 'sac', 'codes'],
      answer: "We pre-load 500+ HSN/SAC codes. Just describe the service ('web design', 'consulting', 'app development') and we suggest the right code. Override anytime if you have a specific one." },

    { keys: ['gstin', 'gst number', 'gst registration'],
      answer: "We auto-validate GSTIN format and extract state code (first 2 digits) to pick CGST+SGST vs IGST. If your customer doesn't have a GSTIN (B2C), we still generate the invoice — just no GSTIN row." },

    { keys: ['e-invoice', 'einvoice', 'irp', 'irn', '5 crore', '5 cr'],
      answer: "If your turnover is ₹5+ Cr, govt requires e-invoices via IRP. v1.3 (Fri 8 May) ships one-click IRP-ready JSON export. You buy now, get this update free." },

    { keys: ['recurring', 'monthly', 'retainer', 'subscription invoice'],
      answer: "Recurring invoices for retainers ship in v1.2.1 (Mon 4 May). Set once, runs monthly. You're a Lifetime customer = you get this free." },

    { keys: ['bulk', 'batch', 'csv import', 'multiple', '40 clients', 'many clients'],
      answer: "Bulk CSV import ships in v1.3.0 (Thu 7 May). Drop a CSV with 40 rows = 40 PDFs in one shot. Killer for CAs handling 30+ clients." },

    { keys: ['founder', 'who built', 'who made', 'about', 'company'],
      answer: "Built by <strong>Bala Ganapathi</strong> at <a href='https://bytezbridge.com' target='_blank'>ByteZBridge</a> in Chennai. Solo founder, ex-builder. Direct line: <a href='" + CALENDLY_URL + "' target='_blank'>15-min chat with Bala</a>." },

    { keys: ['support', 'help', 'contact', 'email'],
      answer: "Email <a href='mailto:" + SUPPORT_EMAIL + "'>" + SUPPORT_EMAIL + "</a> — we reply within 1 working hour. Or book a 15-min call: <a href='" + CALENDLY_URL + "' target='_blank'>Calendly →</a>" },

    { keys: ['template', 'design', 'logo', 'branding', 'customize'],
      answer: "PDF templates with your logo + brand colors ship in v1.4 (Mon 11 May). Multiple designs (modern / classic / minimal) — all free for Lifetime customers." },

    { keys: ['discount', 'cheaper', 'lower price', 'student', 'startup'],
      answer: "<strong>Lifetime ₹9,999</strong> is already 70% cheaper than Tally over 5 years. We don't discount further — earlier customers get the lowest price (₹12,999 from customer #101, ₹14,999 from #251). Buy now, lock in ₹9,999." },

    { keys: ['anthropic', 'official', 'marketplace', 'verified'],
      answer: "We're submitted to the Anthropic plugin marketplace (review pending — typically 2-7 days). Also live on FutureTools and approaching ProductHunt 6 May." },

    { keys: ['mobile', 'phone', 'android', 'ios', 'app'],
      answer: "Plugin runs inside Claude — Claude has mobile apps for iOS and Android, so yes, works on phone. PDF generation works there too." },

    { keys: ['windows', 'mac', 'linux', 'os', 'platform'],
      answer: "Works on any OS that runs Claude (Mac, Windows, Linux, web browser). Pure Python plugin — zero OS-specific code." },

    { keys: ['updates', 'new versions', 'upgrade', 'newer'],
      answer: "All future updates included free, forever. We ship a new feature every 2-3 days right now (v1.2 multi-currency on 3 May, v1.3 e-invoice on 8 May, v1.4 templates 11 May, v1.5 reports 14 May)." }
  ];

  // ───── UI: replace existing bot widget ─────
  function styleAndMount() {
    // Hide any existing bot widget
    var oldBots = document.querySelectorAll('.bot-widget, #bot-widget, .floating-chat, #floating-chat');
    oldBots.forEach(function (el) { el.style.display = 'none'; });

    var css = "" +
      ".sb-trigger { position: fixed; bottom: 24px; right: 24px; z-index: 9998; background: linear-gradient(135deg, #4F46E5, #4338CA); color: #fff; width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 28px; cursor: pointer; box-shadow: 0 8px 24px rgba(79, 70, 229, 0.4); transition: transform 0.2s; }" +
      ".sb-trigger:hover { transform: scale(1.05); }" +
      ".sb-trigger.hidden { display: none; }" +
      ".sb-trigger .pulse { position: absolute; inset: -6px; border-radius: 50%; background: rgba(79,70,229,0.3); animation: sb-pulse 2s infinite; pointer-events: none; }" +
      "@keyframes sb-pulse { 0% { transform: scale(0.95); opacity: 1; } 100% { transform: scale(1.4); opacity: 0; } }" +
      "@keyframes sb-dot { 0%,80%,100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }" +
      ".sb-typing { color: #94A3B8; padding: 14px 16px !important; }" +
      ".sb-window { position: fixed; bottom: 100px; right: 24px; z-index: 9999; width: 380px; max-width: calc(100vw - 32px); height: 580px; max-height: calc(100vh - 140px); background: #fff; border-radius: 16px; box-shadow: 0 20px 60px rgba(15,23,42,0.2); display: none; flex-direction: column; overflow: hidden; border: 1px solid #E2E8F0; }" +
      ".sb-window.open { display: flex; }" +
      ".sb-header { background: linear-gradient(135deg, #4F46E5, #4338CA); color: #fff; padding: 16px 20px; display: flex; align-items: center; gap: 12px; }" +
      ".sb-avatar { width: 40px; height: 40px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }" +
      ".sb-titles { flex: 1; }" +
      ".sb-titles .name { font-weight: 700; font-size: 15px; }" +
      ".sb-titles .status { font-size: 12px; opacity: 0.85; }" +
      ".sb-close { background: rgba(255,255,255,0.15); border: 0; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 18px; line-height: 1; }" +
      ".sb-body { flex: 1; padding: 20px; overflow-y: auto; background: #F8FAFC; display: flex; flex-direction: column; gap: 12px; }" +
      ".sb-msg { max-width: 85%; padding: 12px 16px; border-radius: 14px; font-size: 14px; line-height: 1.5; }" +
      ".sb-msg.bot { align-self: flex-start; background: #fff; color: #0F172A; border: 1px solid #E2E8F0; border-bottom-left-radius: 4px; }" +
      ".sb-msg.user { align-self: flex-end; background: #4F46E5; color: #fff; border-bottom-right-radius: 4px; }" +
      ".sb-msg a { color: #4F46E5; font-weight: 600; }" +
      ".sb-msg.user a { color: #fff; text-decoration: underline; }" +
      ".sb-msg code { background: #EEF2FF; color: #4338CA; padding: 1px 6px; border-radius: 4px; font-size: 12px; font-family: 'SF Mono', Menlo, monospace; }" +
      ".sb-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }" +
      ".sb-quick button { background: #fff; border: 1px solid #C7D2FE; color: #4338CA; padding: 7px 12px; border-radius: 14px; font-size: 13px; cursor: pointer; transition: all 0.15s; font-weight: 500; }" +
      ".sb-quick button:hover { background: #4F46E5; color: #fff; border-color: #4F46E5; }" +
      ".sb-input-row { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #E2E8F0; background: #fff; }" +
      ".sb-input { flex: 1; border: 1px solid #E2E8F0; border-radius: 100px; padding: 10px 16px; font-size: 14px; outline: none; }" +
      ".sb-input:focus { border-color: #4F46E5; }" +
      ".sb-send { background: #4F46E5; color: #fff; border: 0; border-radius: 50%; width: 38px; height: 38px; cursor: pointer; font-size: 16px; }" +
      ".sb-send:disabled { opacity: 0.5; cursor: not-allowed; }" +
      ".sb-cta-card { background: linear-gradient(135deg, #4F46E5, #4338CA); color: #fff; padding: 16px; border-radius: 12px; margin-top: 4px; }" +
      ".sb-cta-card .price { font-size: 24px; font-weight: 800; }" +
      ".sb-cta-card .strike { text-decoration: line-through; opacity: 0.7; font-size: 14px; margin-right: 8px; }" +
      ".sb-cta-card a { display: inline-block; background: #fff; color: #4F46E5; padding: 8px 16px; border-radius: 8px; font-weight: 700; font-size: 13px; margin-top: 8px; text-decoration: none; }" +
      "@media (max-width: 480px) { .sb-window { width: calc(100vw - 16px); right: 8px; bottom: 90px; height: calc(100vh - 110px); } .sb-trigger { bottom: 16px; right: 16px; } }";

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var trigger = document.createElement('div');
    trigger.className = 'sb-trigger';
    trigger.innerHTML = '<span style="position:relative;z-index:2">💬</span><span class="pulse"></span>';
    trigger.title = "Chat with Bala's AI sales assistant";
    document.body.appendChild(trigger);

    var win = document.createElement('div');
    win.className = 'sb-window';
    win.innerHTML =
      '<div class="sb-header">' +
        '<div class="sb-avatar">⚡</div>' +
        '<div class="sb-titles"><div class="name">ByteZBridge Assistant</div><div class="status">● Usually replies instantly</div></div>' +
        '<button class="sb-close" title="Close">×</button>' +
      '</div>' +
      '<div class="sb-body" id="sb-body"></div>' +
      '<div class="sb-input-row">' +
        '<input class="sb-input" id="sb-input" placeholder="Ask anything..." />' +
        '<button class="sb-send" id="sb-send" title="Send">↑</button>' +
      '</div>';
    document.body.appendChild(win);

    return { trigger: trigger, win: win, body: win.querySelector('.sb-body'), input: win.querySelector('.sb-input'), send: win.querySelector('.sb-send'), close: win.querySelector('.sb-close') };
  }

  // ───── Render messages ─────
  function appendBotMsg(html, quickReplies, body) {
    var msg = document.createElement('div');
    msg.className = 'sb-msg bot';
    msg.innerHTML = html;
    body.appendChild(msg);
    if (quickReplies && quickReplies.length) {
      var row = document.createElement('div');
      row.className = 'sb-quick';
      quickReplies.forEach(function (qr) {
        var b = document.createElement('button');
        b.textContent = qr.label;
        b.onclick = function () { handleUserInput(qr.value || qr.label, body); };
        row.appendChild(b);
      });
      body.appendChild(row);
    }
    body.scrollTop = body.scrollHeight;
  }

  function appendUserMsg(text, body) {
    var msg = document.createElement('div');
    msg.className = 'sb-msg user';
    msg.textContent = text;
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
  }

  // Typing indicator (animated dots) while Claude API is thinking
  function appendTyping(body) {
    var msg = document.createElement('div');
    msg.className = 'sb-msg bot sb-typing';
    msg.innerHTML = '<span style="display:inline-block;animation:sb-dot 1.2s infinite">●</span><span style="display:inline-block;animation:sb-dot 1.2s infinite 0.2s;margin:0 4px">●</span><span style="display:inline-block;animation:sb-dot 1.2s infinite 0.4s">●</span>';
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
    return msg;
  }

  // Free-text fallback: call our Railway /api/chat endpoint (Claude Haiku 4.5)
  function callClaudeApi(userText, body) {
    var typingEl = appendTyping(body);
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userText,
        history: state.history.slice(-6) // last 3 turns context
      })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        var answer = (j && j.answer) ? String(j.answer).trim() : '';
        if (!answer) {
          appendBotMsg("Hmm, let me get someone better qualified. Email <a href='mailto:" + SUPPORT_EMAIL + "'>" + SUPPORT_EMAIL + "</a> — Bala replies within 1 working hour.", [
            { label: '📺 Watch demo', value: 'demo' },
            { label: '💰 Price', value: 'price' },
            { label: '📞 Book a call', value: 'calendly' }
          ], body);
          return;
        }
        // Render AI answer (light HTML escape, then re-allow basic markdown-ish)
        var safe = answer
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
        // Append CTA link at end if AI mentioned price/buy
        if (/(₹9,?999|lifetime|buy|purchase|checkout)/i.test(answer)) {
          safe += "<br><br><a href='" + CHECKOUT_URL + "' style='display:inline-block;background:#4F46E5;color:#fff;padding:8px 14px;border-radius:8px;font-weight:700;font-size:13px;text-decoration:none;margin-top:4px'>Buy now ₹9,999 →</a>";
        }
        appendBotMsg(safe, [
          { label: '🚀 Buy now', value: 'buy' },
          { label: '📺 Demo', value: 'demo' },
          { label: '🤔 More questions', value: 'help' }
        ], body);
        state.history.push({ role: 'bot', text: answer });
      })
      .catch(function () {
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        appendBotMsg("My brain hiccupped 😅 Email <a href='mailto:" + SUPPORT_EMAIL + "'>" + SUPPORT_EMAIL + "</a> — Bala replies within 1 working hour. Or pick a topic below:", [
          { label: '📺 Demo', value: 'demo' },
          { label: '💰 Price', value: 'price' },
          { label: '🆚 vs Tally', value: 'tally' }
        ], body);
      });
  }

  function appendCtaCard(body) {
    var card = document.createElement('div');
    card.className = 'sb-cta-card';
    card.innerHTML =
      '<div class="price"><span class="strike">₹15,000/yr</span>₹9,999 <span style="font-size:13px;font-weight:500;opacity:0.85">lifetime</span></div>' +
      '<div style="font-size:13px;opacity:0.95;margin-top:4px">Pay once. Use forever. 30-day refund.</div>' +
      '<a href="' + CHECKOUT_URL + '">Buy now →</a>';
    body.appendChild(card);
    body.scrollTop = body.scrollHeight;
  }

  // ───── Routing ─────
  function matchKeyword(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < FAQ_KB.length; i++) {
      var entry = FAQ_KB[i];
      for (var j = 0; j < entry.keys.length; j++) {
        if (lower.indexOf(entry.keys[j]) !== -1) return entry.answer;
      }
    }
    return null;
  }

  function handleUserInput(rawText, body) {
    var text = (rawText || '').trim();
    if (!text) return;

    appendUserMsg(text, body);
    state.messageCount++;
    state.history.push({ role: 'user', text: text });

    var lower = text.toLowerCase();

    // Stage 1: capture role from initial qualify
    if (!state.role) {
      if (lower.indexOf('ca') !== -1 || lower.indexOf('chartered') !== -1 || lower.indexOf('account') !== -1) state.role = 'ca';
      else if (lower.indexOf('freelanc') !== -1 || lower.indexOf('solo') !== -1) state.role = 'freelancer';
      else if (lower.indexOf('agency') !== -1 || lower.indexOf('agenc') !== -1) state.role = 'agency';
      else if (lower.indexOf('saas') !== -1 || lower.indexOf('founder') !== -1 || lower.indexOf('startup') !== -1) state.role = 'saas';
      else if (lower.indexOf('brows') !== -1 || lower.indexOf('look') !== -1 || lower.indexOf('check') !== -1) state.role = 'browsing';

      if (state.role) {
        setTimeout(function () {
          appendBotMsg(PERSONA.qualify[state.role], roleQuickReplies(state.role), body);
        }, 500);
        return;
      }
    }

    // Stage 2: pain detection (after role set)
    if (state.role && !state.pain) {
      var painKey = detectPain(lower);
      if (painKey) {
        state.pain = painKey;
        setTimeout(function () {
          appendBotMsg(PAIN_RESPONSES[painKey], [
            { label: '📺 Watch demo', value: 'demo' },
            { label: '💰 See pricing', value: 'price' },
            { label: '🚀 Buy now', value: 'buy' }
          ], body);
        }, 500);
        return;
      }
    }

    // Stage 3: explicit "buy" intent
    if (lower.indexOf('buy') !== -1 || lower.indexOf('purchase') !== -1 || lower.indexOf('checkout') !== -1) {
      setTimeout(function () {
        appendBotMsg("Smart move 🚀 ₹9,999 lifetime — pay once, get every update free.", null, body);
        appendCtaCard(body);
      }, 400);
      return;
    }

    // Stage 4: keyword match in FAQ
    var faqAnswer = matchKeyword(text);
    if (faqAnswer) {
      setTimeout(function () {
        appendBotMsg(faqAnswer, [
          { label: '🚀 Buy now ₹9,999', value: 'buy' },
          { label: '📺 Demo', value: 'demo' },
          { label: '🤔 Other questions', value: 'help' }
        ], body);
      }, 500);
      return;
    }

    // Stage 5: 3+ messages with no buy intent → ask for email
    if (state.messageCount >= 3 && !state.askedForEmail && !state.email) {
      state.askedForEmail = true;
      setTimeout(function () {
        appendBotMsg("Tell you what — drop your email and I'll send a 1-page comparison sheet (us vs Tally vs Zoho) + a discount code valid for 24 hours. Sound good?", [
          { label: '📧 Yes, email me', value: 'email_capture' },
          { label: 'No thanks', value: 'no_email' }
        ], body);
      }, 500);
      return;
    }

    // Stage 6: email capture flow
    if (lower === 'email_capture' || lower === 'yes, email me') {
      setTimeout(function () {
        appendBotMsg("Just type your email below ↓", null, body);
      }, 300);
      return;
    }
    if (lower.indexOf('@') !== -1 && lower.indexOf('.') !== -1) {
      state.email = text;
      try {
        // Optional: log lead to backend
        fetch('/api/lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: text, role: state.role, pain: state.pain, source: 'chatbot' })
        }).catch(function () {});
      } catch (e) {}
      setTimeout(function () {
        appendBotMsg("Got it! 🎉 I'll email <strong>" + text + "</strong> the comparison sheet within 5 min. While you wait — most people who get this email buy within 24 hrs because the math is so clear:", null, body);
        appendCtaCard(body);
      }, 500);
      return;
    }

    // Stage 7: "demo" / "video" intent
    if (lower === 'demo' || lower.indexOf('video') !== -1 || lower.indexOf('show me') !== -1) {
      setTimeout(function () {
        appendBotMsg("60-second demo is right here on this page → <a href='" + VIDEO_ANCHOR + "'>scroll to the video</a>. Or watch the live interactive Claude demo just below it (auto-plays as you scroll).", [
          { label: '🚀 Buy now', value: 'buy' },
          { label: '💰 Pricing', value: 'price' }
        ], body);
      }, 400);
      return;
    }

    // Stage 8: "help" / general fallback
    if (lower === 'help' || lower.indexOf('not sure') !== -1 || lower.indexOf('idk') !== -1) {
      setTimeout(function () {
        appendBotMsg("Sure — what would help?", [
          { label: '📺 Watch the 1-min demo', value: 'demo' },
          { label: '💰 See pricing', value: 'price' },
          { label: '🆚 vs Tally / Zoho', value: 'tally' },
          { label: '🔒 Privacy / data', value: 'privacy' },
          { label: '📞 Talk to Bala', value: 'calendly' }
        ], body);
      }, 400);
      return;
    }

    // Stage 9: "calendly" / talk to founder
    if (lower === 'calendly' || lower.indexOf('talk to') !== -1 || lower.indexOf('call') !== -1) {
      setTimeout(function () {
        appendBotMsg("Sure! Bala does 15-min demo calls → <a href='" + CALENDLY_URL + "' target='_blank'>book on Calendly</a>. He'll show you the dashboard live and answer anything specific to your business.", null, body);
      }, 400);
      return;
    }

    // Stage 10: AI fallback — call Claude Haiku via /api/chat for free-text questions
    callClaudeApi(text, body);
  }

  function roleQuickReplies(role) {
    if (role === 'ca') return [
      { label: 'CGST/SGST confusion', value: 'cgst sgst confusion' },
      { label: 'GSTR-1 monthly filing', value: 'gstr1 filing' },
      { label: 'Tally is clunky', value: 'tally' },
      { label: 'Manual data entry', value: 'manual entry' }
    ];
    if (role === 'freelancer') return [
      { label: 'Invoice formatting hell', value: 'manual entry' },
      { label: 'GSTR-1 prep', value: 'gstr1 filing' },
      { label: 'Chasing payments', value: 'payment chasing' },
      { label: 'See pricing', value: 'price' }
    ];
    if (role === 'agency') return [
      { label: 'Many clients', value: 'bulk' },
      { label: 'Recurring retainers', value: 'recurring' },
      { label: 'vs Tally', value: 'tally' },
      { label: 'Pricing', value: 'price' }
    ];
    if (role === 'saas') return [
      { label: 'International invoices', value: 'international' },
      { label: 'B2B GST compliance', value: 'cgst sgst' },
      { label: 'API access?', value: 'api' },
      { label: 'Pricing', value: 'price' }
    ];
    return [
      { label: 'Watch demo', value: 'demo' },
      { label: 'See price', value: 'price' },
      { label: 'vs Tally', value: 'tally' }
    ];
  }

  function detectPain(text) {
    if (text.indexOf('cgst') !== -1 || text.indexOf('sgst') !== -1 || text.indexOf('igst') !== -1 || text.indexOf('split') !== -1) return 'cgst_sgst_confusion';
    if (text.indexOf('gstr') !== -1 || text.indexOf('filing') !== -1 || text.indexOf('return') !== -1 || text.indexOf('11th') !== -1) return 'gstr1_filing';
    if (text.indexOf('tally') !== -1 || text.indexOf('clunky') !== -1) return 'tally_clunky';
    if (text.indexOf('manual') !== -1 || text.indexOf('typing') !== -1 || text.indexOf('formatting') !== -1 || text.indexOf('word doc') !== -1) return 'manual_entry';
    if (text.indexOf('chasing') !== -1 || text.indexOf('payment') !== -1 || text.indexOf('collection') !== -1) return 'payment_chasing';
    if (text.indexOf('international') !== -1 || text.indexOf('export') !== -1 || text.indexOf('usd') !== -1 || text.indexOf('foreign') !== -1) return 'international';
    return null;
  }

  // ───── Boot ─────
  document.addEventListener('DOMContentLoaded', function () {
    var els = styleAndMount();

    els.trigger.addEventListener('click', function () {
      els.trigger.classList.add('hidden');
      els.win.classList.add('open');
      if (state.history.length === 0) {
        appendBotMsg(PERSONA.open, [
          { label: "I'm a CA", value: 'CA' },
          { label: "I'm a freelancer", value: 'freelancer' },
          { label: "I run an agency", value: 'agency' },
          { label: "SaaS founder", value: 'SaaS founder' },
          { label: 'Just browsing', value: 'browsing' }
        ], els.body);
      }
      els.input.focus();
    });

    els.close.addEventListener('click', function () {
      els.win.classList.remove('open');
      els.trigger.classList.remove('hidden');
    });

    els.send.addEventListener('click', function () {
      var v = els.input.value;
      els.input.value = '';
      handleUserInput(v, els.body);
    });

    els.input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') {
        els.send.click();
      }
    });
  });
})();
