// What every agent is for, in plain words — the single description the developer console (Agents tab),
// the Docs tab, the runner (default on/off) and suggest.ts (quiet days per kind) all read.
// Keep this in step with the agent modules: each `kinds` entry is a suggestion kind the module raises.
import type { AgentKey } from './types';

export interface KindInfo {
  kind: string;
  label: string;
  /** When it is raised. */
  when: string;
  /** What the button does ("—" when it's information only: the card then offers "Open"). */
  button: string;
  /** Days a dismissed / accepted item stays quiet before the same thing may be raised again. */
  quietDays: number;
  /** Money involved → owner only (never shown to supervisors). */
  ownerOnly: boolean;
  /** No longer raised (old rows are closed by the scan). */
  retired?: boolean;
}

export interface AgentInfo {
  key: AgentKey;
  label: string; // tag on the card in "Needs your attention"
  purpose: string; // one sentence, plain words
  value: string; // why the owner should care
  watches: string; // which data it reads
  trigger: string; // when it runs
  status: 'active' | 'paused';
  statusNote?: string;
  defaultEnabled: boolean;
  /** Verdict of the round-3 review (shown in the console so the owner knows why it is on / off). */
  verdict: string;
  code: string[];
  kinds: KindInfo[];
}

/** Open cards per agent shown in "Needs your attention" (the most urgent first). Changeable per agent in the console. */
export const DEFAULT_MAX_OPEN = 8;
/** Default quiet period for a dismissed card when its kind doesn't say. */
export const DEFAULT_QUIET_DAYS = 1;

const SCHEDULED = 'In the background when someone opens the attention list — at most every 5 minutes, and straight after a change (dispatch, order, payment, invoice, ledger edit) — plus daily at 07:00 IST (Vercel cron).';

