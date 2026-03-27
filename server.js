// ============================================================
//  CONVERTA.AI — Clean Production Server v3.0
//  Twilio Media Streams + Deepgram + Claude + Resend
// ============================================================
require("dotenv").config();
const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const cors      = require("cors");
const fetch     = require("node-fetch");
const stripe    = require("stripe")(process.env.STRIPE_SECRET_KEY);
const twilio    = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

const app       = express();
const server    = http.createServer(app);
const wss       = new WebSocket.Server({ server });
const client    = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const deepgram  = createClient(process.env.DEEPGRAM_API_KEY);
const VoiceResponse = twilio.twiml.VoiceResponse;
const SERVER_URL = process.env.SERVER_URL || "https://web-production-46fe1e.up.railway.app";

app.post("/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
//  BUSINESS CONFIGS
// ============================================================
const CLIENT_CONFIGS = {
  "+16786790658": getDefaultConfig(),
};

const DEMO_CONFIGS = {
  dental: {
    businessName: "Bright Smile Dental",
    greeting: "Thanks for calling Bright Smile Dental, this is Aria! How can I help you today?",
    faqs: [
      { q: "insurance", a: "We accept Delta Dental, Cigna, Aetna, BlueCross, and most major PPO plans." },
      { q: "hours", a: "We're open Monday through Friday 8am to 5pm, and Saturdays 9am to 1pm." },
      { q: "emergency", a: "Yes we see dental emergencies same day. I'll flag this as urgent for our team." },
    ],
    appointmentQuestions: ["What's your name?", "What's the best number to reach you?", "Are you a new or existing patient?", "What's the reason for your visit?"],
    calendarType: "calendly",
    calendarConfig: {
      bookingUrl: "https://calendly.com/convertaai",
    },
  },
  medspa: {
    businessName: "Luxe Med Spa",
    greeting: "Thank you for calling Luxe Med Spa, this is Aria! How can I help you today?",
    faqs: [
      { q: "botox", a: "Botox starts at $12 per unit. We offer free consultations!" },
      { q: "hours", a: "We're open Tuesday through Saturday 9am to 6pm." },
    ],
    appointmentQuestions: ["What's your name?", "Best callback number?", "Which service are you interested in?"],
  },
  roofing: {
    businessName: "Premier Roofing Co.",
    greeting: "Thanks for calling Premier Roofing, this is Aria! Are you calling about a repair or new roof?",
    faqs: [
      { q: "insurance", a: "Yes, we work with all major insurance companies and help with claims." },
      { q: "inspection", a: "We offer free roof inspections!" },
    ],
    appointmentQuestions: ["What's your name?", "Best callback number?", "What's the property address?", "Is this storm damage or a general inspection?"],
  },
  law: {
    businessName: "Mitchell & Associates Law",
    greeting: "Thank you for calling Mitchell and Associates, this is Aria! How can I help you today?",
    faqs: [
      { q: "consultation", a: "Yes, we offer a free 30-minute initial consultation." },
      { q: "practice areas", a: "We handle personal injury, family law, employment, and estate planning." },
    ],
    appointmentQuestions: ["What's your name?", "Best contact number?", "What type of legal matter can we help you with?"],
  },
  restaurant: {
    businessName: "The Golden Fork",
    greeting: "Thanks for calling The Golden Fork, this is Aria! Are you calling to make a reservation?",
    faqs: [
      { q: "hours", a: "We're open Tuesday through Sunday, lunch 11am to 3pm, dinner 5pm to 10pm." },
      { q: "parking", a: "Free parking in our private lot behind the restaurant." },
    ],
    appointmentQuestions: ["What's your name?", "Best callback number?", "What date and time works for you?", "How many guests will be joining?"],
  },
};

let activeDemoConfig = null;
let demoExpiry = null;

function getDefaultConfig() {
  return {
    businessName: process.env.BUSINESS_NAME || "Converta.AI",
    greeting: process.env.ARIA_GREETING || "Thanks for calling! This is Aria, your AI assistant. How can I help you today?",
    faqs: [],
    appointmentQuestions: ["What's your name?", "What's the best number to reach you?", "How can we help you today?"],
  };
}

// ============================================================
//  CALL SESSIONS
// ============================================================
const SESSIONS = new Map(); // callSid → session

function createSession(callSid, config, fromNumber) {
  return {
    callSid,
    config,
    messages: [],
    leadData: { name: null, phone: fromNumber || null, reason: null },
    turnCount: 0,
    startTime: Date.now(),
    closed: false,
    emailSent: false,
  };
}

// ============================================================
//  DEMO PANEL
// ============================================================
app.get("/demo", (req, res) => {
  const active = activeDemoConfig?.businessName || "None";
  const mins = demoExpiry ? Math.max(0, Math.round((demoExpiry - Date.now()) / 60000)) : 0;
  res.send(`<!DOCTYPE html><html><head><title>Aria Demo</title>
  <style>body{font-family:monospace;background:#020408;color:#00ffe5;padding:40px}
  .btn{display:inline-block;padding:12px 24px;margin:8px;background:#00ffe5;color:#020408;border:none;border-radius:4px;font-weight:bold;cursor:pointer;text-decoration:none;font-family:monospace}
  .btn-off{background:rgba(255,64,96,.2);color:#ff4060;border:1px solid rgba(255,64,96,.3)}
  .status{background:rgba(0,255,229,.08);border:1px solid rgba(0,255,229,.2);padding:20px;border-radius:8px;margin:20px 0}
  </style></head><body>
  <h1>🎯 Aria Demo Panel</h1>
  <div class="status">
    <p>ACTIVE: <strong>${active}</strong> ${activeDemoConfig ? `(${mins} min left)` : ""}</p>
    <p>📞 ${process.env.TWILIO_PHONE_NUMBER || "+16786790658"}</p>
  </div>
  ${Object.keys(DEMO_CONFIGS).map(k => `<a href="/demo/activate/${k}" class="btn">${DEMO_CONFIGS[k].businessName}</a>`).join("")}
  <br><br><a href="/demo/deactivate" class="btn btn-off">❌ Deactivate</a>
  </body></html>`);
});

app.get("/demo/activate/:industry", (req, res) => {
  const cfg = DEMO_CONFIGS[req.params.industry];
  if (!cfg) return res.status(404).send("Not found");
  activeDemoConfig = cfg;
  demoExpiry = Date.now() + 30 * 60 * 1000;
  console.log("🎯 Demo:", cfg.businessName);
  res.redirect("/demo");
});

app.get("/demo/deactivate", (req, res) => {
  activeDemoConfig = null; demoExpiry = null;
  res.redirect("/demo");
});

app.get("/health", (req, res) => res.json({ status: "ok", stripe: "live", twilio: "live", deepgram: "live" }));
app.get("/", (req, res) => res.json({ status: "Converta.AI v3 running" }));


// ============================================================
//  MISSED CALL TEXT-BACK
//  Fires when caller hangs up before Aria answers (no session)
// ============================================================
app.post("/missed-call", async (req, res) => {
  res.sendStatus(200);
  const callSid    = req.body.CallSid;
  const fromNumber = req.body.From;
  const toNumber   = req.body.To;
  const status     = req.body.CallStatus;

  // Only text back if call was not answered (no-answer or busy)
  if (!["no-answer", "busy", "failed"].includes(status)) return;
  if (!fromNumber || fromNumber === "anonymous") return;

  const config = (activeDemoConfig && demoExpiry > Date.now())
    ? activeDemoConfig
    : (CLIENT_CONFIGS[toNumber] || getDefaultConfig());

  console.log(`📵 Missed call from ${fromNumber} to ${config.businessName} — sending text-back`);

  try {
    await client.messages.create({
      to:   fromNumber,
      from: toNumber || process.env.TWILIO_PHONE_NUMBER,
      body: `Hi! You just called ${config.businessName}. Sorry we missed you! Reply to this message or call us back and we'll be happy to help. — ${config.businessName}`,
    });
    console.log(`📱 Text-back sent to ${fromNumber}`);
  } catch(e) {
    console.error("Text-back error:", e.message);
  }
});


// ============================================================
//  PORTAL LOGIN — credentials never exposed in frontend
// ============================================================
const PORTAL_USERS = {
  [process.env.ADMIN_EMAIL || 'admin@converta.ai']: {
    password: process.env.ADMIN_PASSWORD || 'changeme_now',
    role: 'admin', name: 'Marcus', biz: 'Converta.AI'
  },
};

app.post("/portal-login", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { email, password } = req.body;
  console.log(`🔐 Portal login attempt: ${email}`);
  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }
  const user = PORTAL_USERS[email.toLowerCase().trim()];
  if (!user || user.password !== password) {
    console.log(`❌ Failed login for: ${email}`);
    return res.status(401).json({ error: "Invalid credentials" });
  }
  console.log(`✅ Portal login success: ${email} (${user.role})`);
  res.json({ user: { email, role: user.role, name: user.name, biz: user.biz } });
});

