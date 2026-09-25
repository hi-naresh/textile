'use client';

import React, { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill, Segmented, Track, dayTime, effTone, fmt } from '../ui';
import type { Ctx, Lang } from '../ctx';
import { supervisorFor, sectionName } from '@/lib/access';
import { STATUS_LABEL } from '@/lib/derive';
import type { CaptureType } from '@/lib/types';

const T = {
  en: { hello: 'Namaste', target: 'Today’s target', noWork: 'No work allotted yet today. Ask your supervisor.', submit: 'Submit photo', done: 'Done ✓', captureTitle: 'Capture a card or challan', captureText: 'Take a photo of the folding card when a job is done. Your supervisor confirms it.', openCam: 'Open camera', week: 'My week', private: 'Only you and your supervisor see these numbers.', capture: 'Capture photo', captureSub: 'Pick what you are photographing, then hold the paper flat inside the frame', take: 'Take photo', retake: 'Retake', send: 'Send for reading', sending: 'Reading…', recent: 'My recent captures', none: 'No captures yet', history: 'My history', historySub: 'Your own days only', date: 'Date', allotted: 'Allotted', doneM: 'Done', eff: 'Efficiency', fold: 'Folding card', inw: 'Incoming challan', out: 'Outgoing challan', jobDone: 'job done', stockIn: 'stock IN', stockOut: 'stock OUT', fit: 'Fit the paper inside', supervisor: 'Supervisor', noHistory: 'No history yet' },
  hi: { hello: 'नमस्ते', target: 'आज का लक्ष्य', noWork: 'आज अभी कोई काम नहीं मिला। सुपरवाइजर से पूछें।', submit: 'फोटो भेजें', done: 'पूर्ण ✓', captureTitle: 'कार्ड या चालान की फोटो', captureText: 'काम पूरा होने पर फोल्डिंग कार्ड की फोटो लें। सुपरवाइजर पुष्टि करेंगे।', openCam: 'कैमरा खोलें', week: 'मेरा सप्ताह', private: 'ये आंकड़े सिर्फ आप और आपके सुपरवाइजर देखते हैं।', capture: 'फोटो लें', captureSub: 'क्या फोटो ले रहे हैं चुनें, फिर कागज़ फ्रेम में सीधा रखें', take: 'फोटो लें', retake: 'दोबारा लें', send: 'पढ़ने के लिए भेजें', sending: 'पढ़ रहे हैं…', recent: 'मेरी हाल की फोटो', none: 'अभी कोई फोटो नहीं', history: 'मेरा इतिहास', historySub: 'सिर्फ आपके दिन', date: 'तारीख', allotted: 'आवंटित', doneM: 'पूर्ण', eff: 'दक्षता', fold: 'फोल्डिंग कार्ड', inw: 'आवक चालान', out: 'जावक चालान', jobDone: 'काम पूरा', stockIn: 'स्टॉक IN', stockOut: 'स्टॉक OUT', fit: 'कागज़ फ्रेम में रखें', supervisor: 'सुपरवाइजर', noHistory: 'अभी कोई इतिहास नहीं' },
  gu: { hello: 'નમસ્તે', target: 'આજનું લક્ષ્ય', noWork: 'આજે હજુ કોઈ કામ ફાળવાયું નથી. સુપરવાઇઝરને પૂછો.', submit: 'ફોટો મોકલો', done: 'પૂર્ણ ✓', captureTitle: 'કાર્ડ અથવા ચલણનો ફોટો', captureText: 'કામ પૂરું થાય ત્યારે ફોલ્ડિંગ કાર્ડનો ફોટો લો. સુપરવાઇઝર પુષ્ટિ કરશે.', openCam: 'કેમેરા ખોલો', week: 'મારું અઠવાડિયું', private: 'આ આંકડા ફક્ત તમે અને તમારા સુપરવાઇઝર જુએ છે.', capture: 'ફોટો લો', captureSub: 'શેનો ફોટો લો છો તે પસંદ કરો, પછી કાગળ ફ્રેમમાં સીધો રાખો', take: 'ફોટો લો', retake: 'ફરી લો', send: 'વાંચવા મોકલો', sending: 'વાંચી રહ્યા છીએ…', recent: 'મારા તાજેતરના ફોટા', none: 'હજુ કોઈ ફોટો નથી', history: 'મારો ઇતિહાસ', historySub: 'ફક્ત તમારા દિવસો', date: 'તારીખ', allotted: 'ફાળવેલ', doneM: 'પૂર્ણ', eff: 'કાર્યક્ષમતા', fold: 'ફોલ્ડિંગ કાર્ડ', inw: 'આવક ચલણ', out: 'જાવક ચલણ', jobDone: 'કામ પૂરું', stockIn: 'સ્ટોક IN', stockOut: 'સ્ટોક OUT', fit: 'કાગળ ફ્રેમમાં રાખો', supervisor: 'સુપરવાઇઝર', noHistory: 'હજુ કોઈ ઇતિહાસ નથી' },
};
export const workerText = (l: Lang) => T[l];

