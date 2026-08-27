/**
 * Cloudflare Pages Functions - Leggett & Platt Survey Platform
 * Thay thế worker.dev bằng pages.dev (Functions)
 * Đọc DATABASE_URL từ Variables and Secrets của Cloudflare Pages (env.DATABASE_URL)
 * Kết nối Neon Serverless PostgreSQL qua HTTP API
 *
 * File này xử lý mọi request /api/* trên cùng domain pages.dev
 * => Không bị chặn bởi LAN công ty (chặn worker.dev nhưng cho phép page.dev)
 */

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers - cho phép SPA gọi API cùng origin và cross-origin nếu cần
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // Chỉ xử lý /api/*, các path khác để Pages serve static file
  if (!path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const DB_URL = env.DATABASE_URL;

  if (!DB_URL) {
    return new Response(
      JSON.stringify({ error: 'Chưa cấu hình biến DATABASE_URL trong Cloudflare Pages > Settings > Variables and Secrets!' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Hàm gọi truy vấn SQL tới Neon HTTP API
  async function queryNeon(sql, params = []) {
    const hostMatch = DB_URL.match(/@([^/]+)\//);
    const host = hostMatch ? hostMatch[1] : '';
    if (!host) throw new Error('DATABASE_URL không đúng định dạng, không trích xuất được host Neon');

    const endpoint = `https://${host}/sql`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DB_URL}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql, params })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Neon SQL Error (${response.status}): ${errText}`);
    }

    return await response.json();
  }

  try {
    // 1. Health check: /api/health
    if (path === '/api/health') {
      // Optional: thử ping DB nhẹ
      // await queryNeon('SELECT 1 as ok', []);
      return new Response(JSON.stringify({ status: 'ok', service: 'Leggett Survey Pages Functions', neon: !!DB_URL, domain: 'pages.dev' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Nộp bài khảo sát: POST /api/responses
    if (path === '/api/responses' && request.method === 'POST') {
      const body = await request.json();
      const {
        survey_id,
        employee_msnv,
        employee_name,
        employee_dept,
        answers,
        submitted_at
      } = body;

      const sql = `
        INSERT INTO responses (survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id;
      `;
      const result = await queryNeon(sql, [
        survey_id || 'DEFAULT',
        employee_msnv || '',
        employee_name || '',
        employee_dept || '',
        JSON.stringify(answers || []),
        submitted_at || new Date().toISOString()
      ]);

      return new Response(JSON.stringify({ success: true, id: result }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Lấy danh sách kết quả: GET /api/responses?survey_id=...
    if (path === '/api/responses' && request.method === 'GET') {
      const surveyId = url.searchParams.get('survey_id');
      let sql = `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at FROM responses`;
      let params = [];
      if (surveyId) {
        sql += ` WHERE survey_id = $1`;
        params.push(surveyId);
      }
      sql += ` ORDER BY submitted_at DESC LIMIT 10000;`;

      const result = await queryNeon(sql, params);
      const rows = result.rows || result;
      return new Response(JSON.stringify(rows), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 4. XÓA TOÀN BỘ DỮ LIỆU: DELETE /api/responses
    if (path === '/api/responses' && request.method === 'DELETE') {
      const surveyId = url.searchParams.get('survey_id');
      let sql = `TRUNCATE TABLE responses;`;
      let params = [];
      if (surveyId) {
        sql = `DELETE FROM responses WHERE survey_id = $1;`;
        params.push(surveyId);
      }

      await queryNeon(sql, params);
      return new Response(JSON.stringify({ success: true, message: 'All response data purged successfully.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 5. Lưu / Cập nhật cấu hình khảo sát: POST /api/surveys
    if (path === '/api/surveys' && request.method === 'POST') {
      const body = await request.json();
      const { id, title, description, questions } = body;
      if (!id) {
        return new Response(JSON.stringify({ error: 'Survey ID required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const sql = `
        INSERT INTO surveys (id, title, description, questions, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          questions = EXCLUDED.questions,
          updated_at = NOW();
      `;
      await queryNeon(sql, [id, title, description, JSON.stringify(questions || [])]);
      return new Response(JSON.stringify({ success: true, id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 6. Lấy thông tin khảo sát: GET /api/surveys?id=...
    if (path === '/api/surveys' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(JSON.stringify({ error: 'Survey ID required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const sql = `SELECT * FROM surveys WHERE id = $1 LIMIT 1;`;
      const result = await queryNeon(sql, [id]);
      const rows = result.rows || result;
      if (!rows || rows.length === 0) {
        return new Response(JSON.stringify({ error: 'Survey not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(rows[0]), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found: ' + path }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
