// Global search (top bar "Search or ask"): one cheap query per kind of thing, run in parallel, each
// limited, and only over what the caller may see. Every hit carries a deep link (tab + URL hash) that the
// screen reads with useTakeHash / useHashLink (src/lib/useApi.ts) to open, filter or highlight the item.
//
// Cost on big tables (lots, stock_movements ~1M rows): only index-friendly prefix matches (the DB collation
// is C, so `col LIKE 'ABC%'` uses a plain btree). "Contains" matching is used only on small tables (parties,
// orders, inquiries, dispatches, invoices, workers, users), or on lot numbers when a trigram index exists.
import type { Role, Tab } from './access';
import { can, navFor } from './access';
import type { Q } from './db';
import { LOT_DOC } from './lots-query';

export type HitType = 'screen' | 'lot' | 'quality' | 'design' | 'challan' | 'party' | 'order' | 'inquiry' | 'dispatch' | 'invoice' | 'worker' | 'supervisor' | 'section';

/** Where a hit goes: a screen (+ hash the screen reads), or a small details sheet shown by the search box. */
export type HitHref = { tab: Tab; hash?: string } | { sheet: 'lot'; id: string };

export interface SearchHit { type: HitType; id: string; title: string; subtitle: string; href: HitHref; score: number }
export interface SearchGroup { type: HitType; label: string; hits: SearchHit[] }
export interface SearchResult { q: string; groups: SearchGroup[]; ms: number }

export interface SearchCaller { role: Role; userId: string }

const GROUP_LABEL: Record<HitType, string> = {
  screen: 'Screens', lot: 'Lots', quality: 'Qualities', design: 'Designs', challan: 'Challans', party: 'Parties', order: 'Orders',
  inquiry: 'Inquiries', dispatch: 'Dispatches', invoice: 'Invoices', worker: 'Workers', supervisor: 'Supervisors', section: 'Sections',
};

/** Escape LIKE wildcards so "50%" matches literally. */
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const hashOf = (key: string, params: Record<string, string>) => `${key}=${encodeURIComponent(new URLSearchParams(params).toString())}`;
/** Stock ledger deep link (engineer A's Stock screen reads #ledger=<URLSearchParams>). */
export const ledgerHash = (params: Record<string, string>) => hashOf('ledger', params);
const m1 = (n: unknown) => `${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} m`;
const shortDate = (d: unknown) => {
  const t = d instanceof Date ? d : d ? new Date(String(d)) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
};

/** 100 exact · 80 starts with · 60 a word starts with · 40 contains. */
function score(text: string | null | undefined, q: string): number {
  const t = (text ?? '').toLowerCase();
  const k = q.toLowerCase();
  if (!t || !k) return 0;
  if (t === k) return 100;
  if (t.startsWith(k)) return 80;
  if (t.split(/[\s\-_/.,]+/).some((w) => w.startsWith(k))) return 60;
  return t.includes(k) ? 40 : 0;
}

// ---- small caches (per server process) ----
let trgmCache: { at: number; lot: boolean; doc: boolean } | null = null;
/**
 * Do the trigram indexes from migration 010 exist (idx_lots_search_trgm over LOT_DOC, idx_sm_search_trgm over
 * stock_movements.search_doc)? Without pg_trgm they are skipped, and search falls back to prefix matches only. Checked every 5 min.
 */
async function trigram(q: Q) {
  if (trgmCache && Date.now() - trgmCache.at < 300_000) return trgmCache;
  const r = await q(`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_lots_search_trgm', 'idx_sm_search_trgm')`).catch(() => ({ rows: [] as { indexname: string }[] }));
  const names = (r.rows as { indexname: string }[]).map((x) => x.indexname);
  trgmCache = { at: Date.now(), lot: names.includes('idx_lots_search_trgm'), doc: names.includes('idx_sm_search_trgm') };
  return trgmCache;
}