function LangSwitch({ ctx }: { ctx: Ctx }) {
  return <Segmented label="Language" value={ctx.lang} onChange={ctx.setLang} options={[{ value: 'en', label: 'EN' }, { value: 'hi', label: 'हिं' }, { value: 'gu', label: 'ગુ' }]} />;
}

export function Shift({ ctx }: { ctx: Ctx }) {
  const { d, me, days, lang, go } = ctx;
  const t = T[lang];
  if (!me) return <div className="page"><Empty title="No worker selected" text="Add workers in the database first." /></div>;
  const day = days.find((x) => x.worker.id === me.id);
  const allot = day?.allotted ?? 0;
  const done = day?.done ?? 0;
  const pct = allot > 0 ? Math.round((done / allot) * 100) : 0;
  const openCards = d.jobCards.filter((j) => j.worker_id === me.id && j.status !== 'closed');
  const cards = [...(day?.cards ?? []), ...openCards.filter((o) => !(day?.cards ?? []).some((c) => c.id === o.id))];
  const hist = d.efficiency.filter((e) => e.worker_id === me.id).slice(0, 5).reverse();
  const week = [
    ...hist.map((h) => ({ key: h.date_str ?? h.date, day: new Date((h.date_str ?? h.date.slice(0, 10)) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }), eff: Math.round(h.efficiency_pct) })),
    ...(allot > 0 ? [{ key: 'today', day: 'Today', eff: pct }] : []),
  ];

  return (
    <div className="page fade">
      <PageHead title={`${t.hello}, ${me.name.split(' ')[0]}`} sub={`${sectionName(me.section)} · ${t.supervisor}: ${supervisorFor(me.section)}`}><LangSwitch ctx={ctx} /></PageHead>
      <div className="grid-split">
        <section className="card pad-24 stack-16">
          <span className="t2">{t.target}</span>
          <div className="big-num">
            <span className="num xl">{fmt(done)}</span>
            <span className="num muted md">/ {fmt(allot)} m</span>
            <div className="grow" />
            <Pill tone={effTone(pct + 10)} className="tall"><span className="num">{pct}%</span></Pill>
          </div>
          <Track pct={pct} tone={effTone(pct + 10)} height={12} />
          {!cards.length && <p className="muted" style={{ margin: 0 }}>{t.noWork}</p>}
          <div className="stack-10">
            {cards.map((c) => {
              const closed = c.status === 'closed';
              return (
                <div key={c.id} className={`job ${closed ? 'is-done' : ''}`}>
                  <div className="grow stack-4"><span className="num strong">JC-{c.id} · {c.lot_id}</span><span className="muted small">{c.quality} · {c.design} · {STATUS_LABEL[c.status]}</span></div>
                  <span className="num job-m">{fmt(closed ? c.meters_out : c.meters_in)} m</span>
                  <button className={`btn ${closed ? '' : 'primary'} job-btn`} disabled={closed} onClick={() => { ctx.setCapType('job_card_folding'); go('capture'); }}>{closed ? t.done : t.submit}</button>
                </div>
              );
            })}
          </div>
        </section>
        <div className="stack-16">
          <section className="card pad stack-12">
            <h2 className="h2">{t.captureTitle}</h2>
            <span className="t2 lh">{t.captureText}</span>
            <button className="btn primary big" onClick={() => { ctx.setCapType('job_card_folding'); go('capture'); }}><Icon name="camera" size={18} strokeWidth={2} />{t.openCam}</button>
          </section>
          <section className="card pad stack-14">
            <h2 className="h2">{t.week}</h2>
            {week.length ? (
              <div className="mini-bars">
                {week.map((w) => (
                  <div key={w.key} className="mini-bar-col">
                    <span className="num tiny muted">{w.eff}%</span>
                    <div className={`bar ${effTone(w.eff)}`} style={{ height: Math.max(6, Math.min(100, w.eff) * 0.8), width: '100%', borderRadius: 6 }} />
                    <span className="tiny muted">{w.day}</span>
                  </div>
                ))}
              </div>
            ) : <span className="muted small">{t.noHistory}</span>}
            <span className="muted small note"><Icon name="lock" size={12} strokeWidth={2} />{t.private}</span>
          </section>
        </div>
      </div>
    </div>
  );
}

