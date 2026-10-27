'use client';

// Quality catalog (Stock ledger → Quality catalog). New lots typed by hand may only use an active quality from here,
// so "Rayon 60" and "rayon-60" never become two qualities. Owner / supervisor add; the owner renames or switches off.
import React, { useState } from 'react';
import Icon from '../Icon';
import { Pill, fmt } from '../ui';
import type { Ctx } from '../ctx';
import { can } from '@/lib/access';
import { apiSend, useApi } from '@/lib/useApi';

export interface CatalogQuality { id: number; name: string; active: boolean; lots: number; in_stock_lots: number }

/** Active catalog qualities (for pickers). */
export function useQualityCatalog(refreshKey?: unknown) {
  const r = useApi<{ qualities: CatalogQuality[] }>('/api/qualities', refreshKey);
  const all = r.data?.qualities ?? null;
  return { all, active: all ? all.filter((q) => q.active).map((q) => q.name) : null, reload: r.reload };
}

export function QualityCatalog({ ctx }: { ctx: Ctx }) {
  const { d, role } = ctx;
  const [rev, setRev] = useState(0);
  const { all } = useQualityCatalog(`${String(d.stockRev)}:${rev}`);
  const [name, setName] = useState('');
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null);
  const owner = can(role, 'ledger.edit');
  const canAdd = role === 'owner' || role === 'supervisor';
  const typed = name.replace(/\s+/g, ' ').trim();
  const dup = typed && all?.find((q) => q.name.toLowerCase() === typed.toLowerCase());

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); d.showToast(ok); setRev((x) => x + 1); return true; } catch (e) { d.showToast(e instanceof Error ? e.message : 'Could not save.', 'danger'); return false; } finally { setBusy(false); }
  };
  const add = async () => { if (!typed || (dup && dup.active)) return; if (await run(() => apiSend('/api/qualities', 'POST', { name: typed }), `${typed} added to the catalog`)) setName(''); };
  const f = find.trim().toLowerCase();
  const rows = (all ?? []).filter((q) => !f || q.name.toLowerCase().includes(f));

  return (
    <div className="stack-16">
      <p className="small t2">Every new lot must use a quality from this list. Type the first letter in Manual entry and the matching qualities show up. {all ? `${fmt(all.filter((q) => q.active).length)} active qualities.` : ''}</p>
      {canAdd && (
        <div className="qc-row">
          <input className="input" value={name} maxLength={100} placeholder="New quality, e.g. Rayon 60" aria-label="New quality"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
          <button type="button" className="btn primary sm" disabled={busy || !typed || !!(dup && dup.active)} onClick={() => void add()}><Icon name="plus" size={14} strokeWidth={2} />{dup && !dup.active ? 'Switch back on' : 'Add quality'}</button>
          {dup && dup.active && <span className="err small">{dup.name} is already in the catalog.</span>}
        </div>
      )}
      <label className="lf-search"><Icon name="search" size={16} /><input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a quality" aria-label="Find a quality" /></label>
      <section className="card flush">
        <table className="tbl rtbl">
          <thead><tr><th>Quality</th><th className="r">Open lots</th><th className="r">With stock</th><th>Status</th>{owner ? <th className="r">Action</th> : null}</tr></thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id}>
                <td data-label="Quality">{edit?.id === q.id ? (
                  <span className="qc-row">
                    <input className="input" value={edit.name} maxLength={100} aria-label={`Rename ${q.name}`} autoFocus onChange={(e) => setEdit({ id: q.id, name: e.target.value })} />
                    <button type="button" className="btn sm primary" disabled={busy || !edit.name.trim()} onClick={async () => { if (await run(() => apiSend('/api/qualities', 'PATCH', { id: q.id, name: edit.name }), `Renamed to ${edit.name.trim()} (lots too)`)) setEdit(null); }}>Save</button>
                    <button type="button" className="btn sm" onClick={() => setEdit(null)}>Cancel</button>
                  </span>
                ) : <span className="strong">{q.name}</span>}</td>
                <td data-label="Open lots" className="r num">{fmt(q.lots)}</td>
                <td data-label="With stock" className="r num">{fmt(q.in_stock_lots)}</td>
                <td data-label="Status">{q.active ? <Pill tone="good">Active</Pill> : <Pill>Off</Pill>}</td>
                {owner ? (
                  <td data-label="Action" className="r">
                    <span className="qc-row" style={{ justifyContent: 'flex-end' }}>
                      {edit?.id !== q.id && <button type="button" className="btn sm" onClick={() => setEdit({ id: q.id, name: q.name })}>Rename</button>}
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => apiSend('/api/qualities', 'PATCH', { id: q.id, active: !q.active }), q.active ? `${q.name} switched off` : `${q.name} switched on`)}>{q.active ? 'Switch off' : 'Switch on'}</button>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={owner ? 5 : 4} className="muted center">{all == null ? 'Loading…' : f ? 'No quality matches' : 'No qualities yet. Add the first one above.'}</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
