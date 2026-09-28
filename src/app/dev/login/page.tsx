'use client';

import React, { useEffect, useState } from 'react';
import { Logo } from '@/components/Icon';
import { fetchMe, postJson } from '@/lib/authClient';

// Developer sign-in (email + password). Separate from the client login; there is no sign up here.
export default function DevLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe().then((me) => { if (me?.kind === 'developer') window.location.replace('/dev'); }).catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await postJson('/api/auth/dev/login', { email, password });
      window.location.replace('/dev');
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
          <div className="stack-0"><span className="brand-name">Developer console</span><span className="muted tiny">Sign in with your developer account</span></div>
        </div>
        <label className="fld">Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="fld">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="alert bad" role="alert">{error}</div>}
        <button className="btn primary big" type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
