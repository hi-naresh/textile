'use client';

// "Final meters" asked when a lot ends (End entry, Close lot): what the lot really gave after folding / packing.
// Same as dispatched → leave it. Different (e.g. 4,850 or 4,750 against 4,800 finished) → type it; the shortage
// grey → final is worked out and saved on the lot (lots.final_meters, migration 017) for costing.
import React from 'react';
import { fmt } from './ui';
import { useApi } from '@/lib/useApi';

interface Shortage { grey_m: number | null; finished_m: number; dispatched_m: number; final_meters: number; saved: boolean }

/** `extraOut`: meters of the entry being saved (not in the ledger yet). `value` '' = same as dispatched. */
export function FinalMetersField({ lotId, extraOut = 0, value, onChange }: { lotId: string; extraOut?: number; value: string; onChange: (v: string) => void }) {
  const r = useApi<Shortage>(lotId ? `/api/lots/shortage?lot_id=${encodeURIComponent(lotId)}` : null);
  const s = r.data;
  const dispatched = s ? Math.round((s.dispatched_m + (Number.isFinite(extraOut) ? extraOut : 0)) * 100) / 100 : null;
  const typed = parseFloat(value);
  const finalM = Number.isFinite(typed) ? typed : dispatched;
  const short = s?.grey_m != null && finalM != null ? Math.round((s.grey_m - finalM) * 100) / 100 : null;
  const bad = value.trim() !== '' && (!Number.isFinite(typed) || typed < 0);
  return (
    <div className="fld">
      <label htmlFor={`fm-${lotId}`}>Final meters (after folding / packing)</label>
      <input id={`fm-${lotId}`} className="num" inputMode="decimal" value={value} aria-invalid={bad} onChange={(e) => onChange(e.target.value)}
        placeholder={dispatched != null ? `${dispatched} (same as dispatched)` : 'same as dispatched'} />
      {s && (
        <span className="muted small hint">
          Grey {s.grey_m != null ? `${fmt(s.grey_m, 2)} m` : 'not recorded'} · finished {fmt(s.finished_m, 2)} m · dispatched {fmt(dispatched ?? 0, 2)} m. Same? Leave it empty.
        </span>
      )}
      {short != null && (
        <span className={`sf-shortage ${short > 0 ? 'warn' : ''}`}>
          Final shortage: {fmt(short, 2)} m{s?.grey_m ? ` (${((short / s.grey_m) * 100).toFixed(2)}%)` : ''}
        </span>
      )}
      {bad && <span className="err small">A number, 0 or more.</span>}
    </div>
  );
}
