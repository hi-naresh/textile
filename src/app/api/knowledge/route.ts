import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName } from '@/lib/settings';

// Firm knowledge notes used by chat for policy / how-to questions. Owner only (Settings).
// GET → list. POST { title, body } → add. PATCH { id, title?, body?, active? } → edit.
const cleanBody = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new LedgerError('Write the note text.');
  if (s.length > 5000) throw new LedgerError('Keep a note under 5000 characters.');
  return s;
};

export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'settings.manage');
    const r = await query(`SELECT id, title, body, active, updated_at FROM knowledge_docs ORDER BY active DESC, title`);
    return NextResponse.json({ docs: r.rows });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireCap(req, 'settings.manage');
    const b = await readObject(req);
    const r = await query(`INSERT INTO knowledge_docs (title, body) VALUES ($1, $2) RETURNING id, title, body, active, updated_at`, [cleanName(b.title, 'Title', 150), cleanBody(b.body)]);
    return NextResponse.json({ doc: r.rows[0] });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireCap(req, 'settings.manage');
    const b = await readObject(req);
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid note id is required.');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if ('title' in b) add('title', cleanName(b.title, 'Title', 150));
    if ('body' in b) add('body', cleanBody(b.body));
    if ('active' in b) add('active', !!b.active);
    if (!sets.length) throw new LedgerError('Nothing to update.');
    vals.push(id);
    const r = await query(`UPDATE knowledge_docs SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length} RETURNING id, title, body, active, updated_at`, vals);
    if (!r.rowCount) throw new LedgerError('Note not found.', 404);
    return NextResponse.json({ doc: r.rows[0] });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