app.options("/portal-login", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});


// ============================================================
//  ABUSE PROTECTION
//  Rate limiting, spam detection, call blocking
// ============================================================

// Track calls per number per business
const CALL_TRACKER = new Map(); // key: "from:to" -> { count, firstCall, lastCall, blocked }
const BLOCKED_NUMBERS = new Set(); // permanently blocked numbers
const HOURLY_LIMIT   = 3;   // max calls from same number per hour per business
const DAILY_LIMIT    = 8;   // max calls from same number per day per business
const GLOBAL_HOURLY  = 10;  // max calls from same number across ALL businesses per hour

function getTracker(from, to) {
  const key = `${from}:${to}`;
  if (!CALL_TRACKER.has(key)) {
    CALL_TRACKER.set(key, { count: 0, hourCount: 0, firstCall: Date.now(), lastCall: Date.now(), hourStart: Date.now() });
  }
  return CALL_TRACKER.get(key);
}

function getGlobalTracker(from) {
  const key = `global:${from}`;
  if (!CALL_TRACKER.has(key)) {
    CALL_TRACKER.set(key, { count: 0, hourCount: 0, firstCall: Date.now(), lastCall: Date.now(), hourStart: Date.now() });
  }
  return CALL_TRACKER.get(key);
}

function checkAbuse(from, to) {
  if (!from || from === 'anonymous' || from === 'unknown') return { allowed: true };

  // Check permanent block list
  if (BLOCKED_NUMBERS.has(from)) {
    console.log(`🚫 Blocked number attempted call: ${from}`);
    return { allowed: false, reason: 'blocked' };
  }

  const now = Date.now();
  const tracker = getTracker(from, to);
  const global  = getGlobalTracker(from);

  // Reset hourly counts if hour has passed
  if (now - tracker.hourStart > 3600000) {
    tracker.hourCount = 0;
    tracker.hourStart = now;
  }
  if (now - global.hourStart > 3600000) {
    global.hourCount = 0;
    global.hourStart = now;
  }

  // Reset daily counts if 24 hours have passed
  if (now - tracker.firstCall > 86400000) {
    tracker.count    = 0;
    tracker.firstCall = now;
  }

  tracker.count++;
  tracker.hourCount++;
  tracker.lastCall = now;
  global.count++;
  global.hourCount++;

  // Check limits
  if (global.hourCount > GLOBAL_HOURLY) {
    console.log(`🚫 Global rate limit hit for ${from}: ${global.hourCount} calls/hr across all businesses`);
    if (global.hourCount > GLOBAL_HOURLY * 3) {
      BLOCKED_NUMBERS.add(from);
      console.log(`🚫 Auto-blocked ${from} for excessive abuse`);
    }
    return { allowed: false, reason: 'global_rate_limit' };
  }

  if (tracker.hourCount > HOURLY_LIMIT) {
    console.log(`⚠️ Hourly rate limit hit for ${from} → ${to}: ${tracker.hourCount} calls/hr`);
    return { allowed: false, reason: 'hourly_rate_limit' };
  }

  if (tracker.count > DAILY_LIMIT) {
    console.log(`⚠️ Daily limit hit for ${from} → ${to}: ${tracker.count} calls today`);
    return { allowed: false, reason: 'daily_limit' };
  }

  return { allowed: true };
}

