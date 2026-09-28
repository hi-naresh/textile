'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Features, KnownNames, LotLocationEntry, Allotment, CaptureEvent, CaptureType, CctvActivity, ChatMessage, EfficiencyRecord, FlowDay, JobCard, LedgerEntry, Lot, Toast, ToastTone, Worker } from './types';
import { activeSupervisor, owner, setFirmConfig, type Role } from './access';
import { DEFAULT_CONFIG, type FirmConfig } from './config';

export interface ValueWindow { days: number; captures: number; manualMin: number; actualMin: number; savedMin: number; baseline: { challanMin: number; jobCardMin: number } }
export interface ValueSummary { today: ValueWindow; week: ValueWindow; month: ValueWindow }
export interface KnowledgeDoc { id: number; title: string; body: string; active: boolean; updated_at: string }

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

export interface StockEntry {
  direction: 'IN' | 'OUT';
  lot_id: string;
  // IN
  grey_meters: string;
  finished_meters: string;
  mill_name: string;
  weaver_name: string;
  location: string;
  quality: string;
  design: string;
  // OUT
  meters: string;
  party: string;
  // both
  source_doc: string;
}

/**
 * Phone photos are often 3–8 MB; hosted servers cap uploads (Vercel: 4.5 MB) and shop-floor
 * networks are slow. Resize to ≤2000 px and re-encode as JPEG. Falls back to the original
 * if the browser can't decode the format.
 */
