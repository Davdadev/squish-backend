require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();
const PORT   = process.env.PORT || 3000;

const FREE_SHIPPING_THRESHOLD = 5000; // $50.00 AUD in cents
const DEFAULT_COLORS = ['Red', 'Blue', 'Green', 'Purple', 'Pink', 'Orange', 'Yellow', 'Black'];

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Squish Factory backend is running 🎲' });
});

function parseProductColors(metadata = {}) {
  const raw = metadata.colors || metadata.colours || '';
  if (!raw) return DEFAULT_COLORS;

  const parsed = String(raw)
    .split(/[|,\/]/)
    .map(c => c.trim())
    .filter(Boolean)
    .slice(0, 12);

  return parsed.length ? parsed : DEFAULT_COLORS;
}

function normalizeCheckoutItems({ items, priceIds, priceId }) {
  // New format: [{ priceId, quantity, color }]
  if (Array.isArray(items) && items.length) {
    return items
      .map(item => ({
        priceId: typeof item?.priceId === 'string' ? item.priceId.trim() : '',
        quantity: Math.max(1, Math.min(99, Number(item?.quantity) || 1)),
        color: typeof item?.color === 'string' ? item.color.trim().slice(0, 40) : '',
      }))
      .filter(item => item.priceId);
  }

  // Legacy format: duplicates in array imply quantity
  if (Array.isArray(priceIds) && priceIds.length) {
    const qtyCounts = {};
    for (const id of priceIds) {
      if (typeof id !== 'string' || !id.trim()) continue;
      qtyCounts[id] = (qtyCounts[id] || 0) + 1;
    }
    return Object.entries(qtyCounts).map(([pid, quantity]) => ({ priceId: pid, quantity, color: '' }));
  }

  // Legacy format: single priceId
  if (typeof priceId === 'string' && priceId.trim()) {
    return [{ priceId: priceId.trim(), quantity: 1, color: '' }];
  }

  return [];
}

// ── GET /api/products ─────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const products = await stripe.products.list({ active: true, expand: ['data.default_price'], limit: 100 });
    const items = products.data
      .filter(p => p.default_price)
      .map(p => ({
        id: p.id, name: p.name, description: p.description || '',
        image: p.images?.[0] || null, active: p.active,
        priceId: p.default_price.id, price: p.default_price.unit_amount,
        currency: p.default_price.currency, metadata: p.metadata || {},
        colorOptions: parseProductColors(p.metadata || {}),
      }));
    res.json({ products: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/checkout ────────────────────────────
// Body: { priceIds: ['price_xxx', ...], pickup: bool }
// priceIds is an array so upsell items can be added
app.post('/api/checkout', async (req, res) => {
  const { items, priceIds, priceId, pickup } = req.body;

  // Supports:
  // - items: [{ priceId, quantity, color }]
  // - priceIds: ['price_x', 'price_x', 'price_y'] (legacy)
  // - priceId: 'price_x' (legacy)
  const normalizedItems = normalizeCheckoutItems({ items, priceIds, priceId });
  if (!normalizedItems.length) return res.status(400).json({ error: 'Missing item(s)' });

  try {
    // Count quantities per price ID for Stripe line_items
    const qtyCounts = {};
    for (const item of normalizedItems) {
      qtyCounts[item.priceId] = (qtyCounts[item.priceId] || 0) + item.quantity;
    }

    // Build line items with proper quantity (shows as "x3" in Stripe, not 3 rows)
    const line_items = Object.entries(qtyCounts).map(([price, quantity]) => ({ price, quantity }));

    // Keep selected colours/quantities for order ops in metadata
    const optionSummary = normalizedItems
      .map(item => `${item.priceId}:${item.color || 'Default'}x${item.quantity}`)
      .join('|')
      .slice(0, 500);

    // Calculate total for free shipping check
    const uniqueIds = Object.keys(qtyCounts);
    const prices = await Promise.all(uniqueIds.map(id => stripe.prices.retrieve(id)));
    const totalCents = prices.reduce((sum, p) => sum + (p.unit_amount || 0) * qtyCounts[p.id], 0);
    const qualifiesForFreeShipping = totalCents >= FREE_SHIPPING_THRESHOLD;

    const sessionParams = {
      mode: 'payment',
      line_items,
      success_url: process.env.SUCCESS_URL || `http://localhost:${PORT}?success=true`,
      cancel_url:  process.env.CANCEL_URL  || `http://localhost:${PORT}?canceled=true`,
      metadata: {
        selected_options: optionSummary,
      },
    };

    if (pickup) {
      // ── PICKUP: no address, no shipping ──
      sessionParams.custom_fields = [{
        key: 'pickup_note',
        label: { type: 'custom', custom: 'Pickup location' },
        type: 'text',
        text: { default_value: "email me at david.sebbag2010@gmail.com" },
      }];
    } else {
      // ── DELIVERY: address + shipping options ──
      sessionParams.shipping_address_collection = { allowed_countries: ['AU'] };

      if (qualifiesForFreeShipping) {
        // Order is $50+ — offer free standard, discounted express
        sessionParams.shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'aud' },
              display_name: '🎉 Free Standard Delivery (order over $50)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 1500, currency: 'aud' },
              display_name: 'Express Delivery',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 1 },
                maximum: { unit: 'business_day', value: 3 },
              },
            },
          },
        ];
      } else {
        // Under $50 — standard $10, express $15
        sessionParams.shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 1000, currency: 'aud' },
              display_name: 'Standard Delivery',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 1500, currency: 'aud' },
              display_name: 'Express Delivery',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 1 },
                maximum: { unit: 'business_day', value: 3 },
              },
            },
          },
        ];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ sessionId: session.id, qualifiesForFreeShipping, totalCents });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎲 Squish Factory running on http://localhost:${PORT}\n`);
});
