// ============================================================
//  CONVERTA.AI — Combined Server (Stripe + Twilio)
//  Run: node server.js
// ============================================================

require("dotenv").config();
const express = require("express");
const app = express();

// ============================================================
//  CONVERTA.AI — Stripe Billing Server
//  File: stripe-server.js
//  Run: node stripe-server.js
//  Requires: npm install express stripe cors dotenv
// ============================================================

require("dotenv").config();
const express = require("express");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors    = require("cors");

const app = express();

// ── Webhook needs raw body — mount BEFORE express.json() ──
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

app.use(cors({ origin: "*" }));
app.use(express.json());

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", mode: process.env.NODE_ENV || "live" }));

// Root route
app.get("/", (req, res) => res.json({ status: "Converta.AI Stripe Server running" }));



// ============================================================
//  PRICE IDs  (create these once in your Stripe Dashboard,
//  then paste the price_xxx IDs into your .env file)
// ============================================================
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

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Converta.AI Stripe server running on port ${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE 🔴" : "TEST ✅"}`);
  console.log(`   Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:3000"}\n`);
});


// ============================================================
//  TWILIO / ARIA ROUTES
// ============================================================

// ============================================================
//  CONVERTA.AI — Twilio Call Routing Server
//  File: twilio-server.js
//  Run: node twilio-server.js
//  Requires: npm install express twilio @anthropic-ai/sdk dotenv cors
//
//  HOW IT WORKS:
//  1. Client's phone number forwards to their Twilio number
//  2. Twilio hits /incoming-call when someone calls
//  3. We fetch that client's config from Supabase
//  4. Twilio reads a greeting, records the caller's response
//  5. We send the recording to Claude for a smart reply
//  6. Twilio speaks Claude's reply back to the caller
//  7. Lead is saved + business owner gets a text notification
// ============================================================

const twilio     = require("twilio");
const Anthropic  = require("@anthropic-ai/sdk");

const app        = express();
const client     = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VoiceResponse = twilio.twiml.VoiceResponse;

app.use(express.urlencoded({ extended: false }));

// ============================================================
//  IN-MEMORY CLIENT CONFIG
//  In production, replace with Supabase fetch:
//    const config = await supabase.from("clients").select("*").eq("twilio_number", to).single()
// ============================================================
const CLIENT_CONFIGS = {
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
//  POST /incoming-call
//  Twilio hits this when someone calls a client's Aria number
// ============================================================
app.post("/incoming-call", async (req, res) => {
  const twiml    = new VoiceResponse();
  const callSid  = req.body.CallSid;
  const toNumber = req.body.To;

  const config = CLIENT_CONFIGS[toNumber] || getDefaultConfig();

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

  // Record the caller's first response
  twiml.record({
    action:          `/process-speech/${callSid}`,
    maxLength:        15,
    playBeep:         false,
    transcribe:       true,
    transcribeCallback: `/save-transcript/${callSid}`,
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

  const transcription = req.body.TranscriptionText || req.body.SpeechResult || "";
  console.log(`🎙 Caller said: "${transcription}"`);

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

    // Record next response
    twiml.record({
      action:    `/process-speech/${callSid}`,
      maxLength:  15,
      playBeep:   false,
      transcribe: true,
      transcribeCallback: `/save-transcript/${callSid}`,
    });

  } catch (err) {
    console.error("Claude API error:", err.message);
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
    model:      "claude-sonnet-4-20250514",
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
    businessName:  "Our Business",
    ownerPhone:    process.env.NOTIFY_PHONE || "+14045550000",
    greeting:      "Thank you for calling! I'm Aria, your AI assistant. How can I help you today?",
    businessType:  "business",
    faqs:          [],
    appointmentQuestions: ["What's your name?", "What can we help you with today?"],
  };
}

// ============================================================
//  START SERVER
// ============================================================

// ============================================================
//  START COMBINED SERVER
// ============================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 Converta.AI server running on port ${PORT}`);
  console.log(`   Stripe: LIVE`);
  console.log(`   Twilio: LIVE`);
});
