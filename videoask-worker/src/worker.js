/**
 * SmoothSpine Trustpilot Worker
 *
 * Endpoints:
 *   GET /health             — health check
 *   GET /trustpilot         — live business rating (score, stars, reviews_count) by scraping public page
 *   GET /trustpilot/reviews — list of N-star reviews scraped from public page
 *
 * Note: previous /reviews endpoint (VideoAsk via OAuth) was removed — VideoAsk
 * is now fetched directly from the storefront via public sharing API
 * (https://api.videoask.com/forms/{form_id}/contacts?responses_share_id=…).
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return corsResponse(request, env);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', time: new Date().toISOString() }, request, env);
    }

    if (url.pathname === '/trustpilot') {
      try {
        const domain = url.searchParams.get('domain') || 'smoothspine.com';
        const data = await getCachedTrustpilot(domain, ctx);
        return jsonResponse(data, request, env, 200, true);
      } catch (err) {
        console.error('Trustpilot error:', err.message);
        return jsonResponse({ error: err.message }, request, env, 500);
      }
    }

    if (url.pathname === '/trustpilot/reviews') {
      try {
        const domain = url.searchParams.get('domain') || 'smoothspine.com';
        const stars = url.searchParams.get('stars') || '5';
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const data = await getCachedTrustpilotReviews(domain, stars, limit, ctx);
        return jsonResponse(data, request, env, 200, true);
      } catch (err) {
        console.error('Trustpilot reviews error:', err.message);
        return jsonResponse({ error: err.message }, request, env, 500);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ─── Trustpilot business rating ───
async function getCachedTrustpilot(domain, ctx) {
  const cacheKey = new Request(`https://cache.smoothspine.tp/${encodeURIComponent(domain)}/v1`, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const data = await fetchTrustpilot(domain);
  const resp = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
  ctx.waitUntil(cache.put(cacheKey, resp));
  return data;
}

async function fetchTrustpilot(domain) {
  const res = await fetch(`https://www.trustpilot.com/review/${domain}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`Trustpilot HTTP ${res.status}`);
  const html = await res.text();

  const pick = (re, type = 'string') => {
    const m = html.match(re);
    if (!m) return null;
    return type === 'number' ? parseFloat(m[1]) : m[1];
  };

  const score = pick(/"trustScore":([0-9.]+)/, 'number');
  const stars = pick(/"stars":([0-9.]+)/, 'number');
  const reviewsCount = pick(/"numberOfReviews":([0-9]+)/, 'number');
  const displayName = pick(/"displayName":"([^"]+)"/);
  const identifyingName = pick(/"identifyingName":"([^"]+)"/);

  return {
    domain,
    score,
    stars,
    reviews_count: reviewsCount,
    display_name: displayName,
    identifying_name: identifyingName,
    profile_url: `https://www.trustpilot.com/review/${domain}`,
    updated_at: new Date().toISOString()
  };
}

// ─── Trustpilot reviews ───
async function getCachedTrustpilotReviews(domain, stars, limit, ctx) {
  const cacheKey = new Request(`https://cache.smoothspine.tp-reviews/${encodeURIComponent(domain)}/${stars}/${limit}/v1`, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const data = await fetchTrustpilotReviews(domain, stars, limit);
  const resp = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
  ctx.waitUntil(cache.put(cacheKey, resp));
  return data;
}

async function fetchTrustpilotReviews(domain, stars, limit) {
  const pages = 3;
  const reviewsByPage = [];
  for (let p = 1; p <= pages; p++) {
    const q = p === 1 ? `?stars=${encodeURIComponent(stars)}` : `?stars=${encodeURIComponent(stars)}&page=${p}`;
    const res = await fetch(`https://www.trustpilot.com/review/${domain}${q}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) break;
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (!m) break;
    let json;
    try { json = JSON.parse(m[1]); } catch (e) { break; }
    const arr = json && json.props && json.props.pageProps && json.props.pageProps.reviews;
    if (!Array.isArray(arr) || arr.length === 0) break;
    reviewsByPage.push(arr);
    if (reviewsByPage.flat().length >= limit) break;
  }

  const flat = reviewsByPage.flat();
  const minStars = parseInt(stars, 10) || 0;
  const filtered = flat.filter(r => r && typeof r.rating === 'number' && r.rating >= minStars);

  const reviews = filtered.slice(0, limit).map(r => ({
    id: r.id,
    rating: r.rating,
    title: r.title || '',
    body: r.text || '',
    author: (r.consumer && r.consumer.displayName) || 'Anonymous',
    date: (r.dates && (r.dates.experiencedDate || r.dates.publishedDate)) || null,
    verified: !!(r.labels && r.labels.verification && r.labels.verification.isVerified),
    country: (r.consumer && r.consumer.countryCode) || null
  }));

  return {
    domain,
    stars_filter: minStars,
    count: reviews.length,
    updated_at: new Date().toISOString(),
    reviews
  };
}

// ─── CORS helpers ───
function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return origin;
  if (allowed.includes('*')) return '*';
  return allowed[0] || '*';
}

function corsHeaders(request, env) {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(request, env),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function corsResponse(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function jsonResponse(data, request, env, status = 200, includeCDNCache = false) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(request, env)
  };
  if (includeCDNCache) {
    const ttl = parseInt(env.CACHE_TTL_SECONDS || '3600', 10);
    headers['Cache-Control'] = `public, max-age=${ttl}, s-maxage=${ttl}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}
