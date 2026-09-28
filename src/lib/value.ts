// Value tracking: time saved by photo capture vs the firm's manual baseline (Settings → Rules).
// Per confirmed read: saved = manual minutes − (time to take the photo + time spent reviewing), never below 0.
import { query } from './db';

export interface TimeSaved {
  days: number;
  captures: number;
  manualMin: number; // what the same work would have taken by hand
  actualMin: number; // time people actually spent (capture + review)
  savedMin: number;
  baseline: { challanMin: number; jobCardMin: number };
}

/** Reads with no recorded capture time (older reads, API uploads) count as 60 s — deliberately conservative. */
const UNKNOWN_CAPTURE_SECONDS = 60;

export async function timeSaved(days: number): Promise<TimeSaved> {
  const r = await query(
    `WITH s AS (SELECT manual_challan_min AS ch, manual_job_card_min AS jc FROM app_settings WHERE id = 1),
     reads AS (
       SELECT CASE WHEN ce.type = 'job_card_folding' THEN s.jc ELSE s.ch END * 60 AS manual_s,
              COALESCE(ce.capture_seconds, $2) + COALESCE(ce.review_seconds, 0) AS actual_s
       FROM capture_events ce, s
       WHERE ce.status IN ('confirmed', 'corrected') AND ce.ts >= CURRENT_DATE - ($1::int - 1))
     SELECT (SELECT ch FROM s) AS ch, (SELECT jc FROM s) AS jc, COUNT(*) AS n,
            COALESCE(SUM(manual_s), 0) AS manual_s, COALESCE(SUM(actual_s), 0) AS actual_s,
            COALESCE(SUM(GREATEST(manual_s - actual_s, 0)), 0) AS saved_s
     FROM reads`,
    [days, UNKNOWN_CAPTURE_SECONDS],
  );
  const x = r.rows[0] ?? {};
  const min = (s: unknown) => Math.round((Number(s ?? 0) / 60) * 10) / 10;
  return {
    days,
    captures: Number(x.n ?? 0),
    manualMin: min(x.manual_s),
    actualMin: min(x.actual_s),
    savedMin: min(x.saved_s),
    baseline: { challanMin: Number(x.ch ?? 6), jobCardMin: Number(x.jc ?? 4) },
  };
}