function abuseResponse(res, reason) {
  const twiml = new VoiceResponse();
  if (reason === 'blocked') {
    twiml.reject();
  } else {
    twiml.say(
      { voice: "Polly.Joanna-Neural", language: "en-US" },
      "We are unable to process your call at this time. Please try again later."
    );
    twiml.hangup();
  }
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
}

// Admin endpoint to view and manage abuse
app.get("/admin/abuse", (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  const trackers = [];
  CALL_TRACKER.forEach((v, k) => {
    if (!k.startsWith('global:')) {
      trackers.push({ key: k, ...v });
    }
  });
  trackers.sort((a, b) => b.count - a.count);

  res.json({
    blocked_numbers: [...BLOCKED_NUMBERS],
    top_callers: trackers.slice(0, 20),
    total_tracked: trackers.length,
  });
});

app.post("/admin/block", (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  const { number, action } = req.body;
  if (!number) return res.status(400).json({ error: "number required" });
  if (action === 'unblock') {
    BLOCKED_NUMBERS.delete(number);
    console.log(`✅ Unblocked: ${number}`);
  } else {
    BLOCKED_NUMBERS.add(number);
    console.log(`🚫 Manually blocked: ${number}`);
  }
  res.json({ success: true, blocked: [...BLOCKED_NUMBERS] });
});

