// What the app sends on WhatsApp: payment reminders, dispatch messages, the owner's morning summary, a test.
// Every function returns a plain result and never throws into the caller (see send.ts).
import { query, type Q } from '../db';
import { readBilling } from '../billing';
import { logError } from '../errors';
import { creditSummary, partyCredit, type PartyCredit } from '../money/credit';
import { todayIST } from '../sales/util';
import { waConnected, waNumber } from './config';
import { enqueue, send, sleep, type QueuedJob, type SendResult } from './send';
import { readWaSettings, REMINDER_GAP_DAYS, type WaSettings } from './settings';
import { amount, ddmmyyyy, HELLO_WORLD, words } from './templates';

const run: Q = (text, params) => query(text, params as never[]);

const MAX_BILLS_LISTED = 5;
const MAX_AUTO_REMINDERS = 25; // per daily run
const GAP_MS = 300; // between messages in a batch (rate-limit friendly)

// ---------- Payment reminder ----------
export function reminderParams(c: PartyCredit, firm: string, lang: string): { params: string[]; invoiceIds: number[] } {
  const w = words(lang);
  const unpaid = c.invoices.filter((i) => i.unpaid > 0).sort((a, b) => b.days_past_due - a.days_past_due);
  const bills = unpaid.slice(0, MAX_BILLS_LISTED).map((i) => `${i.invoice_no} (${i.days_past_due > 0 ? w.overdue(i.days_past_due) : w.due(ddmmyyyy(i.due_date))})`);
  if (unpaid.length > MAX_BILLS_LISTED) bills.push(w.more(unpaid.length - MAX_BILLS_LISTED));
  return { params: [c.name, firm, amount(c.outstanding), bills.join(', ')], invoiceIds: unpaid.map((i) => i.id) };
}

export interface ReminderResult extends SendResult { message: string; lastAt?: string }

/**
 * Owner's "Send on WhatsApp" (force = send even if one went in the last 7 days) and the daily auto job.
 * Not more than one reminder per party per REMINDER_GAP_DAYS unless forced.
 */
export async function sendReminder(partyId: number, opts: { force?: boolean; by: string; settings?: WaSettings; auto?: boolean }): Promise<ReminderResult> {
  try {
    if (!waConnected()) return { ok: false, skipped: 'not_connected', message: 'WhatsApp is not connected. Use “Open in WhatsApp” instead.' };
    const c = await partyCredit(run, partyId);
    if (!c) return { ok: false, message: 'Party not found.' };
    if (c.outstanding <= 0 || !c.invoices.some((i) => i.unpaid > 0)) return { ok: false, message: `Nothing is pending from ${c.name} right now.` };
    if (!waNumber(c.phone ?? '')) return { ok: false, skipped: 'no_number', message: `No mobile number saved for ${c.name}. Add it in My firm → Parties.` };
    if (!opts.force) {
      const r = await run(
        `SELECT max(created_at) AS at FROM whatsapp_messages
         WHERE party_id = $1 AND purpose = 'reminder' AND direction = 'out' AND status <> 'failed' AND created_at > now() - ($2::int * interval '1 day')`,
        [partyId, REMINDER_GAP_DAYS],
      );
      if (r.rows[0]?.at) {
        const at = new Date(r.rows[0].at).toISOString();
        return { ok: false, skipped: 'duplicate', lastAt: at, message: `A reminder already went to ${c.name} in the last ${REMINDER_GAP_DAYS} days.` };
      }
    }
    const s = opts.settings ?? await readWaSettings();
    const firm = (await readBilling(run)).legalName;
    const { params, invoiceIds } = reminderParams(c, firm, s.lang);
    const r = await send({
      purpose: 'reminder', to: c.phone, template: s.templates.reminder, lang: s.lang, params, partyId, invoiceIds, sentBy: opts.auto ? 'auto' : opts.by,
      // Same day, not forced → one message even if the button / cron runs twice.
      dedupeKey: opts.force ? null : `reminder:${partyId}:${todayIST()}`,
    });
    return { ...r, message: r.ok ? (r.skipped === 'duplicate' ? `A reminder already went to ${c.name} today.` : `Reminder sent to ${c.name} on WhatsApp.`) : `Could not send: ${r.error ?? 'unknown error'}` };
  } catch (e) {
    logError('whatsapp.reminder', e, { partyId });
    return { ok: false, message: 'Could not send the reminder. Try again, or use “Open in WhatsApp”.' };
  }
}

