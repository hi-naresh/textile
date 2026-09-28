'use client';

import React, { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { PageHead, Pill, dayTime } from '../ui';
import type { Ctx, Lang } from '../ctx';
import { CAPTURE_TYPES } from '@/lib/access';
import type { CaptureType } from '@/lib/types';

const T = {
  en: { hello: 'Namaste', target: 'Today’s target', noWork: 'No work allotted yet today. Ask your supervisor.', submit: 'Submit photo', done: 'Done ✓', captureTitle: 'Capture a card or challan', captureText: 'Take a photo of the folding card when a job is done. Your supervisor confirms it.', openCam: 'Open camera', week: 'My week', private: 'Only you and your supervisor see these numbers.', capture: 'Capture photo', captureSub: 'Pick what you are photographing, then hold the paper flat inside the frame', take: 'Take photo', retake: 'Retake', send: 'Send for reading', sending: 'Reading…', recent: 'My recent captures', none: 'No captures yet', history: 'My history', historySub: 'Your own days only', date: 'Date', allotted: 'Allotted', doneM: 'Done', eff: 'Efficiency', fold: 'Job card (cut)', captureSubOne: 'Hold the job card flat inside the frame', inw: 'Incoming challan', out: 'Outgoing challan', jobDone: 'job done', stockIn: 'stock IN', stockOut: 'stock OUT', fit: 'Fit the paper inside', supervisor: 'Supervisor', noHistory: 'No history yet', off: 'Photo reading is switched off right now. Give the paper to your supervisor to enter by hand.' },
  hi: { hello: 'नमस्ते', target: 'आज का लक्ष्य', noWork: 'आज अभी कोई काम नहीं मिला। सुपरवाइजर से पूछें।', submit: 'फोटो भेजें', done: 'पूर्ण ✓', captureTitle: 'कार्ड या चालान की फोटो', captureText: 'काम पूरा होने पर फोल्डिंग कार्ड की फोटो लें। सुपरवाइजर पुष्टि करेंगे।', openCam: 'कैमरा खोलें', week: 'मेरा सप्ताह', private: 'ये आंकड़े सिर्फ आप और आपके सुपरवाइजर देखते हैं।', capture: 'फोटो लें', captureSub: 'क्या फोटो ले रहे हैं चुनें, फिर कागज़ फ्रेम में सीधा रखें', take: 'फोटो लें', retake: 'दोबारा लें', send: 'पढ़ने के लिए भेजें', sending: 'पढ़ रहे हैं…', recent: 'मेरी हाल की फोटो', none: 'अभी कोई फोटो नहीं', history: 'मेरा इतिहास', historySub: 'सिर्फ आपके दिन', date: 'तारीख', allotted: 'आवंटित', doneM: 'पूर्ण', eff: 'दक्षता', fold: 'जॉब कार्ड (कट)', captureSubOne: 'जॉब कार्ड को फ्रेम में सीधा रखें', inw: 'आवक चालान', out: 'जावक चालान', jobDone: 'काम पूरा', stockIn: 'स्टॉक IN', stockOut: 'स्टॉक OUT', fit: 'कागज़ फ्रेम में रखें', supervisor: 'सुपरवाइजर', noHistory: 'अभी कोई इतिहास नहीं', off: 'फोटो पढ़ना अभी बंद है। कागज़ सुपरवाइजर को दें, वे हाथ से दर्ज करेंगे।' },
  gu: { hello: 'નમસ્તે', target: 'આજનું લક્ષ્ય', noWork: 'આજે હજુ કોઈ કામ ફાળવાયું નથી. સુપરવાઇઝરને પૂછો.', submit: 'ફોટો મોકલો', done: 'પૂર્ણ ✓', captureTitle: 'કાર્ડ અથવા ચલણનો ફોટો', captureText: 'કામ પૂરું થાય ત્યારે ફોલ્ડિંગ કાર્ડનો ફોટો લો. સુપરવાઇઝર પુષ્ટિ કરશે.', openCam: 'કેમેરા ખોલો', week: 'મારું અઠવાડિયું', private: 'આ આંકડા ફક્ત તમે અને તમારા સુપરવાઇઝર જુએ છે.', capture: 'ફોટો લો', captureSub: 'શેનો ફોટો લો છો તે પસંદ કરો, પછી કાગળ ફ્રેમમાં સીધો રાખો', take: 'ફોટો લો', retake: 'ફરી લો', send: 'વાંચવા મોકલો', sending: 'વાંચી રહ્યા છીએ…', recent: 'મારા તાજેતરના ફોટા', none: 'હજુ કોઈ ફોટો નથી', history: 'મારો ઇતિહાસ', historySub: 'ફક્ત તમારા દિવસો', date: 'તારીખ', allotted: 'ફાળવેલ', doneM: 'પૂર્ણ', eff: 'કાર્યક્ષમતા', fold: 'જોબ કાર્ડ (કટ)', captureSubOne: 'જોબ કાર્ડ ફ્રેમમાં સીધું રાખો', inw: 'આવક ચલણ', out: 'જાવક ચલણ', jobDone: 'કામ પૂરું', stockIn: 'સ્ટોક IN', stockOut: 'સ્ટોક OUT', fit: 'કાગળ ફ્રેમમાં રાખો', supervisor: 'સુપરવાઇઝર', noHistory: 'હજુ કોઈ ઇતિહાસ નથી', off: 'ફોટો વાંચવાનું હાલ બંધ છે. કાગળ સુપરવાઇઝરને આપો, તેઓ હાથથી નોંધશે.' },
};
export const workerText = (l: Lang) => T[l];

export function Capture({ ctx }: { ctx: Ctx }) {
  const { d, lang, role } = ctx;
  const t = T[lang];
  const allowed = CAPTURE_TYPES[role];
  const type = allowed.includes(ctx.capType) ? ctx.capType : allowed[0];
  const setType = ctx.setCapType;
  const startedAt = useRef<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!startedAt.current) startedAt.current = Date.now();
    setFile(f);
    setPreview(URL.createObjectURL(f));
    e.target.value = '';
  };
  const sendIt = async () => {
    if (!file) return;
    setBusy(true);
    const ok = await d.uploadCapture(file, type, role, startedAt.current);
    setBusy(false);
    if (ok) { setFile(null); setPreview(null); startedAt.current = null; }
  };

  const aiState = d.status?.ai.state;
  const ocrOn = d.status?.ocr?.state === 'connected';
  const readingOff = !!d.status && ((!ocrOn && aiState !== 'connected' && aiState !== 'demo') || d.status.photos.state === 'missing');
  const mine = d.captures.filter((c) => allowed.includes(c.type)).slice(0, 6);
  const statusTone = { pending: 'warn', confirmed: 'good', corrected: 'good', rejected: 'bad' } as const;
  const statusText = { pending: 'In review', confirmed: 'Confirmed', corrected: 'Confirmed', rejected: 'Retake asked' } as const;
  const opts: { v: CaptureType; label: string; sub: string }[] = ([
    { v: 'job_card_folding', label: t.fold, sub: t.jobDone },
    { v: 'incoming_stock', label: t.inw, sub: t.stockIn },
    { v: 'outgoing_stock', label: t.out, sub: t.stockOut },
  ] as { v: CaptureType; label: string; sub: string }[]).filter((o) => allowed.includes(o.v));

  return (
    <div className="page fade">
      <PageHead title={t.capture} sub={opts.length > 1 ? t.captureSub : t.captureSubOne} />
      <div className="grid-capture">
        <section className="card pad stack-16">
          {readingOff && <div className="alert warn" role="alert">{t.off}</div>}
          {opts.length > 1 && <div role="group" aria-label="What are you capturing" className="opts">
            {opts.map((o) => (
              <button key={o.v} className={`opt ${type === o.v ? 'on' : ''}`} aria-pressed={type === o.v} onClick={() => setType(o.v)}>
                <span>{o.label}</span><span className="opt-sub">{o.sub}</span>
              </button>
            ))}
          </div>}
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
              <button className="btn primary big grow" onClick={sendIt} disabled={busy || readingOff}><Icon name="check" size={18} strokeWidth={2} />{busy ? t.sending : t.send}</button>
            </div>
          ) : (
            <button className="btn primary huge" disabled={readingOff} onClick={() => { startedAt.current = Date.now(); input.current?.click(); }}><Icon name="camera" size={20} strokeWidth={2} />{t.take}</button>
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
