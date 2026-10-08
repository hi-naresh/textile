import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { ImportFileError, validateImport } from '@/lib/stock-import';
import { requireCap } from '@/lib/apiAuth';

// Step 1 of the Excel import (owner). POST multipart { file: .xlsx } → checks only, writes nothing.
// Three formats, told apart by the heading row: the firm's Incoming register, its Outgoing (sales) register, or the
// app template (src/lib/stock-import.ts, src/lib/register-import.ts). → also { format, detected, warnings[{row,field,message,skip}],
// warningCount, skipCount, fix } — `rows` leaves out skipped rows; errors (problems) block the file.
// → { ok, batch, total, counts, headerProblems[{column,message}], notes[], problems[{row,field,message}], problemCount, problemRows, rows? }
// When ok, `rows` (cleaned) + `batch` go back in chunks to POST /api/stock/import/commit.
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    const fd = await req.formData();
    const file = fd.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose the Excel file to import.' }, { status: 400 });
    if (!/\.xlsx$/i.test(file.name)) return NextResponse.json({ error: 'Use an .xlsx file (Excel). Older .xls or .csv files: open in Excel and "Save as" .xlsx.' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File is larger than 8 MB. Split it into smaller files.' }, { status: 400 });
    const result = await validateImport((text, params) => query(text, params), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ImportFileError) return NextResponse.json({ error: error.message }, { status: 400 });
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
