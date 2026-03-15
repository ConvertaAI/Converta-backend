// ============================================================
//  CONVERTA.AI — Streaming Server (Twilio Media Streams + Deepgram)
//  Real-time audio streaming for 1-2 second response times
// ============================================================
require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const http        = require("http");
const WebSocket   = require("ws");
const stripe      = require("stripe")(process.env.STRIPE_SECRET_KEY);
const twilio      = require("twilio");
const Anthropic   = require("@anthropic-ai/sdk");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const app         = express();
const server      = http.createServer(app);
const wss         = new WebSocket.Server({ server });

const client      = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const deepgram    = createClient(process.env.DEEPGRAM_API_KEY);
const VoiceResponse = twilio.twiml.VoiceResponse;

const SERVER_URL  = process.env.SERVER_URL || "https://web-production-46fe1e.up.railway.app";

// Webhook needs raw body BEFORE express.json()
app.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => res.json({ status: "ok", stripe: "live", twilio: "live", mode: "streaming" }));
app.get("/", (req, res) => res.json({ status: "Converta.AI Streaming Server running" }));
app.post("/noop", (req, res) => { res.type("text/xml").send("<Response></Response>"); });

// ============================================================
//  CALL SESSIONS & CONFIGS
// ============================================================
const CALL_SESSIONS = new Map();

const CLIENT_CONFIGS = {
  "+16786790658": {
    businessName:    process.env.BUSINESS_NAME || "Converta.AI",
    ownerPhone:      process.env.NOTIFY_PHONE  || process.env.TWILIO_PHONE_NUMBER,
    greeting:        process.env.ARIA_GREETING || "Thanks for calling! This is Aria. How can I help?",
    businessType:    "business",
    faqs:            [],
    appointmentQuestions: ["What's your name?", "What can we help you with today?"],
  },
};

// Demo configs
const DEMO_CONFIGS = {
  dental: {
    businessName: "Bright Smile Dental",
    greeting: "Thanks for calling Bright Smile Dental! This is Aria. Are you a new or existing patient?",
    businessType: "dental",
    faqs: [
      { q: "insurance", a: "We accept Delta Dental, Cigna, Aetna, BlueCross, and most major PPO plans." },
      { q: "hours", a: "We're open Monday through Friday 8am to 5pm, and Saturdays 9am to 1pm." },
      { q: "emergency", a: "Yes, we see dental emergencies. I'll flag this as urgent for our team." },
    ],
    appointmentQuestions: ["What's your name?", "What's your callback number?", "New or existing patient?", "Reason for visit?"],
  },
  medspa: {
    businessName: "Luxe Med Spa",
    greeting: "Thanks for calling Luxe Med Spa! This is Aria. Are you calling to book a consultation?",
    businessType: "medspa",
    faqs: [
      { q: "botox", a: "Botox starts at $12 per unit. Free consultations available!" },
      { q: "hours", a: "We're open Tuesday through Saturday 9am to 6pm." },
    ],
    appointmentQuestions: ["What's your name?", "Best callback number?", "Which service interests you?"],
  },
  roofing: {
    businessName: "Premier Roofing Co.",
    greeting: "Thanks for calling Premier Roofing! This is Aria. Are you calling about a repair or new roof?",
    businessType: "roofing",
    faqs: [
      { q: "insurance", a: "Yes, we work with all major insurance companies and help with claims." },
      { q: "free inspection", a: "Absolutely, we offer free roof inspections!" },
    ],
    appointmentQuestions: ["What's your name?", "Callback number?", "Property address?", "Storm damage or general inspection?"],
  },
  law: {
    businessName: "Mitchell & Associates Law",
    greeting: "Thanks for calling Mitchell and Associates. This is Aria, the virtual intake assistant. How can I help?",
    businessType: "law",
    faqs: [
      { q: "free consultation", a: "Yes, we offer a free 30-minute initial consultation." },
      { q: "practice areas", a: "We handle personal injury, family law, employment, and estate planning." },
    ],
    appointmentQuestions: ["What's your name?", "Contact number?", "Type of legal matter?"],
  },
  restaurant: {
    businessName: "The Golden Fork",
    greeting: "Thanks for calling The Golden Fork! This is Aria. Are you calling for a reservation?",
    businessType: "restaurant",
    faqs: [
      { q: "hours", a: "We're open Tuesday through Sunday, lunch 11am to 3pm, dinner 5pm to 10pm." },
      { q: "parking", a: "Free parking in our private lot behind the restaurant." },
    ],
    appointmentQuestions: ["What's your name?", "Contact number?", "Date and time?", "How many guests?"],
  },
};

