// Shared by the review screen and server. Uncertain codes always need an explicit choice.
import type { RegOutRow } from './register-import';
import { statusFromLotS } from './registers';
import { LedgerError } from './ledger-error';

export type ImportStatus = 'running' | 'end';
export type StatusChoices = Record<string, ImportStatus>;

export function reviewStatuses(rows: RegOutRow[], choices: StatusChoices = {}) {
  const last = new Map<string, number>();
  rows.forEach((r) => last.set(r.lot_id, r.row));
  return rows.map((r) => {
    const mapped = statusFromLotS(r.lot_status_code);
    const chosen = mapped ?? (Object.hasOwn(choices, r.lot_id) ? choices[r.lot_id] : null);
    const deferredEnd = chosen === 'end' && last.get(r.lot_id) !== r.row;
    return {
      row: r.row, lot_id: r.lot_id, code: r.lot_status_code,
      needsChoice: mapped == null, deferredEnd,
      status: deferredEnd ? 'running' as const : chosen,
    };
  });
}

export function resolveReview(rows: RegOutRow[], choices: unknown): RegOutRow[] {
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new LedgerError('Choose the missing lot statuses before confirming.');
  const validLots = new Set(rows.filter((r) => !statusFromLotS(r.lot_status_code)).map((r) => r.lot_id));
  for (const [lot, status] of Object.entries(choices)) {
    if (!validLots.has(lot) || (status !== 'running' && status !== 'end')) throw new LedgerError('Invalid lot status choice. Review the file again.');
  }
  const reviewed = reviewStatuses(rows, choices as StatusChoices);
  return rows.map((r, i) => {
    const status = reviewed[i].status;
    if (status !== 'running' && status !== 'end') throw new LedgerError(`Choose Running or End for lot ${r.lot_id} (row ${r.row}) before confirming.`);
    return { ...r, entry_status: status };
  });
}
