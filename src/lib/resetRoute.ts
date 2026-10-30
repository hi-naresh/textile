// Shared handlers for the two reset endpoints: /api/reset (owner) and /api/dev/reset (developer console).
//   GET                         → { parts, needs, counts, firm }    what each part would remove right now
//   GET ?backup=stock,orders    → a JSON backup file of exactly what those parts would remove (download it first)
//   POST { parts: [...], confirm: 'RESET', password } → wipes them in one transaction, logs it in the audit trail
import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from './db';
import { once } from 'node:events';
import { snapshotExport } from './exportSnapshot';
import { withBulkOperation } from './bulkOperation';
import { LedgerError } from './ledger';
import { readObject } from './apiAuth';
import { audit } from './auth/audit';
import { verifyPassword, burnPasswordCheck } from './auth/password';
import { invalidateSettings } from './settings';
import { NEEDS, PART_TABLES, RESET_PARTS, expandParts, isResetPart, partRowsSql, resetCounts, runReset, type ResetPart } from './reset';

export interface ResetActor { userId: string; sessionId: string; viaDeveloper: boolean }

function readParts(raw: unknown): ResetPart[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const parts = list.map((x) => String(x).trim()).filter(Boolean);
  if (!parts.length) throw new LedgerError('Choose what to reset.');
  const bad = parts.find((p) => !isResetPart(p));
  if (bad) throw new LedgerError(`Unknown part: ${bad.slice(0, 40)}.`);
  return expandParts(parts as ResetPart[]);
}

export async function resetGet(req: NextRequest): Promise<Response> {
  const backup = req.nextUrl.searchParams.get('backup');
  if (backup !== null) return backupFile(readParts(backup), req.signal);
  const counts = await resetCounts(query);
  return NextResponse.json({ parts: RESET_PARTS, needs: NEEDS, counts }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function resetPost(req: NextRequest, a: ResetActor): Promise<Response> {
  const b = await readObject(req);
  const parts = readParts(b.parts);
  if (String(b.confirm ?? '').trim().toUpperCase() !== 'RESET') throw new LedgerError('Type RESET to confirm.');
  const pw = typeof b.password === 'string' ? b.password : '';
  const u = await query(`SELECT password_hash FROM users WHERE id = $1`, [a.userId]);
  const hash = u.rows[0]?.password_hash as string | undefined;
  if (!pw || !hash) { await burnPasswordCheck(pw || 'x'); throw new LedgerError('Wrong password.', 403); }
  if (!(await verifyPassword(pw, hash))) throw new LedgerError('Wrong password.', 403);

  const t0 = Date.now();
  const done = await withBulkOperation(() => withTransaction(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('textile.reset'))`); // one reset at a time
    const removed = await runReset(q, parts, a.userId);
    await audit(q, { event: 'data.reset', actorId: a.userId, sessionId: a.sessionId, req, detail: { parts, removed, via_developer: a.viaDeveloper || undefined } });
    return removed;
  }), req.signal);
  invalidateSettings();
  const labels = parts.map((p) => RESET_PARTS.find((x) => x.key === p)!.label);
  return NextResponse.json({ success: true, parts, removed: done, ms: Date.now() - t0, message: `Reset done: ${labels.join(', ')}.` });
}

/** Streams { made_at, parts, tables: { name: [rows…] } } without loading everything into memory. */
async function backupFile(parts: ResetPart[], signal: AbortSignal): Promise<Response> {
  const seen = new Set<string>();
  const jobs: { part: ResetPart; table: string }[] = [];
  for (const p of parts) for (const t of PART_TABLES[p]) if (!seen.has(t)) { seen.add(t); jobs.push({ part: p, table: t }); }
  const { body } = await snapshotExport(signal, async (q) => {
    // Acquire relation locks before streaming: a concurrent reset must wait until
    // the backup finishes, including tables whose cursor has not been opened yet.
    await q(`LOCK TABLE ${jobs.map(({ table }) => table).sort().join(', ')} IN ACCESS SHARE MODE`);
    return {
      metadata: null,
      write: async (output) => {
        const write = async (text: string) => {
          if (!output.write(text)) await once(output, 'drain');
        };
        await write(`{"made_at":${JSON.stringify(new Date().toISOString())},"parts":${JSON.stringify(parts)},"tables":{`);
        for (let i = 0; i < jobs.length; i++) {
          const { part, table } = jobs[i];
          await write(`${i ? ',' : ''}${JSON.stringify(table)}:[`);
          await q(`DECLARE bk NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM (${partRowsSql(part, table)}) t`);
          let first = true;
          for (;;) {
            const r = await q(`FETCH 2000 FROM bk`);
            if (!r.rows.length) break;
            await write((first ? '' : ',') + r.rows.map((x) => x.j).join(','));
            first = false;
          }
          await q(`CLOSE bk`);
          await write(']');
        }
        await write('}}');
      },
    };
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-${parts.join('-')}-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
