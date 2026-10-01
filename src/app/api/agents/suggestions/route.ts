import { NextRequest, NextResponse, after } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { AGENTS } from '@/lib/agents/registry';
import { agentsDue, runAgents } from '@/lib/agents/runner';
import { agentSettings } from '@/lib/agents/settings';
import { quietDaysFor } from '@/lib/agents/catalog';
import { markAgentsStale } from '@/lib/agents/stale';
import type { AgentKey, Suggestion } from '@/lib/agents/types';
import { readObject, requireUser } from '@/lib/apiAuth';

// GET → open alerts + suggested actions, read straight from agent_suggestions (fast: no scan on the request path).
// When a scan is due (5 min, or data changed) it starts in the background and the answer says `refreshing: true`,
// so the app asks again a few seconds later. Cards of switched-off agents are never listed, and each agent shows at
// most its "max open" (developer console → Agents), most urgent first.
// Supervisors never see money-related (owner_only) items; workers get none.
export async function GET(req: NextRequest) {
  try {
    const { role } = await requireUser(req);
    if (role === 'worker') return NextResponse.json({ suggestions: [] });
    let refreshing = false;
    if (await agentsDue()) {
      refreshing = true;
      const run = runAgents({ trigger: 'auto' }).catch((e) => { console.error('[agents] run failed', e); });
      after(() => run); // keeps the scan alive after the response on serverless hosts
    }
    const settings = await agentSettings();
    const off = (Object.keys(settings) as AgentKey[]).filter((k) => !settings[k].enabled);
    const caps = Object.fromEntries((Object.keys(settings) as AgentKey[]).map((k) => [k, settings[k].maxOpen]));
    const r = await query(
      `SELECT id, agent, kind, severity, title, detail, payload, target_type, target_id, action_label, owner_only, created_at
       FROM (
         SELECT s.*, row_number() OVER (PARTITION BY s.agent
                  ORDER BY CASE s.severity WHEN 'bad' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, (s.action_label IS NULL), s.created_at DESC) AS rn
         FROM agent_suggestions s
         WHERE s.status = 'open' AND ($1::boolean OR NOT s.owner_only) AND NOT (s.agent = ANY($2::text[]))
       ) x
       WHERE x.rn <= COALESCE(($3::jsonb ->> x.agent)::int, 8)
       ORDER BY CASE severity WHEN 'bad' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, (action_label IS NULL), created_at DESC LIMIT 300`,
      [role === 'owner', off, JSON.stringify(caps)],
    );
    return NextResponse.json(
      { suggestions: r.rows.map((x) => ({ ...x, id: Number(x.id) })), refreshing },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { id, action: 'accept' | 'reject', choice? } → act on a suggestion.
// `choice` picks one of the card's alternatives (payload.choices[].value), e.g. another order to count a dispatch against.
export async function POST(req: NextRequest) {
  try {
    const { role, by: actor } = await requireUser(req);
    const b = await readObject(req);
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid suggestion id is required.');
    if (b.action !== 'accept' && b.action !== 'reject') throw new LedgerError('action must be accept or reject.');
    const choice = b.choice == null || b.choice === '' ? null : Number(b.choice);
    if (choice != null && (!Number.isInteger(choice) || choice <= 0)) throw new LedgerError('choice must be a whole number.');
    if (role === 'worker') throw new LedgerError('You are not allowed to do this.', 403);
    const message = await withTransaction(async (q) => {
      const r = await q(`SELECT * FROM agent_suggestions WHERE id = $1 FOR UPDATE`, [id]);
      const s = r.rows[0] as (Suggestion & { status: string }) | undefined;
      if (!s) throw new LedgerError('Suggestion not found.', 404);
      if (s.status !== 'open') throw new LedgerError('This was already handled.');
      if (s.owner_only && role !== 'owner') throw new LedgerError('You are not allowed to do this.', 403);
      const dl = (s.payload as { dismiss_label?: string } | null)?.dismiss_label;
      const quiet = quietDaysFor(s.agent, s.kind);
      let msg = dl ? `Noted: ${dl.toLowerCase()}${quiet >= 3650 ? " — you won't be asked about it again" : ''}` : quiet >= 3650 ? "Dismissed — it won't come back" : quiet > 1 ? `Dismissed — it stays away for ${quiet} days` : 'Dismissed';
      if (b.action === 'accept') {
        const mod = AGENTS[s.agent];
        if (!mod?.accept || !s.action_label) throw new LedgerError('Nothing to do for this one — dismiss it instead.');
        const st = (await agentSettings(q))[s.agent];
        if (st && !st.enabled) throw new LedgerError('This helper is switched off.');
        msg = await mod.accept({ ...s, id: Number(s.id) }, q, actor, choice);
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
