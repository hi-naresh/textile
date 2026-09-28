import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { AGENTS } from '@/lib/agents/registry';
import { runAgents } from '@/lib/agents/runner';
import { markAgentsStale } from '@/lib/agents/stale';
import type { Suggestion } from '@/lib/agents/types';
import { readObject, requireUser } from '@/lib/apiAuth';

// GET → open alerts + suggested actions (runs the agent scan first if it's stale).
// Supervisors never see money-related (owner_only) items; workers get none.
export async function GET(req: NextRequest) {
  try {
    const { role } = await requireUser(req);
    if (role === 'worker') return NextResponse.json({ suggestions: [] });
    await runAgents(false).catch((e) => console.error('[agents] run failed', e));
    const r = await query(
      `SELECT id, agent, kind, severity, title, detail, payload, target_type, target_id, action_label, owner_only, created_at
       FROM agent_suggestions WHERE status = 'open' AND ($1::boolean OR NOT owner_only)
       ORDER BY CASE severity WHEN 'bad' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, (action_label IS NULL), created_at DESC LIMIT 300`,
      [role === 'owner'],
    );
    return NextResponse.json({ suggestions: r.rows.map((x) => ({ ...x, id: Number(x.id) })) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { id, action: 'accept' | 'reject' } → act on a suggestion.
export async function POST(req: NextRequest) {
  try {
    const { role, by: actor } = await requireUser(req);
    const b = await readObject(req);
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid suggestion id is required.');
    if (b.action !== 'accept' && b.action !== 'reject') throw new LedgerError('action must be accept or reject.');
    if (role === 'worker') throw new LedgerError('You are not allowed to do this.', 403);
    const message = await withTransaction(async (q) => {
      const r = await q(`SELECT * FROM agent_suggestions WHERE id = $1 FOR UPDATE`, [id]);
      const s = r.rows[0] as (Suggestion & { status: string }) | undefined;
      if (!s) throw new LedgerError('Suggestion not found.', 404);
      if (s.status !== 'open') throw new LedgerError('This was already handled.');
      if (s.owner_only && role !== 'owner') throw new LedgerError('You are not allowed to do this.', 403);
      let msg = 'Dismissed';
      if (b.action === 'accept') {
        const mod = AGENTS[s.agent];
        if (!mod?.accept || !s.action_label) throw new LedgerError('Nothing to do for this one — dismiss it instead.');
        msg = await mod.accept({ ...s, id: Number(s.id) }, q, actor);
        await markAgentsStale(q);
      }
      await q(`UPDATE agent_suggestions SET status = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [id, b.action === 'accept' ? 'accepted' : 'rejected', actor]);
      return msg;
    });
    return NextResponse.json({ success: true, message });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
