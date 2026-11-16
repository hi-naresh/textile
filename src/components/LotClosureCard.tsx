'use client';

import React, { useState } from 'react';
import type { Lot } from '@/lib/types';
import { apiSend } from '@/lib/useApi';
import { dayTime, fmt } from './ui';

export function LotClosureCard({ lot, canReopen, onReopened, onError }: {
  lot: Lot; canReopen: boolean; onReopened: () => void | Promise<void>; onError: (message: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  if (!lot.closed_at) return null;
  const reopen = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiSend('/api/lots/close', 'POST', { lot_id: lot.lot_id, action: 'reopen', note: note.trim() || null });
      setConfirm(false);
      await onReopened();
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not reopen the lot.'); }
    finally { setBusy(false); }
  };
  const how: Record<string, string> = { manual: 'Closed by hand', end_entry: 'End entry', register: 'Sales register' };
  const adjustment = lot.adjustment_m ?? 0;
  return <section className="card pad stack-8" aria-label="Lot closure">
    <strong>Closed lot</strong>
    <span>{dayTime(lot.closed_at)}{lot.closed_by_name ? ` · by ${lot.closed_by_name}` : ''}</span>
    <span>{how[lot.close_reason ?? ''] ?? 'Closed'}{lot.close_note ? ` · ${lot.close_note}` : ''}</span>
    <span>{fmt(Math.abs(adjustment), 2)} m {adjustment < 0 ? 'written back' : 'written off'}</span>
    {canReopen && (confirm ? <div className="stack-8">
      <p>The closing adjustment will be removed and the End sale will return to its previous status.</p>
      <label className="fld">Note (optional)<input value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="row-8"><button type="button" className="btn primary" disabled={busy} onClick={reopen}>Confirm reopen</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div>
    </div> : <button type="button" className="btn primary" onClick={() => setConfirm(true)}>Reopen</button>)}
  </section>;
}