/** Daily job: parties with a bill overdue by at least N days, a number, and no reminder in the last 7 days. */
export async function autoReminders(s: WaSettings): Promise<{ sent: number; failed: number; skipped: number; stoppedForRateLimit: boolean }> {
  const out = { sent: 0, failed: 0, skipped: 0, stoppedForRateLimit: false };
  const rows = (await creditSummary(run)).filter((p) => p.overdue > 0 && p.oldest_due_days >= s.reminder_days)
    .sort((a, b) => b.overdue - a.overdue);
  for (const p of rows) {
    if (out.sent + out.failed >= MAX_AUTO_REMINDERS) break;
    if (!waNumber(p.phone ?? '')) { out.skipped++; continue; }
    const r = await sendReminder(p.party_id, { by: 'auto', auto: true, settings: s });
    if (r.ok && !r.skipped) out.sent++;
    else if (r.skipped || !r.id) out.skipped++;
    else out.failed++;
    if (r.rateLimited) { out.stoppedForRateLimit = true; break; }
    if (r.id && !r.skipped) await sleep(GAP_MS);
  }
  return out;
}

// ---------- Dispatch message ----------
export async function dispatchParams(q: Q, dispatchId: number, firm: string, lang: string): Promise<{ partyId: number | null; phone: string | null; params: string[] } | null> {
  const r = await q(
    `SELECT d.id, d.party_id, p.name AS party_name, p.phone, d.challan_no, d.transporter, d.lr_no, d.vehicle_no, d.packages,
            to_char(d.dispatched_at + interval '330 minutes', 'YYYY-MM-DD') AS day, -- stored as UTC wall time → firm's (IST) day, like the challan PDF
            COALESCE(SUM(sm.meters), 0) AS meters, array_agg(DISTINCT sm.lot_id) FILTER (WHERE sm.lot_id IS NOT NULL) AS lots,
            array_agg(DISTINCT l.quality) FILTER (WHERE l.quality IS NOT NULL) AS qualities
     FROM dispatches d
     LEFT JOIN parties p ON p.id = d.party_id
     LEFT JOIN stock_movements sm ON sm.dispatch_id = d.id AND sm.direction = 'OUT'
     LEFT JOIN lots l ON l.lot_id = sm.lot_id
     WHERE d.id = $1
     GROUP BY d.id, p.name, p.phone`,
    [dispatchId],
  );
  const d = r.rows[0];
  if (!d) return null;
  const w = words(lang);
  const lots: string[] = d.lots ?? [];
  const quals: string[] = d.qualities ?? [];
  const goods = [
    `${w.lots(lots.length)}${lots.length ? ` (${lots.slice(0, 4).join(', ')}${lots.length > 4 ? ` ${w.more(lots.length - 4)}` : ''})` : ''}`,
    quals.slice(0, 4).join(', ') + (quals.length > 4 ? ` ${w.more(quals.length - 4)}` : ''),
    `${amount(Number(d.meters), 2)} m`,
  ].filter(Boolean).join(' · ');
  const transport = [d.transporter, d.lr_no && `LR ${d.lr_no}`, d.vehicle_no, d.packages != null && `${d.packages} pkgs`].filter(Boolean).join(', ') || w.notGiven;
  return {
    partyId: d.party_id == null ? null : Number(d.party_id), phone: d.phone ?? null,
    params: [d.party_name ?? '-', firm, d.challan_no ?? `#${d.id}`, ddmmyyyy(String(d.day)), goods, transport],
  };
}

