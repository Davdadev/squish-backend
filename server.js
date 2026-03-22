/**
 * SQUISH FACTORY — Stripe Backend Server
 * ────────────────────────────────────────
 * Exposes two endpoints the shop frontend uses:
 *   GET  /api/products   → lists all active Stripe products + prices
 *   POST /api/checkout   → creates a Stripe Checkout session
 *
 * SETUP:
 *   1.  npm install
 *   2.  Create a .env file with your Stripe Secret Key (see below)
 *   3.  node server.js   (or: npm start)
 *
 * .env contents:
 *   STRIPE_SECRET_KEY=sk_live_...
 *   SUCCESS_URL=https://yourshop.com?success=true
 *   CANCEL_URL=https://yourshop.com?canceled=true
 *   PORT=3000
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();
const PORT   = process.env.PORT || 3000;

// ── Allow the HTML shop page to call this server ──
app.use(cors({
  origin: '*', // tighten this to your domain in production, e.g. 'https://yourshop.com'
}));
app.use(express.json());

// ── Health check ──────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Squish Factory backend is running 🎲' });
});

// ── GET /api/products ─────────────────────────────
// Fetches all active products from Stripe and returns
// each one with its default price attached.
// New products added in Stripe appear automatically.
app.get('/api/products', async (req, res) => {
  try {
    // Fetch all active products (auto-paginates up to 100)
    const products = await stripe.products.list({
      active: true,
      expand: ['data.default_price'],
      limit: 100,
    });

    const items = products.data
      .filter(p => p.default_price) // only products that have a price set
      .map(p => {
        const price = p.default_price;
        return {
          id:          p.id,
          name:        p.name,
          description: p.description || '',
          image:       p.images?.[0] || null,
          active:      p.active,
          priceId:     price.id,
          price:       price.unit_amount,       // in cents/smallest currency unit
          currency:    price.currency,
          metadata:    p.metadata || {},
        };
      });

    res.json({ products: items });
  } catch (err) {
    console.error('Stripe products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/checkout ────────────────────────────
// Creates a Stripe Checkout session for a given price ID.
// Returns the session ID so the frontend can redirect.
app.post('/api/checkout', async (req, res) => {
  const { priceId } = req.body;

  if (!priceId) {
    return res.status(400).json({ error: 'Missing priceId' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:        'payment',
      line_items:  [{ price: priceId, quantity: 1 }],
      success_url: process.env.SUCCESS_URL || `http://localhost:${PORT}?success=true`,
      cancel_url:  process.env.CANCEL_URL  || `http://localhost:${PORT}?canceled=true`,
      // Optional: collect shipping address
      shipping_address_collection: {
        allowed_countries: ['AU', 'US', 'GB', 'CA', 'NZ'], // add yours
      },
      // Optional: let customer adjust quantity in checkout
      // allow_promotion_codes: true,
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎲 Squish Factory backend running on http://localhost:${PORT}`);
  console.log(`   GET  /api/products  — list your Stripe products`);
  console.log(`   POST /api/checkout  — create a checkout session\n`);
});