let namesCache: { at: number; qualities: string[]; designs: string[] } | null = null;
/** Distinct qualities / designs via a loose index scan on the lower() indexes (fast even on 1M lots). Cached 60 s. */
async function lotNames(q: Q) {
  if (namesCache && Date.now() - namesCache.at < 60_000) return namesCache;
  const distinct = async (col: 'quality' | 'design') => {
    const r = await q(`
      WITH RECURSIVE t(v) AS (
        (SELECT lower(${col}) FROM lots WHERE ${col} IS NOT NULL ORDER BY lower(${col}) LIMIT 1)
        UNION ALL
        SELECT (SELECT lower(${col}) FROM lots WHERE lower(${col}) > t.v ORDER BY lower(${col}) LIMIT 1) FROM t WHERE t.v IS NOT NULL
      )
      SELECT (SELECT ${col} FROM lots WHERE lower(${col}) = t.v LIMIT 1) AS name FROM t WHERE t.v IS NOT NULL LIMIT 500`);
    return (r.rows as { name: string | null }[]).map((x) => x.name).filter((x): x is string => !!x && !!x.trim());
  };
  const [qualities, designs] = await Promise.all([distinct('quality'), distinct('design')]);
  namesCache = { at: Date.now(), qualities, designs };
  return namesCache;
}

// ---- screens (quick navigation) ----
const SCREEN_WORDS: { tab: Tab; hash?: string; title: string; words: string; cap?: Parameters<typeof can>[1] }[] = [
  { tab: 'overview', title: 'Overview', words: 'overview home dashboard today' },
  { tab: 'stock', title: 'Stock ledger', words: 'stock ledger inventory godown balance movements challans', cap: 'stock.quantity' },
  { tab: 'jobs', title: 'Job cards', words: 'job cards jobs shortage process' },
  { tab: 'floor', title: 'Floor today', words: 'floor today workers present' },
  { tab: 'allot', title: 'Allot work', words: 'allot allotment assign work' },
  { tab: 'capture', title: 'Capture', words: 'capture photo camera scan challan' },
  { tab: 'orders', title: 'Orders & inquiries', words: 'orders inquiries inquiry enquiry sales reserve' },
  { tab: 'dispatch', title: 'Dispatch & documents', words: 'dispatch challan packing list transport lr documents delivery' },
  { tab: 'money', title: 'Money', words: 'money outstanding payments credit margin dues receivable' },
  { tab: 'reports', title: 'Reports', words: 'reports report summary daily weekly monthly' },
  { tab: 'people', title: 'People & CCTV', words: 'people cctv efficiency attendance' },
  { tab: 'firm', hash: 'firm=firm', title: 'My firm · Firm & billing', words: 'my firm billing gst gstin bank invoice numbering' },
  { tab: 'firm', hash: 'firm=parties', title: 'My firm · Parties', words: 'parties party clients customers buyers' },
  { tab: 'firm', hash: 'firm=places', title: 'My firm · Markets & locations', words: 'markets locations places godown shop' },
  { tab: 'firm', hash: 'firm=policy', title: 'My firm · Policy', words: 'policy rules low stock alerts knowledge' },
  { tab: 'firm', hash: 'firm=team', title: 'My firm · Team', words: 'team workers supervisors sections sign ups users staff' },
  { tab: 'settings', title: 'Settings', words: 'settings account password language theme preferences' },
];

