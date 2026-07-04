const Stripe = require("stripe");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || "https://app.tunevote.com";

// Null when no secret key is configured; billing endpoints must guard on this.
let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY);
  console.log("✅ Stripe initialised");
} else {
  console.warn("⚠️  STRIPE_SECRET_KEY missing — billing endpoints will 500");
}

module.exports = {
  stripe,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ID,
  APP_PUBLIC_URL,
};
