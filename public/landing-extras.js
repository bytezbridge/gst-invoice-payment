/* landing-extras.js — adds self-hosted demo video + interactive Claude-style demo to landing page
   Loaded after the rest of index.html, this script:
   1. Replaces the video-placeholder div with an HTML5 <video> tag pointing at /demo.mp4
   2. Inserts a new "Try it. Right here. Right now." interactive demo section before #painpoints
*/
(function () {
  // ---------- 0. Inject "Setup guide" link in nav + footer ----------
  try {
    var navLinks = document.querySelectorAll('header nav a, .nav a, header a');
    var pricingLink = Array.from(navLinks).find(function (a) { return /pricing/i.test(a.textContent || ''); });
    if (pricingLink && !document.querySelector('a[href="/install.html"]')) {
      var setupLink = document.createElement('a');
      setupLink.href = '/install.html';
      setupLink.textContent = 'Setup';
      // Mirror sibling style
      setupLink.className = pricingLink.className;
      setupLink.style.cssText = window.getComputedStyle(pricingLink).cssText;
      pricingLink.parentNode.insertBefore(setupLink, pricingLink.nextSibling);
    }
    // Add to footer too
    var footer = document.querySelector('footer');
    if (footer && !footer.innerHTML.includes('install.html')) {
      var fLink = document.createElement('a');
      fLink.href = '/install.html';
      fLink.textContent = 'Setup guide';
      fLink.style.cssText = 'color:inherit;margin:0 8px;text-decoration:none';
      var divider = document.createElement('span');
      divider.textContent = ' · ';
      // Insert near other footer links
      var firstFooterLink = footer.querySelector('a');
      if (firstFooterLink && firstFooterLink.parentNode) {
        firstFooterLink.parentNode.insertBefore(fLink, firstFooterLink);
        firstFooterLink.parentNode.insertBefore(divider, firstFooterLink);
      }
    }
  } catch (e) { /* ignore — defensive */ }

  // ---------- 1. Self-hosted MP4 video (replaces .video-placeholder) ----------
  var ph = document.querySelector('.video-placeholder');
  if (ph) {
    var video = document.createElement('video');
    video.src = '/demo.mp4';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = '';
    video.title = 'GST Invoice Generator — 1 minute demo';
    video.style.cssText = 'width:100%;height:100%;border:0;border-radius:16px;background:#000;object-fit:cover';
    ph.replaceWith(video);
  }

  // ---------- 2. Inject CSS for the live demo ----------
  var css = "" +
    ".live-demo { padding: 80px 0; background: linear-gradient(180deg, #fff 0%, #F8FAFC 100%); }" +
    ".live-demo .section-title { text-align: center; margin-bottom: 48px; }" +
    ".live-demo .section-title h2 { font-size: 40px; font-weight: 800; color: #0F172A; letter-spacing: -1px; margin-bottom: 12px; }" +
    ".live-demo .section-title p { font-size: 18px; color: #475569; max-width: 600px; margin: 0 auto; }" +
    ".live-demo .demo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; max-width: 1100px; margin: 0 auto; align-items: start; }" +
    "@media (max-width: 768px) { .live-demo .demo-grid { grid-template-columns: 1fr; } }" +
    ".demo-chat { background: #fff; border: 1px solid #E2E8F0; border-radius: 16px; box-shadow: 0 8px 24px rgba(15,23,42,0.06); overflow: hidden; min-height: 420px; display: flex; flex-direction: column; }" +
    ".demo-chat-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: #F8FAFC; border-bottom: 1px solid #E2E8F0; }" +
    ".demo-chat-header .dots { display: flex; gap: 6px; }" +
    ".demo-chat-header .dots i { width: 11px; height: 11px; border-radius: 50%; }" +
    ".demo-chat-header .dots i:nth-child(1) { background: #FF5F56; }" +
    ".demo-chat-header .dots i:nth-child(2) { background: #FFBD2E; }" +
    ".demo-chat-header .dots i:nth-child(3) { background: #27C93F; }" +
    ".demo-chat-header .title { font-weight: 700; color: #0F172A; margin-left: 8px; font-size: 14px; }" +
    ".demo-chat-header .status { margin-left: auto; font-size: 12px; color: #10B981; font-weight: 600; }" +
    ".demo-chat-body { flex: 1; padding: 24px; display: flex; flex-direction: column; gap: 12px; }" +
    ".demo-msg { padding: 12px 16px; border-radius: 12px; font-size: 15px; line-height: 1.5; max-width: 85%; opacity: 0; transform: translateY(8px); transition: opacity 0.4s, transform 0.4s; }" +
    ".demo-msg.show { opacity: 1; transform: translateY(0); }" +
    ".demo-msg.user { align-self: flex-end; background: #4F46E5; color: #fff; }" +
    ".demo-msg.user .typing-cursor { display: inline-block; width: 2px; height: 16px; background: #fff; vertical-align: middle; animation: gstdemo-blink 1s steps(1) infinite; margin-left: 1px; }" +
    ".demo-msg.claude { align-self: flex-start; background: #F1F5F9; color: #0F172A; font-family: -apple-system, 'SF Mono', Menlo, monospace; font-size: 13px; }" +
    ".demo-msg.claude .green { color: #10B981; font-weight: 700; }" +
    ".demo-msg.claude .indigo { color: #4F46E5; font-weight: 700; }" +
    ".demo-typing { align-self: flex-start; padding: 12px 16px; background: #F1F5F9; border-radius: 12px; display: none; gap: 4px; }" +
    ".demo-typing.show { display: flex; }" +
    ".demo-typing i { width: 7px; height: 7px; background: #94A3B8; border-radius: 50%; animation: gstdemo-bounce 1.4s infinite ease-in-out; }" +
    ".demo-typing i:nth-child(2) { animation-delay: 0.2s; }" +
    ".demo-typing i:nth-child(3) { animation-delay: 0.4s; }" +
    ".demo-invoice { background: #fff; border: 1px solid #E2E8F0; border-radius: 16px; box-shadow: 0 8px 24px rgba(15,23,42,0.06); padding: 24px; min-height: 420px; position: relative; overflow: hidden; }" +
    ".invoice-pre { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #94A3B8; transition: opacity 0.4s; }" +
    ".invoice-pre-icon { font-size: 64px; margin-bottom: 12px; opacity: 0.3; }" +
    ".invoice-pre p { font-size: 18px; font-weight: 600; color: #475569; margin-bottom: 4px; }" +
    ".invoice-pre small { font-size: 14px; }" +
    ".demo-invoice.revealed .invoice-pre { opacity: 0; pointer-events: none; }" +
    ".invoice-paper { opacity: 0; transform: translateY(20px); transition: opacity 0.6s, transform 0.6s; }" +
    ".demo-invoice.revealed .invoice-paper { opacity: 1; transform: translateY(0); }" +
    ".inv-head { display: flex; justify-content: space-between; padding-bottom: 12px; margin-bottom: 16px; border-bottom: 2px solid #4F46E5; }" +
    ".inv-head h3 { font-size: 18px; font-weight: 800; color: #4F46E5; }" +
    ".inv-head .num { font-size: 12px; color: #94A3B8; font-weight: 600; }" +
    ".inv-meta-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; font-size: 12px; }" +
    ".inv-meta-row .label { font-size: 10px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }" +
    ".inv-meta-row .value { font-weight: 600; color: #0F172A; }" +
    ".inv-meta-row .value small { display: block; font-weight: 400; color: #475569; font-size: 11px; }" +
    ".inv-table-mini { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }" +
    ".inv-table-mini th { background: #EEF2FF; padding: 8px; text-align: left; color: #4338CA; font-weight: 700; font-size: 11px; }" +
    ".inv-table-mini td { padding: 8px; border-bottom: 1px solid #E2E8F0; }" +
    ".inv-table-mini .hsn { background: #FEF3C7; font-weight: 700; }" +
    ".inv-totals-mini { background: #EEF2FF; padding: 12px; border-radius: 8px; font-size: 13px; }" +
    ".inv-totals-mini .row { display: flex; justify-content: space-between; padding: 2px 0; }" +
    ".inv-totals-mini .row.tax { color: #10B981; font-weight: 700; }" +
    ".inv-totals-mini .row.bold { font-weight: 800; color: #4F46E5; padding-top: 6px; margin-top: 6px; border-top: 1px solid #C7D2FE; font-size: 15px; }" +
    ".inv-words-mini { margin-top: 10px; padding: 8px; background: #FEF3C7; border-radius: 6px; font-size: 11px; font-style: italic; color: #0F172A; }" +
    ".inv-actions { display: flex; gap: 8px; margin-top: 12px; }" +
    ".inv-actions .btn-pdf, .inv-actions .btn-ledger { flex: 1; padding: 10px; border-radius: 8px; font-size: 13px; font-weight: 700; text-align: center; border: none; cursor: pointer; }" +
    ".inv-actions .btn-pdf { background: #4F46E5; color: #fff; }" +
    ".inv-actions .btn-ledger { background: #F1F5F9; color: #0F172A; border: 1px solid #E2E8F0; }" +
    ".demo-toast { position: absolute; bottom: 16px; right: 16px; background: #10B981; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; opacity: 0; transform: translateY(10px); transition: opacity 0.3s, transform 0.3s; }" +
    ".demo-toast.show { opacity: 1; transform: translateY(0); }" +
    ".demo-replay { text-align: center; margin-top: 32px; }" +
    ".demo-replay button { background: transparent; border: 1px solid #CBD5E1; color: #475569; padding: 10px 24px; border-radius: 100px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }" +
    ".demo-replay button:hover { background: #4F46E5; color: #fff; border-color: #4F46E5; }" +
    "@keyframes gstdemo-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }" +
    "@keyframes gstdemo-bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }";

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- 3. Build the demo section HTML ----------
  var section = document.createElement('section');
  section.className = 'live-demo';
  section.id = 'live-demo';
  section.innerHTML =
    '<div class="container">' +
      '<div class="section-title">' +
        '<h2>Try it. Right here. Right now.</h2>' +
        '<p>Watch what happens inside Claude — no signup, no install, just a live preview of the actual flow.</p>' +
      '</div>' +
      '<div class="demo-grid">' +
        '<div class="demo-chat">' +
          '<div class="demo-chat-header">' +
            '<span class="dots"><i></i><i></i><i></i></span>' +
            '<span class="title">⚡ Claude</span>' +
            '<span class="status">● online</span>' +
          '</div>' +
          '<div class="demo-chat-body">' +
            '<div class="demo-msg user" id="gstDemoUserMsg"><span id="gstDemoTypedText"></span><span class="typing-cursor"></span></div>' +
            '<div class="demo-typing" id="gstDemoTyping"><i></i><i></i><i></i></div>' +
            '<div class="demo-msg claude" id="gstDemoClaudeMsg">' +
              '<span class="green">✓</span> Generated <strong>GST-2026-0042.pdf</strong><br>' +
              '⤷ <span class="indigo">IGST 18%</span> applied (Maharashtra is inter-state)<br>' +
              '⤷ HSN <strong>998314</strong> — IT design services<br>' +
              '⤷ Total <strong>₹29,500</strong><br>' +
              '⤷ In words: <em>Twenty-Nine Thousand Five Hundred Rupees Only</em>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="demo-invoice" id="gstDemoInvoice">' +
          '<div class="invoice-pre">' +
            '<div class="invoice-pre-icon">📄</div>' +
            '<p>Your invoice will appear here</p>' +
            '<small>once you ask Claude →</small>' +
          '</div>' +
          '<div class="invoice-paper">' +
            '<div class="inv-head"><h3>GST INVOICE</h3><div class="num">#GST-2026-0042 · 30 Apr 2026</div></div>' +
            '<div class="inv-meta-row">' +
              '<div><div class="label">From</div><div class="value">ByteZBridge Pvt Ltd<small>GSTIN 33ABCDE1234F1Z5 · TN</small></div></div>' +
              '<div><div class="label">Bill To</div><div class="value">Reliance Industries<small>GSTIN 27AAACR5055K1Z3 · MH</small></div></div>' +
            '</div>' +
            '<table class="inv-table-mini">' +
              '<thead><tr><th>Description</th><th>HSN</th><th>Total</th></tr></thead>' +
              '<tbody><tr><td>Web Design Services</td><td class="hsn">998314</td><td>₹25,000</td></tr></tbody>' +
            '</table>' +
            '<div class="inv-totals-mini">' +
              '<div class="row"><span>Subtotal</span><span>₹25,000</span></div>' +
              '<div class="row tax"><span>IGST @ 18%</span><span>₹4,500</span></div>' +
              '<div class="row bold"><span>Total</span><span>₹29,500</span></div>' +
            '</div>' +
            '<div class="inv-words-mini">In words: <strong>Twenty-Nine Thousand Five Hundred Rupees Only</strong></div>' +
            '<div class="inv-actions">' +
              '<button class="btn-pdf" id="gstDemoBtnPdf">⬇ Download PDF</button>' +
              '<button class="btn-ledger">📊 Add to GSTR-1</button>' +
            '</div>' +
          '</div>' +
          '<div class="demo-toast" id="gstDemoToast">✓ Downloaded GST-2026-0042.pdf</div>' +
        '</div>' +
      '</div>' +
      '<p class="demo-replay"><button id="gstDemoReplay">↻ Watch again</button></p>' +
    '</div>';

  // Insert before #painpoints
  var painSection = document.getElementById('painpoints') || document.querySelector('.pain');
  if (painSection && painSection.parentNode) {
    painSection.parentNode.insertBefore(section, painSection);
  } else {
    document.body.appendChild(section);
  }

  // ---------- 4. Animation logic ----------
  var userMsg = document.getElementById('gstDemoUserMsg');
  var typedText = document.getElementById('gstDemoTypedText');
  var typingEl = document.getElementById('gstDemoTyping');
  var claudeMsg = document.getElementById('gstDemoClaudeMsg');
  var invoiceEl = document.getElementById('gstDemoInvoice');
  var btnPdf = document.getElementById('gstDemoBtnPdf');
  var toast = document.getElementById('gstDemoToast');
  var replayBtn = document.getElementById('gstDemoReplay');
  var promptText = "raise an invoice for Reliance Industries, ₹25,000, web design, Mumbai";

  function reset() {
    typedText.textContent = '';
    userMsg.classList.remove('show');
    typingEl.classList.remove('show');
    claudeMsg.classList.remove('show');
    invoiceEl.classList.remove('revealed');
    toast.classList.remove('show');
    var c = userMsg.querySelector('.typing-cursor');
    if (c) c.style.display = 'inline-block';
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function typeIt() {
    userMsg.classList.add('show');
    for (var i = 0; i <= promptText.length; i++) {
      typedText.textContent = promptText.slice(0, i);
      await delay(35);
    }
    var c = userMsg.querySelector('.typing-cursor');
    if (c) c.style.display = 'none';
  }
  async function run() {
    reset();
    await delay(600);
    await typeIt();
    await delay(400);
    typingEl.classList.add('show');
    await delay(1400);
    typingEl.classList.remove('show');
    invoiceEl.classList.add('revealed');
    claudeMsg.classList.add('show');
    await delay(1800);
    btnPdf.style.transform = 'scale(0.95)';
    await delay(150);
    btnPdf.style.transform = '';
    toast.classList.add('show');
    await delay(2400);
    toast.classList.remove('show');
  }

  if (replayBtn) replayBtn.addEventListener('click', run);
  window.runGstDemo = run;

  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        run();
        obs.disconnect();
      }
    });
  }, { threshold: 0.3 });
  obs.observe(section);
})();
