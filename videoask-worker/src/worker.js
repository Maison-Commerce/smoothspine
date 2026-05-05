/**
 * SmoothSpine Worker (currently empty)
 *
 * All previously-served data is now fetched directly from the storefront:
 *   - VideoAsk reviews   → public sharing API (api.videoask.com/forms/.../contacts)
 *   - Trustpilot rating  → public TrustBox data endpoint (widget.trustpilot.com/trustbox-data/...)
 *   - Trustpilot reviews → static blocks in section schema (Trustpilot blocks scraping)
 *
 * Kept around for future use. Currently only /health is implemented.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return corsResponse(request, env);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', time: new Date().toISOString() }, request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

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

function jsonResponse(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env)
    }
  });
}