// Clean up old tracker entries every hour to prevent memory leak
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  CALL_TRACKER.forEach((v, k) => {
    if (now - v.lastCall > 86400000) {
      CALL_TRACKER.delete(k);
      cleaned++;
    }
  });
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale call tracker entries`);
}, 3600000);


// ============================================================
//  DYNAMIC CLIENT SETTINGS
//  Overrides CLIENT_CONFIGS when client saves from portal
//  Keyed by ownerEmail so portal can update by email
// ============================================================
const CLIENT_SETTINGS = new Map(); // email -> settings object

// Merge dynamic settings over base config
function getClientConfig(toNumber, ownerEmail) {
  const base = CLIENT_CONFIGS[toNumber] || getDefaultConfig();
  if (!ownerEmail) return base;
  const dynamic = CLIENT_SETTINGS.get(ownerEmail);
  if (!dynamic) return base;
  return {
    ...base,
    businessName:         dynamic.businessName         || base.businessName,
    greeting:             dynamic.greeting              || base.greeting,
    closing:              dynamic.closing               || base.closing,
    hours:                dynamic.hours                 || base.hours,
    urgent:               dynamic.urgent                || base.urgent,
    never:                dynamic.never                 || base.never,
    appointmentQuestions: dynamic.questions?.length     ? dynamic.questions : base.appointmentQuestions,
    faqs:                 dynamic.faqs?.length          ? dynamic.faqs      : base.faqs,
  };
}

// Save settings endpoint — called from portal
app.post("/client-settings", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { email, password, settings } = req.body;
  if (!email || !settings) return res.status(400).json({ error: "Missing email or settings" });

  // Verify the user is authenticated (check against PORTAL_USERS)
  const user = PORTAL_USERS[email?.toLowerCase()?.trim()];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  CLIENT_SETTINGS.set(email.toLowerCase(), settings);
  console.log(`⚙️ Settings updated for ${email}: ${settings.businessName || "unknown"}`);
  res.json({ success: true, message: "Settings saved. Aria will use these on the next call." });
});

app.options("/client-settings", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

// Get current settings — portal reads this on load
app.get("/client-settings", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Missing email" });
  const settings = CLIENT_SETTINGS.get(email.toLowerCase());
  res.json({ settings: settings || null });
});

// ============================================================
//  INCOMING CALL
// ============================================================
app.post("/incoming-call", async (req, res) => {
  const callSid    = req.body.CallSid;
  const toNumber   = req.body.To || process.env.TWILIO_PHONE_NUMBER;
  const fromNumber = req.body.From || "unknown";
  const baseConfig  = CLIENT_CONFIGS[toNumber];
  const ownerEmail  = baseConfig?.ownerEmail || null;
  const config      = (activeDemoConfig && demoExpiry > Date.now())
    ? activeDemoConfig
    : getClientConfig(toNumber, ownerEmail);

  // Check for abuse before processing
  const abuse = checkAbuse(fromNumber, toNumber);
  if (!abuse.allowed) {
    console.log(`🚫 Call rejected from ${fromNumber} — reason: ${abuse.reason}`);
    return abuseResponse(res, abuse.reason);
  }

  console.log(`📞 Call ${callSid} → ${config.businessName} from ${fromNumber}`);

  // Create session
  SESSIONS.set(callSid, createSession(callSid, config, fromNumber));

  // Register status callback
  try {
    await client.calls(callSid).update({
      statusCallback: `${SERVER_URL}/call-status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed"],
    });
  } catch(e) { console.log("Status callback warn:", e.message); }

  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Joanna-Neural", language: "en-US" }, config.greeting);
  const connect = twiml.connect();
  const stream = connect.stream({ url: `wss://${SERVER_URL.replace("https://", "")}/media-stream` });
  stream.parameter({ name: "callSid", value: callSid });

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// ============================================================
//  CALL STATUS — email fires here
// ============================================================
app.post("/call-status", async (req, res) => {
  const callSid = req.body.CallSid;
  const status  = req.body.CallStatus;
  console.log(`📵 Call ${callSid} → ${status}`);
  res.sendStatus(200);

  const session = SESSIONS.get(callSid);
  if (session && !session.emailSent && session.messages.length > 0) {
    session.emailSent = true;
    await sendLeadEmail(session);
  }
  SESSIONS.delete(callSid);
});

