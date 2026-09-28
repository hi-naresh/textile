import { NextRequest, NextResponse } from 'next/server';
import { LedgerError } from '@/lib/ledger-error';
import { readObject } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { answerQuestion } from '@/lib/chat/router';
import { sectionKey } from '@/lib/settings';

// POST { question, user_id, role } → answer from a fixed query template or the firm's notes.
// No free-form SQL: see src/lib/chat/router.ts for the decision order.
// TODO(auth): take user and role from the session instead of the request body.
export async function POST(request: NextRequest) {
  try {
    const body = await readObject(request);
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
    if (!question) return NextResponse.json({ error: 'Type a question.' }, { status: 400 });
    const role = body.role === 'supervisor' ? 'supervisor' : body.role === 'owner' ? 'owner' : null;
    if (!role) return NextResponse.json({ error: 'Chat is available to the owner and supervisors.' }, { status: 403 });
    const userId = typeof body.user_id === 'string' && body.user_id ? body.user_id.slice(0, 50) : 'usr-owner';

    let sections: string[] = [];
    if (role === 'supervisor') {
      const r = await query(
        `SELECT s.name FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = $1 AND s.active`,
        [userId],
      );
      sections = r.rows.map((x) => sectionKey(x.name));
    }

    const result = await answerQuestion(question, { role, sections }, `chat:${userId}`);

    try {
      const trail = result.route === 'template'
        ? `template:${result.template} ${JSON.stringify(result.params ?? {})} via ${result.via}`
        : result.route === 'knowledge'
          ? `knowledge:${(result.sources ?? []).map((s) => s.id).join(',')} via ${result.via}`
          : 'help';
      await query(`INSERT INTO chat_audit (user_id, question, sql_run, answer) VALUES ($1, $2, $3, $4)`, [userId, question, trail, result.answer]);
    } catch (auditErr) {
      console.error('[chat] could not write audit row', auditErr);
    }

    return NextResponse.json({ success: true, ...result, rows: result.rows.slice(0, 50) });
  } catch (error) {
    if (error instanceof LedgerError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[chat] failed', error);
    return NextResponse.json({ error: 'Could not answer right now. Try again.' }, { status: 500 });
  }
}
