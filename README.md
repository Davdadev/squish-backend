# Squish Factory — Backend

Deploy this to Railway:

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add these environment variables in Railway dashboard:

STRIPE_SECRET_KEY = sk_live_...
SUCCESS_URL       = https://yourusername.github.io/squish-frontend?success=true
CANCEL_URL        = https://yourusername.github.io/squish-frontend?canceled=true
PORT              = 3000

4. Copy the Railway domain URL
5. Paste it into index.html in squish-frontend as BACKEND_URL
