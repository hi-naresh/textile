'use client';

// Chat.
// - Desktop: round button bottom-right that opens a panel.
// - Phone: opened from the chat icon in the top bar; slides down from the top and fills the screen.
// - Mic: dictate one question.
// - Voice mode (like ChatGPT): hands-free — it keeps listening, answers out loud in the language you
//   spoke (English / Hindi / Gujarati), and listens again. Every turn also appears in the chat.
//   Uses the browser's speech recognition + speech synthesis.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Icon from './Icon';
import type { Ctx, Lang } from './ctx';
import { can, firm } from '@/lib/access';
import { VadRecorder, recorderSupported } from './vadRecorder';

// ---------- browser speech helpers ----------
type RecResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<RecResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecCtor = new () => Rec;

function speechCtor(): RecCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
const noop = () => () => {};

/**
 * How this browser can do voice:
 * - browser:  built-in speech recognition (Chrome, Android, Safari tab) — free
 * - recorder: record the mic and let the server transcribe (iPhone home-screen app, Firefox, …)
 * - insecure: page opened over plain http (e.g. http://192.168.x.x on the Wi-Fi) — browsers block the mic
 */
type Engine = 'browser' | 'recorder' | 'insecure' | 'none' | 'server';
function detectEngine(): Engine {
  if (!window.isSecureContext) return 'insecure';
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (speechCtor() && !standalone) return 'browser';
  return recorderSupported() ? 'recorder' : 'none';
}
const useEngine = () => useSyncExternalStore(noop, detectEngine, () => 'server' as Engine);
const ENGINE_HELP: Partial<Record<Engine, string>> = {
  insecure: 'Voice needs a secure link. Open the app over https (the live site, or the tunnel link in DEPLOY.md) — phones block the mic on http:// Wi-Fi addresses.',
  none: 'This browser can’t use the microphone. Try Safari or Chrome.',
};

async function transcribe(wav: Blob, role: string): Promise<{ text: string; lang: Lang } | { error: string }> {
  const fd = new FormData();
  fd.append('audio', wav, 'speech.wav');
  fd.append('role', role);
  try {
    const res = await fetch('/api/chat/transcribe', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { text: String(data.text ?? ''), lang: (data.lang ?? 'en') as Lang } : { error: data.error || 'Could not hear that.' };
  } catch {
    return { error: 'Network error.' };
  }
}

const SPEECH_LANG: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };
const LANG_LABEL: Record<Lang, string> = { en: 'English', hi: 'हिंदी', gu: 'ગુજરાતી' };

/** Language of what was heard: the script decides; romanised Hindi/Gujarati is detected by the server. */
function scriptLang(text: string): Lang | null {
  if (/[઀-૿]/.test(text)) return 'gu';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  return null;
}
function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return voices.find((v) => v.lang.replace('_', '-') === lang)
    ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)))
    ?? null;
}
/** Shorter, speakable version of an answer. */
function forSpeech(text: string): string {
  const t = text.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 420 ? `${t.slice(0, 420).replace(/[^.।]*$/, '')}` : t;
}

// ---------- voice mode ----------
type VoiceState = 'off' | 'listening' | 'thinking' | 'speaking' | 'muted';
type Answer = { text: string; lang: Lang } | null;

/** Split an answer into short sentences — browsers drop or cut off long utterances. */
function sentences(text: string): string[] {
  const parts = forSpeech(text).match(/[^.!?।]+[.!?।]*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length + p.length) < 140) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

const vlog = (...a: unknown[]) => { if (typeof window !== 'undefined' && (window as unknown as { __voiceDebug?: boolean }).__voiceDebug !== false) console.debug('[voice]', ...a); };

/**
 * Hands-free loop: listen → (transcribe) → ask → speak → listen …
 * Every step has a watchdog, because browser speech APIs sometimes never fire their "end" events
 * (Chrome drops long or garbage-collected utterances; iPhone recognition can stall after audio plays).
 * A step that hangs is abandoned and the loop moves on, so it never gets stuck.
 */
