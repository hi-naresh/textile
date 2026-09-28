'use client';

import React, { useState } from 'react';
import Icon, { Logo } from '../Icon';
import { Pill } from '../ui';
import { logout, postJson, type Me } from '@/lib/authClient';
import { formatPhone } from '@/lib/auth/phone';

const ROLE_TITLE: Record<string, string> = { owner: 'Owner', supervisor: 'Supervisor', worker: 'Worker', developer: 'Developer' };

/** Change password form. `forced`: first sign-in with the starting password. */
export function ChangePassword({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) { setMsg({ tone: 'bad', text: 'The two new passwords are not the same.' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      await postJson('/api/auth/password', { current, next });
      setCurrent(''); setNext(''); setAgain('');
      setMsg({ tone: 'good', text: 'Password changed. Other devices were signed out.' });
      onDone?.();
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Something went wrong, try again.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-14" onSubmit={submit}>
      <label className="fld">{forced ? 'Starting password' : 'Current password'}<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label className="fld">New password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <span className="muted small">At least 8 characters.</span></label>
      <label className="fld">New password again<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
      {msg && <div className={`alert ${msg.tone === 'bad' ? 'bad' : ''}`} role="status">{msg.text}</div>}
      <div className="row-8"><button className="btn primary" type="submit" disabled={busy || !current || !next || !again}>{busy ? 'Saving…' : 'Change password'}</button></div>
    </form>
  );
}

function Centered({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <main className="auth-wrap">
      <section className="card pad stack-16 auth-card">
        <div className="auth-brand"><Logo size={36} /><div className="stack-0"><span className="brand-name">{title}</span><span className="muted tiny">{sub}</span></div></div>
        {children}
      </section>
    </main>
  );
}

/** Pending sign up: no data, nothing to do but wait (or sign out). */
export function PendingScreen({ me, onCheck }: { me: Me; onCheck: () => void }) {
  return (
    <Centered title="Waiting for approval" sub={`${me.user.name} · ${formatPhone(me.user.phone)}`}>
      <p className="t2" style={{ margin: 0, lineHeight: 1.5 }}>Your sign up has reached the owner. You can use the app once they approve it and choose your role.</p>
      <div className="row-8">
        <button className="btn primary grow" onClick={onCheck}><Icon name="refresh" size={16} />Check again</button>
        <button className="btn grow" onClick={() => logout()}>Sign out</button>
      </div>
    </Centered>
  );
}

/** First sign-in with the starting password: must choose a new one before anything else. */
export function ForcePasswordScreen({ me, onDone }: { me: Me; onDone: () => void }) {
  return (
    <Centered title="Choose your password" sub={`${me.user.name} · ${formatPhone(me.user.phone)}`}>
      <p className="t2" style={{ margin: 0, lineHeight: 1.5 }}>You signed in with the starting password. Choose your own password to continue.</p>
      <ChangePassword forced onDone={onDone} />
      <button className="btn" onClick={() => logout()}>Sign out</button>
    </Centered>
  );
}

/** Settings → Account: who is signed in, change password, sign out. */
export function AccountCard({ me }: { me: Me }) {
  const u = me.user;
  const [open, setOpen] = useState(false);
  return (
    <section className="card pad stack-16">
      <h2 className="h2">Account</h2>
      <div className="list">
        <div className="list-row">
          <div className="stack-2 grow min0"><span className="strong">{u.name}</span><span className="muted small">{u.phone ? formatPhone(u.phone) : u.email}</span></div>
          {u.role && <Pill tone="info">{ROLE_TITLE[u.role]}</Pill>}
        </div>
      </div>
      {open ? <ChangePassword /> : null}
      <div className="row-8" style={{ flexWrap: 'wrap' }}>
        {!open && <button className="btn" onClick={() => setOpen(true)}>Change password</button>}
        <button className="btn danger" onClick={() => logout()}>Sign out</button>
      </div>
    </section>
  );
}
