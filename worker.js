/**
 * Cloudflare Worker Backend for Leggett & Platt Survey Platform
 * Kết nối Serverless PostgreSQL trên Neon (neon.tech)
 */
export default {
  async fetch(request, env, ctx) {
    // 1. Cấu hình CORS cho phép Single-page App index.html gọi API
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    };

    // Xử lý pre-flight request từ trình duyệt
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Lấy Connection String Neon từ biến môi trường Cloudflare Worker
    const DB_URL = env.DATABASE_URL;

    if (!DB_URL) {
      return new Response(
        JSON.stringify({ error: 'Chưa cấu hình biến DATABASE_URL trong Cloudflare Worker!' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Hàm gọi truy vấn SQL trực tiếp tới Neon Serverless HTTP API
    async function queryNeon(sql, params = []) {
      const hostMatch = DB_URL.match(/@([^/]+)\//);
      const host = hostMatch ? hostMatch[1] : '';
      const endpoint = `https://${host}/sql`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${DB_URL}`,
          'Neon-Connection-String': DB_URL,
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
      // 1. Kiểm tra trạng thái hoạt động (Health check)
      if (path === '/' || path === '/api/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'Leggett Survey Worker', neon: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 2. Nộp bài khảo sát từ người làm (Submit Response)
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

      // 3. Lấy danh sách kết quả phản hồi cho Admin (Get Responses)
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

      // 4. XÓA TOÀN BỘ DỮ LIỆU (RESET / PURGE DATA để tránh phình dung lượng Neon)
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

      // 5. Lưu / Cập nhật cấu hình bài khảo sát (Save Survey)
      if (path === '/api/surveys' && request.method === 'POST') {
        const body = await request.json();
        const { id, title, description, questions } = body;
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

      // 6. Lấy thông tin bài khảo sát (Get Survey)
      if (path === '/api/surveys' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), { status: 400, headers: corsHeaders });
        }
        const sql = `SELECT * FROM surveys WHERE id = $1 LIMIT 1;`;
        const result = await queryNeon(sql, [id]);
        const rows = result.rows || result;
        if (!rows || rows.length === 0) {
          return new Response(JSON.stringify({ error: 'Survey not found' }), { status: 404, headers: corsHeaders });
        }
        return new Response(JSON.stringify(rows[0]), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 7. Xóa khảo sát: DELETE /api/surveys?id=...
      if (path === '/api/surveys' && request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), { status: 400, headers: corsHeaders });
        }
        await queryNeon(`DELETE FROM surveys WHERE id = $1;`, [id]);
        return new Response(JSON.stringify({ success: true, message: 'Survey deleted', id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};
