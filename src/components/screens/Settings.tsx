'use client';

// Settings: general things about you and this device. Everything about the firm (details, parties, places,
// policy = rules / stock alerts / firm knowledge, team) lives in My firm (owner).
// Owner: account, preferences, connections. Supervisor / worker: account + preferences.
import React from 'react';
import Icon from '../Icon';
import { PageHead, Pill, Segmented } from '../ui';
import type { Ctx } from '../ctx';
import { useApi } from '@/lib/useApi';
import { AccountCard } from './Account';

/** Theme + language (every role) and screen density (owner), stored on this device. */
function Preferences({ ctx }: { ctx: Ctx }) {
  return (
    <section className="card pad stack-16">
      <h2 className="h2">Preferences</h2>
      {ctx.role === 'owner' && (
        <div className="fld">Screen density
          <Segmented label="Screen density" value={ctx.density} onChange={ctx.setDensity} className="fit" options={[{ value: 'compact', label: 'Compact' }, { value: 'detailed', label: 'Detailed' }]} />
          <span className="muted small">Compact shows shorter lists and hides extra detail columns.</span>
        </div>
      )}
      <div className="fld">Theme
        <Segmented label="Theme" value={ctx.theme} onChange={ctx.setTheme} className="fit" options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />
      </div>
      <div className="fld">Language
        <Segmented label="Language" value={ctx.lang} onChange={ctx.setLang} className="fit" options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }, { value: 'gu', label: 'ગુજરાતી' }]} />
        <span className="muted small">Used for the capture screen and voice questions.</span>
      </div>
    </section>
  );
}

export function Settings({ ctx }: { ctx: Ctx }) {
  if (ctx.role !== 'owner') {
    return (
      <div className="page fade settings">
        <PageHead title="Settings" />
        <div className="settings-grid">{ctx.session.kind === 'client' && <AccountCard me={ctx.session} />}<Preferences ctx={ctx} /></div>
      </div>
    );
  }
  return <OwnerSettings ctx={ctx} />;
}

function OwnerSettings({ ctx }: { ctx: Ctx }) {
  return (
    <div className="page fade settings">
      <PageHead title="Settings" sub="Your account and this device. Rules, stock alerts and firm knowledge are in My firm → Policy.">
        <button className="btn" onClick={() => ctx.go('firm')}><Icon name="factory" size={16} strokeWidth={2} />My firm</button>
      </PageHead>
      <div className="settings-grid">
        {ctx.session.kind === 'client' && <AccountCard me={ctx.session} />}
        <Preferences ctx={ctx} />
        <Connections ctx={ctx} />
      </div>
    </div>
  );
}

/** Which features work right now (yes/no only; details are in the developer console). */
function Connections({ ctx }: { ctx: Ctx }) {
  const { data, error } = useApi<{ photoReading: boolean; aiWriting: boolean }>('/api/status', ctx.d.lastSync);
  const row = (label: string, ok: boolean | undefined, off: string) => (
    <div className="list-row">
      <span className="grow small">{label}</span>
      {ok == null ? <span className="muted small">Checking…</span> : <Pill tone={ok ? 'good' : 'warn'}>{ok ? 'Working' : off}</Pill>}
    </div>
  );
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Connections</h2><span className="muted small">If something is not working, tell your developer.</span></div>
      {error ? <span className="muted small">{error}</span> : (
        <div className="list">
          {row('Reading photos (challans, job cards)', data?.photoReading, 'Not working')}
          {row('AI help in chat and inquiries', data?.aiWriting, 'Off')}
        </div>
      )}
    </section>
  );
}
