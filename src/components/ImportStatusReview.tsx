'use client';

import { useMemo, useState } from 'react';
import type { RegOutRow } from '@/lib/register-import';
import { reviewStatuses, type ImportStatus, type StatusChoices } from '@/lib/import-status-review';
import { ENTRY_STATUS_LABEL } from '@/lib/registers';

export function ImportStatusReview({ rows, choices, onChange }: {
  rows: RegOutRow[]; choices: StatusChoices; onChange: (choices: StatusChoices) => void;
}) {
  const [page, setPage] = useState(0);
  const lots = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof reviewStatuses>>();
    for (const r of reviewStatuses(rows, choices)) {
      if (!grouped.has(r.lot_id)) grouped.set(r.lot_id, []);
      grouped.get(r.lot_id)!.push(r);
    }
    return [...grouped.entries()];
  }, [rows, choices]);
  const unresolved = lots.filter(([, entries]) => entries.some((r) => !r.status)).length;
  const setAll = (status: string) => {
    if (status !== 'running' && status !== 'end') return;
    onChange(Object.fromEntries(lots.filter(([, entries]) => entries.some((r) => r.needsChoice)).map(([lot]) => [lot, status])));
  };
  return <section className="imp-box stack-8" aria-label="Review lot statuses">
    <h3>Review lot statuses</h3>
    <p>Check every affected lot before importing. Blank, A and unknown codes require your choice; the original LOT S code is kept.</p>
    <p className="small">Running: sales have started and the lot stays open. End: the final sale closes the lot and adjusts its remaining balance to zero. Earlier End rows become Running when more sales follow in this file, as shown below.</p>
    <label className="fld">Set all uncertain statuses
      <select value="" onChange={(e) => setAll(e.target.value)}>
        <option value="">Choose for all…</option><option value="running">Running</option><option value="end">End</option>
      </select>
    </label>
    <p role="status">{unresolved ? `${unresolved} lot(s) still need a choice.` : 'All statuses are set. Confirm below to import.'}</p>
    <div className="table-scroll"><table className="rtbl">
      <thead><tr><th>Lot</th><th>Excel row · LOT S → status to save</th><th>Uncertain rows</th></tr></thead>
      <tbody>{lots.slice(page * 50, (page + 1) * 50).map(([lot, entries]) => <tr key={lot}>
        <td data-label="Lot">{lot}</td>
        <td data-label="Rows"><div>{entries.map((r) => <div key={r.row}>Row {r.row} · {r.code || '(blank)'} → {r.status ? ENTRY_STATUS_LABEL[r.status] : 'Choose a status'}{r.deferredEnd ? ' (more sales follow)' : ''}</div>)}</div></td>
        <td data-label="Choice">{entries.some((r) => r.needsChoice) ? <select aria-label={`Status for lot ${lot}`} value={choices[lot] ?? ''} onChange={(e) => {
          const next = { ...choices };
          if (e.target.value) next[lot] = e.target.value as ImportStatus;
          else delete next[lot];
          onChange(next);
        }}><option value="">Choose…</option><option value="running">Running</option><option value="end">End</option></select> : 'From LOT S'}</td>
      </tr>)}</tbody>
    </table></div>
    {lots.length > 50 && <div className="imp-actions">
      <button type="button" className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous lots</button>
      <span>Page {page + 1} of {Math.ceil(lots.length / 50)}</span>
      <button type="button" className="btn sm" disabled={(page + 1) * 50 >= lots.length} onClick={() => setPage(page + 1)}>Next lots</button>
    </div>}
  </section>;
}
