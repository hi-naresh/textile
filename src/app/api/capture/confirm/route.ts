import { NextRequest, NextResponse } from 'next/server';
import { readObject } from '@/lib/apiAuth';
import { withTransaction } from '@/lib/db';
import { LedgerError, applyCaptureRead, errorResponseBody } from '@/lib/ledger';

// POST: Confirm, correct or reject a pending AI photo read.
// Confirm/correct writes to the ledger through the same rules as manual entry.
export async function POST(request: NextRequest) {
  try {
    const body = await readObject(request);
    const { event_id, confirmed_by, status, corrected_data } = body;
    const rs = parseFloat(body.review_seconds);
    const reviewSeconds = Number.isFinite(rs) && rs >= 0 ? Math.min(rs, 3600) : null;

    if (!event_id || !confirmed_by || !status) {
      return NextResponse.json({ error: 'event_id, confirmed_by, and status are required.' }, { status: 400 });
    }
    if (!['confirmed', 'corrected', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'status must be either confirmed, corrected, or rejected.' }, { status: 400 });
    }

    await withTransaction(async (q) => {
      const eventRes = await q('SELECT * FROM capture_events WHERE id = $1 FOR UPDATE', [event_id]);
      if (!eventRes.rowCount) throw new LedgerError(`Capture event ${event_id} not found.`, 404);
      const event = eventRes.rows[0];
      if (event.status !== 'pending') throw new LedgerError(`Capture event ${event_id} is already processed.`);

      if (status === 'rejected') {
        await q(`UPDATE capture_events SET status = 'rejected', confirmed_by = $1, confirmed_at = NOW(), review_seconds = $3 WHERE id = $2`, [confirmed_by, event_id, reviewSeconds]);
        return;
      }

      const data = status === 'corrected' ? corrected_data : event.ai_json;
      if (!data || typeof data !== 'object') throw new LedgerError('Missing data to confirm.');

      const saved = await applyCaptureRead(q, event.type, data, event.id, confirmed_by);
      await q(
        // A correction keeps the original read in read_meta for audit.
        `UPDATE capture_events SET status = $1, confirmed_by = $2, ai_json = $3, confirmed_at = NOW(), review_seconds = $5,
           read_meta = CASE WHEN $6::boolean THEN COALESCE(read_meta, '{}'::jsonb) || jsonb_build_object('original_read', ai_json) ELSE read_meta END
         WHERE id = $4`,
        [status, confirmed_by, JSON.stringify(saved), event_id, reviewSeconds, status === 'corrected']
      );
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
