// ============================================================
//  CONVERTA.AI — Combined Server (Stripe + Twilio + Aria)
// ============================================================
require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const stripe      = require("stripe")(process.env.STRIPE_SECRET_KEY);
const twilio      = require("twilio");
const Anthropic   = require("@anthropic-ai/sdk");
const OpenAI      = require("openai");
const openai      = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const https       = require("https");
const fs          = require("fs");
const path        = require("path");
const os          = require("os");
const app         = express();
const client      = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VoiceResponse = twilio.twiml.VoiceResponse;

// Webhook needs raw body BEFORE express.json()
app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);
app.use(cors({ origin: "*" }));
app.use(express.json());

const SERVER_URL = process.env.SERVER_URL || "https://web-production-46fe1e.up.railway.app";

app.get("/health", (req, res) => res.json({ status: "ok", stripe: "live", twilio: "live" }));
app.get("/", (req, res) => res.json({ status: "Converta.AI server running" }));

// ── STRIPE ──────────────────────────────────────────────────
const PLANS = {
  starter: {
    name:       "Starter",
    setupPrice: process.env.STRIPE_STARTER_SETUP_PRICE_ID,   // one-time $297
    monthlyPrice: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID, // recurring $197
    annualPrice:  process.env.STRIPE_STARTER_ANNUAL_PRICE_ID,  // recurring $1,967/yr
  },
  growth: {
    name:       "Growth",
    setupPrice:   process.env.STRIPE_GROWTH_SETUP_PRICE_ID,   // one-time $497
    monthlyPrice: process.env.STRIPE_GROWTH_MONTHLY_PRICE_ID, // recurring $397
    annualPrice:  process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID,  // recurring $3,960/yr
  },
  pro: {
    name:       "Pro",
    setupPrice:   process.env.STRIPE_PRO_SETUP_PRICE_ID,      // one-time $997
    monthlyPrice: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,    // recurring $697
    annualPrice:  process.env.STRIPE_PRO_ANNUAL_PRICE_ID,     // recurring $6,949/yr
  },
};

