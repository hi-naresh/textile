'use client';

// Global search ("Search or ask" in the top bar; a search button in the phone header).
// Typing shows what matches — lots, challans, parties, orders, inquiries, dispatches, people, screens —
// grouped, best match first. Choosing one opens the screen with that item opened / filtered / highlighted
// (deep link: tab + URL hash, see openLink in src/lib/useApi.ts). The last row always asks the assistant;
// when the text reads like a question it comes first instead.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { Pill, Sheet, dayTime, fmt } from './ui';
import type { Ctx } from './ctx';
import { can, tabAllowed, type Tab } from '@/lib/access';
import { flashWhenReady, openLink, useApi, useHashLink } from '@/lib/useApi';
import type { HitHref, HitType, SearchGroup, SearchHit } from '@/lib/search';

type Row = { kind: 'hit'; hit: SearchHit } | { kind: 'ask'; text: string };

const ICON: Record<HitType, string> = {
  screen: 'arrow', lot: 'box', quality: 'box', design: 'box', challan: 'rows', party: 'users', order: 'cart', inquiry: 'chat',
  dispatch: 'truck', invoice: 'rupee', worker: 'users', supervisor: 'shield', section: 'factory',
};

const MONO = new Set<HitType>(['lot', 'challan']);

// Hindi / Gujarati script, a question mark, or question words (English, Hinglish, Gujarati in Latin letters).
const QUESTION = /[?ऀ-ॿ઀-૿]|^(how|what|which|who|whom|when|why|where|is|are|do|does|did|can|should|show|list|tell|give|compare|kitna|kitne|kitni|kaun|kaunsa|kya|kab|kahan|kaise|kyon|ketlu|ketla|ketli|kon|shu|kyare|kem)\b|\b(how much|how many|total|today|this week|this month|pending|overdue)\b/i;
export const looksLikeQuestion = (t: string) => QUESTION.test(t.trim()) || t.trim().split(/\s+/).length >= 6;

// ---- recent picks (this device only) ----
const RECENT_KEY = 'tb-search-recent';
type Recent = Pick<SearchHit, 'type' | 'id' | 'title' | 'subtitle' | 'href'>;
function readRecent(): Recent[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.slice(0, 6) : []; } catch { return []; }
}
function saveRecent(h: SearchHit) {
  try {
    const r: Recent = { type: h.type, id: h.id, title: h.title, subtitle: h.subtitle, href: h.href };
    localStorage.setItem(RECENT_KEY, JSON.stringify([r, ...readRecent().filter((x) => !(x.type === r.type && x.id === r.id))].slice(0, 6)));
  } catch { /* storage unavailable */ }
}

/** Opens where a hit points: a screen + hash, or the lot card. Returns false when this role can't open it. */
export function openHref(ctx: Ctx, href: HitHref, onLot: (id: string) => void): boolean {
  if ('sheet' in href) { onLot(href.id); return true; }
  if (!tabAllowed(ctx.role, href.tab)) return false;
  openLink(ctx.go, href.tab, href.hash);
  return true;
}

interface Props {
  ctx: Ctx;
  openChat: () => void;
  onLot: (id: string) => void;
  /** 'bar' = desktop top bar (dropdown); 'sheet' = phone search sheet (results inline). */
  variant: 'bar' | 'sheet';
  onDone?: () => void;
  autoFocus?: boolean;
}