// ============================================================
//  WEBSOCKET — Media Stream
// ============================================================
wss.on("connection", (ws) => {
  let callSid    = null;
  let dg         = null;
  let transcript = "";
  let timer      = null;
  let busy       = false;

  function startDeepgram() {
    if (dg) { try { dg.finish(); } catch(e){} }
    dg = deepgram.listen.live({
      model:           "nova-2-phonecall",
      language:        "en-US",
      smart_format:    true,
      interim_results: false,
      endpointing:     500,
      encoding:        "mulaw",
      sample_rate:     8000,
      channels:        1,
    });
    dg.on(LiveTranscriptionEvents.Open, () => console.log(`🟢 Deepgram ready (${callSid})`));
    dg.on(LiveTranscriptionEvents.Transcript, (data) => {
      const text = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (!text || !data.is_final) return;
      transcript += (transcript ? " " : "") + text;
      console.log(`📝 "${text}"`);
      clearTimeout(timer);
      timer = setTimeout(() => handleTranscript(), 800);
    });
    dg.on(LiveTranscriptionEvents.Error, (e) => console.error("DG error:", e?.message));
  }

  async function handleTranscript() {
    const text = transcript.trim();
    transcript = "";
    if (!text || busy) return;

    const session = SESSIONS.get(callSid);
    if (!session || session.closed) return;

    busy = true;
    try {
      session.messages.push({ role: "user", content: text });
      session.turnCount++;
      extractLeadData(session, text);
      console.log(`👤 Turn ${session.turnCount}: "${text}"`);

      // Check if we should close
      const shouldClose = session.turnCount >= 10 || hasEnoughInfo(session);

      let reply;
      if (shouldClose) {
        reply = buildClosingMessage(session);
        session.messages.push({ role: "assistant", content: reply });
        session.closed = true;
      } else {
        reply = await getAriaReply(session);
        session.messages.push({ role: "assistant", content: reply });
      }

      console.log(`🤖 Aria: "${reply}"`);
      const safe = escapeXml(reply);

      if (session.closed) {
        // Say goodbye and hang up
        await client.calls(callSid).update({
          twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${safe}</Say><Pause length="1"/><Hangup/></Response>`
        });
        if (dg) { try { dg.finish(); } catch(e){} }
        // Backup force-end after 15s
        setTimeout(async () => {
          try { await client.calls(callSid).update({ status: "completed" }); } catch(e){}
        }, 15000);
      } else {
        // Continue conversation
        await client.calls(callSid).update({
          twiml: `<Response><Say voice="Polly.Joanna-Neural" language="en-US">${safe}</Say><Connect><Stream url="wss://${SERVER_URL.replace("https://","")}/media-stream"><Parameter name="callSid" value="${callSid}"/></Stream></Connect></Response>`
        });
        // Restart Deepgram for next turn — delay to let Aria finish speaking
        setTimeout(() => {
          busy = false;
          startDeepgram();
        }, 1500);
        return;
      }
    } catch(err) {
      console.error("Handle error:", err.message);
    }
    busy = false;
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.event === "start") {
      const sid = msg.start.customParameters?.callSid || msg.start.callSid;
      // If this is a reconnect after Aria spoke, check if call is closed
      if (sid === callSid) {
        const session = SESSIONS.get(sid);
        if (!session || session.closed) {
          console.log(`🔴 Reconnect on closed call ${sid} — hanging up`);
          try { client.calls(sid).update({ status: "completed" }); } catch(e){}
          return;
        }
        console.log(`🔄 Stream reconnect for ${sid}`);
        return; // Deepgram already restarted via setTimeout above
      }
      callSid = sid;
      console.log(`🎙 Stream started for ${callSid}`);
      startDeepgram();
    }

    if (msg.event === "media" && dg) {
      try { dg.send(Buffer.from(msg.media.payload, "base64")); } catch(e){}
    }

    if (msg.event === "stop") {
      clearTimeout(timer);
      if (dg) { try { dg.finish(); } catch(e){} }
      console.log(`🔴 Stream stopped for ${callSid}`);
    }
  });

  ws.on("close", () => {
    clearTimeout(timer);
    if (dg) { try { dg.finish(); } catch(e){} }
  });
});

// ============================================================
//  AI RESPONSE
// ============================================================
async function getAriaReply(session) {
  const { config, messages, turnCount } = session;
  const questions = config.appointmentQuestions || ["What's your name?", "What's your callback number?", "How can we help?"];
  const faqs = config.faqs?.length ? config.faqs.map(f => `- If asked about "${f.q}", say: ${f.a}`).join("\n") : "None";

  // Strict question index — never skip, never reorder
  const qIndex = Math.min(turnCount - 1, questions.length - 1);
  const currentQuestion = questions[qIndex];
  const isLast = qIndex >= questions.length - 1;
  const prevMsg = messages.length >= 2 ? messages[messages.length - 2] : null;
  const callerJustAskedFaq = prevMsg?.role === "user" && config.faqs?.some(f =>
    prevMsg.content.toLowerCase().includes(f.q.toLowerCase())
  );

  // If caller asked a FAQ, answer it then ask the current question
  // Otherwise just ask the current question
  const system = `You are Aria, a phone receptionist for ${config.businessName}.

${callerJustAskedFaq
  ? `First answer their question using these FAQs:\n${faqs}\n\nThen immediately ask: "${currentQuestion}"`
  : `Ask exactly this question in a warm natural way: "${currentQuestion}"`
}

${isLast ? `This is the last question. After asking it, you will confirm their info and wrap up.` : ""}

STRICT RULES:
- ONE or TWO sentences maximum
- Do NOT ask any other question besides "${currentQuestion}"
- Do NOT say "Thanks for calling" or re-introduce yourself
- Do NOT skip this question or replace it with a different one`;

  const response = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 80,
    system,
    messages:   messages.slice(-6), // only last 6 messages for speed
  });
  return response.content[0].text.trim();
}