function screens(role: Role, k: string): SearchHit[] {
  if (k.length < 2) return [];
  const allowed = new Set(navFor(role).map((n) => n.tab));
  return SCREEN_WORDS.filter((s) => allowed.has(s.tab) && (!s.cap || can(role, s.cap)))
    .map((s) => ({ s, sc: Math.max(score(s.title, k), ...s.words.split(' ').map((w) => (w.startsWith(k.toLowerCase()) ? 70 : 0))) }))
    .filter((x) => x.sc > 0)
    .map(({ s, sc }) => ({ type: 'screen' as const, id: `${s.tab}${s.hash ? `:${s.hash}` : ''}`, title: s.title, subtitle: 'Open screen', href: { tab: s.tab, hash: s.hash }, score: sc - 5 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// =====================================================================
export async function search(q: Q, caller: SearchCaller, raw: string, limit = 5): Promise<SearchResult> {
  const t0 = Date.now();
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  const { role } = caller;
  if (!text || role === 'worker') return { q: text, groups: [], ms: 0 };

  const k = text.replace(/^#/, '').trim();
  const lower = k.toLowerCase();
  const upper = k.toUpperCase();
  const num = /^\d{1,9}$/.test(k) ? Number(k) : null;
  const contains = `%${esc(lower)}%`;
  const prefixUp = `${esc(upper)}%`;
  const owner = role === 'owner';
  const n = Math.max(1, Math.min(limit, 10));
  const tasks: Promise<SearchHit[]>[] = [Promise.resolve(screens(role, k))];

  // ---- stock: lots, qualities / designs, challans (owner + supervisor, meters only) ----
  if (can(role, 'stock.quantity') && k.length >= 2) {
    const stockTab = owner && navFor(role).some((x) => x.tab === 'stock');
    tasks.push((async () => {
      const tg = await trigram(q);
      // Lot numbers: starts-with through idx_lots_lot_c; "contains" (e.g. the last digits "0962") through the trigram
      // index — only when the text has a digit, so "sat" doesn't list every Satin lot. Balance comes from the lot row (bal_m).
      const inner = tg.lot && k.length >= 3 && /\d/.test(k);
      const r = await q(`
        (SELECT l.lot_id, l.quality, l.design, l.status, l.bal_m AS balance FROM lots l
          WHERE lower(l.lot_id::text) COLLATE "C" LIKE $1 ORDER BY lower(l.lot_id::text) COLLATE "C" LIMIT $2)
        ${inner ? `UNION ALL
        (SELECT l.lot_id, l.quality, l.design, l.status, l.bal_m AS balance FROM lots l
          WHERE ${LOT_DOC} LIKE $3 AND lower(l.lot_id::text) LIKE $3 AND lower(l.lot_id::text) COLLATE "C" NOT LIKE $1 LIMIT $2)` : ''}`,
      inner ? [`${esc(lower)}%`, n, contains] : [`${esc(lower)}%`, n]);
      return (r.rows as { lot_id: string; quality: string | null; design: string | null; status: string | null; balance: string }[]).map((x) => ({
        type: 'lot' as const, id: x.lot_id, title: x.lot_id,
        subtitle: [x.quality, x.design, `${m1(x.balance)} in stock`].filter(Boolean).join(' · '),
        href: stockTab ? { tab: 'stock' as Tab, hash: ledgerHash({ view: 'moves', lot: x.lot_id, focus: x.lot_id }) } : { sheet: 'lot' as const, id: x.lot_id },
        score: Math.max(score(x.lot_id, k), 50),
      }));
    })());
    tasks.push((async () => {
      const names = await lotNames(q);
      const pick = (list: string[], type: 'quality' | 'design') => list
        .map((name) => ({ name, sc: score(name, k) }))
        .filter((x) => x.sc >= 60 || (x.sc > 0 && k.length >= 3))
        .sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name))
        .slice(0, 3)
        .map(({ name, sc }) => ({
          type, id: name, title: name, subtitle: type === 'quality' ? 'Quality · all lots in stock' : 'Design · all lots in stock',
          href: stockTab ? { tab: 'stock' as Tab, hash: ledgerHash({ view: 'lots', q: name, [type]: name }) } : { tab: 'orders' as Tab },
          score: sc - 2,
        }));
      return stockTab ? [...pick(names.qualities, 'quality'), ...pick(names.designs, 'design')] : [];
    })());
    // Challans: by challan / document no. (starts with) or by SR no. (digits).
    if (/\d/.test(k) && k.length >= 2) {
      tasks.push((async () => {
        const tg = await trigram(q);
        // Challan no.: through the ledger's trigram index (search_doc holds the challan, lower case) + a recheck on
        // the column; without that index only "starts with" (a plain scan that stops at the first matches).
        const docWhere = tg.doc && k.length >= 3 ? `(search_doc LIKE $1 AND lower(source_doc_id) LIKE $1)` : `source_doc_id LIKE $1`;
        const params: unknown[] = [tg.doc && k.length >= 3 ? contains : prefixUp];
        const srSql = num != null ? ` UNION ALL (SELECT id, lot_id, direction, meters, party, source_doc_id, sr_no, ts, 1 AS by_sr FROM stock_movements WHERE sr_no = $${params.length + 1} LIMIT 4)` : '';
        if (num != null) params.push(num);
        params.push(n);
        const r = await q(`
          SELECT * FROM (
            (SELECT id, lot_id, direction, meters, party, source_doc_id, sr_no, ts, 0 AS by_sr FROM stock_movements WHERE ${docWhere} LIMIT $${params.length})
            ${srSql}
          ) x LIMIT $${params.length}`, params);
        return (r.rows as { id: number; lot_id: string; direction: string; meters: string; party: string | null; source_doc_id: string | null; sr_no: number | null; ts: string; by_sr: number }[]).map((x) => {
          const doc = x.source_doc_id ?? '';
          const bySr = x.by_sr === 1;
          const title = bySr ? `SR ${x.sr_no}${doc ? ` · ${doc}` : ''}` : doc;
          return {
            type: 'challan' as const, id: String(x.id), title,
            subtitle: [x.direction === 'IN' ? 'In' : 'Out', x.lot_id, m1(x.meters), x.party, shortDate(x.ts)].filter(Boolean).join(' · '),
            href: stockTab
              ? { tab: 'stock' as Tab, hash: ledgerHash({ view: 'moves', q: bySr ? String(x.sr_no) : doc || x.lot_id, focus: String(x.id) }) }
              : { sheet: 'lot' as const, id: x.lot_id },
            score: bySr ? (num != null ? 85 : 60) : Math.max(score(doc, k), 50),
          };
        });
      })());
    }
  }

  // ---- small tables (parties, orders, inquiries, dispatches, invoices, people): ONE statement, one connection ----
  // Each part is a sub-select aggregated to JSON, so a search costs 1–3 pool connections, not a dozen.
  // Shared params: $1 contains · $2 number · $3 text length · $4 lower · $5 lower prefix · $6 phone digits · $7 limit · $8 supervisor id
  type Part = { key: string; sql: string; map: (rows: Record<string, unknown>[]) => SearchHit[] };
  const parts: Part[] = [];
  const S = (v: unknown) => (v == null ? null : String(v));
  const partyOk = owner ? can(role, 'master.manage') || can(role, 'finance.view') : can(role, 'orders.view');
  if (partyOk && k.length >= 2) {
    parts.push({
      key: 'parties',
      sql: `SELECT id, name, city, phone FROM parties
        WHERE active AND (name ILIKE $1 OR city ILIKE $1 OR ($6::text IS NOT NULL AND phone LIKE $6) OR gstin ILIKE $1)
        ORDER BY (lower(name) = $4) DESC, (lower(name) LIKE $5) DESC, name LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'party' as const, id: String(x.id), title: String(x.name),
        subtitle: [owner ? 'Party' : 'Party · their orders', S(x.city), owner ? S(x.phone) : null].filter(Boolean).join(' · '),
        href: owner ? { tab: 'firm' as Tab, hash: `firm=parties&party=${x.id}` } : { tab: 'orders' as Tab, hash: hashOf('orders', { party: String(x.id), name: String(x.name) }) },
        score: Math.max(score(S(x.name), k), score(S(x.city), k) - 20, 30),
      })),
    });
  }
  if (can(role, 'orders.view')) {
    parts.push({
      key: 'orders',
      sql: `SELECT o.id, o.quality, o.design, o.meters, o.status, o.promise_date, p.name AS party
        FROM orders o LEFT JOIN parties p ON p.id = o.party_id
        WHERE ($2::int IS NOT NULL AND o.id = $2::int) OR ($3::int >= 3 AND (p.name ILIKE $1 OR o.quality ILIKE $1))
        ORDER BY (o.id = $2::int) DESC NULLS LAST, (o.status IN ('open', 'partly_dispatched')) DESC, o.created_at DESC LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'order' as const, id: String(x.id), title: `Order #${x.id} · ${S(x.party) ?? 'party not known'}`,
        subtitle: [S(x.quality), S(x.design), m1(x.meters), STATUS[String(x.status)] ?? S(x.status), x.promise_date ? `by ${shortDate(x.promise_date)}` : null].filter(Boolean).join(' · '),
        href: { tab: 'orders' as Tab, hash: `order=${x.id}` },
        score: num === Number(x.id) ? 95 : Math.max(score(S(x.party), k), score(S(x.quality), k)) - 10,
      })),
    });
  }
  if (can(role, 'inquiry.handle')) {
    parts.push({
      key: 'inquiries',
      sql: `SELECT i.id, COALESCE(p.name, i.party_name) AS party, i.quality, i.meters, i.status, left(i.raw_text, 80) AS raw_text, i.created_at
        FROM inquiries i LEFT JOIN parties p ON p.id = i.party_id
        WHERE ($2::int IS NOT NULL AND i.id = $2::int) OR ($3::int >= 3 AND (COALESCE(p.name, i.party_name) ILIKE $1 OR i.raw_text ILIKE $1 OR i.quality ILIKE $1))
        ORDER BY (i.id = $2::int) DESC NULLS LAST, (i.status IN ('new', 'quoted')) DESC, i.created_at DESC LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'inquiry' as const, id: String(x.id), title: `Inquiry #${x.id} · ${S(x.party) ?? 'party not known'}`,
        subtitle: [INQ[String(x.status)] ?? S(x.status), S(x.quality), x.meters != null ? m1(x.meters) : null, shortDate(x.created_at)].filter(Boolean).join(' · ') || String(x.raw_text ?? '').slice(0, 60),
        href: { tab: 'orders' as Tab, hash: `inquiry=${x.id}` },
        score: num === Number(x.id) ? 90 : Math.max(score(S(x.party), k), score(S(x.quality), k) - 10, 35) - 5,
      })),
    });
  }
  if (can(role, 'dispatch.manage')) {
    parts.push({
      key: 'dispatches',
      sql: `SELECT d.id, d.challan_no, d.dispatched_at, d.order_id, p.name AS party
        FROM dispatches d LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.challan_no ILIKE $1 OR ($2::int IS NOT NULL AND d.id = $2::int) OR ($3::int >= 3 AND p.name ILIKE $1)
        ORDER BY (lower(d.challan_no) = $4) DESC, d.dispatched_at DESC LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'dispatch' as const, id: String(x.id), title: `${S(x.challan_no) ?? `Dispatch ${x.id}`} · ${S(x.party) ?? 'party not known'}`,
        subtitle: ['Dispatch', shortDate(x.dispatched_at), x.order_id ? `order #${x.order_id}` : null].filter(Boolean).join(' · '),
        href: { tab: 'dispatch' as Tab, hash: `dispatch=${x.id}` },
        score: Math.max(score(S(x.challan_no), k), num === Number(x.id) ? 70 : 0, score(S(x.party), k) - 15),
      })),
    });
  }
  if (can(role, 'finance.view') && k.length >= 2) { // owner only: ₹
    parts.push({
      key: 'invoices',
      sql: `SELECT v.id, v.invoice_no, v.invoice_date, v.total, v.status, p.name AS party
        FROM invoices v LEFT JOIN parties p ON p.id = v.party_id
        WHERE v.invoice_no ILIKE $1 OR ($3::int >= 3 AND p.name ILIKE $1)
        ORDER BY (lower(v.invoice_no) = $4) DESC, v.invoice_date DESC LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'invoice' as const, id: String(x.id), title: `${x.invoice_no}${x.party ? ` · ${x.party}` : ''}`,
        subtitle: ['Invoice', `₹${Number(x.total).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, shortDate(x.invoice_date), S(x.status)].filter(Boolean).join(' · '),
        href: { tab: 'dispatch' as Tab, hash: `invoice=${x.id}` },
        score: Math.max(score(S(x.invoice_no), k), score(S(x.party), k) - 20),
      })),
    });
  }
  if (k.length >= 2 && (owner || role === 'supervisor')) {
    // A supervisor sees only the people and sections they look after ($8 = their user id; NULL for the owner).
    const mine = `(SELECT lower(s2.name) FROM supervisor_sections ss JOIN sections s2 ON s2.id = ss.section_id WHERE ss.user_id = $8::text AND s2.active)`;
    parts.push({
      key: 'workers',
      sql: `SELECT id, name, section, active FROM workers
        WHERE deleted_at IS NULL AND name ILIKE $1
          AND ($8::text IS NULL OR lower(regexp_replace(COALESCE(section, ''), '\s*section\s*$', '', 'i')) IN ${mine})
        ORDER BY active DESC, (lower(name) LIKE $5) DESC, name LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'worker' as const, id: String(x.id), title: String(x.name), subtitle: [`Worker · ${S(x.section) ?? 'no section'}`, x.active ? null : 'switched off'].filter(Boolean).join(' · '),
        href: owner ? { tab: 'firm' as Tab, hash: `firm=team&person=${encodeURIComponent(String(x.id))}` } : { tab: 'floor' as Tab, hash: `find=${encodeURIComponent(String(x.name))}` },
        score: score(S(x.name), k),
      })),
    });
    if (owner) {
      parts.push({
        key: 'supervisors',
        sql: `SELECT id, name, active FROM users WHERE deleted_at IS NULL AND role = 'supervisor' AND status = 'approved' AND name ILIKE $1 ORDER BY active DESC, name LIMIT $7`,
        map: (rows) => rows.map((x) => ({
          type: 'supervisor' as const, id: String(x.id), title: String(x.name), subtitle: x.active ? 'Supervisor' : 'Supervisor · switched off',
          href: { tab: 'firm' as Tab, hash: `firm=team&person=${encodeURIComponent(String(x.id))}` }, score: score(S(x.name), k),
        })),
      });
    }
    parts.push({
      key: 'sections',
      sql: `SELECT id, name FROM sections WHERE active AND name ILIKE $1 AND ($8::text IS NULL OR lower(name) IN ${mine}) ORDER BY sort_order, name LIMIT $7`,
      map: (rows) => rows.map((x) => ({
        type: 'section' as const, id: String(x.id), title: `${x.name} section`, subtitle: owner ? 'Sections · My firm → Team' : 'Your section · floor today',
        href: owner ? { tab: 'firm' as Tab, hash: `firm=team&person=${encodeURIComponent(`section-${x.id}`)}` } : { tab: 'floor' as Tab },
        score: score(S(x.name), k) - 5,
      })),
    });
  }
  if (parts.length) {
    // The CTE only fixes each parameter's type (a part left out would leave its parameters untyped).
    const sql = `WITH _p AS (SELECT $1::text, $2::int, $3::int, $4::text, $5::text, $6::text, $7::int, $8::text)
      SELECT ${parts.map((p) => `(SELECT COALESCE(json_agg(x), '[]'::json) FROM (${p.sql}) x) AS "${p.key}"`).join(',\n')}`;
    const phone = /^[\d\s+-]{6,}$/.test(k) ? `%${k.replace(/\D/g, '')}%` : null;
    tasks.push(q(sql, [contains, num, k.length, lower, `${esc(lower)}%`, phone, n, owner ? null : caller.userId]).then((r) => {
      const row = (r.rows[0] ?? {}) as Record<string, Record<string, unknown>[] | null>;
      return parts.flatMap((p) => p.map(row[p.key] ?? []));
    }));
  }

  const settled = await Promise.allSettled(tasks);
  const hits = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])).filter((h) => h.score > 0);
  const byType = new Map<HitType, SearchHit[]>();
  for (const h of hits) {
    const list = byType.get(h.type) ?? [];
    if (!list.some((x) => x.id === h.id)) list.push(h);
    byType.set(h.type, list);
  }
  const groups: SearchGroup[] = [...byType.entries()]
    .map(([type, list]) => ({ type, label: GROUP_LABEL[type], hits: list.sort((a, b) => b.score - a.score).slice(0, n) }))
    .sort((a, b) => b.hits[0].score - a.hits[0].score || ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return { q: text, groups, ms: Date.now() - t0 };
}

const ORDER: HitType[] = ['lot', 'challan', 'party', 'order', 'inquiry', 'dispatch', 'invoice', 'worker', 'supervisor', 'section', 'quality', 'design', 'screen'];
const STATUS: Record<string, string> = { open: 'open', partly_dispatched: 'part sent', dispatched: 'dispatched', cancelled: 'cancelled' };
const INQ: Record<string, string> = { new: 'new', quoted: 'quoted', won: 'won', lost: 'lost' };

/** A supervisor's sections, lower case (their scope for workers and job cards). */
export function supervisorSections(q: Q, userId: string): Promise<string[]> {
  return q(`SELECT s.name FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = $1 AND s.active`, [userId])
    .then((r) => (r.rows as { name: string }[]).map((x) => x.name.toLowerCase()));
}

// =====================================================================
/** Small lot card for people without the Stock screen (supervisors): meters only, recent moves, job cards. */
export async function lotDetails(q: Q, lotId: string, sections: string[] | null = null) {
  const [lot, moves, jobs] = await Promise.all([
    q(`SELECT l.lot_id, l.quality, l.design, l.grade, l.status,
         l.bal_m AS balance, l.cur_location AS location
       FROM lots l WHERE l.lot_id = $1`, [lotId]),
    q(`SELECT id, direction, meters, party, source_doc_id, sr_no, ts FROM stock_movements WHERE lot_id = $1 ORDER BY ts DESC, id DESC LIMIT 8`, [lotId]),
    q(`SELECT j.id, j.process, w.name AS worker_name, j.meters_in, j.meters_out, j.status FROM job_cards j LEFT JOIN workers w ON w.id = j.worker_id
       WHERE j.lot_id = $1 AND ($2::text[] IS NULL OR lower(regexp_replace(j.process, '\s*section\s*$', '', 'i')) = ANY($2) OR lower(regexp_replace(COALESCE(w.section, ''), '\s*section\s*$', '', 'i')) = ANY($2))
       ORDER BY j.id DESC LIMIT 8`, [lotId, sections]).catch(() => ({ rows: [] })),
  ]);
  const l = lot.rows[0] as Record<string, unknown> | undefined;
  if (!l) return null;
  return {
    lot: { lot_id: String(l.lot_id), quality: (l.quality as string) ?? null, design: (l.design as string) ?? null, grade: (l.grade as string) ?? null, status: (l.status as string) ?? null, balance: Number(l.balance), location: (l.location as string) ?? null },
    moves: (moves.rows as Record<string, unknown>[]).map((x) => ({ id: Number(x.id), direction: String(x.direction), meters: Number(x.meters), party: (x.party as string) ?? null, doc: (x.source_doc_id as string) ?? null, sr_no: (x.sr_no as number) ?? null, ts: String(x.ts instanceof Date ? x.ts.toISOString() : x.ts) })),
    jobs: (jobs.rows as Record<string, unknown>[]).map((x) => ({ id: Number(x.id), process: String(x.process ?? ''), worker: (x.worker_name as string) ?? null, meters_in: Number(x.meters_in ?? 0), meters_out: x.meters_out == null ? null : Number(x.meters_out), status: String(x.status ?? '') })),
  };
}