let activeDemoConfig = null;
let demoExpiry = null;

// Demo control panel
app.get("/demo", (req, res) => {
  const active = activeDemoConfig ? activeDemoConfig.businessName : "None (using real config)";
  const timeLeft = demoExpiry ? Math.max(0, Math.round((demoExpiry - Date.now()) / 60000)) : 0;
  res.send(`<!DOCTYPE html><html><head><title>Aria Demo Panel</title>
  <style>body{font-family:monospace;background:#020408;color:#00ffe5;padding:40px}
  h1{font-size:24px;margin-bottom:8px}.status{background:rgba(0,255,229,.08);border:1px solid rgba(0,255,229,.2);padding:20px;border-radius:8px;margin:20px 0}
  .btn{display:inline-block;padding:12px 24px;margin:8px;background:#00ffe5;color:#020408;border:none;border-radius:4px;font-family:monospace;font-size:14px;font-weight:bold;cursor:pointer;text-decoration:none}
  .btn-off{background:rgba(255,64,96,.2);color:#ff4060;border:1px solid rgba(255,64,96,.3)}.number{font-size:28px;color:#fff;margin:10px 0}p{color:rgba(216,240,236,.6);margin:6px 0}</style></head>
  <body><h1>🎯 Aria Demo Control Panel</h1>
  <div class="status"><p>ACTIVE PERSONA</p><div class="number">${active}</div>
  <p>${activeDemoConfig ? "Expires in " + timeLeft + " min" : "Using real business config"}</p>
  <div class="number" style="font-size:18px">📞 ${process.env.TWILIO_PHONE_NUMBER || "+16786790658"}</div></div>
  <p style="margin-bottom:12px;font-size:16px">SELECT DEMO PERSONA:</p>
  ${Object.keys(DEMO_CONFIGS).map(k => `<a href="/demo/activate/${k}" class="btn">${DEMO_CONFIGS[k].businessName}</a>`).join("")}
  <br><br><a href="/demo/deactivate" class="btn btn-off">❌ Deactivate Demo</a>
  <br><br><p style="opacity:.5">Demo lasts 30 minutes then resets.</p></body></html>`);
});

app.get("/demo/activate/:industry", (req, res) => {
  const ind = req.params.industry;
  if (!DEMO_CONFIGS[ind]) return res.status(404).send("Not found");
  activeDemoConfig = DEMO_CONFIGS[ind];
  demoExpiry = Date.now() + 30 * 60 * 1000;
  console.log("🎯 Demo activated:", activeDemoConfig.businessName);
  res.redirect("/demo");
});

app.get("/demo/deactivate", (req, res) => {
  activeDemoConfig = null; demoExpiry = null;
  res.redirect("/demo");
});

function getDefaultConfig() {
  return {
    businessName: process.env.BUSINESS_NAME || "Converta.AI",
    ownerPhone:   process.env.NOTIFY_PHONE  || process.env.TWILIO_PHONE_NUMBER,
    greeting:     process.env.ARIA_GREETING || "Thanks for calling! This is Aria. How can I help?",
    businessType: "business",
    faqs:         [],
    appointmentQuestions: ["What's your name?", "How can we help?"],
  };
}


