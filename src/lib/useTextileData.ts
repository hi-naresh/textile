'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Allotment, CaptureEvent, CaptureType, CctvActivity, ChatMessage, EfficiencyRecord, FlowDay, JobCard, LedgerEntry, Lot, Toast, ToastTone, Worker } from './types';
import { ACTIVE_SUPERVISOR, OWNER, type Role } from './access';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed: ${url}`);
  return data as T;
}

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Request failed.');
  return data;
}

export function actorId(role: Role) {
  return role === 'owner' ? OWNER.id : ACTIVE_SUPERVISOR.id;
}

export function useTextileData() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [flow, setFlow] = useState<FlowDay[]>([]);
  const [jobCards, setJobCards] = useState<JobCard[]>([]);
  const [allotments, setAllotments] = useState<Allotment[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [efficiency, setEfficiency] = useState<EfficiencyRecord[]>([]);
  const [cctv, setCctv] = useState<CctvActivity[]>([]);
  const [captures, setCaptures] = useState<CaptureEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbOk, setDbOk] = useState<boolean | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, tone: ToastTone = 'success') => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [stock, jc, wk, cap] = await Promise.all([
        getJson<{ lots: Lot[]; ledger: LedgerEntry[]; flow?: FlowDay[] }>('/api/stock'),
        getJson<{ jobCards: JobCard[]; allotments: Allotment[] }>('/api/job-cards'),
        getJson<{ workers: Worker[]; efficiency: EfficiencyRecord[]; cctv: CctvActivity[] }>('/api/workers'),
        getJson<{ events: CaptureEvent[] }>('/api/capture'),
      ]);
      setLots(stock.lots || []);
      setLedger(stock.ledger || []);
      setFlow(stock.flow || []);
      setJobCards(jc.jobCards || []);
      setAllotments(jc.allotments || []);
      setWorkers(wk.workers || []);
      setEfficiency(wk.efficiency || []);
      setCctv(wk.cctv || []);
      setCaptures(cap.events || []);
      setDbOk(true);
      setLastSync(new Date());
    } catch (err) {
      console.error('Error loading data:', err);
      setDbOk(false);
      showToast('Could not load data. Check that Postgres is running.', 'danger');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    // Initial data load on mount (async fetch; state is set after the requests resolve).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [refresh]);

  // ---------- Actions (each refreshes data) ----------
  const run = useCallback(async (fn: () => Promise<unknown>, ok: string, tone: ToastTone = 'success') => {
    try {
      await fn();
      showToast(ok, tone);
      await refresh();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong.', 'danger');
      return false;
    }
  }, [refresh, showToast]);

  const addStock = (form: { lot_id: string; direction: 'IN' | 'OUT'; meters: string; party: string; source_doc: string; quality: string; design: string }) =>
    run(() => send('/api/stock', 'POST', form), `Stock ${form.direction} for ${form.lot_id} recorded`);

  const createJobCard = (form: { lot_id: string; process: string; worker_id: string; meters_in: string; shift: string }, workerName?: string) =>
    run(() => send('/api/job-cards', 'POST', form), `${form.meters_in} m on ${form.lot_id} allotted${workerName ? ` to ${workerName}` : ''}`);

  const closeJobCard = (id: number, metersOut: string) =>
    run(() => send('/api/job-cards', 'PATCH', { id, meters_out: metersOut }), `Job card JC-${id} closed`);

  const confirmCapture = (role: Role, ev: CaptureEvent, corrected?: Record<string, unknown>) =>
    run(
      () => send('/api/capture/confirm', 'POST', {
        event_id: ev.id,
        confirmed_by: actorId(role),
        status: corrected ? 'corrected' : 'confirmed',
        corrected_data: corrected ?? ev.ai_json,
      }),
      `Read #${ev.id} ${corrected ? 'corrected and ' : ''}confirmed · added to ledger`,
    );

  const rejectCapture = (role: Role, ev: CaptureEvent) =>
    run(() => send('/api/capture/confirm', 'POST', { event_id: ev.id, confirmed_by: actorId(role), status: 'rejected' }), `Read #${ev.id} rejected · retake needed`, 'warning');

  const uploadCapture = async (file: File, type: CaptureType) => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', type);
      const res = await fetch('/api/capture', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Photo reading failed.');
      const pct = Math.round((data.event?.confidence ?? 0) * 100);
      if (data.autoCommitted) showToast(`Read with ${pct}% confidence · saved to ledger`, 'success');
      else showToast(`Read with ${pct}% confidence · sent to supervisor for review`, 'warning');
      await refresh();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error during upload.', 'danger');
      return false;
    }
  };

  // ---------- Chat ----------
  const [messages, setMessages] = useState<ChatMessage[]>([
    { sender: 'bot', text: 'Ask anything about lots, stock balances, ledger movements, job cards or worker efficiency. I query the live database and every answer is logged.', timestamp: new Date() },
  ]);

  const ask = async (role: Role, question: string) => {
    if (!question.trim()) return;
    setMessages((m) => [...m, { sender: 'user', text: question, timestamp: new Date() }, { sender: 'bot', text: 'Thinking…', timestamp: new Date(), loading: true }]);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, user_id: actorId(role) }) });
      const data = await res.json();
      setMessages((m) => [
        ...m.filter((x) => !x.loading),
        res.ok
          ? { sender: 'bot', text: data.answer, sql: data.sql, rows: data.rows, timestamp: new Date() }
          : { sender: 'bot', text: data.error || 'Sorry, I could not answer that.', sql: data.sql, timestamp: new Date(), error: true },
      ]);
    } catch {
      setMessages((m) => [...m.filter((x) => !x.loading), { sender: 'bot', text: 'Network error. Is the server running?', timestamp: new Date(), error: true }]);
    }
  };

  return {
    lots, ledger, flow, jobCards, allotments, workers, efficiency, cctv, captures,
    loading, dbOk, lastSync, toast, showToast, refresh,
    addStock, createJobCard, closeJobCard, confirmCapture, rejectCapture, uploadCapture,
    messages, ask,
  };
}

export type TextileData = ReturnType<typeof useTextileData>;