export const AGENT_CATALOG: AgentInfo[] = [
  {
    key: 'orders', label: 'Orders',
    purpose: 'Warns about orders that are late or due in the next 3 days and not ready, and offers to keep free stock aside for them.',
    value: 'A late order is an unhappy party. Keeping the fabric aside stops it being sold to someone else, and the Dispatch screen then fills those lots in with one tap ("Use reserved lots").',
    watches: 'Open orders (promise date, meters sent, meters kept aside) and free stock of the same quality/design.',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep — merged with the old "Allocation" suggestions. It now raises ONE card per order (not one from each agent), says how late it is, what is still to send, how much of that quality is free, and exactly which lots the button will keep aside.',
    code: ['src/lib/agents/orders.ts', 'src/lib/sales/allocate.ts (autoAllocate, pickLots)'],
    kinds: [
      { kind: 'order_overdue', label: 'Order is late', when: 'Promise date has passed and meters are still to send.', button: '"Keep N m aside" when free stock exists and not all is kept aside yet (reserves the listed lots for the order). "Open order" is always there.', quietDays: 1, ownerOnly: false },
      { kind: 'order_due', label: 'Order due soon, not ready', when: 'Due today or in the next 3 days and not everything is sent or kept aside.', button: 'Same as above.', quietDays: 1, ownerOnly: false },
    ],
  },
  {
    key: 'credit', label: 'Payments',
    purpose: 'Finds parties with bills past their due date, or over their credit limit, and drafts a polite payment reminder.',
    value: 'Money stuck with parties is the biggest cost for a wholesaler. One tap gives a ready reminder listing the unpaid bills; with WhatsApp connected, "Send on WhatsApp" sends the approved reminder template from the firm\'s number (else a wa.me draft in English / Hindi / Gujarati).',
    watches: 'Invoices (due dates), payments (settled oldest bill first), party credit limits.',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep — clearly useful. Owner only (₹). A dismissed card stays quiet for 7 days and comes back when the bill moves to an older age bucket (31–60, 61–90, 90+ days).',
    code: ['src/lib/agents/credit.ts', 'src/lib/money/credit.ts', 'src/lib/money/reminder.ts', 'src/lib/whatsapp/flows.ts'],
    kinds: [
      { kind: 'overdue', label: 'Payment overdue', when: 'A party has unpaid bills past the due date (invoice date + party credit days).', button: '"Draft reminder" opens the reminder for that party in Money → Outstanding: "Send on WhatsApp" (Cloud API, at most once per 7 days unless the owner confirms) or "Open in WhatsApp" / copy. Automatic reminders are a separate owner switch (Policy → WhatsApp), sent by the daily cron.', quietDays: 7, ownerOnly: true },
      { kind: 'over_limit', label: 'Over credit limit', when: 'Outstanding is more than the party\'s credit limit.', button: 'Same reminder.', quietDays: 7, ownerOnly: true },
    ],
  },
  {
    key: 'inquiry', label: 'Inquiries',
    purpose: 'Reminds you about inquiries nobody has answered for a day.',
    value: 'A party asking for fabric who gets no answer buys elsewhere. The card says how long they have waited and how much of that quality is free right now.',
    watches: 'Inquiries still "new" after 24 hours; free stock of the asked quality.',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep — cheap and useful. Info card with "Open" (the reply draft is on the inquiry). It closes itself once the inquiry is marked Quoted, Won or Lost.',
    code: ['src/lib/agents/inquiry.ts', 'src/lib/sales/inquiries.ts'],
    kinds: [
      { kind: 'inquiry_waiting', label: 'Inquiry waiting for a reply', when: 'Status still "new" 24 hours after it was logged.', button: '— (Open shows the inquiry and its reply draft)', quietDays: 1, ownerOnly: false },
    ],
  },
  {
    key: 'logistics', label: 'Dispatch',
    purpose: 'Asks you to count fabric sent to a party against that party\'s open order, so the order shows the right "still to send".',
    value: 'Order progress (sent meters, "partly dispatched", "dispatched") is worked out ONLY from dispatches linked to the order. A challan entered by photo, import or by hand has no order, so the order keeps showing everything as still to send and gets flagged late. It is linked without asking only when the lot that went out was kept aside for that order; otherwise the owner is always asked, even when the party has just one open order.',
    watches: 'Every outgoing (OUT) entry as it is saved, and OUT entries of the last 30 days without an order, for parties that have an open order of the same quality placed before the dispatch.',
    trigger: 'On every OUT entry (inside the same save), plus the scheduled scan.',
    status: 'active', defaultEnabled: true,
    verdict: 'Keep, rewritten. The problem is real (unlinked dispatches make orders look late and short), but the old text "which order?" didn\'t say so, and with one open order it linked silently. It now always asks unless the lot was kept aside for the order. It now reads "151 m of H-2518 went to Mumbai Retailers without an order — count it against order #17?" with [Count against #17] and [Not for an order]. Accepting really adds the meters to the order and updates its status; "Not for an order" is remembered for good.',
    code: ['src/lib/agents/logistics.ts', 'src/lib/agents/logistics-hook.ts', 'src/lib/orderStatus.ts'],
    kinds: [
      { kind: 'match_dispatch', label: 'Dispatch without an order', when: 'An OUT entry to a party has no order and the party has one or more open orders of that quality placed before it (unless the lot was kept aside for one of them — then it is linked by itself).', button: '"Count against #N" links the entry to that order: its sent meters and status update at once. Other open orders get their own "Count against" button; "Not for an order" is remembered for good.', quietDays: 3650, ownerOnly: false },
      { kind: 'reserved_for_other', label: 'Kept-aside lot went to another party', when: 'A lot kept aside for one party\'s order was sent to a different party.', button: '— (Open the order to keep other lots aside)', quietDays: 3650, ownerOnly: false },
    ],
  },
  {
    key: 'inventory', label: 'Stock',
    purpose: 'Keeps the stock picture honest: low stock, not enough for open orders, old stock not moving, lots without a location, a mill losing too much in processing.',
    value: 'Tells you what to buy or process before an order is stuck, and which old stock to push out.',
    watches: 'Lot balances and reservations, dispatches of the last 60 days, open orders, lot locations, grey → finished meters by mill (90 days). Thresholds: My firm → Policy (low-stock meters, ageing days).',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep. Information cards; each closes itself when the problem goes away.',
    code: ['src/lib/agents/inventory.ts', 'src/lib/reports/inventory.ts'],
    kinds: [
      { kind: 'short_for_orders', label: 'Not enough for open orders', when: 'Open orders of a quality need more than is free.', button: '—', quietDays: 1, ownerOnly: false },
      { kind: 'low_stock', label: 'Low stock', when: 'Free meters below the low-stock level for a quality that sold in 60 days or has open orders.', button: '—', quietDays: 1, ownerOnly: false },
      { kind: 'ageing_stock', label: 'Old stock', when: 'Lots with no movement for longer than the ageing days (one summary card).', button: '— ("See the N lots" opens Reports → Inventory with the full list)', quietDays: 7, ownerOnly: false },
      { kind: 'no_location', label: 'Lots without a location', when: 'Lots with stock but no location (one summary card).', button: '—', quietDays: 7, ownerOnly: false },
      { kind: 'mill_loss', label: 'Mill losing too much', when: 'A mill\'s grey → finished loss is 5+ points above the overall loss over 3+ receipts in 90 days.', button: '—', quietDays: 14, ownerOnly: false },
    ],
  },
  {
    key: 'documents', label: 'Invoices',
    purpose: 'Reminds you about dispatches that went out more than a day ago without a GST invoice, and makes the invoice in one tap when the order has a rate.',
    value: 'An un-invoiced dispatch is unbilled money: it doesn\'t appear in Outstanding and no reminder can be sent for it.',
    watches: 'Dispatches made on the Dispatch screen (not photo / manual OUT entries) that have no invoice.',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep, tightened: the "Make invoice" button now appears only when every line has a rate on its order (selling-rate lists are off), otherwise the card says to type the rate or record the Tally bill number. Owner only.',
    code: ['src/lib/agents/documents.ts', 'src/lib/dispatch/invoices.ts'],
    kinds: [
      { kind: 'invoice_missing', label: 'Dispatch not invoiced', when: 'Dispatch older than 1 day with no (non-cancelled) invoice.', button: '"Make invoice" creates the GST invoice at the order\'s rate (only shown when every line has one).', quietDays: 3, ownerOnly: true },
    ],
  },
  {
    key: 'reports', label: 'Reports',
    purpose: 'Each morning, a one-line summary of yesterday (and on Mondays, last week) with a link to the full report.',
    value: 'The owner sees yesterday\'s dispatch / receipts / production at a glance without opening Reports.',
    watches: 'Stock movements, job cards, orders and inquiries for the day / week (meters only).',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Keep, owner only now (supervisors can\'t open Reports, so the card was a dead end for them). Only the newest daily / weekly card stays open.',
    code: ['src/lib/agents/reports.ts', 'src/lib/reports/build.ts'],
    kinds: [
      { kind: 'daily_report', label: "Yesterday's report", when: 'Once a day.', button: '— (Open shows the report)', quietDays: 1, ownerOnly: true },
      { kind: 'weekly_report', label: "Last week's report", when: 'On Mondays.', button: '— (Open shows the report)', quietDays: 1, ownerOnly: true },
    ],
  },
  {
    key: 'allocation', label: 'Reservations',
    purpose: 'Catches fabric that is kept aside for an order but is no longer in stock, and releases the missing part in one tap.',
    value: 'Without it an order can look "covered" by a reservation on a lot that is already empty (e.g. after a ledger correction), and nobody notices until dispatch day.',
    watches: 'Reservations (allocations) against lot balances.',
    trigger: SCHEDULED,
    status: 'active', defaultEnabled: true,
    verdict: 'Rewritten. The old "Allocate 600 m Rayon Print to order #3 … free stock covers it" card was a duplicate of the Orders card for the same order and didn\'t say why reserving helps — it is removed; keeping stock aside is now offered on the Orders card, only for orders due within 3 days or late. What remains is a safety check that rarely fires (dispatches already shrink reservations automatically).',
    code: ['src/lib/agents/allocation.ts', 'src/lib/stock.ts (trimReservations)'],
    kinds: [
      { kind: 'over_allocated', label: 'Kept aside but not in stock', when: 'More meters are kept aside on a lot than the lot holds.', button: '"Release N m" shrinks the newest reservations on that lot to what is really there.', quietDays: 1, ownerOnly: false },
      { kind: 'allocate_order', label: 'Allocate free stock to an order (old)', when: 'No longer raised — merged into the Orders card.', button: '—', quietDays: 1, ownerOnly: false, retired: true },
    ],
  },
  {
    key: 'costing', label: 'Margin',
    purpose: 'Would warn when a party\'s sales in the last 30 days earned under 3% margin.',
    value: 'Needs selling rates and process costs to be meaningful.',
    watches: 'Invoice / order rates, purchase rates, grey → finished shortage.',
    trigger: SCHEDULED,
    status: 'paused', statusNote: 'Switched off: selling rates and process costs are turned off by the owner, so margins would be wrong.',
    defaultEnabled: false,
    verdict: 'Off. It depends on selling rates and process costs, which the owner turned off; a margin without process costs overstates profit. Switch it on again only when process costs are back.',
    code: ['src/lib/agents/costing.ts', 'src/lib/money/costing.ts'],
    kinds: [
      { kind: 'low_margin', label: 'Low margin', when: 'A party\'s fully costed dispatches in 30 days earned under 3%.', button: '—', quietDays: 7, ownerOnly: true },
      { kind: 'missing_rate', label: 'Missing selling rate (old)', when: 'No longer raised (selling rates are off).', button: '—', quietDays: 1, ownerOnly: true, retired: true },
      { kind: 'missing_cost', label: 'Missing process cost (old)', when: 'No longer raised (process costs are off).', button: '—', quietDays: 1, ownerOnly: true, retired: true },
    ],
  },
];

export const AGENT_INFO: Record<AgentKey, AgentInfo> = Object.fromEntries(AGENT_CATALOG.map((a) => [a.key, a])) as Record<AgentKey, AgentInfo>;

export const AGENT_KEYS: AgentKey[] = AGENT_CATALOG.map((a) => a.key);

export function isAgentKey(v: unknown): v is AgentKey {
  return typeof v === 'string' && (AGENT_KEYS as string[]).includes(v);
}

/** Quiet days for a dismissed / accepted card of this kind. */
export function quietDaysFor(agent: AgentKey, kind: string): number {
  return AGENT_INFO[agent]?.kinds.find((k) => k.kind === kind)?.quietDays ?? DEFAULT_QUIET_DAYS;
}
