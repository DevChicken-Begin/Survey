import { neon } from '@neondatabase/serverless';

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
      const sql = neon(DB_URL);
      await sql.query('SELECT 1 as ok');
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