// ── POST /call-status — fires when call ends for ANY reason (hangup, customer disconnect, etc.)
app.post("/call-status", async (req, res) => {
  const callSid    = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  console.log(`📵 Call ${callSid} ended: ${callStatus}`);

  const session = CALL_SESSIONS.get(callSid);
  if (session && session.messages.length > 0 && !session.notified) {
    session.notified = true;
    await saveLeadAndNotify(session, callSid);
  }
  CALL_SESSIONS.delete(callSid);
  res.sendStatus(200);
});

// ============================================================
//  INCOMING CALL — Start Media Stream
// ============================================================
app.post("/incoming-call", (req, res) => {
  const callSid  = req.body.CallSid || ("call_" + Date.now());
  const toNumber = req.body.To || process.env.TWILIO_PHONE_NUMBER;
  const config   = (activeDemoConfig && demoExpiry > Date.now()) ? activeDemoConfig : (CLIENT_CONFIGS[toNumber] || getDefaultConfig());

  console.log(`📞 Incoming call to ${toNumber} (${config.businessName})`);

  CALL_SESSIONS.set(callSid, {
    config,
    messages:  [],
    leadData:  { name: null, phone: req.body.From, reason: null },
    turnCount: 0,
    startTime: Date.now(),
    transcript: "",
  });

  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Joanna-Neural", language: "en-US" }, config.greeting);

  twiml.say; // status callback set on number level
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `wss://${SERVER_URL.replace("https://", "")}/media-stream` });
  stream.parameter({ name: "callSid", value: callSid });

  res.type("text/xml").send(twiml.toString());
});

// ============================================================
//  WEBSOCKET — Real-time Audio Streaming
// ============================================================
wss.on("connection", (ws) => {
  console.log("🔌 WebSocket connected");
  let callSid        = null;
  let dgConnection   = null;
  let finalTranscript = "";
  let silenceTimer   = null;
  let isProcessing   = false;

  ws.on("message", async (data) => {
    const msg = JSON.parse(data);

    if (msg.event === "start") {
      callSid = msg.start.customParameters?.callSid || msg.start.callSid;
      console.log(`🎙 Stream started for ${callSid}`);

      // Connect to Deepgram real-time transcription
      dgConnection = deepgram.listen.live({
        model:           "nova-2-phonecall",
        language:        "en-US",
        smart_format:    true,
        interim_results: true,
        endpointing:     300,
        encoding:        "mulaw",
        sample_rate:     8000,
        channels:        1,
      });

      dgConnection.on(LiveTranscriptionEvents.Open, () => {
        console.log("🟢 Deepgram connected");
      });

      dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
        const alt = data.channel?.alternatives?.[0];
        if (!alt || !alt.transcript) return;

        const text = alt.transcript.trim();
        if (!text) return;

        if (data.is_final) {
          finalTranscript += " " + text;
          console.log(`📝 Final: "${text}"`);

          // Reset silence timer on each final transcript
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(async () => {
            const fullText = finalTranscript.trim();
            finalTranscript = "";
            if (!fullText || isProcessing) return;
            isProcessing = true;

            const session = CALL_SESSIONS.get(callSid);
            if (!session) { isProcessing = false; return; }

            try {
              session.messages.push({ role: "user", content: fullText });
              session.turnCount++;
              extractLeadData(session, fullText);

              let reply;
              let isClosing = false;

              if (session.turnCount >= 8 || hasEnoughLeadInfo(session.leadData)) {
                reply = await getClosingMessage(session);
                isClosing = true;
                session.notified = true; // mark so call-status doesn't double-send
              } else {
                reply = await getAriaResponse(session, fullText);
                session.messages.push({ role: "assistant", content: reply });
              }

              console.log(`🤖 Aria: "${reply}"`);

              const safeReply = reply.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

              if (isClosing) {
                // Say goodbye and hang up - do NOT reconnect stream
                await client.calls(callSid).update({
                  twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${safeReply}</Say><Pause length="1"/><Hangup/></Response>`
                });
              } else {
                // Continue conversation - reconnect stream
                await client.calls(callSid).update({
                  twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${safeReply}</Say><Connect><Stream url="wss://${SERVER_URL.replace("https://","")}/media-stream"><Parameter name="callSid" value="${callSid}"/></Stream></Connect></Response>`
                });
              }

            } catch(err) {
              console.error("Processing error:", err.message);
            }
            isProcessing = false;
          }, 800); // Wait 800ms of silence before processing
        }
      });

      dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error("Deepgram error:", err);
      });
    }

    if (msg.event === "media" && dgConnection) {
      const audio = Buffer.from(msg.media.payload, "base64");
      dgConnection.send(audio);
    }

    if (msg.event === "stop") {
      console.log(`🔴 Stream stopped for ${callSid}`);
      clearTimeout(silenceTimer);
      if (dgConnection) dgConnection.finish();
    }
  });

  ws.on("close", () => {
    clearTimeout(silenceTimer);
    if (dgConnection) dgConnection.finish();
    console.log("🔌 WebSocket disconnected");
  });
});

