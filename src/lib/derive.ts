// Pure helpers that turn API data into the numbers each screen shows.
import type { Allotment, CctvActivity, JobCard, Worker } from './types';
import { SECTIONS, SHORTAGE_LIMIT_PCT, sectionName } from './access';

export interface WorkerDay {
  worker: Worker;
  section: string;
  allotted: number;
  done: number;
  eff: number | null; // null when nothing allotted today
  cards: JobCard[];
  cam: CctvActivity | null;
}

export function workerDay(worker: Worker, allotments: Allotment[], jobCards: JobCard[], cctv: CctvActivity[]): WorkerDay {
  const todays = allotments.filter((a) => a.worker_id === worker.id && a.is_today);
  const cardIds = new Set(todays.map((a) => a.job_card_id));
  const cards = jobCards.filter((j) => cardIds.has(j.id));
  const allotted = todays.reduce((s, a) => s + a.meters_allotted, 0);
  const done = cards.filter((j) => j.status === 'closed').reduce((s, j) => s + (j.meters_out ?? 0), 0);
  const cam = cctv.find((c) => c.worker_id === worker.id) ?? null; // API sorts newest first
  return { worker, section: sectionName(worker.section), allotted, done, eff: allotted > 0 ? Math.round((done / allotted) * 100) : null, cards, cam };
}

export function camStatus(cam: CctvActivity | null): { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (!cam) return { text: 'No camera', tone: 'neutral' };
  const a = Math.round(cam.active_pct);
  if (a < 60) return { text: `Active ${a}% · idle ${Math.round(cam.idle_min)}m`, tone: 'bad' };
  if (a < 80) return { text: `Active ${a}%`, tone: 'warn' };
  return { text: `Active ${a}%`, tone: 'good' };
}

export function avg(nums: number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function sectionRows(days: WorkerDay[], jobCards: JobCard[]) {
  return SECTIONS.map((sec) => {
    const cards = jobCards.filter((j) => sectionName(j.process) === sec);
    const open = cards.filter((j) => j.status !== 'closed').length;
    const closed = cards.filter((j) => j.status === 'closed' && j.meters_out != null);
    const shortage = avg(closed.map((j) => j.shortage_pct));
    const crew = days.filter((d) => d.section === sec);
    const allot = crew.reduce((s, d) => s + d.allotted, 0);
    const done = crew.reduce((s, d) => s + d.done, 0);
    return {
      name: sec,
      open,
      eff: allot > 0 ? Math.round((done / allot) * 100) : null,
      shortage,
      shortTone: shortage == null ? 'neutral' as const : shortage > SHORTAGE_LIMIT_PCT ? 'bad' as const : shortage > SHORTAGE_LIMIT_PCT / 2 ? 'warn' as const : 'good' as const,
    };
  });
}

export function shortTone(pct: number | null): 'good' | 'warn' | 'bad' | 'neutral' {
  if (pct == null) return 'neutral';
  return pct > SHORTAGE_LIMIT_PCT ? 'bad' : pct > SHORTAGE_LIMIT_PCT / 2 ? 'warn' : 'good';
}

export const STATUS_LABEL: Record<JobCard['status'], string> = { open: 'Open', 'in-process': 'In process', folded: 'Folded', closed: 'Closed' };
export const STATUS_TONE: Record<JobCard['status'], 'good' | 'warn' | 'info' | 'neutral'> = { open: 'neutral', 'in-process': 'warn', folded: 'info', closed: 'good' };

export const CAPTURE_LABEL = { incoming_stock: 'Incoming challan', outgoing_stock: 'Outgoing challan', job_card_folding: 'Folding job card' } as const;

export const FIELD_LABEL: Record<string, string> = {
  lot_id: 'Lot', quality: 'Quality', design: 'Design', meters: 'Meters', party: 'Party', source_doc: 'Challan',
  job_card_id: 'Job card', meters_out: 'Meters out', worker_id: 'Worker',
};

export const FIELDS_FOR = {
  incoming_stock: ['lot_id', 'party', 'source_doc', 'meters', 'quality', 'design'],
  outgoing_stock: ['lot_id', 'party', 'source_doc', 'meters'],
  job_card_folding: ['lot_id', 'job_card_id', 'meters_out', 'worker_id'],
} as const;
