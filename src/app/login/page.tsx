'use client';

import React, { useEffect, useState } from 'react';
import { Logo } from '@/components/Icon';
import { Segmented } from '@/components/ui';
import { fetchMe, postJson } from '@/lib/authClient';

type Mode = 'signin' | 'signup';

// Owner, supervisors and workers sign in with their phone number + password.
// Supervisors and workers can sign up; the owner approves them and gives the role.
export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wants, setWants] = useState<'worker' | 'supervisor'>('worker');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in on this device → straight into the app.
  useEffect(() => {
    fetchMe().then((me) => { if (me) window.location.replace(me.kind === 'developer' ? '/dev' : '/'); }).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'signup' && password !== confirm) { setError('The two passwords are not the same.'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') await postJson('/api/auth/login', { phone, password });
      else await postJson('/api/auth/signup', { name, phone, password, requested_role: wants });
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong, try again.');
      setBusy(false);
    }
  };

  return (
    <main className="auth-wrap">
      <form className="card pad stack-16 auth-card" onSubmit={submit} noValidate>
        <div className="auth-brand">
          <Logo size={36} />
          <div className="stack-0"><span className="brand-name">{mode === 'signin' ? 'Sign in' : 'Sign up'}</span><span className="muted tiny">Owner, supervisors and workers</span></div>
        </div>
        <Segmented label="Sign in or sign up" value={mode} onChange={(m) => { setMode(m); setError(null); }} className="fit"
          options={[{ value: 'signin', label: 'Sign in' }, { value: 'signup', label: 'New here? Sign up' }]} />

        {mode === 'signup' && (
          <label className="fld">Your name<input value={name} autoComplete="name" maxLength={100} onChange={(e) => setName(e.target.value)} required /></label>
        )}
        <label className="fld">Phone number
          <input type="tel" inputMode="numeric" autoComplete="tel" placeholder="98250 12345" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </label>
        <label className="fld">Password
          <input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
          {mode === 'signup' && <span className="muted small">At least 8 characters.</span>}
        </label>
        {mode === 'signup' && (
          <>
            <label className="fld">Password again<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
            <div className="fld">I work as
              <Segmented label="I work as" value={wants} onChange={setWants} className="fit" options={[{ value: 'worker', label: 'Worker' }, { value: 'supervisor', label: 'Supervisor' }]} />
              <span className="muted small">The owner checks this and approves your account.</span>
            </div>
          </>
        )}

        {error && <div className="alert bad" role="alert">{error}</div>}
        <button className="btn primary big" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
        </button>
        {mode === 'signin' && <span className="muted small auth-foot">Forgot your password? Ask the owner to reset it.</span>}
      </form>
    </main>
  );
}
