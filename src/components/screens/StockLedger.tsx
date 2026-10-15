'use client';

// Filters for the stock ledger (Stock screen → Movements). Rows come from the server (src/lib/useLedger.ts).
import React from 'react';
import Icon from '../Icon';
import { Segmented } from '../ui';
import { EMPTY_FILTERS, filtersActive, type LedgerFacets, type LedgerFilterState } from '@/lib/useLedger';
import { useLotSearch } from '@/lib/useLots';
import { ENTRY_STATUSES, ENTRY_STATUS_LABEL, type EntryStatus } from '@/lib/registers';

export function LedgerFilterBar({ value, onChange, facets }: {
  value: LedgerFilterState;
  onChange: (f: LedgerFilterState) => void;
  facets: LedgerFacets | null;
}) {
  const set = <K extends keyof LedgerFilterState>(k: K, v: LedgerFilterState[K]) => onChange({ ...value, [k]: v });
  const designs = value.quality && facets?.byQuality[value.quality] ? facets.byQuality[value.quality] : facets?.designs ?? [];
  const active = filtersActive(value);
  // Lot suggestions come from the server as you type (only once something is typed).
  const lotSearch = useLotSearch(value.lot, { limit: 30, enabled: value.lot.trim() !== '' });
  const lotOptions = value.lot.trim() ? (lotSearch.lots ?? []).map((l) => l.lot_id) : [];
  const [open, setOpen] = React.useState(false); // phone: quality / design / lot / dates fold away
  const extra = [value.status, value.quality, value.design, value.lot, value.party, value.from, value.to].filter(Boolean).length;

  return (
    <div className={`lf ${open ? 'open' : ''}`} role="search" aria-label="Filter the ledger">
      <label className="lf-search">
        <Icon name="search" size={16} />
        <input type="search" value={value.q} onChange={(e) => set('q', e.target.value)} placeholder="Search lot, quality, design, party, mill, challan, SR…" aria-label="Search the ledger" />
      </label>
      <div className="lf-row">
        <Segmented label="Direction" value={value.direction || 'ALL'} onChange={(v) => onChange({ ...value, direction: v === 'ALL' ? '' : v, status: v === 'IN' ? '' : value.status })}
          options={[{ value: 'ALL', label: 'All' }, { value: 'IN', label: 'Inward' }, { value: 'OUT', label: 'Outward' }]} />
        <button type="button" className="btn sm lf-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="filter" size={14} />{open ? 'Fewer filters' : `More filters${extra ? ` (${extra})` : ''}`}
        </button>
        {/* Only outgoing entries have a status: picking one shows outward rows only. */}
        <select className="input sel lf-x" aria-label="Status of outgoing entries" value={value.status}
          onChange={(e) => { const st = e.target.value as '' | EntryStatus; onChange({ ...value, status: st, direction: st && value.direction === 'IN' ? '' : value.direction }); }}>
          <option value="">All statuses</option>
          {ENTRY_STATUSES.map((x) => <option key={x} value={x}>{ENTRY_STATUS_LABEL[x]}</option>)}
        </select>
        <select className="input sel lf-x" aria-label="Quality" value={value.quality} onChange={(e) => onChange({ ...value, quality: e.target.value, design: '' })}>
          <option value="">All qualities</option>
          {facets?.qualities.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
        <select className="input sel lf-x" aria-label="Design" value={value.design} onChange={(e) => set('design', e.target.value)}>
          <option value="">All designs</option>
          {designs.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <input className="input lf-lot lf-x num" list="lf-lots" aria-label="Lot" placeholder="Lot" value={value.lot} onChange={(e) => set('lot', e.target.value)} autoComplete="off" />
        <datalist id="lf-lots">{lotOptions.map((l) => <option key={l} value={l} />)}</datalist>
        <label className="lf-date lf-x"><span>From</span><input className="input" type="date" value={value.from} max={value.to || undefined} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="lf-date lf-x"><span>To</span><input className="input" type="date" value={value.to} min={value.from || undefined} onChange={(e) => set('to', e.target.value)} /></label>
        {value.party && <button type="button" className="btn sm lf-x" onClick={() => set('party', '')} aria-label={`Remove party filter ${value.party}`}>Party: {value.party}<Icon name="x" size={14} /></button>}
        {active && <button type="button" className="btn sm lf-clear" onClick={() => onChange(EMPTY_FILTERS)}><Icon name="x" size={14} />Clear all</button>}
      </div>
    </div>
  );
}