export default function SearchBox({ ctx, openChat, onLot, variant, onDone, autoFocus = false }: Props) {
  const { role, d } = ctx;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<{ q: string; groups: SearchGroup[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const listId = useId();
  const chatOk = can(role, 'chat.use');
  const q = text.trim();

  const fetchHits = useCallback(async (value: string) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(value)}&limit=5`, { cache: 'no-store', signal: ac.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Could not search.');
      const out = { q: value, groups: (j.groups ?? []) as SearchGroup[] };
      if (!ac.signal.aborted) { setRes(out); setActive(0); setLoading(false); }
      return out;
    } catch {
      if (!ac.signal.aborted) { setRes({ q: value, groups: [] }); setLoading(false); }
      return { q: value, groups: [] as SearchGroup[] };
    }
  }, []);

  // Search while typing (short pause first).
  useEffect(() => {
    if (!q) { abort.current?.abort(); return; }
    const t = setTimeout(() => { void fetchHits(q); }, 140);
    return () => clearTimeout(t);
  }, [q, fetchHits]);

  // Close the desktop dropdown on an outside click.
  useEffect(() => {
    if (variant !== 'bar' || !open) return;
    const on = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [variant, open]);

  // "/" or Ctrl/⌘+K focuses the desktop search.
  useEffect(() => {
    if (variant !== 'bar') return;
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [variant]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- recent picks come from this device's storage after mount
    if (open || variant === 'sheet') setRecent(readRecent());
  }, [open, variant]);

  const rowsFor = useCallback((value: string, groups: SearchGroup[]): Row[] => {
    const hits: Row[] = groups.flatMap((g) => g.hits.map((hit) => ({ kind: 'hit' as const, hit })));
    if (!chatOk || !value) return hits;
    const ask: Row = { kind: 'ask', text: value };
    return looksLikeQuestion(value) ? [ask, ...hits] : [...hits, ask];
  }, [chatOk]);

  const current = res && res.q === q ? res : null;
  const rows = useMemo(() => (q ? rowsFor(q, current?.groups ?? []) : recent.map((r) => ({ kind: 'hit' as const, hit: { ...r, score: 0 } }))), [q, current, recent, rowsFor]);

  const done = () => { setOpen(false); setText(''); setRes(null); (document.activeElement as HTMLElement | null)?.blur?.(); onDone?.(); };

  const choose = (row: Row) => {
    if (row.kind === 'ask') {
      void d.ask(role, row.text);
      openChat();
      done();
      return;
    }
    if (!openHref(ctx, row.hit.href, onLot)) { d.showToast('You can’t open this here.', 'warning'); return; }
    saveRecent(row.hit);
    done();
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => (rows.length ? (a + 1) % rows.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0)); }
    else if (e.key === 'Escape') {
      if (variant === 'bar' && open) { e.preventDefault(); setOpen(false); } else if (text) { e.preventDefault(); setText(''); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!q && !rows.length) return;
      // Enter before the results for this text came back: search now, then take the best match.
      if (q && !current) {
        const out = await fetchHits(q);
        const r = rowsFor(q, out.groups);
        if (r[0]) choose(r[0]);
        return;
      }
      const row = rows[Math.min(active, rows.length - 1)];
      if (row) choose(row);
    }
  };

  const showList = variant === 'sheet' || (open && (!!q || rows.length > 0));
  const optionId = (i: number) => `${listId}-o${i}`;
  const renderRow = (row: Row) => {
    const i = rows.indexOf(row);
    const on = i === active;
    if (row.kind === 'ask') {
      return (
        <button key="ask" id={optionId(i)} type="button" role="option" aria-selected={on} className={`sb-row sb-ask ${on ? 'on' : ''}`}
          onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(row)}>
          <span className="sb-ic"><Icon name="chat" size={16} strokeWidth={2} /></span>
          <span className="sb-main"><span className="sb-title">Ask the assistant: “{row.text}”</span><span className="sb-sub">Get an answer in the chat</span></span>
          <Icon name="arrow" size={14} />
        </button>
      );
    }
    const h = row.hit;
    return (
      <button key={`${h.type}:${h.id}`} id={optionId(i)} type="button" role="option" aria-selected={on} className={`sb-row ${on ? 'on' : ''}`}
        onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(row)}>
        <span className="sb-ic"><Icon name={ICON[h.type] ?? 'search'} size={16} strokeWidth={2} /></span>
        <span className="sb-main"><span className={`sb-title ${MONO.has(h.type) ? 'num' : ''}`}>{h.title}</span>{h.subtitle && <span className="sb-sub">{h.subtitle}</span>}</span>
        <Icon name="arrow" size={14} />
      </button>
    );
  };

  const hitRows = rows.filter((r): r is Extract<Row, { kind: 'hit' }> => r.kind === 'hit');
  const askRow = rows.find((r) => r.kind === 'ask');
  const askFirst = rows[0]?.kind === 'ask';
  const groupsShown: { label: string; rows: Row[] }[] = q
    ? (current?.groups ?? []).map((g) => ({ label: g.label, rows: hitRows.filter((r) => r.hit.type === g.type) })).filter((g) => g.rows.length)
    : hitRows.length ? [{ label: 'Recent', rows: hitRows }] : [];
  // Keep the visual order equal to the keyboard order (rows): ask first/last, groups in between.
  const list = (
    <div className={`sb-list sb-v-${variant}`} id={listId} role="listbox" aria-label="Search results">
      {askRow && askFirst && renderRow(askRow)}
      {groupsShown.map((g) => (
        <div key={g.label} className="sb-group" role="group" aria-label={g.label}>
          <div className="sb-label">{g.label}</div>
          {g.rows.map(renderRow)}
        </div>
      ))}
      {q && current && !hitRows.length && <div className="sb-empty">{loading ? 'Searching…' : `Nothing found for “${q}”.`}{chatOk ? ' Ask the assistant below.' : ''}</div>}
      {q && !current && <div className="sb-empty">Searching…</div>}
      {!q && !hitRows.length && <div className="sb-empty">Type a lot no., challan, party, order #, worker…</div>}
      {askRow && !askFirst && renderRow(askRow)}
    </div>
  );

  return (
    <div ref={boxRef} className={`sb sb-v-${variant}`}>
      <form className="search sb-input" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={16} strokeWidth={2} />
        <input ref={inputRef} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={showList && rows.length ? optionId(Math.min(active, rows.length - 1)) : undefined}
          aria-label="Search or ask" placeholder={variant === 'bar' ? 'Search a lot, party, challan, worker… or ask' : 'Lot, party, challan, order, worker… or ask'}
          value={text} autoFocus={autoFocus} autoComplete="off" spellCheck={false} enterKeyHint="go"
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
        {text ? <button type="button" className="ib sm-ib sb-clear" aria-label="Clear" onClick={() => { setText(''); inputRef.current?.focus(); }}><Icon name="x" size={14} /></button>
          : variant === 'bar' ? <kbd className="num">/</kbd> : null}
      </form>
      {showList && list}
    </div>
  );
}

/** Phone header button → full-width search sheet. */
export function SearchButton({ ctx, openChat, onLot }: { ctx: Ctx; openChat: () => void; onLot: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ib m-chat" aria-label="Search" onClick={() => setOpen(true)}><Icon name="search" size={20} strokeWidth={2} /></button>
      {/* Portal: the phone header uses backdrop-filter, which would trap a fixed-position sheet inside it. */}
      {open && createPortal(
        <div className="sb-sheet" role="dialog" aria-modal="true" aria-label="Search">
          <div className="sb-sheet-head">
            <SearchBox ctx={ctx} openChat={openChat} onLot={onLot} variant="sheet" autoFocus onDone={() => setOpen(false)} />
            <button type="button" className="linkbtn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** "#find=<text>" (e.g. a worker on the supervisor's Floor screen): scroll to + highlight the row showing that text. */
export function useFindLink() {
  const link = useHashLink('find');
  useEffect(() => {
    if (!link.value) return;
    return flashWhenReady({ text: link.value });
  }, [link]);
}

// ---------------- Lot card (for people without the Stock screen) ----------------
interface LotCardData {
  lot: { lot_id: string; quality: string | null; design: string | null; grade: string | null; status: string | null; balance: number; location: string | null };
  moves: { id: number; direction: string; meters: number; party: string | null; doc: string | null; sr_no: number | null; ts: string }[];
  jobs: { id: number; process: string; worker: string | null; meters_in: number; meters_out: number | null; status: string }[];
}

export function LotSheet({ ctx, id, onClose }: { ctx: Ctx; id: string | null; onClose: () => void }) {
  const { data, error, loading } = useApi<LotCardData>(id ? `/api/search/lot?id=${encodeURIComponent(id)}` : null);
  const show = data && data.lot.lot_id === id ? data : null;
  const canJobs = tabAllowed(ctx.role, 'jobs' as Tab);
  return (
    <Sheet open={id != null} title={id ? `Lot ${id}` : 'Lot'} onClose={onClose}>
      {error && <div className="alert bad">{error}</div>}
      {!show && !error && loading && <div className="loading"><span className="spinner" />Loading…</div>}
      {show && (
        <div className="stack-16">
          <div className="sb-lot-kpis">
            <div><span className="muted tiny">In stock</span><span className="strong num">{fmt(show.lot.balance, 1)} m</span></div>
            <div><span className="muted tiny">Quality</span><span className="strong">{show.lot.quality ?? '—'}{show.lot.design ? ` · ${show.lot.design}` : ''}</span></div>
            <div><span className="muted tiny">Where</span><span className="strong">{show.lot.location ?? '—'}</span></div>
          </div>
          <section className="stack-6">
            <h3 className="h3">Job cards</h3>
            {show.jobs.length ? (
              <div className="list">
                {show.jobs.map((j) => (
                  <div key={j.id} className="list-row">
                    <div className="stack-2 grow min0"><span className="strong num">JC-{j.id} · {j.process}</span><span className="muted small">{j.worker ?? '—'} · in {fmt(j.meters_in, 1)} m{j.meters_out != null ? ` · out ${fmt(j.meters_out, 1)} m` : ''}</span></div>
                    <Pill tone={j.status === 'closed' ? 'good' : 'info'}>{j.status}</Pill>
                  </div>
                ))}
              </div>
            ) : <span className="muted small">No job cards for this lot in your sections.</span>}
            {canJobs && show.jobs.length > 0 && (
              <button type="button" className="btn sm left" onClick={() => { onClose(); openLink(ctx.go, 'jobs', `find=${encodeURIComponent(show.lot.lot_id)}`); }}>
                <Icon name="card" size={15} />Show in Job cards
              </button>
            )}
          </section>
          <section className="stack-6">
            <h3 className="h3">Latest movements</h3>
            <div className="list">
              {show.moves.map((m) => (
                <div key={m.id} className="list-row">
                  <Pill tone={m.direction === 'IN' ? 'good' : 'warn'}>{m.direction === 'IN' ? 'In' : 'Out'}</Pill>
                  <div className="stack-2 grow min0"><span className="strong num">{fmt(m.meters, 1)} m{m.party ? ` · ${m.party}` : ''}</span><span className="muted small num">{[m.doc, m.sr_no ? `SR ${m.sr_no}` : null, dayTime(m.ts)].filter(Boolean).join(' · ')}</span></div>
                </div>
              ))}
              {!show.moves.length && <span className="muted small" style={{ padding: 14 }}>No movements yet.</span>}
            </div>
          </section>
        </div>
      )}
    </Sheet>
  );
}