/**
 * After a dispatch is saved (auto, owner switch) or "Send again" (force). Auto: once per dispatch, only when the
 * switch is on and the party has a number — otherwise quietly skipped.
 * Only logs the message as 'queued' (fast) and returns the job; the caller delivers it — in after() for the dispatch
 * save, right away for "Send again".
 */
export async function queueDispatch(dispatchId: number, opts: { force?: boolean; by: string }): Promise<{ job: QueuedJob | null; result: SendResult & { message: string } }> {
  try {
    if (!waConnected()) return { job: null, result: { ok: false, skipped: 'not_connected', message: 'WhatsApp is not connected.' } };
    const s = await readWaSettings();
    if (!opts.force && !s.dispatch_messages) return { job: null, result: { ok: false, message: 'Dispatch messages are off.' } };
    const firm = (await readBilling(run)).legalName;
    const p = await dispatchParams(run, dispatchId, firm, s.lang);
    if (!p) return { job: null, result: { ok: false, message: 'Dispatch not found.' } };
    if (!p.partyId || !waNumber(p.phone ?? '')) return { job: null, result: { ok: false, skipped: 'no_number', message: 'The party has no mobile number saved — no WhatsApp sent.' } };
    const q = await enqueue({
      purpose: 'dispatch', to: p.phone, template: s.templates.dispatch, lang: s.lang, params: p.params, partyId: p.partyId, dispatchId,
      sentBy: opts.force ? opts.by : 'auto', dedupeKey: opts.force ? null : `dispatch:${dispatchId}`,
    });
    if (q.job) return { job: q.job, result: { ok: true, id: q.job.id, status: 'queued', message: 'WhatsApp message to the party is on its way.' } };
    const r = q.result!;
    return { job: null, result: { ...r, message: r.skipped === 'duplicate' ? 'WhatsApp already sent for this dispatch.' : `WhatsApp not sent: ${r.error ?? 'unknown error'}` } };
  } catch (e) {
    logError('whatsapp.dispatch', e, { dispatchId });
    return { job: null, result: { ok: false, message: 'WhatsApp not sent (unexpected error).' } };
  }
}

// ---------- Morning summary ----------
export async function summaryParams(lang: string): Promise<string[]> {
  const w = words(lang);
  const [b, st, y, o, att] = await Promise.all([
    readBilling(run),
    run(`SELECT COALESCE(SUM(bal_m), 0) AS m, COUNT(*)::int AS n FROM lots WHERE bal_m > 0`),
    run(`SELECT COALESCE(SUM(meters) FILTER (WHERE direction = 'IN'), 0) AS i, COALESCE(SUM(meters) FILTER (WHERE direction = 'OUT'), 0) AS o
         FROM stock_movements WHERE ts >= CURRENT_DATE - 1 AND ts < CURRENT_DATE`),
    run(`SELECT COUNT(*) FILTER (WHERE promise_date = CURRENT_DATE)::int AS due, COUNT(*) FILTER (WHERE promise_date < CURRENT_DATE)::int AS late
         FROM orders WHERE status IN ('open', 'partly_dispatched')`),
    run(`SELECT (SELECT COUNT(*)::int FROM agent_suggestions WHERE status = 'open') AS alerts,
                (SELECT COUNT(*)::int FROM capture_events WHERE status = 'pending') AS reads`),
  ]);
  const credit = await creditSummary(run);
  const overdue = credit.reduce((t, p) => t + p.overdue, 0);
  const nOd = credit.filter((p) => p.overdue > 0).length;
  const due = Number(o.rows[0].due), late = Number(o.rows[0].late);
  const alerts = Number(att.rows[0].alerts), reads = Number(att.rows[0].reads);
  return [
    b.firmName,
    ddmmyyyy(todayIST()),
    w.inLots(amount(Number(st.rows[0].m), 0), Number(st.rows[0].n)),
    w.inOut(amount(Number(y.rows[0].i), 0), amount(Number(y.rows[0].o), 0)),
    due || late ? [due && w.dueToday(due), late && w.late(late)].filter(Boolean).join(', ') : w.noOrders,
    nOd ? w.fromParties(amount(overdue, 0), nOd) : w.none,
    alerts || reads ? [alerts && w.alerts(alerts), reads && w.reads(reads)].filter(Boolean).join(', ') : w.allClear,
  ];
}