// ============================================================
//  AI RESPONSE
// ============================================================
async function getAriaResponse(session, latestInput) {
  const { config, messages } = session;
  const systemPrompt = `You are Aria, a warm AI phone receptionist for ${config.businessName}.
GOALS: 1) Get caller's name and phone 2) Understand why they're calling 3) Answer FAQs 4) Book if needed
FAQs: ${config.faqs.map(f => `Q: ${f.q} → A: ${f.a}`).join(" | ")}
RULES: Max 1 SHORT sentence. Warm and natural. Get name+reason then wrap up.
Captured: Name=${session.leadData.name||"unknown"} Reason=${session.leadData.reason||"unknown"}`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 80,
    system:     systemPrompt,
    messages:   messages,
  });
  return response.content[0].text;
}

function extractLeadData(session, text) {
  const lower = text.toLowerCase();
  if (!session.leadData.name) {
    const m = text.match(/(?:my name is|i'm|i am|it's|this is)\s+([A-Z][a-z]+ ?[A-Z]?[a-z]*)/i);
    if (m) session.leadData.name = m[1];
  }
  if (!session.leadData.reason) {
    const reasons = ["appointment","checkup","cleaning","pain","emergency","question","quote","consultation","inspection","reservation","booking"];
    for (const r of reasons) if (lower.includes(r)) { session.leadData.reason = r; break; }
  }
}

function hasEnoughLeadInfo(ld) { return ld.name && ld.reason; }

async function getClosingMessage(session) {
  const name = session.leadData.name ? `, ${session.leadData.name.split(" ")[0]}` : "";
  return `Perfect${name}! I've captured your info and our team will call you back shortly. Have a great day!`;
}

