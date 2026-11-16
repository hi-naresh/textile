'use client';
import { useState, type FormEvent } from 'react';
import type { Ctx } from '../ctx';
import { EntryDateInput } from '../EntryDateInput';
import { entryDateValue } from '@/lib/entry-date';
import { apiSend, useApi } from '@/lib/useApi';
import type { DispatchRow, DispatchLine } from '@/lib/dispatch/dispatches';
import { dayTime } from '../ui';

type Detail = { dispatch: DispatchRow; lines: DispatchLine[]; edits: { before_value: { dispatch: DispatchRow; lines: DispatchLine[] }; after_value: { dispatch: DispatchRow; lines: DispatchLine[] }; edited_at: string; edited_by: string }[] };
export function DispatchEdit({ id, ctx, onDone }: { id: number; ctx: Ctx; onDone: () => void }) {
  const { data, error } = useApi<Detail>(`/api/dispatches/${id}`);
  if (error) return <div className="alert bad">{error}</div>;
  return data ? <Editor data={data} ctx={ctx} onDone={onDone} /> : <p>Loading dispatch…</p>;
}
function Editor({ data, ctx, onDone }: { data: Detail; ctx: Ctx; onDone: () => void }) {
  const d = data.dispatch;
  const initial = {
    party: d.party_name ?? '', challan_no: d.challan_no ?? '', transporter: d.transporter ?? '', lr_no: d.lr_no ?? '',
    vehicle_no: d.vehicle_no ?? '', packages: d.packages == null ? '' : String(d.packages),
    date: new Date(d.dispatched_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
  };
  const [form, setForm] = useState(initial);
  const [meters, setMeters] = useState(Object.fromEntries(data.lines.map((l) => [l.movement_id, String(l.meters)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const values = { ...form, date: entryDateValue(form.date) };
      const changes: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof typeof initial]));
      const lines = data.lines.filter((l) => Number(meters[l.movement_id]) !== l.meters).map((l) => ({ movement_id: l.movement_id, meters: meters[l.movement_id] }));
      if (lines.length) changes.lines = lines;
      if (!Object.keys(changes).length) { onDone(); return; }
      const result = await apiSend<{ warnings: string[] }>(`/api/dispatches/${d.id}`, 'PATCH', changes);
      ctx.d.showToast(['Dispatch updated', ...result.warnings].join(' · '), result.warnings.length ? 'warning' : 'success');
      void ctx.d.refreshStock(); onDone();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update dispatch.'); }
    finally { setBusy(false); }
  };
  return <form className="stack-16" onSubmit={submit}>
    {d.invoice_no && <p className="alert warn">Invoice {d.invoice_no} is active. Cancel it before correcting the party, date, challan or meters. Transport details can still be updated.</p>}
    {d.wa && <p className="muted small">Previously sent messages stay unchanged. Download the updated documents after saving; use Send again separately if needed.</p>}
    {(['party', 'challan_no', 'transporter', 'lr_no', 'vehicle_no', 'packages'] as const).map((key) => <label className="fld" key={key}>
      {{ party: 'Party', challan_no: 'Challan no.', transporter: 'Transporter', lr_no: 'LR no.', vehicle_no: 'Vehicle no.', packages: 'Packages' }[key]}
      <input value={form[key]} disabled={busy || !!d.invoice_no && ['party', 'challan_no'].includes(key)} required={key === 'party' || key === 'challan_no'} inputMode={key === 'packages' ? 'numeric' : undefined} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </label>)}
    <label className="fld">Dispatch date<EntryDateInput required value={form.date} disabled={busy || !!d.invoice_no} onChange={(date) => setForm({ ...form, date })} /></label>
    <p className="muted small">Meter corrections update stock, NQTY and order progress. Check the receipts if a correction produces a negative balance.</p>
    {data.lines.map((l) => <label className="fld" key={l.movement_id}>{l.lot_id} · meters<input className="num" inputMode="decimal" required value={meters[l.movement_id]} disabled={busy || !!d.invoice_no} onChange={(e) => setMeters({ ...meters, [l.movement_id]: e.target.value })} /></label>)}
    {error && <p role="alert" className="alert bad">{error}</p>}
    <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save dispatch'}</button>
    {!!data.edits.length && <details><summary>Edit history ({data.edits.length})</summary>{data.edits.map((e, i) => <div className="card pad" key={i}>
      <strong>{e.edited_by} · {dayTime(e.edited_at)}</strong>
      <ul>{historyChanges(e.before_value, e.after_value).map((text) => <li key={text}>{text}</li>)}</ul>
    </div>)}</details>}
  </form>;
}

function historyChanges(before: Pick<Detail, 'dispatch' | 'lines'>, after: Pick<Detail, 'dispatch' | 'lines'>) {
  const labels = { party_name: 'Party', challan_no: 'Challan', transporter: 'Transporter', lr_no: 'LR', vehicle_no: 'Vehicle', packages: 'Packages', dispatched_at: 'Date', order_id: 'Order' } as const;
  const changes: string[] = [];
  for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
    if (before.dispatch[key] !== after.dispatch[key]) changes.push(`${labels[key]}: ${before.dispatch[key] ?? 'empty'} → ${after.dispatch[key] ?? 'empty'}`);
  }
  for (const line of after.lines) {
    const previous = before.lines.find((l) => l.movement_id === line.movement_id);
    if (previous && previous.meters !== line.meters) changes.push(`${line.lot_id}: ${previous.meters} → ${line.meters} m`);
    if (previous && previous.order_id !== line.order_id) changes.push(`${line.lot_id} order: ${previous.order_id ?? 'none'} → ${line.order_id ?? 'none'}`);
  }
  return changes;
}