function useVoiceMode(startLang: Lang, engine: Engine, role: string, ask: (q: string) => Promise<Answer>, onError: (msg: string) => void) {
  const [state, setStateRaw] = useState<VoiceState>('off');
  const [heard, setHeard] = useState('');
  const [lang, setLang] = useState<Lang>(startLang);
  const live = useRef({ ask, onError, lang, engine, role });
  useEffect(() => { live.current = { ask, onError, lang, engine, role }; });
  const vad = useRef<VadRecorder | null>(null);
  const alive = useRef(false);
  const muted = useRef(false);
  const rec = useRef<Rec | null>(null);
  const turn = useRef(0); // bumps on every new step; late callbacks from older steps are ignored
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const utter = useRef<SpeechSynthesisUtterance[]>([]); // keep references (Chrome GC bug)
  const quickFails = useRef(0);
  const captureFails = useRef(0);
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  const stateRef = useRef<VoiceState>('off');
  const setState = (s: VoiceState) => { stateRef.current = s; setStateRaw(s); vlog('state', s); };

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (poll.current) { clearInterval(poll.current); poll.current = null; }
  };
  const later = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };
  const killRec = () => {
    const r = rec.current;
    rec.current = null;
    if (r) { r.onend = null; r.onresult = null; r.onerror = null; try { r.abort(); } catch { /* already stopped */ } }
  };
  const hush = () => { try { window.speechSynthesis?.cancel(); } catch { /* not available */ } utter.current = []; };

  const loop = useRef({
    listen(delay = 0) {
      if (!alive.current || muted.current) return;
      const my = ++turn.current;
      clearTimers();
      killRec();
      hush();
      setHeard('');
      setState('listening');
      if (live.current.engine === 'recorder') { vad.current?.resume(); return; }
      const Ctor = speechCtor();
      if (!Ctor) return;
      const begin = () => {
        if (turn.current !== my || !alive.current) return;
        const r = new Ctor();
        r.lang = SPEECH_LANG[live.current.lang];
        r.interimResults = true;
        r.continuous = false;
        let finalText = '';
        let lastText = '';
        let lastChange = Date.now();
        const startedAt = Date.now();
        const finish = () => {
          if (turn.current !== my) return;
          const q = (finalText || lastText).trim();
          killRec();
          if (!alive.current || muted.current) return;
          if (q) { quickFails.current = 0; void loop.current.answer(q); return; }
          quickFails.current = Date.now() - startedAt < 900 ? quickFails.current + 1 : 0;
          loop.current.listen(quickFails.current >= 4 ? 1500 : 150); // silence → just keep listening
        };
        r.onresult = (e) => {
          let interim = '';
          finalText = '';
          for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
            else interim += e.results[i][0].transcript;
          }
          const t = (finalText + interim).trim();
          if (t !== lastText) { lastText = t; lastChange = Date.now(); }
          setHeard(t);
        };
        r.onerror = (e) => {
          vlog('recognition error', e.error);
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            loop.current.stop();
            live.current.onError('Allow the microphone to use voice mode.');
          } else if (e.error === 'audio-capture' && ++captureFails.current >= 3) {
            loop.current.stop();
            live.current.onError('The microphone is busy or missing.');
          }
        };
        r.onend = finish;
        rec.current = r;
        try { r.start(); } catch (err) { vlog('start failed', err); later(600, () => loop.current.listen()); return; }
        // Watchdog: some browsers never end the session. Words stopped coming for 1.8 s → take them;
        // nothing heard for 9 s → restart the recogniser.
        poll.current = setInterval(() => {
          if (turn.current !== my) return;
          const quiet = Date.now() - lastChange;
          if (lastText && quiet > 1800) { vlog('watchdog: finalise'); finish(); }
          else if (!lastText && Date.now() - startedAt > 9000) { vlog('watchdog: restart'); loop.current.listen(); }
        }, 300);
      };
      if (delay) later(delay, begin); else begin();
    },

    speak(text: string, lang: Lang) {
      const my = ++turn.current;
      clearTimers();
      killRec();
      const synth = window.speechSynthesis;
      const next = () => { if (turn.current === my && alive.current) loop.current.listen(350); }; // short gap lets the phone switch audio back to the mic
      if (!synth || !text.trim()) { next(); return; }
      setState('speaking');
      hush();
      const chunks = sentences(text);
      const voice = pickVoice(SPEECH_LANG[lang]);
      utter.current = chunks.map((c) => {
        const u = new SpeechSynthesisUtterance(c);
        u.lang = SPEECH_LANG[lang];
        if (voice) u.voice = voice;
        u.rate = 1.03;
        return u;
      });
      const last = utter.current[utter.current.length - 1];
      last.onend = next;
      utter.current.forEach((u) => { u.onerror = (e) => { vlog('speech error', (e as SpeechSynthesisErrorEvent).error); next(); }; });
      // Chrome needs a tick after cancel() before speak(), or the first utterance is silently dropped.
      later(60, () => { if (turn.current === my) utter.current.forEach((u) => synth.speak(u)); });
      // Watchdogs: end events can go missing — poll the engine, and cap by an estimate of the length.
      let started = false;
      const t0 = Date.now();
      poll.current = setInterval(() => {
        if (turn.current !== my) return;
        if (synth.speaking || synth.pending) { started = true; return; }
        if (started || Date.now() - t0 > 2500) { vlog('watchdog: speech done'); next(); }
      }, 300);
      later(4000 + text.length * 90, () => { vlog('watchdog: speech cap'); hush(); next(); });
    },

    async answer(q: string) {
      const my = ++turn.current;
      clearTimers();
      killRec();
      setState('thinking');
      setHeard('');
      const spoken = scriptLang(q);
      if (spoken) setLang(spoken);
      const timeout = new Promise<'timeout'>((r) => later(25000, () => r('timeout')));
      const a = await Promise.race([live.current.ask(q), timeout]);
      if (turn.current !== my || !alive.current) return;
      if (a === 'timeout') { loop.current.speak('Sorry, that took too long. Please ask again.', 'en'); return; }
      const replyLang = a?.lang ?? spoken ?? live.current.lang;
      if (a && a.lang !== 'en') setLang(a.lang); // keep listening in the language they speak
      else if (a && !spoken) setLang('en');
      loop.current.speak(a?.text ?? 'Sorry, I could not answer that.', replyLang);
    },

    /** Recorder engine: a finished utterance → server transcription → answer. */
    async heardAudio(wav: Blob) {
      if (!alive.current) return;
      const my = ++turn.current;
      setState('thinking');
      setHeard('…');
      const r = await transcribe(wav, live.current.role);
      if (turn.current !== my || !alive.current) return;
      if ('error' in r) { live.current.onError(r.error); loop.current.listen(); return; }
      if (!r.text) { loop.current.listen(); return; }
      setHeard(r.text);
      await loop.current.answer(r.text);
    },

    stop() {
      alive.current = false;
      turn.current++;
      clearTimers();
      killRec();
      hush();
      vad.current?.stop();
      vad.current = null;
      wake.current?.release().catch(() => {});
      wake.current = null;
      setState('off');
      setHeard('');
    },
  });

  /** Called from a tap (browsers only allow the mic and audio after a user gesture). */
  const start = () => {
    alive.current = true;
    muted.current = false;
    quickFails.current = 0;
    captureFails.current = 0;
    setLang(startLang);
    live.current.lang = startLang;
    // Unlock speech output on iPhone inside the tap; keep the screen on while talking.
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis?.speak(u); } catch { /* not available */ }
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((w) => { wake.current = w; }).catch(() => {});
    if (engine === 'recorder') {
      const v = new VadRecorder({
        onSpeechStart: () => setHeard('…'),
        onUtterance: (wav) => { void loop.current.heardAudio(wav); },
        onLevel: (l) => document.querySelector<HTMLElement>('.vorb')?.style.setProperty('--lvl', String(l)),
      });
      vad.current = v;
      setState('listening');
      v.start().catch(() => { loop.current.stop(); onError('Allow the microphone to use voice mode.'); });
      return;
    }
    loop.current.listen();
  };
  const end = () => loop.current.stop();
  const toggleMute = () => {
    if (!alive.current) return;
    if (muted.current) { muted.current = false; loop.current.listen(); return; }
    muted.current = true;
    turn.current++;
    clearTimers();
    killRec();
    hush();
    vad.current?.pause();
    setHeard('');
    setState('muted');
  };
  /** Tapping the orb while it talks interrupts it and listens straight away. */
  const interrupt = () => { if (stateRef.current === 'speaking') loop.current.listen(); };

  useEffect(() => { const l = loop.current; return () => l.stop(); }, []);
  return { state, heard, lang, start, end, toggleMute, interrupt };
}

