const express = require("express");
const pool = require("../db");
const {
  stripe,
  STRIPE_PRICE_ID,
  APP_PUBLIC_URL,
} = require("../services/stripe");
const { getUserFromToken } = require("../services/auth");

const router = express.Router();

// === Billing: status / checkout / portal ===
router.get("/billing/status", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT subscription_status, subscription_current_period_end
       FROM users WHERE id = ?`,
    [user.id],
  );
  const row = rows[0] || {};
  const active =
    row.subscription_status === "active" &&
    row.subscription_current_period_end &&
    new Date(row.subscription_current_period_end) > new Date();
  res.json({
    active: !!active,
    status: row.subscription_status || "none",
    current_period_end: row.subscription_current_period_end || null,
  });
});

router.post("/billing/checkout-session", async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: "billing not configured" });
  }
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT email, stripe_customer_id FROM users WHERE id = ?`,
    [user.id],
  );
  const userRow = rows[0];
  if (!userRow) return res.status(404).json({ error: "user not found" });

  try {
    const params = {
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${APP_PUBLIC_URL}/?checkout=success`,
      cancel_url: `${APP_PUBLIC_URL}/?checkout=canceled`,
      client_reference_id: String(user.id),
      allow_promotion_codes: true,
    };
    if (userRow.stripe_customer_id) {
      params.customer = userRow.stripe_customer_id;
    } else {
      params.customer_email = userRow.email;
    }
    const checkoutSession = await stripe.checkout.sessions.create(params);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err);
    res.status(500).json({ error: "checkout failed" });
  }
});

router.post("/billing/portal-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "billing not configured" });
  const token = req.headers.authorization?.split(" ")[1];
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const [rows] = await pool.query(
    `SELECT stripe_customer_id FROM users WHERE id = ?`,
    [user.id],
  );
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: "no subscription" });

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_PUBLIC_URL}/`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error("❌ Stripe portal error:", err);
    res.status(500).json({ error: "portal failed" });
  }
});

module.exports = router;
