'use client';

// Developer console → WhatsApp (Meta WhatsApp Cloud API, direct). Connection check against the Graph API, which env
// vars are set (names only), the webhook URL to paste in Meta, the three templates with copy buttons, template
// names / language, the message log (filters, errors) and counts by day, plus a short setup guide.
// Data: GET / PUT / POST /api/dev/whatsapp.
import React, { useState } from 'react';
import Icon from '@/components/Icon';
import { Pill, Segmented, dayTime } from '@/components/ui';
import { apiSend, useApi } from '@/lib/useApi';
import { TEMPLATES, TEMPLATE_LANGS, HELLO_WORLD, fillTemplate, type TemplateKey } from '@/lib/whatsapp/templates';
import { WA_STATUS_LABEL, WA_STATUS_TONE, type WaStatusWord } from '@/lib/whatsapp/status';
import type { WaSettings } from '@/lib/whatsapp/settings';

interface LogRow {
  id: number; direction: 'out' | 'in'; purpose: string; phone: string; phone_shown: string; template: string | null; lang: string | null;
  params: string[] | { name?: string | null; type?: string | null } | null; body: string | null; status: WaStatusWord; error: string | null; error_code: number | null;
  wa_id: string | null; sent_by_name: string | null; created_at: string; sent_at: string | null; delivered_at: string | null; read_at: string | null; failed_at: string | null;
  party_name: string | null; challan_no: string | null; dispatch_id: number | null;
}
interface CheckInfo { ok: boolean; error?: string; verified_name?: string; display_phone_number?: string; quality_rating?: string; code_verification_status?: string; platform_type?: string; throughput?: { level?: string } }
interface WaDev {
  connected: boolean; env: { name: string; set: boolean; need: string; note: string }[]; version: string; base_default: boolean; base: string;
  webhook_url: string; verify_token: { set: boolean; length: number }; app_secret_set: boolean; settings: WaSettings; check: CheckInfo | null;
  log: LogRow[]; by_day: { day: string; out: number; delivered: number; read: number; failed: number; incoming: number }[];
}

const PURPOSE_LABEL: Record<string, string> = { reminder: 'Reminder', dispatch: 'Dispatch', summary: 'Summary', test: 'Test', incoming: 'Received' };

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500); }).catch(() => setCopied(null));
  };
  return [copied, copy];
}

