/**
 * Cloudflare Pages Functions - Health Check Endpoint
 * Zero-dependency native fetch implementation
 */

function getNeonHost(dbUrl) {
  try {
    const u = new URL(dbUrl);
    return u.hostname;
  } catch (e) {
    const m = (dbUrl || '').match(/@([^/:]+)/);
    return m ? m[1] : '';
  }
}

export async function onRequestGet(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };

  const DB_URL = context.env.DATABASE_URL;
  let dbOk = false;
  let dbError = null;

  if (DB_URL) {
    try {
      const host = getNeonHost(DB_URL);
      if (!host) throw new Error('DATABASE_URL không hợp lệ, không trích xuất được host Neon');

      const endpoint = `https://${host}/sql`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Neon-Connection-String': DB_URL,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'SELECT 1 as ok', params: [] })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Neon HTTP ${response.status}: ${errText}`);
      }
      dbOk = true;
    } catch (err) {
      dbError = err.message;
    }
  }

  return new Response(JSON.stringify({
    status: 'ok',
    service: 'Leggett Survey Pages Functions',
    domain: 'pages.dev',
    neonConfigured: !!DB_URL,
    dbOk: dbOk,
    dbError: dbError
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    }
  });
}