async function saveLeadAndNotify(session, callSid) {
  const { config, leadData, messages, startTime } = session;
  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`✅ Lead saved: ${JSON.stringify(leadData)} for ${config.businessName}`);

  // Build transcript
  const transcript = messages.map(m => `${m.role === "user" ? "Caller" : "Aria"}: ${m.content}`).join("\n");

  // Email to business owner
  const ownerEmail = config.ownerEmail || process.env.NOTIFY_EMAIL;
  if (ownerEmail && process.env.GMAIL_APP_PASSWORD) {
    try {
      await mailer.sendMail({
        from: `"Converta.AI" <${process.env.NOTIFY_EMAIL}>`,
        to: ownerEmail,
        subject: `📞 New Lead: ${leadData.name || "Unknown"} called ${config.businessName}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px">
            <div style="background:#00d4aa;padding:16px 20px;border-radius:6px 6px 0 0">
              <h2 style="color:#020408;margin:0;font-size:18px">📞 New Lead Captured by Aria</h2>
            </div>
            <div style="background:#fff;padding:20px;border-radius:0 0 6px 6px;border:1px solid #e0e0e0">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="padding:8px 0;color:#666;width:140px">Business</td><td style="padding:8px 0;font-weight:bold">${config.businessName}</td></tr>
                <tr><td style="padding:8px 0;color:#666">Caller name</td><td style="padding:8px 0;font-weight:bold">${leadData.name || "Not captured"}</td></tr>
                <tr><td style="padding:8px 0;color:#666">Phone number</td><td style="padding:8px 0;font-weight:bold"><a href="tel:${leadData.phone}">${leadData.phone || "Unknown"}</a></td></tr>
                <tr><td style="padding:8px 0;color:#666">Reason for call</td><td style="padding:8px 0;font-weight:bold">${leadData.reason || "Not captured"}</td></tr>
                <tr><td style="padding:8px 0;color:#666">Call duration</td><td style="padding:8px 0">${duration} seconds</td></tr>
                <tr><td style="padding:8px 0;color:#666">Time</td><td style="padding:8px 0">${new Date().toLocaleString()}</td></tr>
              </table>
              <div style="margin-top:20px;padding:16px;background:#f5f5f5;border-radius:6px">
                <p style="margin:0 0 8px;font-weight:bold;color:#333">Call Transcript</p>
                <pre style="margin:0;font-size:13px;color:#444;white-space:pre-wrap;font-family:Arial,sans-serif">${transcript}</pre>
              </div>
              <p style="margin:20px 0 0;font-size:12px;color:#999">Powered by Converta.AI — Your AI Receptionist</p>
            </div>
          </div>
        `
      });
      console.log(`📧 Lead email sent to ${ownerEmail}`);
    } catch(e) {
      console.error("Email error:", e.message);
    }
  }
}

// ============================================================
//  STRIPE ROUTES
// ============================================================
const PLANS = {
  starter: { name: "Starter", setupPrice: process.env.STRIPE_STARTER_SETUP_PRICE_ID, monthlyPrice: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID, annualPrice: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID },
  growth:  { name: "Growth",  setupPrice: process.env.STRIPE_GROWTH_SETUP_PRICE_ID,   monthlyPrice: process.env.STRIPE_GROWTH_MONTHLY_PRICE_ID,   annualPrice: process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID },
  pro:     { name: "Pro",     setupPrice: process.env.STRIPE_PRO_SETUP_PRICE_ID,       monthlyPrice: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,       annualPrice: process.env.STRIPE_PRO_ANNUAL_PRICE_ID },
};

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan, billing } = req.body;
    const selectedPlan = PLANS[plan];
    if (!selectedPlan) return res.status(400).json({ error: "Invalid plan" });
    const recurringPrice = billing === "annual" ? selectedPlan.annualPrice : selectedPlan.monthlyPrice;
    const lineItems = [];
    if (selectedPlan.setupPrice) lineItems.push({ price: selectedPlan.setupPrice, quantity: 1 });
    if (recurringPrice) lineItems.push({ price: recurringPrice, quantity: 1 });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: lineItems.some(i => i.price === recurringPrice) ? "subscription" : "payment",
      success_url: `${process.env.FRONTEND_URL || "https://converta-site.vercel.app"}/?success=true&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL || "https://converta-site.vercel.app"}/?canceled=true`,
      metadata: { plan, billing },
    });
    res.json({ url: session.url });
  } catch(err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-customer-portal-session", async (req, res) => {
  try {
    const { customerId } = req.body;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL || "https://converta-site.vercel.app",
    });
    res.json({ url: session.url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log(`Stripe webhook: ${event.type}`);
  res.json({ received: true });
}

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🚀 Converta.AI Streaming Server on port ${PORT}`);
  console.log(`   Stripe: LIVE | Twilio: LIVE | Deepgram: LIVE`);
});
