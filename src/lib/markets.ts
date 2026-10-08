// Markets and their shops (migration 014), server side: read, add / change (owner), add shops (owner + supervisor),
// and the search helper that lets "Landmark" find lots labelled "LM 245 · Pipe 3".
import type { Q } from './db';
import { LIMITS } from './config';
import { LedgerError } from './ledger-error';
import { checkCode, checkMarketName, checkShop, type MarketInfo } from './location';

/** Every market (sort order, then name) with its shops, most used first (uses = lot location rows at that shop). */
export async function loadMarkets(q: Q): Promise<MarketInfo[]> {
  const [mk, sh] = await Promise.all([
    q(`SELECT id, name, code, active, sort_order FROM markets ORDER BY sort_order, lower(name), id`),
    q(`SELECT s.id, s.market_id, s.shop_no, s.active, COALESCE(u.n, 0)::int AS uses
         FROM market_shops s
         LEFT JOIN (SELECT market_id, shop_no, count(*) AS n FROM lot_locations WHERE market_id IS NOT NULL GROUP BY 1, 2) u
           ON u.market_id = s.market_id AND u.shop_no = s.shop_no
        ORDER BY s.market_id, COALESCE(u.n, 0) DESC, length(s.shop_no), s.shop_no`),
  ]);
  const byMarket = new Map<number, MarketInfo['shops']>();
  for (const r of sh.rows) {
    const list = byMarket.get(Number(r.market_id)) ?? [];
    list.push({ id: Number(r.id), shop_no: String(r.shop_no), active: !!r.active, uses: Number(r.uses) });
    byMarket.set(Number(r.market_id), list);
  }
  return mk.rows.map((r) => ({
    id: Number(r.id), name: String(r.name), code: String(r.code), active: !!r.active, sort_order: Number(r.sort_order),
    shops: byMarket.get(Number(r.id)) ?? [],
  }));
}

const value = <T,>(c: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!c.ok) throw new LedgerError(c.error);
  return c.value;
};

async function assertFree(q: Q, name: string | null, code: string | null, exceptId: number | null) {
  if (name != null) {
    const r = await q(`SELECT name FROM markets WHERE lower(btrim(name)) = lower($1) AND ($2::int IS NULL OR id <> $2) LIMIT 1`, [name, exceptId]);
    if (r.rows[0]) throw new LedgerError(`A market called "${r.rows[0].name}" already exists.`, 409);
  }
  if (code != null) {
    const r = await q(`SELECT name FROM markets WHERE lower(code) = lower($1) AND ($2::int IS NULL OR id <> $2) LIMIT 1`, [code, exceptId]);
    if (r.rows[0]) throw new LedgerError(`Initials ${code} are already used by ${r.rows[0].name}.`, 409);
  }
}

/** Unique-index race (two people adding the same market / shop at once) → the same plain message. */
function uniqueRace(e: unknown, msg: string): never {
  if ((e as { code?: string } | null)?.code === '23505') throw new LedgerError(msg, 409);
  throw e;
}

export async function addMarket(q: Q, input: { name: unknown; code: unknown }, by: string | null) {
  const name = value(checkMarketName(input.name));
  const code = value(checkCode(input.code));
  await assertFree(q, name, code, null);
  const n = await q(`SELECT count(*)::int AS n, COALESCE(MAX(sort_order), 0) AS last FROM markets`);
  if (Number(n.rows[0].n) >= LIMITS.marketsMax) throw new LedgerError(`Up to ${LIMITS.marketsMax} markets.`);
  try {
    const r = await q(`INSERT INTO markets (name, code, sort_order, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, code, active, sort_order`,
      [name, code, Number(n.rows[0].last) + 1, by]);
    return r.rows[0];
  } catch (e) { uniqueRace(e, `A market called "${name}" or with initials ${code} already exists.`); }
}