function extractLeadData(session, text) {
  const msgs = session.messages;
  const prevAria = msgs.length >= 2 ? msgs[msgs.length - 2] : null;

  // Name: if Aria asked for name and caller gave a short response
  if (!session.leadData.name && prevAria?.role === "assistant") {
    const askedName = /name|call you|who (am i|is this)/i.test(prevAria.content);
    if (askedName && text.split(" ").length <= 4) {
      session.leadData.name = text.replace(/[^a-zA-Z\s]/g, "").trim();
    }
  }

  // Phone: extract digits
  if (!session.leadData.phone || session.leadData.phone === "unknown") {
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 10) session.leadData.phone = digits;
  }

  // Reason: keywords or previous Aria question context
  if (!session.leadData.reason && prevAria?.role === "assistant") {
    const askedReason = /help|reason|visit|interested|matter|calling/i.test(prevAria.content);
    if (askedReason && text.length > 3) session.leadData.reason = text.slice(0, 80);
  }
  if (!session.leadData.reason) {
    const keywords = ["appointment","reservation","booking","consultation","question","emergency","pain","repair","injury","dinner","lunch","table"];
    for (const k of keywords) if (text.toLowerCase().includes(k)) { session.leadData.reason = k; break; }
  }
}

function hasEnoughInfo(session) {
  const { config } = session;
  const questionsCount = config.appointmentQuestions?.length || 3;
  // Only close after ALL questions have been asked (one per turn)
  return session.turnCount >= questionsCount;
}

function buildClosingMessage(session) {
  const name = session.leadData.name ? ` ${session.leadData.name.split(" ")[0]}` : "";
  return `Perfect${name}! I've got everything I need. Someone from our team will be in touch with you shortly. Have a great day!`;
}

function escapeXml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

// ============================================================
//  EMAIL via Resend
// ============================================================
async function sendLeadEmail(session) {
  const { config, leadData, messages, startTime } = session;
  const duration = Math.round((Date.now() - startTime) / 1000);
  const to = config.ownerEmail || process.env.NOTIFY_EMAIL;

  if (!to || !process.env.RESEND_API_KEY) {
    console.log("📧 Email skipped — no NOTIFY_EMAIL or RESEND_API_KEY");
    return;
  }

  // Fire calendar integration before sending email
  await handleCalendarIntegration(session);

  const transcript = messages.map(m => `${m.role === "user" ? "Caller" : "Aria"}: ${m.content}`).join("\n");
  const calendlySection = session.calendlyUrl
    ? `<div style="margin-top:16px;padding:14px;background:#e8f5f2;border-radius:6px;border-left:3px solid #00d4aa">
        <strong>📅 Book a follow-up appointment:</strong><br>
        <a href="${session.calendlyUrl}" style="color:#00857a">${session.calendlyUrl}</a>
       </div>`
    : '';

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Converta.AI <onboarding@resend.dev>",
        to,
        subject: `📞 New Lead: ${leadData.name || "Unknown"} — ${config.businessName}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#00d4aa;padding:16px 20px;border-radius:6px 6px 0 0">
            <h2 style="color:#020408;margin:0">📞 New Lead from Aria</h2>
          </div>
          <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:0 0 6px 6px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#666;width:160px">Business</td><td style="font-weight:bold">${config.businessName}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Name</td><td style="font-weight:bold">${leadData.name || "Not captured"}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Phone</td><td style="font-weight:bold"><a href="tel:${leadData.phone}">${leadData.phone || "Unknown"}</a></td></tr>
              <tr><td style="padding:8px 0;color:#666">Reason</td><td style="font-weight:bold">${leadData.reason || "Not captured"}</td></tr>
              <tr><td style="padding:8px 0;color:#666">Duration</td><td>${duration}s</td></tr>
              <tr><td style="padding:8px 0;color:#666">Time</td><td>${new Date().toLocaleString()}</td></tr>
            </table>
            <div style="margin-top:20px;padding:16px;background:#f5f5f5;border-radius:6px">
              <strong>Transcript</strong><br><br>
              <pre style="font-family:Arial;font-size:13px;white-space:pre-wrap;margin:0">${transcript}</pre>
            </div>
            ${calendlySection}<p style="font-size:12px;color:#999;margin-top:16px">Powered by Converta.AI</p>
          </div>
        </div>`
      })
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`📧 Email sent to ${to} — id: ${data.id}`);
    } else {
      console.error("📧 Email failed:", JSON.stringify(data));
    }
  } catch(e) {
    console.error("📧 Email error:", e.message);
  }

  // Fire Zapier webhook if configured
  await sendZapierWebhook(session);
}

// ============================================================
//  ZAPIER WEBHOOK
// ============================================================
async function sendZapierWebhook(session) {
  const { config, leadData, messages, startTime } = session;
  if (!config.zapierWebhook) return;

  const duration = Math.round((Date.now() - startTime) / 1000);
  const transcript = messages.map(m => `${m.role === "user" ? "Caller" : "Aria"}: ${m.content}`).join("\n");

  try {
    const res = await fetch(config.zapierWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business:    config.businessName,
        caller_name: leadData.name || "Unknown",
        caller_phone: leadData.phone || "Unknown",
        reason:      leadData.reason || "Unknown",
        duration_seconds: duration,
        timestamp:   new Date().toISOString(),
        transcript,
      })
    });
    console.log(`⚡ Zapier webhook fired for ${config.businessName} — status: ${res.status}`);
  } catch(e) {
    console.error("Zapier webhook error:", e.message);
  }
}

