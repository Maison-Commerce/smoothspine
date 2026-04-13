/**
 * SmoothSpine VideoAsk Reviews Worker
 *
 * Endpoints:
 *   GET /reviews        — returns JSON array of testimonials filtered by REQUIRED_TAG
 *   GET /health         — health check
 *
 * Auth flow:
 *   1. Try cached access_token from KV
 *   2. If missing or expired → POST refresh_token to get new access_token
 *   3. Cache new access_token in KV until expiry
 *
 * Response cache:
 *   Cloudflare Cache API stores final JSON for CACHE_TTL_SECONDS
 */

const VIDEOASK_API = 'https://api.videoask.com';
const VIDEOASK_AUTH = 'https://auth.videoask.com/oauth/token';
const ACCESS_TOKEN_KV_KEY = 'videoask_access_token';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(request, env);
    }

    // Health check
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', time: new Date().toISOString() }, request, env);
    }

    // Reviews endpoint
    if (url.pathname === '/reviews') {
      try {
        const reviews = await getCachedReviews(request, env, ctx);
        return jsonResponse(reviews, request, env, 200, true);
      } catch (err) {
        console.error('Reviews error:', err.message, err.stack);
        return jsonResponse({ error: err.message }, request, env, 500);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ─── Reviews fetch with Cache API ───
async function getCachedReviews(request, env, ctx) {
  const cacheKey = new Request('https://cache.smoothspine.videoask/reviews/v2', { method: 'GET' });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return data;
  }

  const reviews = await fetchAndProcessReviews(env);

  // Store in cache
  const ttl = parseInt(env.CACHE_TTL_SECONDS || '3600', 10);
  const cacheResponse = new Response(JSON.stringify(reviews), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));

  return reviews;
}

// ─── Fetch all conversations + answers, filter, sort ───
async function fetchAndProcessReviews(env) {
  const accessToken = await getAccessToken(env);

  // 1. Get all conversations (paginated)
  const conversations = await fetchAllConversations(accessToken, env);

  // 2. Filter by required tag
  const requiredTag = env.REQUIRED_TAG;
  const approved = conversations.filter(c => {
    const tags = (c.tags || []).map(t => (t.title || '').toLowerCase());
    return tags.includes(requiredTag.toLowerCase()) && c.status === 'completed';
  });

  // 3. Fetch answers for each approved conversation (parallel batches)
  const reviewsWithAnswers = await fetchAnswersForContacts(approved, accessToken, env);

  // 4. Filter only those with valid video answer
  const validReviews = reviewsWithAnswers.filter(r => r.video_url);

  // 5. Sort by created_at desc (newest first)
  validReviews.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    count: validReviews.length,
    updated_at: new Date().toISOString(),
    reviews: validReviews
  };
}

// ─── Fetch all conversations (paginate through all pages) ───
async function fetchAllConversations(accessToken, env) {
  const all = [];
  let offset = 0;
  const limit = 100;
  const maxPages = 10; // safety

  for (let page = 0; page < maxPages; page++) {
    const url = `${VIDEOASK_API}/forms/${env.VIDEOASK_FORM_ID}/conversations?limit=${limit}&offset=${offset}&exclude_humans=false`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'organization-id': env.VIDEOASK_ORG_ID
      }
    });
    if (!res.ok) {
      throw new Error(`Conversations fetch failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const results = data.results || [];
    all.push(...results);
    if (results.length < limit) break;
    offset += limit;
  }

  return all;
}

// ─── Fetch answers in parallel batches ───
async function fetchAnswersForContacts(contacts, accessToken, env) {
  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(c => fetchContactAnswer(c, accessToken, env).catch(err => {
        console.error(`Failed contact ${c.contact_id}:`, err.message);
        return null;
      }))
    );
    results.push(...batchResults.filter(Boolean));
  }

  return results;
}

async function fetchContactAnswer(contact, accessToken, env) {
  const url = `${VIDEOASK_API}/forms/${env.VIDEOASK_FORM_ID}/contacts/${contact.contact_id}?include_answers=true`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'organization-id': env.VIDEOASK_ORG_ID
    }
  });
  if (!res.ok) throw new Error(`Contact fetch failed: ${res.status}`);
  const data = await res.json();

  // Find first video answer
  const videoAnswer = (data.answers || []).find(a => a.media_url && a.transcode_status === 'completed');
  if (!videoAnswer) return null;

  return {
    id: contact.contact_id,
    name: contact.name || 'Anonymous',
    video_url: videoAnswer.media_url,
    thumbnail: videoAnswer.thumbnail || contact.thumbnail,
    gif: videoAnswer.gif || null,
    duration: videoAnswer.media_duration || 0,
    transcription: videoAnswer.transcription || '',
    share_url: videoAnswer.share_url || null,
    created_at: contact.created_at,
    tags: (contact.tags || []).map(function(t) { return t.title; }).filter(Boolean)
  };
}

// ─── Token management ───
async function getAccessToken(env) {
  // Try cached token from KV
  const cached = await env.TOKEN_KV.get(ACCESS_TOKEN_KV_KEY, { type: 'json' });
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.access_token;
  }

  // Refresh
  const tokenData = await refreshAccessToken(env);

  // Store in KV with TTL slightly less than expires_in
  const expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
  await env.TOKEN_KV.put(
    ACCESS_TOKEN_KV_KEY,
    JSON.stringify({ access_token: tokenData.access_token, expires_at: expiresAt }),
    { expirationTtl: tokenData.expires_in - 60 }
  );

  // If a new refresh_token was returned, store it too (rotation)
  if (tokenData.refresh_token && tokenData.refresh_token !== env.VIDEOASK_REFRESH_TOKEN) {
    console.warn('VideoAsk returned new refresh_token. Update VIDEOASK_REFRESH_TOKEN secret manually:', tokenData.refresh_token.substring(0, 10) + '...');
  }

  return tokenData.access_token;
}

async function refreshAccessToken(env) {
  const res = await fetch(VIDEOASK_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.VIDEOASK_CLIENT_ID,
      client_secret: env.VIDEOASK_CLIENT_SECRET,
      refresh_token: env.VIDEOASK_REFRESH_TOKEN
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  return res.json();
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
