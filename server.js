require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Stripe  = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app    = express();
const PORT   = process.env.PORT || 3000;

const FREE_SHIPPING_THRESHOLD = 5000; // $50.00 AUD in cents
const DEFAULT_COLORS = ['Red', 'Blue', 'Green', 'Purple', 'Pink', 'Orange', 'Yellow', 'Black'];
const VARIANT_PRICING_CSV_URL = (process.env.VARIANT_PRICING_CSV_URL || '').trim();
const VARIANT_PRICING_SYNC_MS = Math.max(60_000, Number(process.env.VARIANT_PRICING_SYNC_MS) || 300_000);
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || 'https://3dfidgets.shop').replace(/\/+$/, '');

let variantPricingByPriceId = new Map(); // priceId -> { [color]: deltaCents }
let variantPricingLastSyncAt = null;
let variantPricingLastError = null;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Squish Factory backend is running 🎲' });
});

app.get('/api/variant-pricing/status', (req, res) => {
  res.json({
    enabled: Boolean(VARIANT_PRICING_CSV_URL),
    source: VARIANT_PRICING_CSV_URL || null,
    syncedPriceIds: variantPricingByPriceId.size,
    lastSyncAt: variantPricingLastSyncAt,
    lastError: variantPricingLastError,
  });
});

app.post('/api/variant-pricing/refresh', async (req, res) => {
  try {
    await refreshVariantPricingFromSheet();
    res.json({ ok: true, syncedPriceIds: variantPricingByPriceId.size, lastSyncAt: variantPricingLastSyncAt });
  } catch (err) {
    variantPricingLastError = err.message;
    res.status(500).json({ ok: false, error: err.message });
  }
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

function parseDeltaToCents(value) {
  if (value === null || value === undefined) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;

  // Supports:
  // - "2" or "2.50"  -> dollars
  // - "$2"            -> dollars
  // - "200c"          -> cents
  const centsMatch = raw.match(/^([+-]?\d+)\s*c$/i);
  if (centsMatch) return Number(centsMatch[1]) || 0;

  const dollars = Number(raw.replace(/\$/g, ''));
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

function parseColorPriceAdjustments(metadata = {}) {
  const raw =
    metadata.color_prices ||
    metadata.colour_prices ||
    metadata.color_price_adjustments ||
    metadata.colour_price_adjustments ||
    metadata.variant_prices ||
    metadata.variant_pricing ||
    '';

  if (!raw) return {};

  // JSON format example:
  // {"Red":0,"Blue":2,"Glow":3.5}
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const normalized = {};
      for (const [color, delta] of Object.entries(parsed)) {
        const key = String(color).trim();
        if (!key) continue;
        normalized[key] = parseDeltaToCents(delta);
      }
      return normalized;
    }
  } catch {
    // fall through to text parser
  }

  // Text format examples:
  // "Red:0, Blue:2, Glow:3.5"
  // "Red=0|Blue=2|Glow=350c"
  const result = {};
  const chunks = String(raw)
    .split(/[|,\/]/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const [namePart, pricePart] = chunk.split(/[:=]/);
    const color = String(namePart || '').trim();
    if (!color) continue;
    result[color] = parseDeltaToCents(pricePart);
  }

  return result;
}

function mergeColorAdjustments(base = {}, override = {}) {
  return { ...(base || {}), ...(override || {}) };
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function getFirstValueByAliases(row, aliases) {
  for (const key of aliases) {
    const normalized = key.toLowerCase();
    const hit = Object.entries(row).find(([k]) => k.toLowerCase() === normalized);
    if (hit && String(hit[1] || '').trim()) return String(hit[1]).trim();
  }
  return '';
}

function parseVariantPricingCsv(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return new Map();

  const headers = parseCsvLine(lines[0]);
  const parsedRows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || '';
    });
    parsedRows.push(row);
  }

  // Required columns in spreadsheet:
  // - price_id (or priceId)
  // - color
  // - adjustment (or delta / color_price)
  const nextMap = new Map();

  for (const row of parsedRows) {
    const priceId = getFirstValueByAliases(row, ['price_id', 'priceId', 'stripe_price_id']);
    const color = getFirstValueByAliases(row, ['color', 'colour']);
    const adjustmentRaw = getFirstValueByAliases(row, [
      'adjustment',
      'delta',
      'price_adjustment',
      'color_price',
      'colour_price',
    ]);

    if (!priceId || !color) continue;
    const deltaCents = parseDeltaToCents(adjustmentRaw);
    const existing = nextMap.get(priceId) || {};
    existing[color] = deltaCents;
    nextMap.set(priceId, existing);
  }

  return nextMap;
}

