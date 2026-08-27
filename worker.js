/**
 * Cloudflare Worker Backend for Leggett & Platt Survey Platform
 * Kết nối Serverless PostgreSQL trên Neon (neon.tech) qua native HTTP API (Zero dependencies)
 */

let tablesInitialized = false;

function getNeonHost(dbUrl) {
  try {
    const u = new URL(dbUrl);
    return u.hostname;
  } catch (e) {
    const m = (dbUrl || '').match(/@([^/:]+)/);
    return m ? m[1] : '';
  }
}

async function queryNeon(dbUrl, sql, params = []) {
  const host = getNeonHost(dbUrl);
  if (!host) throw new Error('DATABASE_URL không hợp lệ, không thể trích xuất host Neon');

  const endpoint = `https://${host}/sql`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': dbUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, params })
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
    } catch (e) {}
    throw new Error(`Neon DB Error (${response.status}): ${errMsg}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  return data;
}

async function ensureTables(dbUrl) {
  if (tablesInitialized) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS surveys (
      id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      questions JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      survey_id VARCHAR(64) NOT NULL,
      employee_msnv VARCHAR(64) NOT NULL,
      employee_name VARCHAR(255) NOT NULL,
      employee_dept VARCHAR(255) NOT NULL,
      answers JSONB NOT NULL,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_resp_survey ON responses(survey_id);`,
    `CREATE INDEX IF NOT EXISTS idx_resp_msnv ON responses(employee_msnv);`
  ];

  for (const stmt of statements) {
    try {
      await queryNeon(dbUrl, stmt);
    } catch (e) {
      console.warn('Table init warning:', e.message);
    }
  }
  tablesInitialized = true;
}

export default {
  async fetch(request, env, ctx) {
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

    const DB_URL = env.DATABASE_URL;

    if (!DB_URL) {
      return new Response(
        JSON.stringify({ error: 'Chưa cấu hình biến DATABASE_URL trong Cloudflare Worker!' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    try {
      // 1. Kiểm tra trạng thái hoạt động (Health check)
      if (path === '/' || path === '/api/health') {
        let dbOk = false;
        let dbError = null;
        try {
          await queryNeon(DB_URL, 'SELECT 1 as ok');
          dbOk = true;
        } catch (e) {
          dbError = e.message;
        }
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'Leggett Survey Worker',
          neonConfigured: true,
          dbOk,
          dbError
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Đảm bảo các bảng surveys và responses đã được tạo trong Neon
      await ensureTables(DB_URL);

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

        const answersStr = typeof answers === 'string' ? answers : JSON.stringify(answers || []);
        const result = await queryNeon(
          DB_URL,
          `INSERT INTO responses (survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id;`,
          [
            survey_id || 'DEFAULT',
            employee_msnv || '',
            employee_name || '',
            employee_dept || '',
            answersStr,
            submitted_at || new Date().toISOString()
          ]
        );

        const insertedId = (Array.isArray(result) && result.length > 0) ? (result[0].id || result[0]) : result;

        return new Response(JSON.stringify({ success: true, id: insertedId }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 3. Lấy danh sách kết quả phản hồi cho Admin (Get Responses)
      if (path === '/api/responses' && request.method === 'GET') {
        const surveyId = url.searchParams.get('survey_id');
        let rows;
        if (surveyId) {
          rows = await queryNeon(
            DB_URL,
            `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at
             FROM responses WHERE survey_id = $1 ORDER BY submitted_at DESC LIMIT 10000;`,
            [surveyId]
          );
        } else {
          rows = await queryNeon(
            DB_URL,
            `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at
             FROM responses ORDER BY submitted_at DESC LIMIT 10000;`
          );
        }

        const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

        const normalizedRows = rowsList.map(r => {
          let parsedAnswers = r.answers;
          if (typeof parsedAnswers === 'string') {
            try { parsedAnswers = JSON.parse(parsedAnswers); } catch (e) { parsedAnswers = []; }
          }
          return {
            ...r,
            answers: parsedAnswers || []
          };
        });

        return new Response(JSON.stringify(normalizedRows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 4. XÓA TOÀN BỘ DỮ LIỆU (RESET / PURGE DATA để tránh phình dung lượng Neon)
      if (path === '/api/responses' && request.method === 'DELETE') {
        const surveyId = url.searchParams.get('survey_id');
        if (surveyId) {
          await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1;`, [surveyId]);
        } else {
          await queryNeon(DB_URL, `TRUNCATE TABLE responses;`);
        }

        return new Response(JSON.stringify({ success: true, message: 'All response data purged successfully.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 5. Lưu / Cập nhật cấu hình bài khảo sát (Save Survey)
      if (path === '/api/surveys' && request.method === 'POST') {
        const body = await request.json();
        const { id, title, description, questions } = body;
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const questionsStr = typeof questions === 'string' ? questions : JSON.stringify(questions || []);

        await queryNeon(
          DB_URL,
          `INSERT INTO surveys (id, title, description, questions, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             questions = EXCLUDED.questions,
             updated_at = NOW();`,
          [id, title || '', description || '', questionsStr]
        );

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
        const rows = await queryNeon(DB_URL, `SELECT * FROM surveys WHERE id = $1 LIMIT 1;`, [id]);
        const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

        if (rowsList.length === 0) {
          return new Response(JSON.stringify({ error: 'Survey not found' }), { status: 404, headers: corsHeaders });
        }
        const s = { ...rowsList[0] };
        if (typeof s.questions === 'string') {
          try { s.questions = JSON.parse(s.questions); } catch (e) {}
        }
        return new Response(JSON.stringify(s), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 7. Xóa khảo sát: DELETE /api/surveys?id=...
      if (path === '/api/surveys' && request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), { status: 400, headers: corsHeaders });
        }
        await queryNeon(DB_URL, `DELETE FROM surveys WHERE id = $1;`, [id]);
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