export async function updateMarket(q: Q, input: { id: unknown; name?: unknown; code?: unknown; active?: unknown }) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid market id is required.');
  const cur = await q(`SELECT id, name, code FROM markets WHERE id = $1 FOR UPDATE`, [id]);
  if (!cur.rows[0]) throw new LedgerError('Market not found.', 404);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const name = input.name !== undefined ? value(checkMarketName(input.name)) : null;
  const code = input.code !== undefined ? value(checkCode(input.code)) : null;
  await assertFree(q, name, code, id);
  if (name != null) set('name', name);
  if (code != null) set('code', code);
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw new LedgerError('active must be true or false.');
    set('active', input.active);
  }
  if (!sets.length) throw new LedgerError('Nothing to update.');
  try {
    const r = await q(`UPDATE markets SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, code, active, sort_order`, vals);
    return { market: r.rows[0], oldCode: String(cur.rows[0].code) };
  } catch (e) { uniqueRace(e, 'Another market already has that name or those initials.'); }
}

/**
 * Add a shop to a market (or switch a removed one back on). Returns the shop and whether it is new.
 * `marketId` must be an active market.
 */
export async function addShop(q: Q, marketId: unknown, shopNo: unknown, by: string | null) {
  const id = Number(marketId);
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('Pick a market.');
  const shop = value(checkShop(shopNo));
  const m = await q(`SELECT id, name, active FROM markets WHERE id = $1`, [id]);
  if (!m.rows[0]) throw new LedgerError('Market not found.', 404);
  if (!m.rows[0].active) throw new LedgerError(`${m.rows[0].name} is switched off. Switch it on in My firm first.`);
  const n = await q(`SELECT count(*)::int AS n FROM market_shops WHERE market_id = $1`, [id]);
  const r = await q(
    `INSERT INTO market_shops (market_id, shop_no, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (market_id, shop_no) DO UPDATE SET active = true
     RETURNING id, market_id, shop_no, active, (xmax = 0) AS inserted`,
    [id, shop, by],
  );
  if (r.rows[0].inserted && Number(n.rows[0].n) >= LIMITS.shopsPerMarketMax) throw new LedgerError(`Up to ${LIMITS.shopsPerMarketMax} shops per market.`);
  return { shop: { id: Number(r.rows[0].id), market_id: id, shop_no: shop, active: true }, created: !!r.rows[0].inserted, market: String(m.rows[0].name) };
}

export async function updateShop(q: Q, input: { id: unknown; active?: unknown }) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid shop id is required.');
  if (typeof input.active !== 'boolean') throw new LedgerError('active must be true or false.');
  const r = await q(`UPDATE market_shops SET active = $2 WHERE id = $1 RETURNING id, market_id, shop_no, active`, [id, input.active]);
  if (!r.rows[0]) throw new LedgerError('Shop not found.', 404);
  return r.rows[0];
}

// ---------- search ----------
/**
 * Search words that name a market ("landmark", "raghuveer") → LIKE patterns for its location labels: the current
 * initials and any older initials still on lot location rows ("% lm %"). Location text in the search documents always
 * follows a space (it is appended after lot / quality / design …), and the code is followed by a space and the shop.
 * Words under 3 letters are left alone ("lm" already matches "lm 245" as plain text).
 */
let codesCache: { at: number; list: { name: string; codes: string[] }[] } | null = null;
export function invalidateMarketSearch() { codesCache = null; }

export async function marketSearchPatterns(q: Q, words: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const wanted = [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && /\p{L}/u.test(w)))];
  if (!wanted.length) return out;
  if (!codesCache || Date.now() - codesCache.at > 60_000) {
    const r = await q(
      `SELECT lower(m.name) AS name,
              array(SELECT lower(m.code) UNION
                    SELECT DISTINCT lower(split_part(ll.location, ' ', 1)) FROM lot_locations ll WHERE ll.market_id = m.id) AS codes
         FROM markets m`,
    ).catch(() => ({ rows: [] as { name: string; codes: string[] }[] }));
    codesCache = { at: Date.now(), list: (r.rows as { name: string; codes: string[] }[]).map((x) => ({ name: x.name, codes: x.codes.filter((c) => /^[a-z0-9]{1,6}$/.test(c)) })) };
  }
  for (const w of wanted) {
    const codes = new Set(codesCache.list.filter((m) => m.name.includes(w)).flatMap((m) => m.codes));
    if (codes.size) out.set(w, [...codes].map((c) => `% ${c} %`));
  }
  return out;
}
