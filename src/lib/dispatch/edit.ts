import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import { applyLedgerEdits, type EditChange } from '../ledger-edit';
import { entryDateValue } from '../entry-date';
import { challanCode, nameValue } from '../normalize';
import { partyByName } from '../parties';
import { refreshOrderStatus } from '../orderStatus';
import { onOutgoing } from '../agents/logistics-hook';
import { markAgentsStale } from '../agents/stale';
import { trimReservations } from '../stock';
import { getDispatch } from './dispatches';

export async function dispatchEditHistory(q: Q, id: number) {
  return (await q(`SELECT e.before_value, e.after_value, e.edited_at, COALESCE(u.name, e.edited_by) AS edited_by
    FROM dispatch_edits e LEFT JOIN users u ON u.id = e.edited_by WHERE e.dispatch_id = $1 ORDER BY e.id DESC LIMIT 50`, [id])).rows;
}

/** Caller owns the transaction. Metadata corrections never send a WhatsApp message. */
export async function editDispatch(q: Q, id: number, body: Record<string, unknown>, actor: string) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new LedgerError('A valid dispatch id is required.');
  const allowed = ['party', 'date', 'challan_no', 'transporter', 'lr_no', 'vehicle_no', 'packages', 'lines'];
  if (!Object.keys(body).length || Object.keys(body).some((k) => !allowed.includes(k))) throw new LedgerError('Send dispatch fields to correct.');
  await markAgentsStale(q);
  await q(`SELECT id FROM orders WHERE id IN (SELECT order_id FROM stock_movements WHERE dispatch_id = $1) ORDER BY id FOR UPDATE`, [id]);
  const locked = await q(`SELECT *, to_char(dispatched_at, 'YYYY-MM-DD') AS date FROM dispatches WHERE id = $1 FOR UPDATE`, [id]);
  const old = locked.rows[0];
  if (!old) throw new LedgerError(`Dispatch #${id} not found.`, 404);
  const before = await getDispatch(q, id, true);
  const updates: Record<string, string | number | null> = {};
  const changes: EditChange[] = [];
  const addToLines = (field: 'party' | 'date' | 'source_doc_id', value: string) => {
    for (const line of before.lines) changes.push({ target: 'movement', id: line.movement_id, field, value });
  };
  for (const [field, max] of [['transporter', 100], ['lr_no', 40], ['vehicle_no', 20]] as const) {
    if (!(field in body)) continue;
    if (body[field] != null && typeof body[field] !== 'string') throw new LedgerError(`${field} must be text.`);
    const text = String(body[field] ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > max) throw new LedgerError(`${field} must be ${max} characters or fewer.`);
    updates[field] = (field === 'vehicle_no' ? text.toUpperCase() : text) || null;
  }
  if ('packages' in body) {
    const value = body.packages == null || body.packages === '' ? null : Number(body.packages);
    if (value != null && (!Number.isInteger(value) || value < 0 || value > 100_000)) throw new LedgerError('Packages must be a whole number from 0 to 100,000.');
    updates.packages = value;
  }
  if ('challan_no' in body) {
    const challan = challanCode(body.challan_no);
    if (!challan) throw new LedgerError('Challan number is required.');
    await q(`SELECT pg_advisory_xact_lock(hashtext('dispatch-challan:' || $1))`, [challan]);
    const dup = await q(`SELECT id FROM dispatches WHERE upper(challan_no) = $1 AND id <> $2`, [challan, id]);
    if (dup.rows.length) throw new LedgerError(`Challan ${challan} is already used.`, 409);
    updates.challan_no = challan;
    if (challan !== old.challan_no) addToLines('source_doc_id', challan);
  }
  if ('date' in body) {
    updates.date = entryDateValue(String(body.date ?? ''));
    if (updates.date !== old.date) addToLines('date', updates.date);
  }
  let partyChanged = false;
  if ('party' in body) {
    const name = nameValue(body.party, 'Party');
    if (!name) throw new LedgerError('Party is required.');
    const party = await partyByName(q, name, true);
    updates.party_id = party!.id;
    partyChanged = party!.id !== old.party_id;
    if (partyChanged) addToLines('party', party!.name);
  }
  if ('lines' in body) {
    if (!Array.isArray(body.lines) || body.lines.length > 200) throw new LedgerError('Send up to 200 existing lines.');
    const ids = new Set(before.lines.map((l) => l.movement_id));
    const seen = new Set<number>();
    for (const line of body.lines) {
      if (!line || !ids.has(line.movement_id) || seen.has(line.movement_id) || !['number', 'string'].includes(typeof line.meters)) throw new LedgerError('Each line must identify one existing movement and its meters.');
      seen.add(line.movement_id);
      changes.push({ target: 'movement', id: line.movement_id, field: 'meters', value: line.meters });
    }
  }
  const invoice = before.dispatch.invoice_no;
  if (invoice && (partyChanged || updates.date != null && updates.date !== old.date || updates.challan_no != null && updates.challan_no !== old.challan_no)) {
    throw new LedgerError(`Cancel invoice ${invoice} before correcting its party, date or challan.`, 409);
  }
  const result = changes.length ? await applyLedgerEdits(q, changes, actor, { dispatchHeader: true }) : { warnings: [] };
  for (const [field, value] of Object.entries(updates)) {
    if (String(value ?? '') === String(old[field] ?? '')) continue;
    if (field === 'date') await q(`UPDATE dispatches SET dispatched_at = ($2::date + dispatched_at::time) WHERE id = $1`, [id, value]);
    else await q(`UPDATE dispatches SET ${field} = $2 WHERE id = $1`, [id, value]); // fixed keys above
  }
  if (partyChanged) {
    const orders = [...new Set(before.lines.flatMap((l) => l.order_id == null ? [] : [l.order_id]))].sort((a, b) => a - b);
    await q('UPDATE stock_movements SET order_id = NULL WHERE dispatch_id = $1', [id]);
    await q('UPDATE dispatches SET order_id = NULL WHERE id = $1', [id]);
    for (const order of orders) await refreshOrderStatus(q, order);
    const movements = await q('SELECT * FROM stock_movements WHERE dispatch_id = $1 ORDER BY id', [id]);
    for (const m of movements.rows) await onOutgoing(q, m, actor);
    for (const lot of new Set(before.lines.map((l) => l.lot_id))) await trimReservations(q, lot);
  }
  const after = await getDispatch(q, id, true);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await q(`INSERT INTO dispatch_edits (dispatch_id, before_value, after_value, edited_by) VALUES ($1, $2::jsonb, $3::jsonb, $4)`, [id, JSON.stringify(before), JSON.stringify(after), actor]);
  }
  return { ...after, warnings: result.warnings, edits: await dispatchEditHistory(q, id) };
}
