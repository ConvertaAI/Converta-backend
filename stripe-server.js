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