async function ownerPhone(): Promise<string | null> {
  const r = await run(`SELECT phone FROM users WHERE role = 'owner' AND deleted_at IS NULL AND phone IS NOT NULL ORDER BY id LIMIT 1`);
  return r.rows[0]?.phone ?? null;
}

export async function sendSummary(s: WaSettings): Promise<{ sent: number; failed: number; skipped: number; errors: string[] }> {
  const out = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };
  const params = await summaryParams(s.lang);
  const owner = await ownerPhone();
  const to = [...new Set([owner, ...s.summary_extra].map((x) => waNumber(x ?? '')).filter((x): x is string => !!x))];
  const day = todayIST();
  for (const n of to) {
    const r = await send({ purpose: 'summary', to: n, template: s.templates.summary, lang: s.lang, params, sentBy: 'auto', dedupeKey: `summary:${day}:${n}` });
    if (r.ok && !r.skipped) out.sent++;
    else if (r.skipped) out.skipped++;
    else { out.failed++; if (r.error) out.errors.push(r.error); }
    if (r.rateLimited) break;
    await sleep(GAP_MS);
  }
  return out;
}

/** Called by the daily cron (after the agents). Never throws. */
export async function runWhatsAppDaily(): Promise<Record<string, unknown>> {
  if (!waConnected()) return { skipped: 'not connected' };
  const res: Record<string, unknown> = {};
  try {
    const s = await readWaSettings();
    res.summary = s.morning_summary ? await sendSummary(s).catch((e) => { logError('whatsapp.summary', e); return 'failed'; }) : 'off';
    res.reminders = s.auto_reminders ? await autoReminders(s).catch((e) => { logError('whatsapp.auto_reminders', e); return 'failed'; }) : 'off';
  } catch (e) {
    logError('whatsapp.daily', e);
    res.error = 'failed';
  }
  return res;
}

// ---------- Test ----------
/** "Send me a test message": the summary template to the owner; if Meta says it is not there / not approved, hello_world. */
export async function sendTest(by: string): Promise<{ ok: boolean; message: string; template?: string; setup?: boolean }> {
  try {
    if (!waConnected()) return { ok: false, setup: true, message: 'WhatsApp is not connected yet. The developer adds it in the developer console.' };
    const owner = await ownerPhone();
    if (!waNumber(owner ?? '')) return { ok: false, setup: true, message: 'Your account has no mobile number. Add it in My firm → Team.' };
    const s = await readWaSettings();
    const r = await send({ purpose: 'test', to: owner, template: s.templates.summary, lang: s.lang, params: await summaryParams(s.lang), sentBy: by });
    if (r.ok) return { ok: true, template: s.templates.summary, message: 'Test message sent to your WhatsApp (today’s summary).' };
    if (r.errorCode === 132001 || r.errorCode === 132000) {
      const h = await send({ purpose: 'test', to: owner, template: HELLO_WORLD.name, lang: HELLO_WORLD.lang, params: [], sentBy: by });
      if (h.ok) return { ok: true, template: HELLO_WORLD.name, message: 'Your summary template is not approved yet, so Meta’s “hello_world” test was sent instead. It should arrive in a minute.' };
      return { ok: false, message: `Could not send: ${h.error ?? 'unknown error'}` };
    }
    return { ok: false, message: `Could not send: ${r.error ?? 'unknown error'}` };
  } catch (e) {
    logError('whatsapp.test', e);
    return { ok: false, message: 'Could not send the test message.' };
  }
}

