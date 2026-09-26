import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { LedgerError, applyCaptureRead } from '@/lib/ledger';
import { readRules } from '@/lib/settings';
import { extractDataFromPhoto } from '@/lib/ai';
import { photoUrlForClient, savePhoto } from '@/lib/photos';

// TODO(auth): attribute auto-commits to a system user once users/sessions exist.
const AUTO_COMMIT_ACTOR = 'usr-owner';

export async function GET() {
  // GET: Fetch all capture events (e.g. for the confirm queue)
  try {
    const res = await query(
      `SELECT ce.*, u.name as confirmed_by_name
       FROM capture_events ce
       LEFT JOIN users u ON ce.confirmed_by = u.id
       ORDER BY ce.ts DESC`
    );
    return NextResponse.json({
      events: res.rows.map(row => ({
        ...row,
        photo_url: photoUrlForClient(row.photo_url),
        confidence: parseFloat(row.confidence)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch capture events:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const type = formData.get('type') as 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }

    if (!type || !['incoming_stock', 'outgoing_stock', 'job_card_folding'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid or missing capture type. Must be incoming_stock, outgoing_stock, or job_card_folding.' },
        { status: 400 }
      );
    }

    // 1. Validate and read the photo
    const MAX_BYTES = 15 * 1024 * 1024;
    const ALLOWED: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
    const mediaType = ALLOWED[file.type] ? file.type : 'image/jpeg';
    if (file.type && !ALLOWED[file.type]) {
      return NextResponse.json({ error: 'Please upload a JPG, PNG, WEBP or HEIC photo.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Photo is larger than 15 MB. Please retake at a lower resolution.' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const safeName = `${type}_${Date.now()}${ALLOWED[mediaType]}`;

    // 2. Read it with AI first (nothing is stored if the photo can't be read)
    console.log(`[Capture API] Initiating vision extraction for type: ${type}, file: ${safeName}`);
    const extraction = await extractDataFromPhoto({ buffer, filename: file.name || safeName, mediaType }, type);

    if (!extraction.success) {
      return NextResponse.json(
        { error: 'Could not read the photo. Please retake it or enter the details manually.', details: extraction.rawResponse },
        { status: 502 }
      );
    }

    const { data: aiData, confidence } = extraction;

    // 3. Store the photo (Supabase Storage on Vercel, public/uploads locally)
    const photoRef = await savePhoto(buffer, safeName, mediaType);

    // 4. Save capture event to DB in a pending state
    const insertEventRes = await query(
      `INSERT INTO capture_events (photo_url, type, ai_json, confidence, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [photoRef, type, JSON.stringify(aiData), confidence]
    );
    const event = insertEventRes.rows[0];

    // 5. If confidence >= threshold, attempt auto-commit
    let autoCommitted = false;
    let commitError: string | null = null;

    // Reads at or above the firm's auto-confirm level are saved without review (Settings → Rules).
    const { aiAutoConfirmPct } = await readRules();
    if (confidence * 100 >= aiAutoConfirmPct) {
      try {
        await withTransaction(async (q) => {
          const saved = await applyCaptureRead(q, type, aiData as Record<string, unknown>, event.id, AUTO_COMMIT_ACTOR);
          await q(
            `UPDATE capture_events SET status = 'confirmed', confirmed_by = $1, ai_json = $2 WHERE id = $3`,
            [AUTO_COMMIT_ACTOR, JSON.stringify(saved), event.id]
          );
        });
        autoCommitted = true;
      } catch (err) {
        // Anything that can't be saved automatically stays in the review queue.
        commitError = err instanceof LedgerError ? `${err.message} Left in review queue.` : String(err);
        if (!(err instanceof LedgerError)) console.error('[Capture API] Auto-commit failed:', err);
      }
    }

    return NextResponse.json({
      success: true,
      event: {
        ...event,
        photo_url: photoUrlForClient(event.photo_url),
        status: autoCommitted ? 'confirmed' : 'pending',
        confidence: parseFloat(event.confidence)
      },
      extracted: aiData,
      autoCommitted,
      commitError
    });

  } catch (error) {
    console.error('Failed to handle photo capture:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
