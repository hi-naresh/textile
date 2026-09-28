import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { LedgerError, errorResponseBody, recordIncoming, recordOutgoing } from '@/lib/ledger';
import { readImport } from '@/lib/excel';
import { can, type Role } from '@/lib/access';

// POST multipart { file: .xlsx (import template), role, moved_by }
// All-or-nothing: every row is checked with the same rules as manual entry. If any row fails,
// nothing is saved and all problems come back as [{ row, error }].
// TODO(auth): role and actor from the session.
const MAX_ROWS = 1000;

class RowErrors extends Error {
  constructor(public errors: { row: number; error: string }[]) { super('rows failed'); }
}

export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();
    const role = String(fd.get('role') ?? '') as Role;
    if (!can(role, 'ledger.edit')) return NextResponse.json({ error: 'Only the owner can import stock.' }, { status: 403 });
    const file = fd.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Choose the Excel file to import.' }, { status: 400 });
    if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: 'Use the .xlsx template (Excel).' }, { status: 400 });
    if (file.size > 3 * 1024 * 1024) return NextResponse.json({ error: 'File is larger than 3 MB.' }, { status: 400 });
    const movedBy = String(fd.get('moved_by') ?? '').slice(0, 50) || null;

    let rows;
    try {
      rows = await readImport(Buffer.from(await file.arrayBuffer()));
    } catch {
      return NextResponse.json({ error: 'Could not open this file. Download the template and fill that.' }, { status: 400 });
    }
    if (!rows.length) return NextResponse.json({ error: 'No filled rows found in the file.' }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Up to ${MAX_ROWS} rows per file (this one has ${rows.length}).` }, { status: 400 });

    const summary = await withTransaction(async (q) => {
      const errors: { row: number; error: string }[] = [];
      let inCount = 0;
      let outCount = 0;
      for (const { row, values: v } of rows) {
        const dir = String(v.direction ?? '').trim().toUpperCase();
        await q('SAVEPOINT import_row');
        try {
          if (dir === 'IN') {
            await recordIncoming(q, { lot_id: v.lot_id, quality: v.quality, design: v.design, grey_meters: v.grey_meters, finished_meters: v.finished_meters, mill_name: v.mill_name, weaver_name: v.weaver_name, source_doc: v.challan, location: v.location, capture_event_id: null, moved_by: movedBy }, { requireLotDetails: true });
            inCount++;
          } else if (dir === 'OUT') {
            await recordOutgoing(q, { lot_id: v.lot_id, meters: v.meters, party: v.party, source_doc: v.challan, capture_event_id: null, moved_by: movedBy });
            outCount++;
          } else {
            throw new LedgerError('Direction must be IN or OUT.');
          }
          await q('RELEASE SAVEPOINT import_row');
        } catch (e) {
          await q('ROLLBACK TO SAVEPOINT import_row');
          if (!(e instanceof LedgerError)) throw e;
          errors.push({ row, error: e.message });
        }
      }
      if (errors.length) throw new RowErrors(errors); // rolls back every row
      return { in: inCount, out: outCount };
    });
    return NextResponse.json({ success: true, imported: summary });
  } catch (error) {
    if (error instanceof RowErrors) {
      return NextResponse.json({ error: `${error.errors.length} row(s) need fixing. Nothing was imported.`, rows: error.errors.slice(0, 200) }, { status: 422 });
    }
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
