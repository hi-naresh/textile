import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';
import { enforceApiRateLimit, rateLimitResponse } from '@/lib/apiRateLimit';
import { confirmImportReview } from '@/lib/stock-import-review';

export async function POST(req: NextRequest) {
  try {
    const actor = await requireCap(req, 'ledger.edit');
    await enforceApiRateLimit(query, actor.userId, 'stock-import');
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'Send the reviewed Excel file (up to 8 MB).' }, { status: 400 });
    }
    let choices: unknown;
    try { choices = JSON.parse(String(form.get('choices'))); } catch {
      return NextResponse.json({ error: 'Send the lot status choices.' }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await withTransaction((q) => confirmImportReview(q, form.get('reviewId'), actor.userId, bytes, choices));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const limited = rateLimitResponse(error);
    if (limited) return limited;
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