// ============================================================
//  STRIPE
// ============================================================
const PLANS = {
  starter: { name: "Starter", setupPrice: process.env.STRIPE_STARTER_SETUP_PRICE_ID, monthlyPrice: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID, annualPrice: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID },
  growth:  { name: "Growth",  setupPrice: process.env.STRIPE_GROWTH_SETUP_PRICE_ID,  monthlyPrice: process.env.STRIPE_GROWTH_MONTHLY_PRICE_ID,  annualPrice: process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID },
  pro:     { name: "Pro",     setupPrice: process.env.STRIPE_PRO_SETUP_PRICE_ID,     monthlyPrice: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,     annualPrice: process.env.STRIPE_PRO_ANNUAL_PRICE_ID },
};

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan, billing } = req.body;
    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: "Invalid plan" });
    const recurring = billing === "annual" ? p.annualPrice : p.monthlyPrice;
    const items = [];
    if (p.setupPrice)  items.push({ price: p.setupPrice,  quantity: 1 });
    if (recurring)     items.push({ price: recurring,     quantity: 1 });
    const sess = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: items,
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL || "https://converta-site.vercel.app"}/?success=true&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL || "https://converta-site.vercel.app"}/?canceled=true`,
      metadata: { plan, billing },
    });
    res.json({ url: sess.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/create-customer-portal-session", async (req, res) => {
  try {
    const sess = await stripe.billingPortal.sessions.create({
      customer: req.body.customerId,
      return_url: process.env.FRONTEND_URL || "https://converta-site.vercel.app",
    });
    res.json({ url: sess.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function handleStripeWebhook(req, res) {
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    console.log("Stripe:", event.type);
    res.json({ received: true });
  } catch(e) { res.status(400).send(`Webhook Error: ${e.message}`); }
}


// ============================================================
//  FALLBACK — fires if primary webhook fails
// ============================================================
app.post("/fallback", (req, res) => {
  const callSid    = req.body.CallSid;
  const fromNumber = req.body.From;
  const toNumber   = req.body.To;
  console.log(`⚠️ Fallback triggered for ${callSid} from ${fromNumber}`);

  if (fromNumber && fromNumber !== 'anonymous') {
    const config = CLIENT_CONFIGS[toNumber] || getDefaultConfig();
    client.messages.create({
      to: fromNumber, from: toNumber || process.env.TWILIO_PHONE_NUMBER,
      body: `Hi! You just called ${config.businessName}. We missed your call but will call you back shortly. Sorry for the inconvenience!`,
    }).catch(e => console.error("Fallback text error:", e.message));
  }

  const twiml = new VoiceResponse();
  twiml.say({ voice:"Polly.Joanna-Neural", language:"en-US" },
    "Thank you for calling. We are experiencing a brief technical issue. Please leave your name and number after the tone and we will call you back as soon as possible."
  );
  twiml.record({ maxLength:120, transcribe:false, playBeep:true, recordingStatusCallback:`${SERVER_URL}/recording-status` });
  twiml.say({ voice:"Polly.Joanna-Neural" }, "Thank you. We will be in touch shortly.");
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

app.post("/recording-status", async (req, res) => {
  res.sendStatus(200);
  const recordingUrl = req.body.RecordingUrl;
  const from         = req.body.From || "Unknown";
  const to           = req.body.To;
  if (!recordingUrl) return;

  const config     = CLIENT_CONFIGS[to] || getDefaultConfig();
  const ownerEmail = config.ownerEmail || process.env.NOTIFY_EMAIL;
  if (!ownerEmail || !process.env.RESEND_API_KEY) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization":`Bearer ${process.env.RESEND_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        from: "Converta.AI <onboarding@resend.dev>", to: ownerEmail,
        subject: `⚠️ Missed call voicemail — ${from}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px"><div style="background:#f0c040;padding:16px 20px;border-radius:6px 6px 0 0"><h2 style="color:#020408;margin:0">⚠️ Fallback Voicemail</h2></div><div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:0 0 6px 6px"><p>A caller was routed to the fallback system.</p><table style="width:100%"><tr><td style="color:#666;padding:6px 0;width:120px">From</td><td><strong>${from}</strong></td></tr><tr><td style="color:#666;padding:6px 0">Business</td><td><strong>${config.businessName}</strong></td></tr><tr><td style="color:#666;padding:6px 0">Voicemail</td><td><a href="${recordingUrl}">Listen here</a></td></tr><tr><td style="color:#666;padding:6px 0">Time</td><td>${new Date().toLocaleString()}</td></tr></table></div></div>`
      })
    });
    console.log(`📧 Fallback voicemail email sent for ${from}`);
  } catch(e) { console.error("Fallback email error:", e.message); }
});

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🚀 Converta.AI v3 on port ${PORT}`);
  console.log(`   Stripe: LIVE | Twilio: LIVE | Deepgram: LIVE`);
});

// ============================================================
//  CALENDAR INTEGRATIONS
// ============================================================

async function createGoogleCalendarEvent(session, config) {
  const { leadData } = session;
  const cal = config.calendarConfig;
  if (!cal?.serviceAccountEmail || !cal?.privateKey || !cal?.calendarId) return;
  try {
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg:'RS256', typ:'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: cal.serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600, iat: now,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(cal.privateKey.replace(/\\n/g, '\n'), 'base64url');
    const jwt = `${header}.${payload}.${sig}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('No access token');

    const start = new Date(); start.setDate(start.getDate()+1); start.setHours(9,0,0,0);
    const end   = new Date(start.getTime() + 30*60000);

    const evtRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.calendarId)}/events`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary:     `📞 New Lead: ${leadData.name||'Unknown'} — ${config.businessName}`,
          description: `Caller: ${leadData.name||'Unknown'}\nPhone: ${leadData.phone||'Unknown'}\nReason: ${leadData.reason||'Unknown'}\nCaptured by Aria at ${new Date().toLocaleString()}\n\nView full transcript in your Converta.AI portal.`,
          start: { dateTime: start.toISOString(), timeZone: 'America/New_York' },
          end:   { dateTime: end.toISOString(),   timeZone: 'America/New_York' },
          colorId: '2',
          reminders: { useDefault: false, overrides: [{ method:'popup', minutes:30 }] },
        }),
      }
    );
    const evt = await evtRes.json();
    if (evt.id) console.log(`📅 Google Calendar event created: ${evt.htmlLink}`);
    else console.error('Google Calendar failed:', JSON.stringify(evt));
  } catch(e) { console.error('Google Calendar error:', e.message); }
}

async function createOutlookCalendarEvent(session, config) {
  const { leadData } = session;
  const cal = config.calendarConfig;
  if (!cal?.tenantId || !cal?.clientId || !cal?.clientSecret || !cal?.userEmail) return;
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${cal.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials', client_id: cal.clientId,
          client_secret: cal.clientSecret, scope: 'https://graph.microsoft.com/.default',
        }).toString(),
      }
    );
    const { access_token } = await tokenRes.json();
    if (!access_token) throw new Error('No token');

    const start = new Date(); start.setDate(start.getDate()+1); start.setHours(9,0,0,0);
    const end   = new Date(start.getTime() + 30*60000);

    const evtRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${cal.userEmail}/calendar/events`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: `📞 New Lead: ${leadData.name||'Unknown'} — ${config.businessName}`,
          body: { contentType:'text', content:`Caller: ${leadData.name||'Unknown'}\nPhone: ${leadData.phone||'Unknown'}\nReason: ${leadData.reason||'Unknown'}\nCaptured by Aria at ${new Date().toLocaleString()}` },
          start: { dateTime: start.toISOString(), timeZone:'Eastern Standard Time' },
          end:   { dateTime: end.toISOString(),   timeZone:'Eastern Standard Time' },
          isReminderOn: true, reminderMinutesBeforeStart: 30,
        }),
      }
    );
    const evt = await evtRes.json();
    if (evt.id) console.log(`📅 Outlook event created for ${leadData.name||'Unknown'}`);
    else console.error('Outlook failed:', JSON.stringify(evt));
  } catch(e) { console.error('Outlook Calendar error:', e.message); }
}

async function handleCalendlyIntegration(session, config) {
  const cal = config.calendarConfig;
  if (!cal?.bookingUrl) return;
  session.calendlyUrl = cal.bookingUrl;
  console.log(`📅 Calendly link attached: ${cal.bookingUrl}`);
  if (cal.webhookUrl) {
    try {
      await fetch(cal.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: session.leadData.name||'Unknown', phone: session.leadData.phone||'Unknown',
          reason: session.leadData.reason||'Unknown', business: config.businessName,
          timestamp: new Date().toISOString(), source: 'Converta.AI',
        }),
      });
    } catch(e) { console.error('Calendly webhook error:', e.message); }
  }
}

async function handleCalendarIntegration(session) {
  const config = session.config;
  if (!config.calendarType || !config.calendarConfig) return;
  console.log(`📅 Running calendar integration: ${config.calendarType}`);
  switch(config.calendarType) {
    case 'google':   await createGoogleCalendarEvent(session, config); break;
    case 'outlook':  await createOutlookCalendarEvent(session, config); break;
    case 'calendly': await handleCalendlyIntegration(session, config); break;
  }
}