// ============================================================
//  POST /create-checkout-session
//  Called when a prospect clicks "Get Started" on pricing page
//  Body: { plan: "starter"|"growth"|"pro", billing: "monthly"|"annual", businessName, email }
// ============================================================
app.post("/create-checkout-session", async (req, res) => {
  const { plan, billing, businessName, email } = req.body;

  if (!PLANS[plan]) {
    return res.status(400).json({ error: "Invalid plan selected." });
  }

  const selectedPlan  = PLANS[plan];
  const recurringPrice = billing === "annual"
    ? selectedPlan.annualPrice
    : selectedPlan.monthlyPrice;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email || undefined,

      // Line items: setup fee (one-time) + recurring subscription
      line_items: [
        {
          // One-time setup fee — charged immediately
          price: selectedPlan.setupPrice,
          quantity: 1,
        },
        {
          // Recurring monthly or annual fee
          price: recurringPrice,
          quantity: 1,
        },
      ],

      // Pre-fill metadata so you know who signed up
      subscription_data: {
        metadata: {
          plan,
          billing,
          businessName: businessName || "",
        },
      },

      // Success/cancel redirect URLs
      success_url: `${process.env.FRONTEND_URL}/onboarding/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/pricing?canceled=true`,

      // Collect billing address for tax purposes
      billing_address_collection: "required",

      // Allow promo codes
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  POST /create-customer-portal-session
//  Lets existing clients manage their subscription themselves
//  Body: { customerId: "cus_xxx" }
// ============================================================
app.post("/create-customer-portal-session", async (req, res) => {
  const { customerId } = req.body;

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error("Portal session error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET /subscription/:customerId
//  Fetch current subscription details for a client
// ============================================================
app.get("/subscription/:customerId", async (req, res) => {
  const { customerId } = req.params;

  try {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status:   "active",
      limit:    1,
    });

    if (!subscriptions.data.length) {
      return res.json({ active: false });
    }

    const sub  = subscriptions.data[0];
    const item = sub.items.data[0];

    res.json({
      active:             true,
      subscriptionId:     sub.id,
      plan:               sub.metadata.plan,
      billing:            sub.metadata.billing,
      currentPeriodEnd:   new Date(sub.current_period_end * 1000).toISOString(),
      cancelAtPeriodEnd:  sub.cancel_at_period_end,
      amount:             item.price.unit_amount / 100,
      currency:           item.price.currency,
      interval:           item.price.recurring.interval,
    });
  } catch (err) {
    console.error("Subscription fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  POST /cancel-subscription
//  Cancels at period end (client keeps access until billing date)
//  Body: { subscriptionId: "sub_xxx" }
// ============================================================
app.post("/cancel-subscription", async (req, res) => {
  const { subscriptionId } = req.body;

  try {
    const updated = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    res.json({
      canceled:          true,
      cancelAt:          new Date(updated.cancel_at * 1000).toISOString(),
    });
  } catch (err) {
    console.error("Cancel error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  POST /upgrade-plan
//  Switches client to a different tier immediately (prorated)
//  Body: { subscriptionId, newPriceId }
// ============================================================
app.post("/upgrade-plan", async (req, res) => {
  const { subscriptionId, newPriceId } = req.body;

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId       = subscription.items.data[0].id;

    const updated = await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: "always_invoice", // charge/credit immediately
    });

    res.json({ success: true, subscriptionId: updated.id });
  } catch (err) {
    console.error("Upgrade error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  POST /webhook  (already mounted above with raw body parser)
//  Stripe sends events here — handle them to update your DB
// ============================================================
async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle each event type ──────────────────────────────
  switch (event.type) {

    case "checkout.session.completed": {
      const session = event.data.object;
      console.log("✅ New client signed up:", session.customer_email);
      // TODO: Create client record in Supabase, provision Twilio number, send welcome email
      // Example: await createClientInDatabase(session)
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      console.log("💰 Payment received:", invoice.amount_paid / 100, invoice.currency.toUpperCase());
      // TODO: Update client's billing status in Supabase, send receipt email
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.log("❌ Payment failed for:", invoice.customer_email);
      // TODO: Send payment failure email, flag account in dashboard
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      console.log("🚫 Subscription canceled:", sub.id);
      // TODO: Deactivate client account, release Twilio number, send offboarding email
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      console.log("🔄 Subscription updated:", sub.id, "Plan:", sub.metadata.plan);
      // TODO: Update plan tier in Supabase
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
}



// ── TWILIO / ARIA ────────────────────────────────────────────
const CLIENT_CONFIGS = {
  "+18339686657": {
    businessName:    process.env.BUSINESS_NAME || "Converta.AI",
    ownerPhone:      process.env.NOTIFY_EMAIL || "jaymflight@gmail.com",
    greeting:        process.env.ARIA_GREETING || "Thank you for calling! I'm Aria, your AI assistant. How can I help you today?",
    businessType:    "business",
    faqs:            [],
    appointmentQuestions: ["What's your name?", "What can we help you with today?"],
  },
  "+14045550100": {
    businessName:    "Bright Smile Dental",
    ownerPhone:      "+14045550192",
    ownerEmail:      "marcus@brightsmile.com",
    greeting:        "Thank you for calling Bright Smile Dental! I'm Aria, your AI assistant. How can I help you today?",
    businessType:    "dental practice",
    faqs: [
      { q: "insurance",     a: "We accept Delta Dental, Cigna, Aetna, MetLife, and most major plans." },
      { q: "hours",         a: "We're open Monday through Friday, 8 AM to 5 PM." },
      { q: "new patient",   a: "Yes, we're accepting new patients! I can capture your info for a callback." },
      { q: "emergency",     a: "Yes — tell me what's wrong and I'll flag this as urgent for immediate callback." },
      { q: "parking",       a: "Free parking is available in our lot at the front of the building." },
    ],
    appointmentQuestions: [
      "What's your name?",
      "What's the best phone number to reach you?",
      "What brings you in today?",
      "Do you have a preferred day or time?",
      "Do you have dental insurance?",
    ],
  },
};

// ── Active call sessions (in production, use Redis) ──────────
const CALL_SESSIONS = new Map();


// ============================================================
//  DEMO CONFIGS — swap Aria's persona for sales demos
// ============================================================
const DEMO_CONFIGS = {
  dental: {
    businessName:  "Bright Smile Dental",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      "Thank you for calling Bright Smile Dental! I'm Aria, your virtual receptionist. Are you a new or existing patient?",
    businessType:  "dental",
    faqs: [
      { q: "insurance",        a: "We accept Delta Dental, Cigna, Aetna, BlueCross, and most major PPO plans. We also offer flexible payment plans." },
      { q: "hours",            a: "We're open Monday through Friday 8am to 5pm, and Saturdays from 9am to 1pm." },
      { q: "new patient",      a: "We're always welcoming new patients! I can schedule a new patient exam which includes X-rays and a cleaning." },
      { q: "emergency",        a: "We do see dental emergencies. If you're in pain, I'll make sure we get you in as soon as possible." },
      { q: "cost",             a: "Costs vary by procedure. With insurance, most routine visits are fully covered. I can have our billing team call you with specifics." },
    ],
    appointmentQuestions: ["What's your name?", "What's the best callback number?", "Are you a new or existing patient?", "What's the reason for your visit today?"],
  },
  medspa: {
    businessName:  "Luxe Med Spa",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      "Thank you for calling Luxe Med Spa! I'm Aria. Are you calling to book a consultation or do you have a question about our services?",
    businessType:  "medspa",
    faqs: [
      { q: "botox",            a: "Yes, we offer Botox starting at $12 per unit. Most treatment areas require 20 to 40 units. We'd love to schedule a free consultation." },
      { q: "filler",           a: "We offer a full range of dermal fillers including Juvederm and Restylane. Consultations are complimentary." },
      { q: "hours",            a: "We're open Tuesday through Saturday 9am to 6pm." },
      { q: "price",            a: "Pricing depends on the treatment. We offer free consultations so you can get an exact quote. Want me to book one for you?" },
      { q: "membership",       a: "Yes! Our monthly membership starts at $199 and includes discounts on all services plus one free treatment per month." },
    ],
    appointmentQuestions: ["What's your name?", "What's the best number to reach you?", "Which service are you interested in?", "Have you visited us before?"],
  },
  roofing: {
    businessName:  "Premier Roofing Co.",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      "Thanks for calling Premier Roofing! I'm Aria. Are you calling about a repair, a new roof, or storm damage?",
    businessType:  "roofing",
    faqs: [
      { q: "cost",             a: "Roofing costs depend on the size and materials. Most residential roofs run between $8,000 and $20,000. We offer free inspections and estimates." },
      { q: "insurance",        a: "Absolutely — we work with all major insurance companies and can help you through the claims process at no extra charge." },
      { q: "how long",         a: "Most full roof replacements take 1 to 2 days. Repairs are often same-day or next-day." },
      { q: "warranty",         a: "We offer a 10-year workmanship warranty on all installations, plus manufacturer warranties on materials." },
      { q: "free inspection",  a: "Yes! We offer completely free roof inspections. I can get you scheduled with one of our inspectors." },
    ],
    appointmentQuestions: ["What's your name?", "What's your callback number?", "What's the address of the property?", "Are you dealing with storm damage or a general inspection?"],
  },
  law: {
    businessName:  "Mitchell & Associates Law",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      "Thank you for calling Mitchell and Associates. I'm Aria, the virtual intake assistant. How can I help you today?",
    businessType:  "law",
    faqs: [
      { q: "practice areas",   a: "We handle personal injury, family law, employment disputes, and estate planning." },
      { q: "free consultation", a: "Yes, we offer a free 30-minute initial consultation for all new clients." },
      { q: "cost",             a: "Our fees vary by case type. Personal injury cases are handled on contingency — no fees unless we win." },
      { q: "location",         a: "We're located in downtown Atlanta. We also offer phone and video consultations for your convenience." },
    ],
    appointmentQuestions: ["What's your name?", "What's your contact number?", "What type of legal matter are you calling about?", "Have you worked with our firm before?"],
  },
  restaurant: {
    businessName:  "The Golden Fork",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      "Thank you for calling The Golden Fork! I'm Aria. Are you calling to make a reservation or do you have a question?",
    businessType:  "restaurant",
    faqs: [
      { q: "hours",            a: "We're open Tuesday through Sunday. Lunch is 11am to 3pm, dinner is 5pm to 10pm. We're closed Mondays." },
      { q: "reservation",      a: "I'd love to help you with a reservation! I just need a few details." },
      { q: "menu",             a: "We specialize in contemporary American cuisine with locally sourced ingredients. Our menu changes seasonally." },
      { q: "parking",          a: "We have a private lot behind the restaurant with free parking for guests." },
      { q: "private event",    a: "Yes, we have a private dining room that seats up to 40 guests. I can have our events coordinator reach out to you." },
    ],
    appointmentQuestions: ["What's your name?", "What's your contact number?", "What date and time were you thinking?", "How many guests will be joining you?"],
  },
};

// Active demo config (null = use real CLIENT_CONFIGS)
let activeDemoConfig = null;
let demoExpiry = null;

// ── GET /demo — show demo control panel ──────────────────────
app.get("/demo", (req, res) => {
  const industries = Object.keys(DEMO_CONFIGS);
  const active = activeDemoConfig ? activeDemoConfig.businessName : "None (using real config)";
  const timeLeft = demoExpiry ? Math.max(0, Math.round((demoExpiry - Date.now()) / 60000)) : 0;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Aria Demo Control Panel</title>
      <style>
        body { font-family: monospace; background: #020408; color: #00ffe5; padding: 40px; }
        h1 { font-size: 24px; margin-bottom: 8px; }
        .status { background: rgba(0,255,229,.08); border: 1px solid rgba(0,255,229,.2); padding: 20px; border-radius: 8px; margin: 20px 0; }
        .btn { display: inline-block; padding: 12px 24px; margin: 8px; background: #00ffe5; color: #020408; border: none; border-radius: 4px; font-family: monospace; font-size: 14px; font-weight: bold; cursor: pointer; text-decoration: none; }
        .btn:hover { background: #00fff2; }
        .btn-off { background: rgba(255,64,96,.2); color: #ff4060; border: 1px solid rgba(255,64,96,.3); }
        .btn-off:hover { background: rgba(255,64,96,.3); }
        .number { font-size: 28px; color: #fff; margin: 10px 0; }
        p { color: rgba(216,240,236,.6); margin: 6px 0; }
      </style>
    </head>
    <body>
      <h1>🎯 Aria Demo Control Panel</h1>
      <p>Use this to swap Aria's persona before a sales demo call.</p>

      <div class="status">
        <p>ACTIVE PERSONA</p>
        <div class="number">${active}</div>
        <p>${activeDemoConfig ? "Demo expires in " + timeLeft + " minutes" : "Call your Twilio number to test the current config"}</p>
        <div class="number" style="font-size:18px">📞 ${process.env.TWILIO_PHONE_NUMBER || "+18339686657"}</div>
      </div>

      <p style="margin-bottom:12px; font-size:16px;">SELECT DEMO PERSONA:</p>
      ${industries.map(ind => `
        <a href="/demo/activate/${ind}" class="btn">${DEMO_CONFIGS[ind].businessName}</a>
      `).join('')}
      <br><br>
      <a href="/demo/deactivate" class="btn btn-off">❌ Deactivate Demo Mode</a>

      <br><br>
      <p style="opacity:.5">Demo mode lasts 30 minutes then resets automatically.</p>
    </body>
    </html>
  `);
});

// ── GET /demo/activate/:industry ─────────────────────────────
app.get("/demo/activate/:industry", (req, res) => {
  const industry = req.params.industry;
  if (!DEMO_CONFIGS[industry]) {
    return res.status(404).send("Demo config not found for: " + industry);
  }
  activeDemoConfig = DEMO_CONFIGS[industry];
  demoExpiry = Date.now() + 30 * 60 * 1000; // 30 min
  console.log("🎯 Demo mode activated:", activeDemoConfig.businessName);
  res.redirect("/demo");
});

// ── GET /demo/deactivate ─────────────────────────────────────
app.get("/demo/deactivate", (req, res) => {
  activeDemoConfig = null;
  demoExpiry = null;
  console.log("Demo mode deactivated");
  res.redirect("/demo");
});


// ── POST /recording/:callSid — Twilio sends recording URL here ──
app.post("/recording/:callSid", async (req, res) => {
  const callSid       = req.params.callSid;
  const recordingUrl  = req.body.RecordingUrl;
  const recordingSid  = req.body.RecordingSid;
  console.log(`🎙 Recording received for ${callSid}: ${recordingUrl}`);

  const session = CALL_SESSIONS.get(callSid);
  if (!session || !recordingUrl) return res.sendStatus(200);

  try {
    // Download the recording MP3
    const tmpFile = path.join(os.tmpdir(), `${recordingSid}.mp3`);
    await new Promise((resolve, reject) => {
      const url = recordingUrl + ".mp3";
      const authStr = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
      const fileStream = fs.createWriteStream(tmpFile);
      https.get(url, { headers: { Authorization: `Basic ${authStr}` } }, (response) => {
        response.pipe(fileStream);
        fileStream.on("finish", () => { fileStream.close(); resolve(); });
      }).on("error", reject);
    });

    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file:  fs.createReadStream(tmpFile),
      model: "whisper-1",
    });
    
    const text = (transcription.text || "").trim();
    console.log(`📝 Whisper transcribed: "${text}"`);
    
    // Clean up temp file
    fs.unlink(tmpFile, () => {});

    if (!text) {
      await client.calls(callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna-Neural">I'm sorry, I didn't catch that. Could you please repeat?</Say><Record action="${SERVER_URL}/process-speech/${callSid}" maxLength="8" playBeep="false" trim="trim-silence" recordingStatusCallback="${SERVER_URL}/recording/${callSid}" recordingStatusCallbackEvent="completed"/></Response>`
      });
      return res.sendStatus(200);
    }

    session.messages.push({ role: "user", content: text });
    session.turnCount++;
    extractLeadData(session, text);

    if (session.turnCount >= 8 || hasEnoughLeadInfo(session.leadData)) {
      const closing = await getClosingMessage(session);
      await saveLeadAndNotify(session, callSid);
      await client.calls(callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${closing}</Say><Hangup/></Response>`
      });
      CALL_SESSIONS.delete(callSid);
      return res.sendStatus(200);
    }

    const aiReply = await getAriaResponse(session, text);
    session.messages.push({ role: "assistant", content: aiReply });
    console.log(`🤖 Aria replied: "${aiReply}"`);

    // Speak reply and record next response
    await client.calls(callSid).update({
      twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${aiReply.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</Say><Record action="${SERVER_URL}/process-speech/${callSid}" maxLength="8" playBeep="false" trim="trim-silence" recordingStatusCallback="${SERVER_URL}/recording/${callSid}" recordingStatusCallbackEvent="completed"/></Response>`
    });

  } catch(err) {
    console.error("Recording handler error:", err.message);
    try {
      await client.calls(callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna-Neural">I apologize for the trouble. Please hold while I connect you.</Say><Hangup/></Response>`
      });
    } catch(e) {}
  }

  res.sendStatus(200);
});

// ============================================================
//  POST /incoming-call
//  Twilio hits this when someone calls a client's Aria number
// ============================================================
app.post("/incoming-call", async (req, res) => {
  const twiml    = new VoiceResponse();
  const callSid  = req.body.CallSid || req.query.CallSid || ("call_" + Date.now());
  const toNumber = req.body.To || req.query.To || process.env.TWILIO_PHONE_NUMBER;

  // Use demo config if active, otherwise use client config
  const config = (activeDemoConfig && demoExpiry > Date.now()) ? activeDemoConfig : (CLIENT_CONFIGS[toNumber] || getDefaultConfig());

  // Initialize session for this call
  CALL_SESSIONS.set(callSid, {
    config,
    messages:    [],
    leadData:    { name: null, phone: req.body.From, email: null, reason: null, notes: "" },
    turnCount:   0,
    startTime:   Date.now(),
  });

  console.log(`📞 Incoming call to ${toNumber} (${config.businessName}) from ${req.body.From}`);

  // Greet the caller
  twiml.say(
    { voice: "Polly.Joanna-Neural", language: "en-US" },
    config.greeting
  );

  // Gather speech
  twiml.record({
    action:                   `${SERVER_URL}/process-speech/${callSid}`,
    maxLength:                8,
    playBeep:                 false,
    trim:                     "trim-silence",
    recordingStatusCallback:       `${SERVER_URL}/recording/${callSid}`,
    recordingStatusCallbackEvent:  ["completed"],
  });

  res.type("text/xml").send(twiml.toString());
});

// ============================================================
//  POST /process-speech/:callSid
//  Called after each caller response — sends to Claude, speaks reply
// ============================================================
app.post("/process-speech/:callSid", async (req, res) => {
  const twiml   = new VoiceResponse();
  const callSid = req.params.callSid;
  const session = CALL_SESSIONS.get(callSid);

  if (!session) {
    twiml.say({ voice: "Polly.Joanna-Neural" }, "I'm sorry, there was a connection issue. Please call back and we'll be happy to help!");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  console.log("📥 Full request body:", JSON.stringify(req.body));
  const transcription = (req.body.SpeechResult || req.body.TranscriptionText || "").trim();
  console.log(`🎙 Caller said: "${transcription}"`);

  // If transcription is empty, ask caller to repeat
  if (!transcription) {
    const twiml2 = new VoiceResponse();
    twiml2.say({ voice: "Polly.Joanna-Neural", language: "en-US" }, "I'm sorry, I didn't catch that. Could you please repeat that?");
    twiml2.record({
      action:                   `${SERVER_URL}/process-speech/${callSid}`,
      maxLength:                8,
      playBeep:                 false,
      trim:                     "trim-silence",
      recordingStatusCallback:  `${SERVER_URL}/recording/${callSid}`,
    });
    return res.type("text/xml").send(twiml2.toString());
  }

  session.messages.push({ role: "user", content: transcription });
  session.turnCount++;

  // After 8 turns or if we have enough info, wrap up gracefully
  if (session.turnCount >= 8 || hasEnoughLeadInfo(session.leadData)) {
    const closing = await getClosingMessage(session);
    twiml.say({ voice: "Polly.Joanna-Neural", language: "en-US" }, closing);

    // Save lead and notify owner
    await saveLeadAndNotify(session, callSid);

    twiml.hangup();
    CALL_SESSIONS.delete(callSid);
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    // Get Claude's response
    const aiReply = await getAriaResponse(session, transcription);
    console.log(`🤖 Aria replied: "${aiReply}"`);

    session.messages.push({ role: "assistant", content: aiReply });

    // Extract any lead data Claude identified
    extractLeadData(session, transcription);

    // Speak the reply
    twiml.say({ voice: "Polly.Joanna-Neural", language: "en-US" }, aiReply);

    // Gather next response
    twiml.gather({
      input:         "speech",
      action:        `${SERVER_URL}/process-speech/${callSid}`,
      speechTimeout: "auto",
      timeout:       5,
      language:      "en-US",
    });

  } catch (err) {
    console.error("Claude API error FULL:", JSON.stringify(err));
    twiml.say({ voice: "Polly.Joanna-Neural" },
      "I apologize for the trouble. Let me take your name and number so our team can call you right back."
    );
    twiml.record({ action: `/collect-callback/${callSid}`, maxLength: 10, playBeep: false });
  }

  res.type("text/xml").send(twiml.toString());
});

// ============================================================
//  AI RESPONSE — sends conversation history to Claude
// ============================================================
async function getAriaResponse(session, latestInput) {
  const { config, messages } = session;

  const systemPrompt = `You are Aria, a warm and professional AI phone receptionist for ${config.businessName}, a ${config.businessType}.

YOUR GOALS (in order of priority):
1. Capture the caller's name and phone number
2. Understand why they're calling (appointment, question, emergency)
3. Answer FAQs from the list below if relevant
4. Collect appointment details if they want to book

FAQ ANSWERS — use these exactly when relevant:
${config.faqs.map(f => `- If they ask about "${f.q}": ${f.a}`).join("\n")}

RULES:
- Keep every response to 1-2 SHORT sentences — this is a phone call, not a chat
- Sound natural and warm, never robotic
- Never make up information not in the FAQs
- If you don't know something, say "Our team will be able to help with that when they call you back"
- If it sounds urgent (pain, emergency, broken pipe, etc.), say you're flagging it as urgent
- When you have their name and reason, confirm it and say the team will call back shortly

Current lead data captured so far:
Name: ${session.leadData.name || "not yet captured"}
Reason: ${session.leadData.reason || "not yet captured"}`;

  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 150,
    system:     systemPrompt,
    messages:   messages,
  });

  return response.content[0].text;
}

// ============================================================
//  HELPER: Extract lead data from caller's words
// ============================================================
function extractLeadData(session, text) {
  const lower = text.toLowerCase();

  // Very basic extraction — in production use Claude to extract structured data
  if (!session.leadData.name) {
    const nameMatch = text.match(/(?:my name is|i'm|i am|it's|this is)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    if (nameMatch) session.leadData.name = nameMatch[1];
  }

  if (!session.leadData.reason) {
    const reasons = ["appointment","checkup","cleaning","pain","emergency","question","quote","consultation","inspection"];
    for (const r of reasons) {
      if (lower.includes(r)) { session.leadData.reason = r; break; }
    }
  }
}

function hasEnoughLeadInfo(leadData) {
  return leadData.name && leadData.reason;
}

async function getClosingMessage(session) {
  const name = session.leadData.name ? `, ${session.leadData.name.split(" ")[0]}` : "";
  return `Perfect${name}! I've captured all your information and our team will reach out to you shortly. Have a wonderful day!`;
}

// ============================================================
//  SAVE LEAD + NOTIFY BUSINESS OWNER
// ============================================================
async function saveLeadAndNotify(session, callSid) {
  const { config, leadData, messages, startTime } = session;
  const duration = Math.round((Date.now() - startTime) / 1000);

  const lead = {
    callSid,
    businessName:  config.businessName,
    callerPhone:   leadData.phone,
    callerName:    leadData.name    || "Unknown",
    reason:        leadData.reason  || "General inquiry",
    duration:      `${Math.floor(duration/60)}m ${duration%60}s`,
    transcript:    messages.map(m => `${m.role === "user" ? "Caller" : "Aria"}: ${m.content}`).join("\n"),
    capturedAt:    new Date().toISOString(),
  };

  console.log("💾 Saving lead:", lead);
  // TODO: await supabase.from("leads").insert(lead)

  // SMS notification to business owner
  try {
    await client.messages.create({
      body: `🔔 New lead from Aria!\n\nBusiness: ${config.businessName}\nCaller: ${lead.callerName}\nPhone: ${lead.callerPhone}\nReason: ${lead.reason}\nDuration: ${lead.duration}\n\nLog in to Converta.AI to view the full transcript.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   config.ownerPhone,
    });
    console.log(`📱 SMS sent to ${config.ownerPhone}`);
  } catch (err) {
    console.error("SMS notification failed:", err.message);
  }
}

// ============================================================
//  POST /save-transcript/:callSid  — async transcription callback
// ============================================================
app.post("/save-transcript/:callSid", async (req, res) => {
  const { callSid } = req.params;
  const { TranscriptionText, TranscriptionStatus } = req.body;

  if (TranscriptionStatus === "completed") {
    console.log(`📝 Transcript for ${callSid}:`, TranscriptionText);
    // TODO: append to lead record in Supabase
  }
  res.sendStatus(200);
});

// ============================================================
//  POST /outbound-sms
//  Send a follow-up SMS to a lead after their call
//  Body: { to, businessName, callerName }
// ============================================================
app.post("/outbound-sms", async (req, res) => {
  const { to, businessName, callerName } = req.body;
  const firstName = callerName?.split(" ")[0] || "there";

  try {
    const msg = await client.messages.create({
      body: `Hi ${firstName}! Thanks for calling ${businessName}. We received your message and our team will be in touch shortly. Reply STOP to opt out.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error("Outbound SMS error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  POST /provision-number
//  Buy a new local Twilio number for a new client
//  Body: { areaCode: "404", clientId: "uuid" }
// ============================================================
app.post("/provision-number", async (req, res) => {
  const { areaCode, clientId } = req.body;

  try {
    // Search for an available local number
    const available = await client.availablePhoneNumbers("US")
      .local.list({ areaCode: areaCode || "404", limit: 1 });

    if (!available.length) {
      return res.status(404).json({ error: `No numbers available for area code ${areaCode}` });
    }

    // Purchase it
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      voiceUrl:    `${process.env.SERVER_URL}/incoming-call`,
      voiceMethod: "POST",
      friendlyName: `Converta Client ${clientId}`,
    });

    console.log(`📞 Provisioned number ${purchased.phoneNumber} for client ${clientId}`);

    // TODO: Save to Supabase: await supabase.from("clients").update({ twilio_number: purchased.phoneNumber }).eq("id", clientId)

    res.json({
      success:     true,
      phoneNumber: purchased.phoneNumber,
      sid:         purchased.sid,
    });
  } catch (err) {
    console.error("Number provision error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET /health — simple health check
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    service: "Converta.AI Twilio Server",
    time:    new Date().toISOString(),
  });
});

function getDefaultConfig() {
  return {
    businessName:  process.env.BUSINESS_NAME || "Converta.AI",
    ownerPhone:    process.env.NOTIFY_PHONE || process.env.TWILIO_PHONE_NUMBER,
    greeting:      process.env.ARIA_GREETING || "Thank you for calling! I'm Aria, your AI assistant. How can I help you today?",
    businessType:  "business",
    faqs:          [],
    appointmentQuestions: ["What's your name?", "What can we help you with today?"],
  };
}

// ============================================================
//  START SERVER
// ============================================================

// ── START SERVER ─────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("\n🚀 Converta.AI server running on port " + PORT);
  console.log("   Stripe: LIVE | Twilio: LIVE");
});
