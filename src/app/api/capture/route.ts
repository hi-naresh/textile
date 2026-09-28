import { NextRequest, NextResponse, after } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { LedgerError, applyCaptureRead, errorResponseBody } from '@/lib/ledger';
import { readRules } from '@/lib/settings';
import { extractDataFromPhoto } from '@/lib/ai';
import { compressForAudit, photoUrlForClient, savePhoto } from '@/lib/photos';
import { canCapture } from '@/lib/access';
import { requireUser } from '@/lib/apiAuth';
import { logError } from '@/lib/errors';

export async function GET(request: NextRequest) {
  // GET: Fetch all capture events (e.g. for the confirm queue)
  try {
    // Workers see only their own photos; owner / supervisors see the whole queue.
    const a = await requireUser(request);
    const res = await query(
      `SELECT ce.*, (ce.ts::date = CURRENT_DATE) AS is_today, u.name as confirmed_by_name
       FROM capture_events ce
       LEFT JOIN users u ON ce.confirmed_by = u.id
       WHERE $1::varchar IS NULL OR ce.captured_by = $1
       ORDER BY ce.ts DESC`,
      [a.role === 'worker' ? a.userId : null]
    );
    return NextResponse.json({
      events: res.rows.map(row => ({
        ...row,
        photo_url: photoUrlForClient(row.photo_url),
        confidence: parseFloat(row.confidence)
      }))
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

const TYPES = ['incoming_stock', 'outgoing_stock', 'job_card_folding'] as const;
type Kind = (typeof TYPES)[number];

export async function POST(request: NextRequest) {
  try {
    // Who captured it (and who an auto-confirm is attributed to) is the signed-in user.
    const a = await requireUser(request);
    const role = a.role;
    const capturedBy = a.by;
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const type = formData.get('type') as Kind;
    const captureSecondsRaw = parseFloat(String(formData.get('capture_seconds') ?? ''));
    const captureSeconds = Number.isFinite(captureSecondsRaw) && captureSecondsRaw >= 0 ? Math.min(captureSecondsRaw, 3600) : null;

    if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    if (!TYPES.includes(type)) {
      return NextResponse.json({ error: 'Invalid or missing capture type. Must be incoming_stock, outgoing_stock, or job_card_folding.' }, { status: 400 });
    }
    if (!canCapture(role, type)) {
      return NextResponse.json({ error: 'You are not allowed to capture this kind of photo.' }, { status: 403 });
    }

    // 1. Validate the photo
    const MAX_BYTES = 15 * 1024 * 1024;
    const ALLOWED: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
    const mediaType = ALLOWED[file.type] ? file.type : 'image/jpeg';
    if (file.type && !ALLOWED[file.type]) {
      return NextResponse.json({ error: 'Please upload a JPG, PNG, WEBP or HEIC photo.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Photo is larger than 15 MB. Please retake at a lower resolution.' }, { status: 400 });
    }
    const raw = Buffer.from(await file.arrayBuffer());
    const stamp = Date.now();

    // 2. Read it from the RAW photo (OCR first, LLM only if needed). Nothing is stored if it can't be read.
    const extraction = await extractDataFromPhoto({ buffer: raw, filename: file.name || `${type}_${stamp}`, mediaType }, type, `capture:${type}:${stamp}`);
    if (!extraction.success) {
      logError('capture.read', new Error('Photo could not be read'), { type, engine: extraction.engine ?? null, raw: String(extraction.rawResponse ?? '').slice(0, 2000) });
      return NextResponse.json({ error: 'Could not read the photo. Please retake it or enter the details manually.' }, { status: 502 });
    }
    const { data: aiData, confidence } = extraction;

    // 3. Save the read. The photo itself is compressed and stored in the background (below).
    const insertEventRes = await query(
      `INSERT INTO capture_events (photo_url, type, ai_json, confidence, status, read_engine, read_meta, captured_by, capture_seconds)
       VALUES (NULL, $1, $2, $3, 'pending', $4, $5, $6, $7) RETURNING *`,
      [type, JSON.stringify(aiData), Math.round(confidence * 100) / 100, extraction.engine ?? null, JSON.stringify(extraction.meta ?? {}), capturedBy, captureSeconds]
    );
    const event = insertEventRes.rows[0];

    // 4. Background: compress (WEBP ≤1600 px) and keep only that copy for audit, in a YYYY/MM/DD folder.
    after(async () => {
      try {
        const small = await compressForAudit(raw);
        const ref = await savePhoto(small.buffer, `${type}_${event.id}_${stamp}${small.ext}`, small.contentType);
        await query(
          `UPDATE capture_events SET photo_url = $1,
             read_meta = COALESCE(read_meta, '{}'::jsonb) || jsonb_build_object('photo', jsonb_build_object('raw_bytes', $2::int, 'stored_bytes', $3::int))
           WHERE id = $4`,
          [ref, raw.length, small.buffer.length, event.id]
        );
      } catch (err) {
        console.error('[Capture API] could not store audit photo', err);
        await query(`UPDATE capture_events SET read_meta = COALESCE(read_meta, '{}'::jsonb) || jsonb_build_object('photo_error', $1::text) WHERE id = $2`, [String(err).slice(0, 300), event.id]).catch(() => {});
      }
    });

    // 5. Reads at or above the firm's auto-confirm level are saved without review (Settings → Rules).
    let autoCommitted = false;
    let commitError: string | null = null;
    const { aiAutoConfirmPct } = await readRules();
    if (confidence * 100 >= aiAutoConfirmPct) {
      try {
        await withTransaction(async (q) => {
          const saved = await applyCaptureRead(q, type, aiData as Record<string, unknown>, event.id, capturedBy);
          await q(
            `UPDATE capture_events SET status = 'confirmed', confirmed_by = $1, ai_json = $2, confirmed_at = NOW(), review_seconds = 0 WHERE id = $3`,
            [capturedBy, JSON.stringify(saved), event.id]
          );
        });
        autoCommitted = true;
      } catch (err) {
        // Anything that can't be saved automatically stays in the review queue.
        commitError = err instanceof LedgerError ? `${err.message} Left in review queue.` : 'Could not save it automatically. Left in review queue.';
        if (!(err instanceof LedgerError)) logError('capture.auto_commit', err, { event_id: event.id });
      }
    }

    return NextResponse.json({
      success: true,
      event: {
        ...event,
        photo_url: null,
        status: autoCommitted ? 'confirmed' : 'pending',
        confidence: parseFloat(event.confidence)
      },
      extracted: aiData,
      engine: extraction.engine,
      autoCommitted,
      commitError
    });

  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
