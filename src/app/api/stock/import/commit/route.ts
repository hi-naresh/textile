import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { CHUNK_MAX, ChunkRowError, commitChunk } from '@/lib/stock-import';
import { readObject, requireCap } from '@/lib/apiAuth';

// Step 2 of the Excel import (owner). POST { batch, rows: ImportRow[] } — one chunk, one transaction.
// Rows are re-checked with the ledger's rules. Rows already saved for this batch are skipped (safe to re-send).
// → { saved, skipped, in, out, first_row, last_row }   |   422 { error, row } (nothing from this chunk saved)
export async function POST(req: NextRequest) {
  try {
    const a = await requireCap(req, 'ledger.edit');
    const body = await readObject(req);
    const batch = body?.batch;
    const rows = body?.rows;
    if (typeof batch !== 'string' || !/^[a-f0-9]{16}$/.test(batch)) return NextResponse.json({ error: 'Check the file again before importing.' }, { status: 400 });
    if (!Array.isArray(rows) || !rows.length) return NextResponse.json({ error: 'No rows sent.' }, { status: 400 });
    if (rows.length > CHUNK_MAX) return NextResponse.json({ error: `Send at most ${CHUNK_MAX} rows at a time.` }, { status: 400 });
    const result = await withTransaction((q) => commitChunk(q, batch, rows, a.by));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ChunkRowError) return NextResponse.json({ error: `Row ${error.row}: ${error.message}`, row: error.row }, { status: 422 });
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
