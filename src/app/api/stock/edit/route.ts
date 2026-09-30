import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { EditProblems, applyLedgerEdits, editHistory, parseChanges } from '@/lib/ledger-edit';

// PATCH /api/stock/edit (owner, ledger.edit) — the stock ledger's edit mode.
// Body: { changes: [{ target: 'movement', id: <stock_movements.id>, field, value } | { target: 'lot', id: <lot_id>, field, value }] } (≤ 500)
//   movement fields: sr_no, pieces, source_doc_id, mill_name + weaver_name (IN), party (OUT), quality + design (edit the row's lot)
//   lot fields:      quality, design, grade, status (active | completed | dispatched | hold)
//   Empty value (or null) clears sr_no / pieces / source_doc_id / mill_name / weaver_name / party. Quality, design, grade, status are required.
// All-or-nothing, one transaction. → { saved, rows: LedgerRow[] (edited movements), lots: [{ lot_id, quality, design, grade, status }] }
// Invalid values → 422 { error, problems: [{ target, id, field, message }] }. Malformed body / unknown field → 400.
export async function PATCH(req: NextRequest) {
  try {
    const a = await requireCap(req, 'ledger.edit');
    const changes = parseChanges(await readObject(req));
    const out = await withTransaction((q) => applyLedgerEdits(q, changes, a.by));
    return NextResponse.json(out);
  } catch (error) {
    if (error instanceof EditProblems) return NextResponse.json({ error: error.message, problems: error.problems }, { status: 422 });
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// GET /api/stock/edit?target=movement|lot&id=… (owner) → { edits: [{ field, label, old_value, new_value, edited_at, edited_by }] }, newest first.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    const sp = req.nextUrl.searchParams;
    const target = sp.get('target');
    const id = (sp.get('id') ?? '').trim();
    if (target !== 'movement' && target !== 'lot') return NextResponse.json({ error: 'target must be movement or lot.' }, { status: 400 });
    if (!id || id.length > 50 || (target === 'movement' && !/^\d{1,12}$/.test(id))) return NextResponse.json({ error: 'id is not valid.' }, { status: 400 });
    const edits = await editHistory((text, params) => query(text, params), target, id);
    return NextResponse.json({ edits }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
