'use client';

import { useState } from 'react';
import type { Ctx } from '../ctx';
import { PageHead, fmt } from '../ui';
import { EMPTY_LOT_FILTERS, useLots } from '@/lib/useLots';
import { useDebounced } from '@/lib/useLedger';

/** Supervisors look up available goods; totals and stock mutations are owner-only. */
export function SupervisorStock({ ctx }: { ctx: Ctx }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const lots = useLots({ ...EMPTY_LOT_FILTERS, q }, ctx.d.stockRev);
  return (
    <div className="page fade">
      <PageHead title="Available stock" sub="Find a lot, its available meters and where it is kept." />
      <div className="toolbar">
        <label className="fld grow">Search stock
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Quality, lot or location" />
        </label>
      </div>
      {lots.error && <p role="alert" className="danger">{lots.error}</p>}
      <section className="card flush" aria-busy={lots.loading}>
        <table className="tbl rtbl">
          <thead><tr><th>Lot</th><th>Quality</th><th>Design</th><th className="r">Available meters</th><th>Location</th></tr></thead>
          <tbody>
            {lots.rows.map((lot) => <tr key={lot.lot_id}>
              <td data-label="Lot">{lot.lot_id}</td>
              <td data-label="Quality">{lot.quality}</td>
              <td data-label="Design">{lot.design || '—'}</td>
              <td data-label="Available meters" className="r num">{fmt(lot.balance, 2)}</td>
              <td data-label="Location">{lot.location || 'No location recorded'}</td>
            </tr>)}
            {!lots.rows.length && <tr><td colSpan={5} className="muted center">{lots.loading ? 'Loading stock…' : 'No matching stock.'}</td></tr>}
          </tbody>
        </table>
      </section>
      {lots.hasMore && <button className="btn" disabled={lots.loadingMore || lots.loading} onClick={lots.loadMore}>{lots.loadingMore ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}
