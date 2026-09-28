// Small helpers shared by the dispatch, invoice and document code.
import type { Q } from '../db';

/** users.id when it exists, else null (created_by / moved_by are foreign keys). */
export async function validActor(q: Q, actor: string | null | undefined): Promise<string | null> {
  if (!actor) return null;
  const r = await q(`SELECT id FROM users WHERE id = $1`, [actor]);
  return r.rows[0] ? String(r.rows[0].id) : null;
}

/** Trimmed text or null, cut to max. */
export const textOrNull = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Today's date in the database (YYYY-MM-DD). */
export async function dbToday(q: Q): Promise<string> {
  const r = await q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`);
  return r.rows[0].d;
}

/** Log a generated document / export (generated_docs). Never fails the download. */
export async function logDoc(q: Q, kind: 'challan' | 'packing_list' | 'invoice' | 'statement' | 'tally_export', ref: string, actor: string | null): Promise<void> {
  try {
    await q(`INSERT INTO generated_docs (kind, ref, created_by) VALUES ($1, $2, $3)`, [kind, ref.slice(0, 60), await validActor(q, actor)]);
  } catch (e) {
    console.error('[docs] could not log generated doc', e);
  }
}

/** Safe file name part. */
export const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'doc';
