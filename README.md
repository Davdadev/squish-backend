# Squish Factory — Backend

Deploy this to Railway:

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add these environment variables in Railway dashboard:

STRIPE_SECRET_KEY = sk_live_...
SUCCESS_URL       = https://yourusername.github.io/squish-frontend?success=true
CANCEL_URL        = https://yourusername.github.io/squish-frontend?canceled=true
PORT              = 3000

# Optional: spreadsheet-driven color pricing
VARIANT_PRICING_CSV_URL = https://.../your-sheet.csv
VARIANT_PRICING_SYNC_MS = 300000

4. Copy the Railway domain URL
5. Paste it into index.html in squish-frontend as BACKEND_URL

## Spreadsheet setup (optional)

If you want color prices to come from a spreadsheet, publish/export it as CSV and set `VARIANT_PRICING_CSV_URL`.

Required CSV columns:

- `price_id` (or `priceId`)
- `color`
- `adjustment` (or `delta`, `price_adjustment`, `color_price`)

Example rows:

price_id,color,adjustment
price_123,Red,0
price_123,Blue,2
price_123,Glow,350c

Notes:

- `2` means +$2.00
- `350c` means +$3.50
- Sync status: `GET /api/variant-pricing/status`
- Force refresh: `POST /api/variant-pricing/refresh`
