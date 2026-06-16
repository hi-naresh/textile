import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// Safely validate SQL queries to prevent modifications
function isSafeQuery(sql: string): boolean {
  const cleanSql = sql.trim().toLowerCase();
  
  // Must start with select
  if (!cleanSql.startsWith('select')) {
    return false;
  }
  
  // Must not contain modifying keywords
  const forbidden = [
    'insert', 'update', 'delete', 'drop', 'truncate', 
    'alter', 'create', 'grant', 'revoke', 'replace',
    'upsert', 'exec', 'execute', 'procedure', 'union'
  ];
  
  for (const word of forbidden) {
    // Check if the word is present as a separate token/word
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(cleanSql)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Fallback pattern-based mock text-to-SQL translation for local development
 */
async function translateMock(question: string): Promise<{ sql: string; explanation: string; params: any[] }> {
  const q = question.toLowerCase().trim();
  
  if (q.includes('lot') && (q.includes('all') || q.includes('list') || q.includes('show'))) {
    return {
      sql: `SELECT lot_id, quality, design, grade, status FROM lots ORDER BY lot_id DESC`,
      explanation: 'List of all fabric lots in the mill.',
      params: []
    };
  }
  
  if (q.includes('ledger') || q.includes('movements') || q.includes('transactions')) {
    return {
      sql: `SELECT sm.id, sm.lot_id, sm.direction, sm.meters, sm.party, sm.source_doc_id, sm.ts 
            FROM stock_movements sm 
            ORDER BY sm.ts DESC LIMIT 20`,
      explanation: 'Recent stock movements (IN/OUT ledger entries).',
      params: []
    };
  }

  // Stock of a specific lot
  const lotMatch = q.match(/lot-\d+/i);
  if (lotMatch) {
    const lotId = lotMatch[0].toUpperCase();
    return {
      sql: `SELECT 
              l.lot_id, l.quality, l.design, l.grade, l.status,
              COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) as balance
            FROM lots l
            LEFT JOIN stock_movements sm ON l.lot_id = sm.lot_id
            WHERE l.lot_id = $1
            GROUP BY l.lot_id, l.quality, l.design, l.grade, l.status`,
      explanation: `Current stock balance and specifications for lot ${lotId}.`,
      params: [lotId]
    };
  }

  // Shortage queries
  if (q.includes('shortage') || q.includes('short')) {
    return {
      sql: `SELECT jc.id, jc.lot_id, jc.process, w.name as worker_name, jc.meters_in, jc.meters_out, jc.shortage,
            ROUND((jc.shortage / jc.meters_in * 100)::numeric, 2) as shortage_pct
            FROM job_cards jc
            JOIN workers w ON jc.worker_id = w.id
            WHERE jc.status = 'closed' AND jc.shortage > 0
            ORDER BY jc.shortage DESC`,
      explanation: 'Job cards that completed with fabric shortages.',
      params: []
    };
  }

  // Job cards list
  if (q.includes('job card') || q.includes('jobs')) {
    return {
      sql: `SELECT jc.id, jc.lot_id, jc.process, w.name as worker_name, jc.meters_in, jc.meters_out, jc.status 
            FROM job_cards jc
            JOIN workers w ON jc.worker_id = w.id
            ORDER BY jc.id DESC`,
      explanation: 'List of all job cards and their current processing status.',
      params: []
    };
  }

  // Efficiency and workers
  if (q.includes('efficiency') || q.includes('slow') || q.includes('worker') || q.includes('operator')) {
    return {
      sql: `SELECT ed.worker_id, w.name, w.section, ed.date, ed.allotted, ed.done, ed.efficiency_pct, ed.flagged 
            FROM efficiency_daily ed
            JOIN workers w ON ed.worker_id = w.id
            ORDER BY ed.efficiency_pct ASC LIMIT 10`,
      explanation: 'Roster of worker daily efficiencies ordered from lowest to highest.',
      params: []
    };
  }
  
  if (q.includes('cctv') || q.includes('idle') || q.includes('camera')) {
    return {
      sql: `SELECT ca.worker_id, w.name, ca.station, ca.active_pct, ca.idle_min, ca.ts
            FROM cctv_activity ca
            JOIN workers w ON ca.worker_id = w.id
            ORDER BY ca.active_pct ASC LIMIT 10`,
      explanation: 'Recent camera analytics records for worker activity level.',
      params: []
    };
  }

  // Default fallback query
  return {
    sql: `SELECT 
            (SELECT COUNT(*) FROM lots) as total_lots,
            (SELECT COUNT(*) FROM job_cards) as total_job_cards,
            (SELECT COUNT(*) FROM workers) as total_workers,
            COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) FROM stock_movements), 0) as total_stock`,
    explanation: 'System totals summary (fallback for general queries).',
    params: []
  };
}

/**
 * Generate a friendly response for the SQL rows using a mock summarize
 */
function mockSummarize(question: string, sql: string, rows: any[]): string {
  const q = question.toLowerCase();
  
  if (sql.includes('lots') && !sql.includes('SUM')) {
    return `I found ${rows.length} lots in the database. The most recent lots are active and currently in processing.`;
  }
  
  if (sql.includes('stock_movements') && !sql.includes('WHERE')) {
    return `Here are the latest stock ledger entries. There have been several IN movements from suppliers like Karan Fabrics and Vimal Processors, as well as dispatches (OUT).`;
  }
  
  if (sql.includes('balance') && rows.length > 0) {
    const row = rows[0];
    return `Lot **${row.lot_id}** is a **${row.quality}** fabric of design **${row.design}** (Grade ${row.grade}). The current running balance is **${parseFloat(row.balance).toFixed(2)} meters**. Its status is currently listed as **${row.status}**.`;
  }
  
  if (sql.includes('shortage')) {
    const flagged = rows.filter(r => parseFloat(r.shortage_pct) > 3.0);
    return `I analyzed completed job cards for folding shortages. I found ${rows.length} records with shortages. Out of these, **${flagged.length} job cards exceed the 3.0% shortage limit** and are flagged for supervisor audit (e.g. Lot LOT-5022 completed with a shortage of ${rows[0]?.shortage || 0}m).`;
  }
  
  if (sql.includes('efficiency_daily')) {
    const low = rows.filter(r => r.flagged);
    return `Worker efficiency records show that the average efficiency stands at around 90%. However, we have **${low.length} workers currently flagged** for operating below the 85.0% threshold today.`;
  }
  
  if (sql.includes('cctv_activity')) {
    return `Camera tracking indicates that active work is progressing normally. Station A (Folding) has flagged lower activity (45.0% active, 180 min idle) for Bharat Gohil. We should review this against his job-card output before taking coaching actions.`;
  }

  return `I ran a query against the central database to summarize the information. I found **${rows.length} relevant records** in the database matching your search. You can view the raw query and output data below.`;
}

/**
 * Call Anthropic Claude API for Text-to-SQL translation
 */
async function translateWithClaude(question: string, apiKey: string): Promise<string> {
  const schemaPrompt = `You are a safe Text-to-SQL translator for a textile mill database in Surat.
Your task is to take a natural language question in English, Hindi, or Gujarati and translate it into a safe, valid PostgreSQL query.

The database schema is as follows:
- users (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), role VARCHAR(20), locale VARCHAR(10), active BOOLEAN)
- workers (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), section VARCHAR(100), role VARCHAR(50), active BOOLEAN)
- lots (lot_id VARCHAR(50) PRIMARY KEY, quality VARCHAR(100), design VARCHAR(100), grade VARCHAR(10), status VARCHAR(20))
- capture_events (id SERIAL PRIMARY KEY, photo_url VARCHAR(255), type VARCHAR(30), ai_json JSONB, confidence NUMERIC(3,2), status VARCHAR(20), confirmed_by VARCHAR(50), ts TIMESTAMP)
- stock_movements (id SERIAL PRIMARY KEY, lot_id VARCHAR(50) REFERENCES lots, direction VARCHAR(5) CHECK (IN/OUT), meters NUMERIC(10,2), party VARCHAR(150), source_doc_id VARCHAR(100), capture_event_id INTEGER, ts TIMESTAMP)
- job_cards (id SERIAL PRIMARY KEY, lot_id VARCHAR(50) REFERENCES lots, process VARCHAR(100), worker_id VARCHAR(50) REFERENCES workers, meters_in NUMERIC(10,2), meters_out NUMERIC(10,2), shortage NUMERIC(10,2) GENERATED, status VARCHAR(20), ts_created TIMESTAMP, ts_closed TIMESTAMP)
- allotments (id SERIAL PRIMARY KEY, worker_id VARCHAR(50) REFERENCES workers, job_card_id INTEGER REFERENCES job_cards, meters_allotted NUMERIC(10,2), shift VARCHAR(20), date DATE)
- efficiency_daily (id SERIAL PRIMARY KEY, worker_id VARCHAR(50) REFERENCES workers, date DATE, allotted NUMERIC(10,2), done NUMERIC(10,2), efficiency_pct NUMERIC(5,2), flagged BOOLEAN)
- cctv_activity (id SERIAL PRIMARY KEY, worker_id VARCHAR(50) REFERENCES workers, station VARCHAR(50), active_pct NUMERIC(5,2), idle_min NUMERIC(10,2), ts TIMESTAMP)
- chat_audit (id SERIAL PRIMARY KEY, user_id VARCHAR(50) REFERENCES users, question TEXT, sql_run TEXT, answer TEXT, ts TIMESTAMP)

Rules:
1. Generate ONLY the PostgreSQL SELECT query. Do not wrap it in quotes, do not add markdown backticks (\`\`\`sql), and do not add conversational text.
2. The query MUST be read-only (SELECT statements only). Never write INSERT, UPDATE, DELETE, or DDL queries.
3. Be careful with joins: join stock_movements with lots on lot_id, join job_cards with workers on worker_id, etc.
4. For running stock balance of a lot or quality, compute it as: SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END).
5. For shortage pct on a job card, compute: (shortage / meters_in * 100).
`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: schemaPrompt },
            { type: 'text', text: `Translate this question to a SQL query: "${question}"` }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude SQL API error: ${response.status} - ${errText}`);
  }

  const resJson = await response.json();
  return (resJson.content?.[0]?.text || '').trim();
}

/**
 * Generate a friendly response for the SQL rows using Claude
 */
async function summarizeWithClaude(question: string, sql: string, rows: any[], apiKey: string): Promise<string> {
  const prompt = `You are the AI Brain of a textile mill in Surat. The owner has asked a question: "${question}".
We executed the following SQL query against our central database:
\`\`\`sql
${sql}
\`\`\`
It returned these rows of data:
\`\`\`json
${JSON.stringify(rows, null, 2)}
\`\`\`

Please write a helpful, concise response answering the owner's question based on these database records.
- Speak in the same language the question was asked in (English, Hindi, or Gujarati).
- Highlight key numbers (like meters, shortages, or flagged workers).
- Do not mention table names, database details, or technical terms like SQL or database. Speak purely from a business operations perspective.
- If no rows were returned, politely explain that no matching records were found in the database.
`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude Summarize API error: ${response.status} - ${errText}`);
  }

  const resJson = await response.json();
  return (resJson.content?.[0]?.text || '').trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, user_id } = body;

    if (!question) {
      return NextResponse.json({ error: 'question is required.' }, { status: 400 });
    }

    const userId = user_id || 'usr-owner';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    let sql = '';
    let explanation = '';
    let params: any[] = [];
    let rows: any[] = [];
    let answer = '';

    if (apiKey) {
      console.log(`[AI Chat] Translating question using Claude: "${question}"`);
      try {
        const rawSql = await translateWithClaude(question, apiKey);
        // Clean SQL of any wrappers
        sql = rawSql.trim().replace(/^```sql\s*/i, '').replace(/```$/, '').trim();
        explanation = 'Translated dynamically by Claude 3.5 Sonnet.';
      } catch (err) {
        console.error('[AI Chat] Claude translation failed, falling back to pattern matcher:', err);
        const mockTrans = await translateMock(question);
        sql = mockTrans.sql;
        explanation = mockTrans.explanation;
        params = mockTrans.params;
      }
    } else {
      console.log(`[AI Chat] No API key. Translating using pattern matcher: "${question}"`);
      const mockTrans = await translateMock(question);
      sql = mockTrans.sql;
      explanation = mockTrans.explanation;
      params = mockTrans.params;
    }

    // Safety validation
    if (!isSafeQuery(sql)) {
      console.warn(`[AI Chat] Refused unsafe query: ${sql}`);
      return NextResponse.json(
        { 
          error: 'Unsafe database query generated. For security, only SELECT queries are permitted.',
          sql
        },
        { status: 400 }
      );
    }

    // Execute query
    try {
      const dbRes = await query(sql, params);
      rows = dbRes.rows;
    } catch (dbErr) {
      console.error(`[AI Chat] SQL Execution failed: ${sql}`, dbErr);
      return NextResponse.json(
        { 
          error: `Failed to execute the database query: ${String(dbErr)}`,
          sql 
        },
        { status: 500 }
      );
    }

    // Generate plain-language summary
    if (apiKey) {
      try {
        answer = await summarizeWithClaude(question, sql, rows, apiKey);
      } catch (err) {
        console.error('[AI Chat] Claude summarization failed, falling back to mock:', err);
        answer = mockSummarize(question, sql, rows);
      }
    } else {
      // Simulate small delay
      await new Promise(resolve => setTimeout(resolve, 500));
      answer = mockSummarize(question, sql, rows);
    }

    // Log to audit table
    try {
      await query(
        `INSERT INTO chat_audit (user_id, question, sql_run, answer) 
         VALUES ($1, $2, $3, $4)`,
        [userId, question, sql, answer]
      );
    } catch (auditErr) {
      console.error('[AI Chat] Failed to log chat audit:', auditErr);
    }

    return NextResponse.json({
      success: true,
      answer,
      sql,
      rows,
      explanation
    });

  } catch (error) {
    console.error('Failed to handle chat assistant query:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
