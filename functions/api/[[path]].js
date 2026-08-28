/**
 * Cloudflare Pages Functions - Leggett & Platt Survey Platform
 * Đọc DATABASE_URL từ Variables and Secrets của Cloudflare Pages (env.DATABASE_URL)
 * Kết nối Neon Serverless PostgreSQL qua native HTTP API (Zero dependencies)
 *
 * File này xử lý mọi request /api/* trên cùng domain pages.dev
 * => Không bị chặn bởi LAN công ty (chặn worker.dev nhưng cho phép pages.dev)
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

function getClientIP(request) {
  // Cloudflare Pages Functions: CF-Connecting-IP là chuẩn, fallback các header phổ biến
  const h = request.headers;
  return (
    h.get('CF-Connecting-IP') ||
    h.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    h.get('X-Real-IP') ||
    h.get('CF-IP') ||
    h.get('True-Client-IP') ||
    ''
  ).trim();
}

function getAdminCredentials(env) {
  return {
    user: (env.ADMIN_USER || env.ADMIN_USERNAME || 'admin').trim(),
    pass: (env.ADMIN_PASS || env.ADMIN_PASSWORD || 'admin123').trim()
  };
}

function isAdminAuthorized(request, env) {
  const creds = getAdminCredentials(env);
  // Nếu chưa cấu hình env thì cho phép (dev mode) – nhưng vẫn check nếu client gửi key
  const headerKey = (request.headers.get('x-admin-key') || request.headers.get('X-Admin-Key') || '').trim();
  const authHeader = (request.headers.get('Authorization') || '').trim();
  let token = headerKey;
  if (!token && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  }
  // Nếu env có cấu hình thì bắt buộc khớp pass
  if (env.ADMIN_PASS || env.ADMIN_PASSWORD || env.ADMIN_USER || env.ADMIN_USERNAME) {
    return token === creds.pass;
  }
  // Dev mode không cấu hình: cho phép nếu không gửi key, hoặc cho phép nếu gửi đúng admin123
  if (!token) return true;
  return token === creds.pass;
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
    `ALTER TABLE responses ADD COLUMN IF NOT EXISTS client_ip VARCHAR(64);`,
    `ALTER TABLE responses ADD COLUMN IF NOT EXISTS survey_title TEXT;`,
    `CREATE INDEX IF NOT EXISTS idx_resp_survey ON responses(survey_id);`,
    `CREATE INDEX IF NOT EXISTS idx_resp_msnv ON responses(employee_msnv);`,
    `CREATE INDEX IF NOT EXISTS idx_resp_ip ON responses(client_ip);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resp_survey_ip_unique ON responses(survey_id, client_ip) WHERE client_ip IS NOT NULL AND client_ip <> '';`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resp_survey_msnv_unique ON responses(survey_id, employee_msnv) WHERE employee_msnv IS NOT NULL AND employee_msnv <> '';`
  ];

  for (const stmt of statements) {
    try {
      await queryNeon(dbUrl, stmt);
    } catch (e) {
      console.warn('Table init warning:', e.message, 'stmt:', stmt.slice(0,80));
    }
  }
  tablesInitialized = true;
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers - cho phép SPA gọi API cùng origin và cross-origin nếu cần
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, X-Admin-Key, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // Chỉ xử lý /api/*, các path khác để Pages serve static file
  if (!path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Endpoint not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const DB_URL = env.DATABASE_URL;

  // Admin login không cần DB
  if (path === '/api/admin/login' && request.method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const username = (body.username || body.user || '').trim();
      const password = (body.password || body.pass || '').trim();
      const creds = getAdminCredentials(env);
      if (username === creds.user && password === creds.pass) {
        return new Response(JSON.stringify({ success: true, message: 'Login success', user: creds.user }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        return new Response(JSON.stringify({ success: false, error: 'Sai tài khoản hoặc mật khẩu' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  if (!DB_URL) {
    return new Response(
      JSON.stringify({
        error: 'Chưa cấu hình biến DATABASE_URL trong Cloudflare Pages > Settings > Variables and Secrets!'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // 1. Health check: /api/health
    if (path === '/api/health') {
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
        service: 'Leggett Survey Pages Functions',
        neonConfigured: true,
        dbOk,
        dbError,
        domain: 'pages.dev'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Đảm bảo các bảng surveys và responses đã được tạo trong Neon
    await ensureTables(DB_URL);

    // 2. CHECK ĐÃ NỘP CHƯA: GET /api/responses/check?survey_id=...&msnv=...
    if (path === '/api/responses/check' && request.method === 'GET') {
      const surveyId = url.searchParams.get('survey_id') || url.searchParams.get('surveyId') || url.searchParams.get('id');
      const msnv = (url.searchParams.get('msnv') || url.searchParams.get('employee_msnv') || '').trim();
      const clientIp = getClientIP(request);

      if (!surveyId) {
        return new Response(JSON.stringify({ error: 'survey_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Tìm bản ghi trùng IP hoặc MSNV trên cùng survey_id
      let rows = [];
      if (msnv && clientIp) {
        rows = await queryNeon(
          DB_URL,
          `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
           FROM responses WHERE survey_id = $1 AND (client_ip = $2 OR employee_msnv = $3) LIMIT 1;`,
          [surveyId, clientIp, msnv]
        );
      } else if (clientIp) {
        rows = await queryNeon(
          DB_URL,
          `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
           FROM responses WHERE survey_id = $1 AND client_ip = $2 LIMIT 1;`,
          [surveyId, clientIp]
        );
      } else if (msnv) {
        rows = await queryNeon(
          DB_URL,
          `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
           FROM responses WHERE survey_id = $1 AND employee_msnv = $2 LIMIT 1;`,
          [surveyId, msnv]
        );
      }

      const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);
      if (rowsList.length > 0) {
        const r = rowsList[0];
        let parsedAnswers = r.answers;
        if (typeof parsedAnswers === 'string') { try { parsedAnswers = JSON.parse(parsedAnswers); } catch(e){ parsedAnswers = []; } }
        return new Response(JSON.stringify({
          submitted: true,
          reason: (clientIp && r.client_ip === clientIp) ? 'ip' : 'msnv',
          client_ip: clientIp,
          response: { ...r, answers: parsedAnswers || [] }
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else {
        return new Response(JSON.stringify({ submitted: false, client_ip: clientIp }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // 3. Nộp bài khảo sát: POST /api/responses  (có chặn trùng IP+MSNV)
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

      const clientIp = getClientIP(request);
      const msnvTrim = (employee_msnv || '').trim();
      const sid = survey_id || 'DEFAULT';

      // Kiểm tra trùng: IP hoặc MSNV đã nộp cho survey này chưa
      if (sid && (clientIp || msnvTrim)) {
        let dupRows = [];
        if (clientIp && msnvTrim) {
          dupRows = await queryNeon(
            DB_URL,
            `SELECT id FROM responses WHERE survey_id = $1 AND (client_ip = $2 OR employee_msnv = $3) LIMIT 1;`,
            [sid, clientIp, msnvTrim]
          );
        } else if (clientIp) {
          dupRows = await queryNeon(DB_URL, `SELECT id FROM responses WHERE survey_id = $1 AND client_ip = $2 LIMIT 1;`, [sid, clientIp]);
        } else if (msnvTrim) {
          dupRows = await queryNeon(DB_URL, `SELECT id FROM responses WHERE survey_id = $1 AND employee_msnv = $2 LIMIT 1;`, [sid, msnvTrim]);
        }
        const dupList = Array.isArray(dupRows) ? dupRows : (dupRows && dupRows.rows ? dupRows.rows : []);
        if (dupList.length > 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Bạn đã nộp khảo sát này rồi. Mỗi thiết bị/IP và MSNV chỉ được tham gia 1 lần. Nếu muốn làm lại hãy liên hệ nhân sự.'
          }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      const answersStr = typeof answers === 'string' ? answers : JSON.stringify(answers || []);
      try {
        const result = await queryNeon(
          DB_URL,
          `INSERT INTO responses (survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING id;`,
          [
            sid,
            employee_msnv || '',
            employee_name || '',
            employee_dept || '',
            answersStr,
            submitted_at || new Date().toISOString(),
            clientIp || ''
          ]
        );
        const insertedId = (Array.isArray(result) && result.length > 0) ? (result[0].id || result[0]) : result;
        return new Response(JSON.stringify({ success: true, id: insertedId, client_ip: clientIp }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        // Bắt lỗi unique violation do race condition
        if (e.message && (e.message.includes('duplicate') || e.message.includes('unique') || e.message.includes('idx_resp_'))) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Bạn đã nộp khảo sát này rồi (trùng IP/MSNV). Vui lòng liên hệ nhân sự nếu muốn làm lại.'
          }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        throw e;
      }
    }

    // 4. Lấy danh sách kết quả: GET /api/responses?survey_id=...
    if (path === '/api/responses' && request.method === 'GET') {
      const surveyId = url.searchParams.get('survey_id');
      let rows;
      if (surveyId) {
        rows = await queryNeon(
          DB_URL,
          `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
           FROM responses WHERE survey_id = $1 ORDER BY submitted_at DESC LIMIT 10000;`,
          [surveyId]
        );
      } else {
        rows = await queryNeon(
          DB_URL,
          `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
           FROM responses ORDER BY submitted_at DESC LIMIT 10000;`
        );
      }

      const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

      // Chuẩn hóa answers thành array/object nếu trả về dưới dạng JSON string
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

    // 5. XÓA DỮ LIỆU: DELETE /api/responses?id=123 hoặc ?survey_id=... hoặc truncate
    if (path === '/api/responses' && request.method === 'DELETE') {
      if (!isAdminAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized - cần đăng nhập admin' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const id = url.searchParams.get('id');
      const surveyId = url.searchParams.get('survey_id');
      const msnv = url.searchParams.get('msnv') || url.searchParams.get('employee_msnv');
      const ip = url.searchParams.get('ip') || url.searchParams.get('client_ip');

      if (id) {
        await queryNeon(DB_URL, `DELETE FROM responses WHERE id = $1;`, [id]);
        return new Response(JSON.stringify({ success: true, message: 'Đã xóa bài nộp id=' + id + ' và mở khóa cho thiết bị/IP đó.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      if (surveyId && msnv) {
        await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1 AND employee_msnv = $2;`, [surveyId, msnv]);
        return new Response(JSON.stringify({ success: true, message: 'Đã xóa bài theo survey+MSNV' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (surveyId && ip) {
        await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1 AND client_ip = $2;`, [surveyId, ip]);
        return new Response(JSON.stringify({ success: true, message: 'Đã xóa bài theo survey+IP' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (surveyId) {
        await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1;`, [surveyId]);
      } else {
        await queryNeon(DB_URL, `TRUNCATE TABLE responses;`);
      }

      return new Response(JSON.stringify({ success: true, message: 'All response data purged successfully.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 6. Lưu / Cập nhật cấu hình khảo sát: POST /api/surveys
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

    // 7. Lấy thông tin khảo sát: GET /api/surveys?id=...
    if (path === '/api/surveys' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(JSON.stringify({ error: 'Survey ID required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const rows = await queryNeon(DB_URL, `SELECT * FROM surveys WHERE id = $1 LIMIT 1;`, [id]);
      const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

      if (rowsList.length === 0) {
        return new Response(JSON.stringify({ error: 'Survey not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const s = { ...rowsList[0] };
      if (typeof s.questions === 'string') {
        try { s.questions = JSON.parse(s.questions); } catch (e) {}
      }

      return new Response(JSON.stringify(s), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 8. Xóa khảo sát: DELETE /api/surveys?id=...
    if (path === '/api/surveys' && request.method === 'DELETE') {
      if (!isAdminAuthorized(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized - cần đăng nhập admin' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(JSON.stringify({ error: 'Survey ID required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      await queryNeon(DB_URL, `DELETE FROM surveys WHERE id = $1;`, [id]);
      return new Response(JSON.stringify({ success: true, message: 'Survey deleted', id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Endpoint not found: ' + path }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
