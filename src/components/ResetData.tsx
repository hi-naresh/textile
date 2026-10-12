'use client';

// Reset data: My firm → Reset data (owner) and the developer console → Reset (api="/api/dev/reset").
// Pick what to wipe (or Everything) → see exactly how much goes → download a backup → type RESET + password → reset.
import React, { useState } from 'react';
import Icon from './Icon';
import { apiSend, useApi } from '@/lib/useApi';

type Part = 'stock' | 'floor' | 'orders' | 'billing' | 'parties' | 'employees' | 'activity';
interface Info {
  parts: { key: Part; label: string; what: string }[];
  needs: Partial<Record<Part, Part[]>>;
  counts: Record<Part, { label: string; n: number; detail: string }>;
}

const KEPT = 'Always kept: the owner account, firm details & billing, policy, stock alert levels, firm knowledge, markets & shops, sections, and app settings.';

export function ResetData({ api = '/api/reset', developer = false }: { api?: string; developer?: boolean }) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useApi<Info>(api, tick);
  const [picked, setPicked] = useState<Set<Part>>(new Set());
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [backedUp, setBackedUp] = useState(false);

  if (loading && !data) return <section className="card pad"><span className="muted">Loading…</span></section>;
  if (error || !data) return <section className="card pad"><span className="muted">{error ?? 'Could not load.'}</span></section>;

  // Picked parts plus what they need (e.g. Stock → Floor work).
  const included = new Set<Part>();
  const add = (p: Part) => { if (included.has(p)) return; included.add(p); (data.needs[p] ?? []).forEach(add); };
  picked.forEach(add);
  const why = (p: Part) => [...picked].find((x) => x !== p && (data.needs[x] ?? []).includes(p));
  const all = data.parts.every((p) => included.has(p.key));
  const list = data.parts.filter((p) => included.has(p.key));
  const total = list.reduce((s, p) => s + data.counts[p.key].n, 0);
  const ready = list.length > 0 && confirm.trim().toUpperCase() === 'RESET' && password.length > 0 && !busy;
  const keys = list.map((p) => p.key).join(',');

  const toggle = (p: Part) => {
    setMsg(null); setBackedUp(false);
    setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };
  const toggleAll = () => { setMsg(null); setBackedUp(false); setPicked(all ? new Set() : new Set(data.parts.map((p) => p.key))); };

  const run = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await apiSend<{ message: string }>(api, 'POST', { parts: list.map((p) => p.key), confirm, password });
      setMsg({ ok: true, text: developer ? r.message : `${r.message} The app will reload in a moment.` });
      setPicked(new Set()); setConfirm(''); setPassword(''); setBackedUp(false);
      setTick((t) => t + 1);
      if (!developer) setTimeout(() => window.location.reload(), 1800);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Reset failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card pad stack-16 reset-card">
      <div className="stack-4">
        <h2 className="h2">Reset data</h2>
        <span className="muted small">Start fresh: wipe one kind of data, several, or everything. This can’t be undone, so download a backup first.</span>
      </div>

      <div className="reset-list" role="group" aria-label="What to reset">
        <label className={`reset-row all ${all ? 'on' : ''}`}>
          <input type="checkbox" checked={all} onChange={toggleAll} />
          <span className="reset-main"><b>Everything</b><span className="muted small">All of the below.</span></span>
        </label>
        {data.parts.map((p) => {
          const c = data.counts[p.key];
          const auto = !picked.has(p.key) && included.has(p.key);
          const by = auto ? why(p.key) : undefined;
          return (
            <label key={p.key} className={`reset-row ${included.has(p.key) ? 'on' : ''}`}>
              <input type="checkbox" checked={included.has(p.key)} disabled={auto} onChange={() => toggle(p.key)} />
              <span className="reset-main">
                <b>{p.label}</b>
                <span className="muted small">{p.what}</span>
                {by && <span className="small reset-auto">Included because {data.parts.find((x) => x.key === by)?.label} needs it.</span>}
              </span>
              <span className={`reset-count small ${c.n ? '' : 'muted'}`}>{c.n ? c.detail : 'Nothing to remove'}</span>
            </label>
          );
        })}
      </div>
      <span className="muted small">{KEPT}</span>

      {list.length > 0 && (
        <div className="reset-confirm stack-12">
          <div className="callout bad">
            <div className="callout-title"><Icon name="alert" size={16} /> {total ? `${total.toLocaleString('en-IN')} records will be removed` : 'Nothing to remove right now'}</div>
            <div className="small">{list.map((p) => `${p.label}: ${data.counts[p.key].detail}`).join(' · ')}</div>
          </div>
          <div className="row-8 wrap">
            <a className="btn" href={`${api}?backup=${encodeURIComponent(keys)}`} download onClick={() => setBackedUp(true)}>
              <Icon name="download" size={16} /> Download backup
            </a>
            {backedUp && <span className="muted small">Backup download started. Keep the file safe.</span>}
          </div>
          <div className="two-col">
            <label className="fld">Type RESET to confirm
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} placeholder="RESET" />
            </label>
            <label className="fld">{developer ? 'Developer password' : 'Your password'}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
          </div>
          <div className="row-8">
            <button className="btn reset-go" disabled={!ready} onClick={run}>
              <Icon name="trash" size={16} /> {busy ? 'Resetting…' : all ? 'Reset everything' : `Reset ${list.map((p) => p.label).join(', ')}`}
            </button>
          </div>
        </div>
      )}
      {msg && <div className={`callout ${msg.ok ? '' : 'bad'}`} role="status"><div className="small">{msg.text}</div></div>}
    </section>
  );
}