// ---------- chat ----------
export default function ChatDock({ ctx, open, setOpen }: { ctx: Ctx; open: boolean; setOpen: (o: boolean) => void }) {
  const { d, role, lang } = ctx;
  const [q, setQ] = useState('');
  const [dictating, setDictating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [rowsOpen, setRowsOpen] = useState<number | null>(null);
  const recRef = useRef<Rec | null>(null);
  const oneShot = useRef<VadRecorder | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const engine = useEngine();
  const voice = useVoiceMode(lang, engine, role, (text) => d.ask(role, text), (m) => d.showToast(m, 'warning'));
  const voiceOn = voice.state !== 'off';

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [open, d.messages.length, voice.heard]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('chat-open'); // phones: stop the page behind from scrolling
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('chat-open'); };
  }, [open, setOpen]);
  useEffect(() => () => { recRef.current?.stop(); oneShot.current?.stop(); }, []);

  if (!can(role, 'chat.use')) return null;

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    void d.ask(role, t);
    setQ('');
  };

  const cantTalk = () => {
    const help = ENGINE_HELP[engine];
    if (help) { d.showToast(help, 'warning'); return true; }
    return false;
  };
  const startVoice = () => { if (!cantTalk()) voice.start(); };

  const toggleDictation = () => {
    if (cantTalk()) return;
    if (dictating) { recRef.current?.stop(); oneShot.current?.stop(); oneShot.current = null; setDictating(false); return; }
    if (engine === 'recorder') {
      const v = new VadRecorder({
        onUtterance: async (wav) => {
          v.stop();
          oneShot.current = null;
          setQ('…');
          const r = await transcribe(wav, role);
          setDictating(false);
          if ('error' in r) { setQ(''); d.showToast(r.error, 'warning'); return; }
          setQ('');
          if (r.text) submit(r.text);
        },
      });
      oneShot.current = v;
      setDictating(true);
      v.start().catch(() => { setDictating(false); oneShot.current = null; d.showToast('Allow the microphone to ask by voice.', 'warning'); });
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = SPEECH_LANG[lang];
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setQ((finalText + interim).trim());
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') d.showToast('Allow the microphone to ask by voice.', 'warning'); };
    rec.onend = () => {
      setDictating(false);
      recRef.current = null;
      if (finalText.trim()) submit(finalText);
    };
    recRef.current = rec;
    setDictating(true);
    rec.start();
  };

  const close = () => {
    voice.end();
    setClosing(true);
    setTimeout(() => { setClosing(false); setOpen(false); }, 220);
  };
  const suggestions = role === 'owner'
    ? ["What's happening today?", 'How many workers do I have?', 'Who folded how much today?', 'आज कितना माल आया?']
    : ["What's happening today?", 'Who folded how much today?', 'Open job cards', 'Shortage by worker this week'];
  const fresh = d.messages.length <= 1 && !voiceOn;
  const busy = d.messages.some((m) => m.loading);
  const caption = voice.state === 'listening' ? 'Listening' : voice.state === 'thinking' ? 'Thinking' : voice.state === 'speaking' ? 'Speaking' : 'Mic is off';

  return (
    <>
      {!open && (
        <button className="chat-fab" aria-label="Open chat" onClick={() => setOpen(true)}>
          <Icon name="chat" size={22} strokeWidth={2} />
        </button>
      )}
      {open && (
        <section className={`chat-pop ${closing ? 'closing' : ''}`} role="dialog" aria-label="Chat">
          <header className="chat-pop-head">
            <div className="stack-0 grow min0">
              <span className="strong ellipsis">Ask {firm().name}</span>
              <span className="muted tiny">{voiceOn ? `Voice · ${LANG_LABEL[voice.lang]}` : 'English · हिंदी · ગુજરાતી'}</span>
            </div>
            {!fresh && !voiceOn && <button className="ib sm-ib" aria-label="New chat" title="New chat" onClick={() => d.clearChat()}><Icon name="edit" size={16} /></button>}
            <button className="ib sm-ib" aria-label="Close chat" onClick={close}><Icon name="x" size={18} /></button>
          </header>

          <div className="chat-pop-body">
            {fresh ? (
              <div className="chat-empty">
                <span className="chat-empty-mark"><Icon name="chat" size={26} strokeWidth={1.8} /></span>
                <h2>What do you want to know?</h2>
                <p className="muted small">Type or talk — in English, हिंदी or ગુજરાતી.</p>
                <div className="chat-suggest">
                  {suggestions.map((s) => <button key={s} className="chat-suggest-item" onClick={() => submit(s)}>{s}</button>)}
                </div>
              </div>
            ) : (
              d.messages.slice(1).map((m, i) => (
                <div key={i} className={`cmsg ${m.sender} ${m.error ? 'err' : ''}`}>
                  {m.sender === 'bot' && <span className="cmsg-av"><Icon name="chat" size={14} strokeWidth={2} /></span>}
                  <div className="cmsg-body" lang={m.lang}>
                    {m.loading ? <span className="typing" aria-label="Thinking"><i /><i /><i /></span> : <span>{m.text}</span>}
                    {m.rows && m.rows.length > 1 && (
                      <div className="stack-6">
                        <button className="linkbtn small left" onClick={() => setRowsOpen(rowsOpen === i ? null : i)}>{rowsOpen === i ? 'Hide rows' : `Show ${m.rows.length} rows`}</button>
                        {rowsOpen === i && (
                          <div className="mini-table">
                            <table className="tbl">
                              <thead><tr>{Object.keys(m.rows[0]).map((k) => <th key={k}>{k.replace(/_/g, ' ')}</th>)}</tr></thead>
                              <tbody>{m.rows.slice(0, 20).map((r, ri) => <tr key={ri}>{Object.values(r).map((v, vi) => <td key={vi} className="num">{v == null ? '—' : String(v)}</td>)}</tr>)}</tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                    {m.sources && m.sources.length > 0 && <span className="muted tiny">From: {m.sources.map((s) => s.title).join(', ')}</span>}
                  </div>
                </div>
              ))
            )}
            {voiceOn && voice.heard && (
              <div className="cmsg user live"><div className="cmsg-body"><span>{voice.heard}</span></div></div>
            )}
            <div ref={endRef} />
          </div>

          {voiceOn ? (
            <div className={`voice-bar ${voice.state}`} role="group" aria-label="Voice mode">
              <button type="button" className={`vbtn ${voice.state === 'muted' ? 'off' : ''}`} aria-label={voice.state === 'muted' ? 'Turn mic on' : 'Mute mic'} aria-pressed={voice.state === 'muted'} onClick={voice.toggleMute}>
                <Icon name={voice.state === 'muted' ? 'micOff' : 'mic'} size={20} strokeWidth={2} />
              </button>
              <button type="button" className="vorb" aria-label={voice.state === 'speaking' ? 'Interrupt' : caption} onClick={voice.interrupt}>
                <span className="vorb-blob" /><span className="vorb-blob b2" /><span className="vorb-blob b3" />
              </button>
              <span className="vcaption" aria-live="polite">{caption}</span>
              <button type="button" className="vbtn end" aria-label="End voice mode" onClick={voice.end}><Icon name="x" size={20} strokeWidth={2.2} /></button>
            </div>
          ) : (
            <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); submit(q); }}>
              <input aria-label="Ask a question" placeholder={dictating ? 'Listening…' : 'Ask anything'} value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="send" />
              {engine !== 'server' && (
                <button type="button" className={`cbtn ${dictating ? 'rec' : ''}`} aria-label={dictating ? 'Stop dictation' : 'Dictate'} aria-pressed={dictating} onClick={toggleDictation}>
                  <Icon name="mic" size={18} strokeWidth={2} />
                </button>
              )}
              {q.trim() || engine === 'server' ? (
                <button className="cbtn primary" aria-label="Send" type="submit" disabled={!q.trim() || busy}><Icon name="send" size={17} strokeWidth={2} /></button>
              ) : (
                <button type="button" className="cbtn primary" aria-label="Start voice mode" title="Voice mode"  onClick={startVoice}><Icon name="wave" size={18} strokeWidth={2} /></button>
              )}
            </form>
          )}
        </section>
      )}
    </>
  );
}