export function Capture({ ctx }: { ctx: Ctx }) {
  const { d, me, lang } = ctx;
  const t = T[lang];
  const type = ctx.capType;
  const setType = ctx.setCapType;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    e.target.value = '';
  };
  const sendIt = async () => {
    if (!file) return;
    setBusy(true);
    const ok = await d.uploadCapture(file, type);
    setBusy(false);
    if (ok) { setFile(null); setPreview(null); }
  };

  const mine = d.captures.filter((c) => me && (c.ai_json as Record<string, unknown> | null)?.worker_id === me.id).slice(0, 6);
  const statusTone = { pending: 'warn', confirmed: 'good', corrected: 'good', rejected: 'bad' } as const;
  const statusText = { pending: 'In review', confirmed: 'Confirmed', corrected: 'Confirmed', rejected: 'Retake asked' } as const;
  const opts: { v: CaptureType; label: string; sub: string }[] = [
    { v: 'job_card_folding', label: t.fold, sub: t.jobDone },
    { v: 'incoming_stock', label: t.inw, sub: t.stockIn },
    { v: 'outgoing_stock', label: t.out, sub: t.stockOut },
  ];

  return (
    <div className="page fade">
      <PageHead title={t.capture} sub={t.captureSub}><LangSwitch ctx={ctx} /></PageHead>
      <div className="grid-capture">
        <section className="card pad stack-16">
          <div role="group" aria-label="What are you capturing" className="opts">
            {opts.map((o) => (
              <button key={o.v} className={`opt ${type === o.v ? 'on' : ''}`} aria-pressed={type === o.v} onClick={() => setType(o.v)}>
                <span>{o.label}</span><span className="opt-sub">{o.sub}</span>
              </button>
            ))}
          </div>
          <div className="photo frame">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Photo preview" />
            ) : (
              <div className="frame-guide"><Pill tone="info" className="tall">{t.fit}</Pill></div>
            )}
          </div>
          <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
          {preview ? (
            <div className="row-10">
              <button className="btn big grow" onClick={() => input.current?.click()} disabled={busy}>{t.retake}</button>
              <button className="btn primary big grow" onClick={sendIt} disabled={busy}><Icon name="check" size={18} strokeWidth={2} />{busy ? t.sending : t.send}</button>
            </div>
          ) : (
            <button className="btn primary huge" onClick={() => input.current?.click()}><Icon name="camera" size={20} strokeWidth={2} />{t.take}</button>
          )}
        </section>
        <section className="card pad stack-12">
          <h2 className="h2">{t.recent}</h2>
          {!mine.length && <span className="muted small">{t.none}</span>}
          {mine.map((c) => (
            <div key={c.id} className="cap-row">
              <div className="photo cap-thumb" />
              <div className="grow stack-2"><span className="strong small">{opts.find((o) => o.v === c.type)?.label}</span><span className="num muted tiny">{String((c.ai_json as Record<string, unknown> | null)?.lot_id ?? '—')} · {dayTime(c.ts)}</span></div>
              <Pill tone={statusTone[c.status]}>{statusText[c.status]}</Pill>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function History({ ctx }: { ctx: Ctx }) {
  const { d, me, lang } = ctx;
  const t = T[lang];
  const rows = d.efficiency.filter((e) => me && e.worker_id === me.id);
  return (
    <div className="page fade">
      <PageHead title={t.history} sub={t.historySub}><LangSwitch ctx={ctx} /></PageHead>
      <section className="card flush narrow">
        <table className="tbl rtbl">
          <thead><tr><th>{t.date}</th><th className="r">{t.allotted}</th><th className="r">{t.doneM}</th><th className="r">{t.eff}</th></tr></thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id}>
                <td data-label={t.date} className="strong">{new Date((h.date_str ?? h.date.slice(0, 10)) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td data-label={t.allotted} className="r num">{fmt(h.allotted)}</td>
                <td data-label={t.doneM} className="r num">{fmt(h.done)}</td>
                <td data-label={t.eff} className="r"><Pill tone={effTone(h.efficiency_pct)}><span className="num">{Math.round(h.efficiency_pct)}%</span></Pill></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="muted center">{t.noHistory}</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