async function refreshVariantPricingFromSheet() {
  if (!VARIANT_PRICING_CSV_URL) return;

  const response = await fetch(VARIANT_PRICING_CSV_URL);
  if (!response.ok) throw new Error(`Spreadsheet fetch failed: ${response.status}`);

  const csvText = await response.text();
  const parsed = parseVariantPricingCsv(csvText);
  variantPricingByPriceId = parsed;
  variantPricingLastSyncAt = new Date().toISOString();
  variantPricingLastError = null;
}

function findColorDeltaCents(colorAdjustments, selectedColor) {
  if (!selectedColor) return 0;
  const target = String(selectedColor).trim().toLowerCase();
  const match = Object.entries(colorAdjustments).find(([color]) => color.toLowerCase() === target);
  return match ? Number(match[1]) || 0 : 0;
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

async function resolveDiscountToStripeDiscount(discountCode) {
  const code = String(discountCode || '').trim();
  if (!code) return null;

  // Direct Stripe IDs are supported for backward compatibility
  if (code.startsWith('promo_')) return { promotion_code: code };
  if (code.startsWith('coupon_')) return { coupon: code };

  // Most storefronts collect a human-readable promotion code
  const promoMatches = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  if (promoMatches?.data?.length) {
    return { promotion_code: promoMatches.data[0].id };
  }

  // Fall back to coupon ID (some setups expose simple coupon IDs to users)
  try {
    const coupon = await stripe.coupons.retrieve(code);
    if (coupon && !coupon.deleted && coupon.valid) {
      return { coupon: coupon.id };
    }
  } catch {
    // Ignore and return null below
  }

  return null;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toStorefrontProductUrl(priceId) {
  return `${FRONTEND_BASE_URL}/checkout.html?priceId=${encodeURIComponent(priceId)}&pickup=false`;
}

async function listCatalogForSeo() {
  const products = await stripe.products.list({ active: true, expand: ['data.default_price'], limit: 100 });

  return products.data
    .filter(p => p.default_price)
    .map((p) => ({
      id: p.id,
      priceId: p.default_price.id,
      name: p.name || '3D Printed Fidget',
      description: p.description || '',
      image: p.images?.[0] || null,
      currency: String(p.default_price.currency || 'aud').toUpperCase(),
      price: Number(p.default_price.unit_amount || 0),
      active: Boolean(p.active),
      url: toStorefrontProductUrl(p.default_price.id),
    }));
}

app.get('/api/seo/product-feed.json', async (req, res) => {
  try {
    const items = await listCatalogForSeo();
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      baseUrl: FRONTEND_BASE_URL,
      products: items,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/seo/image-sitemap.xml', async (req, res) => {
  try {
    const items = await listCatalogForSeo();
    const nowIso = new Date().toISOString();

    const urlEntries = items
      .filter(item => item.image)
      .map((item) => {
        const title = xmlEscape(item.name);
        const caption = xmlEscape(item.description || item.name);
        return [
          '  <url>',
          `    <loc>${xmlEscape(item.url)}</loc>`,
          `    <lastmod>${nowIso}</lastmod>`,
          '    <image:image>',
          `      <image:loc>${xmlEscape(item.image)}</image:loc>`,
          `      <image:title>${title}</image:title>`,
          `      <image:caption>${caption}</image:caption>`,
          '    </image:image>',
          '  </url>',
        ].join('\n');
      })
      .join('\n');

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      urlEntries,
      '</urlset>',
    ].join('\n');

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    res.status(500).type('text/plain').send(`sitemap error: ${err.message}`);
  }
});

// ── GET /api/products ─────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const products = await stripe.products.list({ active: true, expand: ['data.default_price'], limit: 100 });
    const items = products.data
      .filter(p => p.default_price)
      .map(p => {
        const metadataAdjustments = parseColorPriceAdjustments(p.metadata || {});
        const sheetAdjustments = variantPricingByPriceId.get(p.default_price.id) || {};
        return {
          id: p.id, name: p.name, description: p.description || '',
          image: p.images?.[0] || null, active: p.active,
          priceId: p.default_price.id, price: p.default_price.unit_amount,
          currency: p.default_price.currency, metadata: p.metadata || {},
          colorOptions: parseProductColors(p.metadata || {}),
          colorPriceAdjustments: mergeColorAdjustments(metadataAdjustments, sheetAdjustments),
        };
      });
    res.json({ products: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/checkout ────────────────────────────
// Body: { priceIds: ['price_xxx', ...], pickup: bool, discountCode: 'PROMO_CODE' }
// priceIds is an array so upsell items can be added
app.post('/api/checkout', async (req, res) => {
  const { items, priceIds, priceId, pickup, discountCode } = req.body;

  // Supports:
  // - items: [{ priceId, quantity, color }]
  // - priceIds: ['price_x', 'price_x', 'price_y'] (legacy)
  // - priceId: 'price_x' (legacy)
  const normalizedItems = normalizeCheckoutItems({ items, priceIds, priceId });
  if (!normalizedItems.length) return res.status(400).json({ error: 'Missing item(s)' });

  try {
    // Count quantities by price + color so colour selections are preserved per item variant
    const variantCounts = {};
    for (const item of normalizedItems) {
      const key = `${item.priceId}::${item.color || 'Default'}`;
      variantCounts[key] = (variantCounts[key] || 0) + item.quantity;
    }

    const uniquePriceIds = [...new Set(normalizedItems.map(item => item.priceId))];
    const priceMap = new Map();
    await Promise.all(
      uniquePriceIds.map(async (id) => {
        const price = await stripe.prices.retrieve(id, { expand: ['product'] });
        priceMap.set(id, price);
      })
    );

    let totalCents = 0;
    const line_items = [];

    for (const [key, quantity] of Object.entries(variantCounts)) {
      const [priceId, selectedColor = 'Default'] = key.split('::');
      const price = priceMap.get(priceId);
      if (!price) throw new Error(`Price not found: ${priceId}`);

      const baseAmount = Number(price.unit_amount || 0);
      const currency = String(price.currency || 'aud').toLowerCase();
      const product = price.product && typeof price.product === 'object' ? price.product : null;
      const metadataAdjustments = parseColorPriceAdjustments(product?.metadata || {});
      const sheetAdjustments = variantPricingByPriceId.get(priceId) || {};
      const colorAdjustments = mergeColorAdjustments(metadataAdjustments, sheetAdjustments);
      const colorDelta = findColorDeltaCents(colorAdjustments, selectedColor);
      const finalUnitAmount = Math.max(0, baseAmount + colorDelta);

      totalCents += finalUnitAmount * quantity;

      if (colorDelta === 0) {
        line_items.push({
          price: priceId,
          quantity,
          adjustable_quantity: {
            enabled: true,
            minimum: 1,
            maximum: 99,
          },
        });
      } else {
        line_items.push({
          price_data: {
            currency,
            unit_amount: finalUnitAmount,
            product_data: {
              name: `${product?.name || 'Product'} (${selectedColor})`,
              description: product?.description || undefined,
              images: Array.isArray(product?.images) && product.images.length ? [product.images[0]] : undefined,
              metadata: {
                base_price_id: priceId,
                color: selectedColor,
                color_price_adjustment_cents: String(colorDelta),
              },
            },
          },
          quantity,
        });
      }
    }

    // Keep selected colours/quantities for order ops in metadata
    const optionSummary = Object.entries(variantCounts)
      .map(([key, quantity]) => {
        const [variantPriceId, color = 'Default'] = key.split('::');
        return `${variantPriceId}:${color}x${quantity}`;
      })
      .join('|')
      .slice(0, 500);

    const qualifiesForFreeShipping = totalCents >= FREE_SHIPPING_THRESHOLD;

    const sessionParams = {
      mode: 'payment',
      line_items,
      success_url: process.env.SUCCESS_URL || `http://localhost:${PORT}?success=true`,
      cancel_url:  process.env.CANCEL_URL  || `http://localhost:${PORT}?canceled=true`,
      allow_promotion_codes: true,
      metadata: {
        selected_options: optionSummary,
      },
    };

    if (discountCode) {
      const resolvedDiscount = await resolveDiscountToStripeDiscount(discountCode);
      if (!resolvedDiscount) {
        return res.status(400).json({ error: 'Invalid discount code' });
      }
      sessionParams.discounts = [resolvedDiscount];
      sessionParams.allow_promotion_codes = false;
    }

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

if (VARIANT_PRICING_CSV_URL) {
  refreshVariantPricingFromSheet()
    .then(() => {
      console.log(`✅ Variant pricing synced (${variantPricingByPriceId.size} price IDs)`);
    })
    .catch((err) => {
      variantPricingLastError = err.message;
      console.error('Variant pricing initial sync failed:', err.message);
    });

  setInterval(async () => {
    try {
      await refreshVariantPricingFromSheet();
    } catch (err) {
      variantPricingLastError = err.message;
      console.error('Variant pricing sync failed:', err.message);
    }
  }, VARIANT_PRICING_SYNC_MS);
}
