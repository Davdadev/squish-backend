require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Squish Factory backend is running 🎲' });
});

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
      }));
    res.json({ products: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  const { priceId, pickup } = req.body;
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

  try {
    const sessionParams = {
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.SUCCESS_URL || `http://localhost:${PORT}?success=true`,
      cancel_url:  process.env.CANCEL_URL  || `http://localhost:${PORT}?canceled=true`,
    };

    if (pickup) {
      // ── PICKUP: no address, no shipping fees ──
      sessionParams.custom_fields = [{
        key: 'pickup_note',
        label: { type: 'custom', custom: 'Pickup location' },
        type: 'text',
        text: { default_value: 'Narre Warren South — we\'ll contact you to arrange' },
      }];
    } else {
      // ── DELIVERY: address + shipping rate options ──
      sessionParams.shipping_address_collection = { allowed_countries: ['AU'] };
      sessionParams.shipping_options = [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 1000, currency: 'aud' }, // $10.00
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
            fixed_amount: { amount: 1500, currency: 'aud' }, // $15.00
            display_name: 'Express Delivery',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 1 },
              maximum: { unit: 'business_day', value: 3 },
            },
          },
        },
      ];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎲 Squish Factory running on http://localhost:${PORT}\n`);
});
