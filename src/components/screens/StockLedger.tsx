'use client';

// Filters for the stock ledger (Stock screen → Movements). Rows come from the server (src/lib/useLedger.ts).
import React from 'react';
import Icon from '../Icon';
import { Segmented } from '../ui';
import { EMPTY_FILTERS, filtersActive, type LedgerFacets, type LedgerFilterState } from '@/lib/useLedger';
import { useLotSearch } from '@/lib/useLots';
import { ENTRY_STATUSES, ENTRY_STATUS_LABEL, type EntryStatus } from '@/lib/registers';
import { markets as allMarkets } from '@/lib/access';
import { fmtExact } from '../ui';

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
  const extra = [value.status, value.quality, value.design, value.lot, value.party, value.from, value.to, value.market].filter(Boolean).length;

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
        <LocationFilter market={value.market} shop={value.shop} onChange={(market, shop) => onChange({ ...value, market, shop })} className="lf-x" />
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

/** Where the lot is now: a market (and optionally a shop no.), Floor, Dispatched or not recorded. */
export function LocationFilter({ market, shop, onChange, className = '' }: { market: string; shop: string; onChange: (market: string, shop: string) => void; className?: string }) {
  const list = allMarkets();
  const m = list.find((x) => x.code === market);
  const shops = (m?.shops ?? []).filter((x) => x.active);
  return (
    <>
      <select className={`input sel ${className}`} aria-label="Location" value={market} onChange={(e) => onChange(e.target.value, '')}>
        <option value="">All locations</option>
        {list.map((x) => <option key={x.id} value={x.code}>{x.code} · {x.name}{x.active ? '' : ' (off)'}</option>)}
        <option value="@floor">Floor (job cards)</option>
        <option value="@dispatched">Dispatched</option>
        <option value="@none">Not recorded</option>
      </select>
      {m && (
        <>
          <input className={`input lf-lot num ${className}`} list="lf-shops" aria-label={`Shop no. in ${m.name}`} placeholder="All shops" value={shop}
            onChange={(e) => onChange(market, e.target.value.toUpperCase())} autoComplete="off" maxLength={10} />
          <datalist id="lf-shops">{shops.map((x) => <option key={x.id} value={x.shop_no} />)}</datalist>
        </>
      )}
    </>
  );
}

// ---------- stock components (summary cards) ----------
export interface LedgerSummary {
  entries: number; lots: number; qualities: number;
  in_count: number; in_m: number; in_pieces: number; grey_m: number; finished_m: number; shortage_m: number; shortage_pct: number | null;
  out_count: number; out_m: number; out_pieces: number; adjust_m: number; net_m: number; on_hand_m: number;
}
export interface LotsSummary { lots: number; in_stock_lots: number; on_hand_m: number; in_m: number; out_m: number; qualities: number; packed_lots: number; running_lots: number; final_m: number }

/** Totals for exactly what the filters match (GET `url`?params); reloads with the filters and on stock changes. */
export function useSummary<T>(url: string, params: string, refreshKey: unknown, enabled = true) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect -- request start
    fetch(`${url}${params ? `?${params}` : ''}`, { cache: 'no-store', signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => { if (x) setData(x.summary ?? null); })
      .catch(() => {})
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [url, params, refreshKey, enabled]);
  return { data, loading };
}

const m = (v: number) => `${fmtExact(v)} m`;
function Comp({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className="card kpi sc-card">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num sc-value">{value}</span>
      {sub != null && <span className={`kpi-sub ${tone ?? ''}`}>{sub}</span>}
    </div>
  );
}

/** Movements view: received, grey → finished shortage, dispatched, net and on hand — for the filtered rows. */
export function LedgerSummaryCards({ s, filtered, loading }: { s: LedgerSummary | null; filtered: boolean; loading: boolean }) {
  return (
    <section className={`sc ${loading ? 'lf-stale' : ''}`} aria-label={filtered ? 'Totals for the filtered entries' : 'Totals for all entries'}>
      <div className="sc-head small t2">{filtered ? 'Totals for the filtered entries' : 'Totals for all entries'}</div>
      <div className="sc-grid">
        <Comp label="Stock on hand (these lots)" value={s ? m(s.on_hand_m) : '—'} sub={s ? `${fmtExact(s.lots, 0)} lots · ${fmtExact(s.qualities, 0)} qualities` : ' '} />
        <Comp label="Received (inward)" value={s ? m(s.in_m) : '—'} sub={s ? `${fmtExact(s.in_count, 0)} entries · ${fmtExact(s.in_pieces, 0)} taka` : ' '} />
        <Comp label="Grey → Finished" value={s ? <>{fmtExact(s.grey_m)} → {fmtExact(s.finished_m)}</> : '—'}
          sub={s ? <span className="strong">Shortage {m(s.shortage_m)}{s.shortage_pct != null ? ` (${s.shortage_pct.toFixed(2)}%)` : ''}</span> : ' '} tone={s && s.shortage_m > 0 ? 'warn' : undefined} />
        <Comp label="Dispatched (outward)" value={s ? m(s.out_m) : '—'} sub={s ? `${fmtExact(s.out_count, 0)} entries · ${fmtExact(s.out_pieces, 0)} taka` : ' '} />
        <Comp label="Net (in − out)" value={s ? m(s.net_m) : '—'} sub={s ? (Math.abs(s.adjust_m) >= 0.01 ? `incl. adjustments ${m(-s.adjust_m)}` : `${fmtExact(s.entries, 0)} entries in all`) : ' '} />
      </div>
    </section>
  );
}

/** Lots & balance view. */
export function LotsSummaryCards({ s, filtered, loading }: { s: LotsSummary | null; filtered: boolean; loading: boolean }) {
  return (
    <section className={`sc ${loading ? 'lf-stale' : ''}`} aria-label={filtered ? 'Totals for the filtered lots' : 'Totals for all lots'}>
      <div className="sc-head small t2">{filtered ? 'Totals for the filtered lots' : 'Totals for all lots'}</div>
      <div className="sc-grid">
        <Comp label="Stock on hand" value={s ? m(s.on_hand_m) : '—'} sub={s ? `${fmtExact(s.in_stock_lots, 0)} lots with stock` : ' '} />
        <Comp label="Lots" value={s ? fmtExact(s.lots, 0) : '—'} sub={s ? `${fmtExact(s.packed_lots, 0)} packed · ${fmtExact(s.running_lots, 0)} running` : ' '} />
        <Comp label="Received (all time)" value={s ? m(s.in_m) : '—'} sub={s ? `${fmtExact(s.qualities, 0)} qualities` : ' '} />
        <Comp label="Dispatched (all time)" value={s ? m(s.out_m) : '—'} sub=" " />
      </div>
    </section>
  );
}