export function WhatsAppPanel() {
  const [purpose, setPurpose] = useState('');
  const [status, setStatus] = useState('');
  const [days, setDays] = useState<'1' | '7' | '14' | '30'>('14');
  const [check, setCheck] = useState(false);
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useApi<WaDev>(`/api/dev/whatsapp?days=${days}${purpose ? `&purpose=${purpose}` : ''}${status ? `&status=${status}` : ''}${check ? '&check=1' : ''}`, tick);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  const runDaily = async () => {
    if (!window.confirm('Run the daily WhatsApp job now? It sends the morning summary and automatic reminders if the owner switched them on (each at most once a day).')) return;
    setBusy(true); setMsg(null);
    try { const r = await apiSend<{ message: string; result: unknown }>('/api/dev/whatsapp', 'POST', { action: 'run_daily' }); setMsg({ ok: true, text: `${r.message} ${JSON.stringify(r.result)}` }); setTick((t) => t + 1); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed.' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack-16">
      {error && <div className="alert bad">{error}</div>}
      {msg && <div className={`alert ${msg.ok ? 'good' : 'bad'}`} role="status">{msg.text}</div>}
      {!data && !error && <div className="loading"><span className="spinner" />Loading…</div>}
      {data && (
        <div className="settings-grid">
          <section className="card pad stack-12">
            <div className="wa-head">
              <div className="stack-4 min0"><h2 className="h2">Connection</h2><span className="muted small">Meta WhatsApp Cloud API, called directly (no other provider). Graph API {data.version}{data.base_default ? '' : ` · API base ${data.base} (test server)`}.</span></div>
              <Pill tone={data.connected ? 'good' : 'warn'}>{data.connected ? 'Connected' : 'Not connected'}</Pill>
            </div>
            {!data.connected && <span className="small">Not connected: nothing is sent; the owner gets “Open in WhatsApp” drafts as before.</span>}
            <div className="row-8"><button className="btn sm" disabled={loading || !data.connected} onClick={() => { setCheck(true); setTick((t) => t + 1); }}><Icon name="refresh" size={14} />Check connection</button></div>
            {data.check && (data.check.ok ? (
              <div className="dev-scroll"><table className="dev-table"><tbody>
                <tr><td>Display name</td><td>{data.check.verified_name ?? '—'}</td></tr>
                <tr><td>Number</td><td>{data.check.display_phone_number ?? '—'}</td></tr>
                <tr><td>Quality rating</td><td>{data.check.quality_rating ?? '—'}</td></tr>
                <tr><td>Verification</td><td>{data.check.code_verification_status ?? '—'}</td></tr>
                <tr><td>Platform</td><td>{data.check.platform_type ?? '—'}</td></tr>
                <tr><td>Throughput</td><td>{data.check.throughput?.level ?? '—'}</td></tr>
              </tbody></table></div>
            ) : <div className="alert bad">{data.check.error}</div>)}
            <div className="list">
              {data.env.map((e) => (
                <div className="list-row" key={e.name}>
                  <div className="stack-2 grow min0"><span className="strong wa-code">{e.name}</span><span className="muted tiny">{e.note}</span></div>
                  <Pill tone={e.set ? 'good' : e.need === 'required' ? 'warn' : 'neutral'}>{e.set ? 'Set' : 'Not set'}</Pill>
                </div>
              ))}
            </div>
          </section>

          <section className="card pad stack-12">
            <div className="stack-4"><h2 className="h2">Webhook</h2><span className="muted small">Meta sends delivery updates (sent / delivered / read / failed) and messages people send to the firm here.</span></div>
            <div className="stack-4"><span className="small strong">Callback URL</span>
              <div className="row-8" style={{ flexWrap: 'wrap' }}><span className="wa-code" data-wa-webhook>{data.webhook_url}</span><button className="btn sm" onClick={() => copy('url', data.webhook_url)}>{copied === 'url' ? 'Copied' : 'Copy'}</button></div>
              <span className="muted tiny">Must be the public https address of the live site (not localhost).</span></div>
            <div className="stack-4"><span className="small strong">Verify token</span>
              <span className="small">{data.verify_token.set ? `The value of WHATSAPP_VERIFY_TOKEN (${data.verify_token.length} characters) — paste the same text in Meta.` : 'WHATSAPP_VERIFY_TOKEN is not set: choose a long random text, set it, redeploy, then paste the same text in Meta.'}</span></div>
            <div className="stack-4"><span className="small strong">Signature check</span>
              <span className="small">{data.app_secret_set ? 'WHATSAPP_APP_SECRET is set: every webhook call is checked (X-Hub-Signature-256).' : 'WHATSAPP_APP_SECRET is not set: webhook calls are refused until it is.'}</span></div>
            <span className="small">Webhook fields: subscribe to <span className="wa-code">messages</span>.</span>
          </section>
        </div>
      )}

      {data && <Templates settings={data.settings} copied={copied} copy={copy} onSaved={(t) => { setMsg({ ok: true, text: t }); setTick((x) => x + 1); }} onError={(t) => setMsg({ ok: false, text: t })} />}

      {data && (
        <section className="card pad stack-12">
          <div className="card-head wrap-head">
            <div className="stack-4 min0"><h2 className="h2">Message log</h2><span className="muted small">Latest 200. Times are when the row last changed.</span></div>
            <button className="btn sm" disabled={busy} onClick={runDaily}>{busy ? 'Running…' : 'Run daily job now'}</button>
          </div>
          <div className="row-8" style={{ flexWrap: 'wrap' }}>
            <select className="input sel" aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="">All kinds</option>{Object.entries(PURPOSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="input sel" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>{(Object.keys(WA_STATUS_LABEL) as WaStatusWord[]).map((k) => <option key={k} value={k}>{WA_STATUS_LABEL[k]}</option>)}
            </select>
            <Segmented label="Period" value={days} onChange={setDays} className="fit" options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 d' }, { value: '14', label: '14 d' }, { value: '30', label: '30 d' }]} />
          </div>
          {!data.log.length && <span className="muted small">No messages{purpose || status ? ' match' : ' yet'}.</span>}
          {data.log.length > 0 && (
            <div className="dev-scroll"><table className="dev-table" data-wa-log>
              <thead><tr><th>When</th><th>Kind</th><th>To / from</th><th>About</th><th>Template</th><th>Status</th><th>By</th></tr></thead>
              <tbody>{data.log.map((m) => (
                <tr key={m.id}>
                  <td>{dayTime(m.created_at)}</td>
                  <td>{m.direction === 'in' ? '← ' : '→ '}{PURPOSE_LABEL[m.purpose] ?? m.purpose}</td>
                  <td>{m.phone_shown}{m.direction === 'in' && !Array.isArray(m.params) && m.params?.name ? <div className="muted tiny">{m.params.name}</div> : null}</td>
                  <td>{[m.party_name, m.challan_no && `challan ${m.challan_no}`].filter(Boolean).join(' · ') || '—'}{m.body ? <div className="tiny wa-body">{m.body.slice(0, 300)}</div> : null}</td>
                  <td>{m.template ? <span title={Array.isArray(m.params) ? m.params.join(' | ') : undefined}>{m.template} <span className="muted">({m.lang})</span></span> : '—'}</td>
                  <td><Pill tone={WA_STATUS_TONE[m.status]}>{WA_STATUS_LABEL[m.status]}</Pill>{m.error ? <div className="wa-err tiny">{m.error}</div> : null}</td>
                  <td className="muted">{m.direction === 'in' ? '—' : m.sent_by_name === 'auto' ? 'automatic' : m.sent_by_name ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {data.by_day.length > 0 && (
            <>
              <h3 className="h3" style={{ margin: '8px 0 0' }}>By day (IST)</h3>
              <div className="dev-scroll"><table className="dev-table">
                <thead><tr><th>Day</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Received</th></tr></thead>
                <tbody>{data.by_day.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.out}</td><td>{d.delivered}</td><td>{d.read}</td><td>{d.failed ? <span className="wa-err">{d.failed}</span> : 0}</td><td>{d.incoming}</td></tr>)}</tbody>
              </table></div>
            </>
          )}
        </section>
      )}

      <SetupGuide webhookUrl={data?.webhook_url ?? '/api/whatsapp/webhook'} />
    </div>
  );
}

function Templates({ settings, copied, copy, onSaved, onError }: { settings: WaSettings; copied: string | null; copy: (k: string, t: string) => void; onSaved: (t: string) => void; onError: (t: string) => void }) {
  const init = { tpl_reminder: settings.templates.reminder, tpl_dispatch: settings.templates.dispatch, tpl_summary: settings.templates.summary, lang: settings.lang };
  const [f, setF] = useState(init);
  const [showLang, setShowLang] = useState<'en' | 'hi'>(settings.lang.startsWith('hi') ? 'hi' : 'en');
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== init[k]);
  const field: Record<TemplateKey, keyof typeof f> = { reminder: 'tpl_reminder', dispatch: 'tpl_dispatch', summary: 'tpl_summary' };
  const save = async () => {
    try { const r = await apiSend<{ message: string }>('/api/dev/whatsapp', 'PUT', f); onSaved(r.message); } catch (e) { onError(e instanceof Error ? e.message : 'Could not save.'); }
  };
  return (
    <section className="card pad stack-14">
      <div className="card-head wrap-head">
        <div className="stack-4 min0"><h2 className="h2">Message templates</h2>
          <span className="muted small">Create these three in WhatsApp Manager → Message templates exactly as shown: category <b>Utility</b>, the name below, language below. Body text only (no header, footer or buttons). Meta asks for sample values for each variable — use the examples.</span></div>
        <Segmented label="Template language" value={showLang} onChange={setShowLang} className="fit" options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} />
      </div>
      <div className="row-8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="fld" style={{ minWidth: 150 }}>Language the app sends
          <select className="input" value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value })}>
            {[...TEMPLATE_LANGS.map((l) => l.code as string), ...(TEMPLATE_LANGS.some((l) => l.code === f.lang) ? [] : [f.lang])].map((c) => <option key={c} value={c}>{TEMPLATE_LANGS.find((l) => l.code === c)?.label ?? c}</option>)}
          </select></label>
        <button className="btn primary" disabled={!dirty} onClick={save}>Save names & language</button>
      </div>
      <span className="muted tiny">All three templates must exist in the language the app sends. The test message falls back to Meta’s own <span className="wa-code">{HELLO_WORLD.name}</span> ({HELLO_WORLD.lang}) until the summary template is approved.</span>
      <div className="settings-grid">
        {TEMPLATES.map((t) => {
          const body = t.body[showLang];
          const k = field[t.key];
          return (
            <div key={t.key} className="card pad stack-10" data-wa-template={t.key}>
              <div className="wa-head"><span className="strong">{t.key === 'reminder' ? 'Payment reminder' : t.key === 'dispatch' ? 'Dispatch message' : 'Morning summary'}</span><Pill tone="info">UTILITY · {showLang}</Pill></div>
              <span className="muted small">{t.purpose}</span>
              <label className="fld">Template name
                <input className="num" value={f[k]} maxLength={100} onChange={(e) => setF({ ...f, [k]: e.target.value.trim().toLowerCase() })} /></label>
              <div className="row-8" style={{ flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => copy(`${t.key}-name`, f[k])}>{copied === `${t.key}-name` ? 'Copied' : 'Copy name'}</button>
                <button className="btn sm primary" onClick={() => copy(`${t.key}-body`, body)}>{copied === `${t.key}-body` ? 'Copied' : 'Copy text'}</button>
                <button className="btn sm" onClick={() => copy(`${t.key}-ex`, t.vars.map((v) => `{{${v.n}}} ${v.example}`).join('\n'))}>{copied === `${t.key}-ex` ? 'Copied' : 'Copy sample values'}</button>
              </div>
              <pre className="wa-tpl">{body}</pre>
              <div className="dev-scroll"><table className="dev-table"><thead><tr><th>Var</th><th>Means</th><th>Sample</th></tr></thead>
                <tbody>{t.vars.map((v) => <tr key={v.n}><td>{`{{${v.n}}}`}</td><td>{v.meaning}</td><td>{v.example}</td></tr>)}</tbody></table></div>
              <details><summary className="small">Preview with samples</summary><pre className="wa-tpl">{fillTemplate(body, t.vars.map((v) => v.example))}</pre></details>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SetupGuide({ webhookUrl }: { webhookUrl: string }) {
  return (
    <section className="card pad stack-12">
      <div className="stack-4"><h2 className="h2">Setup, step by step</h2><span className="muted small">About an hour, plus Meta’s review time for templates (usually minutes, sometimes a day).</span></div>
      <ol className="wa-steps">
        <li><b>Meta Business account.</b> Go to business.facebook.com and create (or open) the firm’s business account. Verify the business later for higher sending limits.</li>
        <li><b>Create an app.</b> developers.facebook.com → My Apps → Create app → type <b>Business</b> → link it to the business account.</li>
        <li><b>Add WhatsApp.</b> In the app, add the <b>WhatsApp</b> product. Meta gives you a free <b>test number</b> to start with.</li>
        <li><b>Test recipients.</b> WhatsApp → API Setup → “To”: add the owner’s mobile (and any test numbers) and confirm the code each one receives. A test number can only message these.</li>
        <li><b>Phone number ID.</b> Same page: copy the <b>Phone number ID</b> (a long number, not the phone number) → <code>WHATSAPP_PHONE_NUMBER_ID</code>.</li>
        <li><b>Permanent token.</b> Business settings → Users → <b>System users</b> → add one (Admin) → Add assets → the app (full control) and the WhatsApp account → <b>Generate token</b> with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>, expiry “Never” → <code>WHATSAPP_TOKEN</code>. (The 24-hour token on API Setup is only for a quick try.)</li>
        <li><b>App secret.</b> App settings → Basic → App secret → Show → <code>WHATSAPP_APP_SECRET</code>.</li>
        <li><b>Verify token.</b> Make up a long random text → <code>WHATSAPP_VERIFY_TOKEN</code>.</li>
        <li><b>Set the env vars in Vercel</b> (Project → Settings → Environment Variables, Production) and <b>redeploy</b>. Optional: <code>WHATSAPP_API_VERSION</code> (default shown above).</li>
        <li><b>Webhook.</b> App → WhatsApp → Configuration → Webhook → Edit: Callback URL <code>{webhookUrl}</code>, Verify token = the same text → Verify and save. Then under Webhook fields <b>subscribe to <code>messages</code></b>.</li>
        <li><b>Templates.</b> WhatsApp Manager → Message templates → Create: the three above (Utility, exact names, language), with the sample values. Wait for “Active – Approved”.</li>
        <li><b>Test.</b> Owner: My firm → Policy → WhatsApp → “Send me a test message”. Check “Check connection” and the log here.</li>
        <li><b>Go live.</b> Add the firm’s real number (WhatsApp → Phone numbers → Add; it must not be in use on the WhatsApp app), add a payment method, update <code>WHATSAPP_PHONE_NUMBER_ID</code>, redeploy. Then the owner switches on what they want in Policy.</li>
      </ol>
    </section>
  );
}