export async function shrinkPhoto(file: File, maxSide = 2000, quality = 0.85): Promise<File> {
  if (typeof window === 'undefined' || file.size < 900 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function actorId(role: Role) {
  return role === 'owner' ? owner().id : activeSupervisor().id || null;
}

export function useTextileData() {
  const [lots, setLots] = useState<Lot[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [flow, setFlow] = useState<FlowDay[]>([]);
  const [config, setConfigState] = useState<FirmConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<Features | null>(null);

  // Which features work right now (photo reading, AI text). Plain yes/no; details are developer-only.
  // Re-checked every 10 minutes.
  const checkStatus = useCallback(async () => {
    try {
      const s = await getJson<Features>('/api/status');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkStatus();
    const id = setInterval(() => checkStatus(), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [checkStatus]);
  const [names, setNames] = useState<KnownNames>({ mills: [], weavers: [], parties: [] });
  const [jobCards, setJobCards] = useState<JobCard[]>([]);
  const [allotments, setAllotments] = useState<Allotment[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [efficiency, setEfficiency] = useState<EfficiencyRecord[]>([]);
  const [cctv, setCctv] = useState<CctvActivity[]>([]);
  const [captures, setCaptures] = useState<CaptureEvent[]>([]);
  const [value, setValue] = useState<ValueSummary | null>(null);
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
      const [settings, stock, jc, wk, cap] = await Promise.all([
        getJson<{ config: FirmConfig }>('/api/settings'),
        getJson<{ lots: Lot[]; ledger: LedgerEntry[]; flow?: FlowDay[]; names?: KnownNames }>('/api/stock'),
        getJson<{ jobCards: JobCard[]; allotments: Allotment[] }>('/api/job-cards'),
        getJson<{ workers: Worker[]; efficiency: EfficiencyRecord[]; cctv: CctvActivity[] }>('/api/workers'),
        getJson<{ events: CaptureEvent[] }>('/api/capture'),
      ]);
      setFirmConfig(settings.config);
      setConfigState(settings.config);
      setLots(stock.lots || []);
      setLedger(stock.ledger || []);
      setFlow(stock.flow || []);
      setNames(stock.names || { mills: [], weavers: [], parties: [] });
      setJobCards(jc.jobCards || []);
      setAllotments(jc.allotments || []);
      setWorkers(wk.workers || []);
      setEfficiency(wk.efficiency || []);
      setCctv(wk.cctv || []);
      setCaptures(cap.events || []);
      getJson<ValueSummary>('/api/value').then(setValue).catch(() => setValue(null));
      setDbOk(true);
      setLastSync(new Date());
    } catch (err) {
      console.error('Error loading data:', err);
      setDbOk(false);
      showToast('Something went wrong loading data, try again.', 'danger');
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

  const addStock = (role: Role, form: StockEntry) => {
    const body = form.direction === 'IN'
      ? { direction: 'IN', lot_id: form.lot_id, grey_meters: form.grey_meters, finished_meters: form.finished_meters, mill_name: form.mill_name, weaver_name: form.weaver_name, source_doc: form.source_doc, location: form.location, quality: form.quality, design: form.design, moved_by: actorId(role) }
      : { direction: 'OUT', lot_id: form.lot_id, meters: form.meters, party: form.party, source_doc: form.source_doc, moved_by: actorId(role) };
    return run(() => send('/api/stock', 'POST', body), form.direction === 'IN' ? `${form.lot_id} received into ${form.location || 'Godown'}` : `${form.meters} m of ${form.lot_id} dispatched to ${form.party}`);
  };

  const moveLot = (role: Role, lotId: string, location: string, note: string) =>
    run(() => send('/api/lots/location', 'POST', { lot_id: lotId, location, note, moved_by: actorId(role) }), `${lotId} moved to ${location}`);

  const lotHistory = async (lotId: string): Promise<LotLocationEntry[]> => {
    const data = await getJson<{ history: LotLocationEntry[] }>(`/api/lots/location?lot_id=${encodeURIComponent(lotId)}`);
    return data.history || [];
  };

  const createJobCard = (role: Role, form: { lot_id: string; process: string; worker_id: string; meters_in: string; shift: string }, workerName?: string) =>
    run(() => send('/api/job-cards', 'POST', { ...form, moved_by: actorId(role) }), `${form.meters_in} m on ${form.lot_id} allotted${workerName ? ` to ${workerName}` : ''}`);

  const closeJobCard = (role: Role, id: number, metersOut: string) =>
    run(() => send('/api/job-cards', 'PATCH', { id, meters_out: metersOut, moved_by: actorId(role) }), `Job card JC-${id} closed`);

  const confirmCapture = (role: Role, ev: CaptureEvent, corrected?: Record<string, unknown>, reviewSeconds?: number | null) =>
    run(
      () => send('/api/capture/confirm', 'POST', {
        event_id: ev.id,
        confirmed_by: actorId(role),
        status: corrected ? 'corrected' : 'confirmed',
        corrected_data: corrected ?? ev.ai_json,
        review_seconds: reviewSeconds ?? null,
      }),
      `Read #${ev.id} ${corrected ? 'corrected and ' : ''}confirmed · added to ledger`,
    );

  const rejectCapture = (role: Role, ev: CaptureEvent, reviewSeconds?: number | null) =>
    run(() => send('/api/capture/confirm', 'POST', { event_id: ev.id, confirmed_by: actorId(role), status: 'rejected', review_seconds: reviewSeconds ?? null }), `Read #${ev.id} rejected · retake needed`, 'warning');

  /** `startedAt`: when the person opened the camera / picked the photo (for the time-saved figure). */
  const uploadCapture = async (original: File, type: CaptureType, role: Role, startedAt?: number | null) => {
    try {
      const file = await shrinkPhoto(original);
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', type);
      fd.append('role', role);
      const by = role === 'worker' ? null : actorId(role);
      if (by) fd.append('captured_by', by);
      if (startedAt) fd.append('capture_seconds', String(Math.max(0, Math.round((Date.now() - startedAt) / 1000))));
      const res = await fetch('/api/capture', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) { checkStatus(); throw new Error(data?.error || 'Photo reading failed.'); }
      const pct = Math.round((data.event?.confidence ?? 0) * 100);
      if (data.autoCommitted) showToast(`Read ${pct}% sure · saved`, 'success');
      else showToast(`Read ${pct}% sure · sent for review`, 'warning');
      await refresh();
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error during upload.', 'danger');
      return false;
    }
  };

  // ---------- Excel ----------
  const importStock = async (role: Role, file: File): Promise<{ ok: boolean; rows?: { row: number; error: string }[] }> => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('role', role);
      const by = actorId(role);
      if (by) fd.append('moved_by', by);
      const res = await fetch('/api/stock/import', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data?.error || 'Import failed.', 'danger'); return { ok: false, rows: data?.rows }; }
      showToast(`Imported ${data.imported.in} incoming + ${data.imported.out} outgoing`, 'success');
      await refresh();
      return { ok: true };
    } catch {
      showToast('Network error during import.', 'danger');
      return { ok: false };
    }
  };

  // ---------- Settings (owner) ----------
  // Memoised so screens can depend on it without re-running effects every render.
  const settingsApi = useMemo(() => {
    const save = async (path: string, method: string, body: unknown, ok: string) => {
      try {
        const data = await send(path, method, body);
        if (data?.config) { setFirmConfig(data.config); setConfigState(data.config); }
        showToast(ok, 'success');
        await refresh();
        return true;
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Could not save.', 'danger');
        return false;
      }
    };
    return {
      updateFirm: (body: Record<string, unknown>) => save('/api/settings', 'PUT', body, 'Settings saved'),
      addSupervisor: (name: string, sections: number[]) => save('/api/settings/users', 'POST', { name, sections }, `${name} added as supervisor`),
      updateUser: (id: string, body: Record<string, unknown>) => save('/api/settings/users', 'PATCH', { id, ...body }, 'Saved'),
      addSection: (name: string) => save('/api/settings/sections', 'POST', { name }, `Section ${name} added`),
      updateSection: (id: number, body: Record<string, unknown>) => save('/api/settings/sections', 'PATCH', { id, ...body }, 'Section saved'),
      addWorker: (name: string, section: string) => save('/api/workers', 'POST', { name, section }, `${name} added`),
      updateWorker: (id: string, body: Record<string, unknown>) => save('/api/workers', 'PATCH', { id, ...body }, 'Worker saved'),
      knowledge: async (): Promise<KnowledgeDoc[]> => (await getJson<{ docs: KnowledgeDoc[] }>('/api/knowledge')).docs,
      addKnowledge: (title: string, body: string) => save('/api/knowledge', 'POST', { title, body }, 'Note added'),
      updateKnowledge: (id: number, body: Record<string, unknown>) => save('/api/knowledge', 'PATCH', { id, ...body }, 'Note saved'),
      allWorkers: async (): Promise<(Worker & { active: boolean })[]> => (await getJson<{ workers: (Worker & { active: boolean })[] }>('/api/workers?include_inactive=1')).workers,
    };
  }, [refresh, showToast]);

  // ---------- Chat ----------
  const [messages, setMessages] = useState<ChatMessage[]>([
    { sender: 'bot', text: 'Ask about stock, a lot, a challan, dispatches, job cards, shortage or efficiency.', timestamp: new Date() },
  ]);

  /** Sends a question to chat; resolves with the answer + its language (null on failure) so voice mode can speak it. */
  const ask = async (role: Role, question: string): Promise<{ text: string; lang: 'en' | 'hi' | 'gu' } | null> => {
    if (!question.trim()) return null;
    setMessages((m) => [...m, { sender: 'user', text: question, timestamp: new Date() }, { sender: 'bot', text: 'Thinking…', timestamp: new Date(), loading: true }]);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, user_id: actorId(role), role }) });
      const data = await res.json();
      const msg: ChatMessage = res.ok
        ? { sender: 'bot', text: data.answer, rows: data.rows, route: data.route, sources: data.sources, lang: data.lang, timestamp: new Date() }
        : { sender: 'bot', text: data.error || 'Sorry, I could not answer that.', timestamp: new Date(), error: true };
      setMessages((m) => [...m.filter((x) => !x.loading), msg]);
      return { text: msg.text, lang: msg.lang ?? 'en' };
    } catch {
      setMessages((m) => [...m.filter((x) => !x.loading), { sender: 'bot', text: 'Network error. Is the server running?', timestamp: new Date(), error: true }]);
      return null;
    }
  };
  const clearChat = () => setMessages((m) => m.slice(0, 1));

  return {
    config, settingsApi, status, checkStatus,
    lots, ledger, flow, names, jobCards, allotments, workers, efficiency, cctv, captures,
    loading, dbOk, lastSync, toast, showToast, refresh,
    value, importStock,
    addStock, moveLot, lotHistory, createJobCard, closeJobCard, confirmCapture, rejectCapture, uploadCapture,
    messages, ask, clearChat,
  };
}

export type TextileData = ReturnType<typeof useTextileData>;
