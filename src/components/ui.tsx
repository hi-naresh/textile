'use client';

import React, { useEffect } from 'react';
import Icon from './Icon';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

export const fmt = (n: number | null | undefined, digits = 0) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

export const fmtM = (n: number | null | undefined) => (n == null ? '—' : `${fmt(n, 1)} m`);

export const inr = (n: number) => {
  if (n >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`;
  return `₹ ${fmt(n)}`;
};

export const effTone = (e: number): Tone => (e >= 85 ? 'good' : e >= 75 ? 'warn' : 'bad');

export const time = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

export const dayTime = (ts: string) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? time(ts) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' + time(ts);
};

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();

export function Pill({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={`pill ${tone} ${className}`}>{children}</span>;
}

export function LockTag({ label = 'Owner only' }: { label?: string }) {
  return (
    <span className="lock">
      <Icon name="lock" size={12} strokeWidth={2} />
      {label}
    </span>
  );
}

export function Track({ pct, tone = 'info', height }: { pct: number; tone?: Tone; height?: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="track" style={height ? { height } : undefined}>
      <div className={`bar ${tone}`} style={{ width: `${w}%`, height: height ?? undefined }} />
    </div>
  );
}

export function Kpi({ label, value, sub, subTone, lock, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; subTone?: Tone; lock?: boolean; children?: React.ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        {lock && <LockTag />}
      </div>
      <span className="kpi-value num">{value}</span>
      {sub && <span className={`kpi-sub ${subTone ?? ''}`}>{sub}</span>}
      {children}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

export function Empty({ title, text, children }: { title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="card empty">
      <span className="empty-icon"><Icon name="check" size={24} strokeWidth={2} /></span>
      <h2>{title}</h2>
      {text && <span>{text}</span>}
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`segbar ${className}`}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`seg ${value === o.value ? 'on' : ''}`} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Right-side drawer on desktop, bottom sheet on phones. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
