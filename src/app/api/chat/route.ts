import { NextRequest, NextResponse } from 'next/server';
import { LedgerError } from '@/lib/ledger-error';
import { readObject, requireCap } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { answerQuestion } from '@/lib/chat/router';
import { sectionKey } from '@/lib/settings';
import { logError, PLAIN_ERROR } from '@/lib/errors';

// POST { question } (owner / supervisor) → answer from a fixed query template or the firm's notes.
// No free-form SQL: see src/lib/chat/router.ts for the decision order. Who is asking comes from the session.
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'chat.use');
    const body = await readObject(request);
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
    if (!question) return NextResponse.json({ error: 'Type a question.' }, { status: 400 });
    const role = a.role === 'owner' ? 'owner' : 'supervisor';

    let sections: string[] = [];
    if (role === 'supervisor') {
      const r = await query(
        `SELECT s.name FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = $1 AND s.active`,
        [a.userId],
      );
      sections = r.rows.map((x) => sectionKey(x.name));
    }

    const result = await answerQuestion(question, { role, sections }, `chat:${a.by}`);

    try {
      const trail = result.route === 'template'
        ? `template:${result.template} ${JSON.stringify(result.params ?? {})} via ${result.via}`
        : result.route === 'knowledge'
          ? `knowledge:${(result.sources ?? []).map((s) => s.id).join(',')} via ${result.via}`
          : 'help';
      await query(`INSERT INTO chat_audit (user_id, question, sql_run, answer) VALUES ($1, $2, $3, $4)`, [a.by, question, trail, result.answer]);
    } catch (auditErr) {
      logError('chat.audit', auditErr);
    }

    return NextResponse.json({ success: true, ...result, rows: result.rows.slice(0, 50) });
  } catch (error) {
    if (error instanceof LedgerError) return NextResponse.json({ error: error.message }, { status: error.status });
    logError('chat', error);
    return NextResponse.json({ error: PLAIN_ERROR }, { status: 500 });
  }
}
