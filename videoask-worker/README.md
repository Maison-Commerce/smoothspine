# SmoothSpine VideoAsk Reviews Worker

Cloudflare Worker that proxies VideoAsk API to expose customer testimonials publicly,
without leaking the OAuth credentials.

## Endpoints

- `GET /reviews` — JSON list of approved testimonials (filtered by tag "Reviewed by CS"), sorted newest first
- `GET /health` — health check

## Setup (one-time)

### 1. Install Wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespace for token cache
```bash
cd videoask-worker
wrangler kv:namespace create TOKEN_KV
```
Copy the `id` from the output and paste into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).

### 3. Set secrets
```bash
wrangler secret put VIDEOASK_CLIENT_ID
# paste: Q1BeHgTvK9qydP4OFotgTMQtNVwpBUD5

wrangler secret put VIDEOASK_CLIENT_SECRET
# paste: <client_secret>

wrangler secret put VIDEOASK_REFRESH_TOKEN
# paste: wonyCdMcT8BmjDsdq50jS0La2g_2OVIi2ralhuwlAPQI6
```

### 4. Deploy
```bash
wrangler deploy
```

You'll get a URL like `https://smoothspine-videoask.choojiie.workers.dev`.

## Refresh token rotation (every 30 days)

VideoAsk refresh tokens last only 30 days. To renew:

1. Open the OAuth authorize URL in browser:
```
https://auth.videoask.com/authorize?response_type=code&client_id=Q1BeHgTvK9qydP4OFotgTMQtNVwpBUD5&redirect_uri=https%3A%2F%2Fsmoothspine.com%2Fvideoask-callback&scope=openid%20profile%20email%20offline_access&audience=https%3A%2F%2Fapi.videoask.com%2F
```

2. Authorize, copy `code` from redirect URL.

3. Exchange code for tokens:
```bash
curl -X POST https://auth.videoask.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","client_id":"Q1BeHgTvK9qydP4OFotgTMQtNVwpBUD5","client_secret":"<SECRET>","code":"<CODE>","redirect_uri":"https://smoothspine.com/videoask-callback"}'
```

4. Update Worker secret:
```bash
wrangler secret put VIDEOASK_REFRESH_TOKEN
# paste: <new refresh_token>
```

## Local testing
```bash
wrangler dev
curl http://localhost:8787/reviews
```
