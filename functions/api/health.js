export async function onRequestGet(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };
  return new Response(JSON.stringify({ status: 'ok', service: 'Leggett Survey Pages Functions', domain: 'pages.dev', neon: !!context.env.DATABASE_URL }), {
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
