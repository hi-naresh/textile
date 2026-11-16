'use client';
import { useState, type FormEvent } from 'react';
import { apiSend, useApi } from '@/lib/useApi';
import type { Ctx } from '../ctx';
type Series = { prefix: string; name: string; active: boolean };
export function SrSeries({ ctx }: { ctx: Ctx }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<{ series: Series[] }>('/api/stock/series', tick);
  const [editing, setEditing] = useState<Series | null>(null);
  const [prefix, setPrefix] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const save = async (row: Series) => {
    setBusy(true);
    try { await apiSend('/api/stock/series', 'POST', row); setTick((x) => x + 1); ctx.d.showToast('SR series saved'); return true; }
    catch (e) { ctx.d.showToast((e as Error).message, 'danger'); return false; }
    finally { setBusy(false); }
  };
  const submit = async (e: FormEvent) => { e.preventDefault(); if (await save({ prefix, name, active: editing?.active ?? true })) { setPrefix(''); setName(''); setEditing(null); } };
  return <section className="card pad stack-16"><h2>SR series</h2>
    <p className="muted">Each prefix has separate incoming and outgoing numbers. Pick the series on each entry. Existing numbers stay in Main; changing a location does not renumber entries.</p>
    {error && <p role="alert">{error}</p>}
    {data?.series.map((r) => <div key={r.prefix} className="toolbar"><strong>{r.prefix || 'Main'} · {r.name}</strong><span>{r.active ? 'Active' : 'Inactive'}</span>{r.prefix && <button className="btn sm" disabled={busy} onClick={() => save({ ...r, active: !r.active })}>{r.active ? 'Deactivate' : 'Activate'}</button>}<button className="btn sm" onClick={() => { setPrefix(r.prefix); setName(r.name); setEditing(r); }}>Edit name</button></div>)}
    <form className="stack-16" onSubmit={submit}><label className="fld">Prefix<input value={prefix} readOnly={editing !== null} maxLength={10} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="RS (blank for Main)" /></label><label className="fld">Godown name<input value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save series'}</button>{editing && <button type="button" className="btn" onClick={() => { setEditing(null); setPrefix(''); setName(''); }}>Cancel edit</button>}</form>
  </section>;
}
