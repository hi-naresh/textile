import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';
import { prices } from '@/lib/usage';

// Developer only: AI usage + cost log. Any other session gets 404.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const d = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') ?? '30', 10) || 30, 1), 366);
    const [byFeature, byDay, recent, engines] = await Promise.all([
      query(
        `SELECT feature, provider, model, tier, COUNT(*) AS calls, SUM(CASE WHEN success THEN 0 ELSE 1 END) AS failures,
                SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(units) AS units,
                ROUND(AVG(latency_ms)) AS avg_latency_ms, ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
         FROM llm_usage WHERE ts >= CURRENT_DATE - ($1::int - 1)
         GROUP BY feature, provider, model, tier ORDER BY cost_usd DESC`,
        [d],
      ),
      query(
        `SELECT ts::date AS day, COUNT(*) AS calls, ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
         FROM llm_usage WHERE ts >= CURRENT_DATE - ($1::int - 1) GROUP BY 1 ORDER BY 1 DESC`,
        [d],
      ),
      query(`SELECT id, ts, feature, model, tier, tokens_in, tokens_out, units, latency_ms, cost_usd, success, error, ref FROM llm_usage ORDER BY id DESC LIMIT 100`),
      query(
        `SELECT COALESCE(read_engine, 'unknown') AS engine, COUNT(*) AS reads,
                ROUND(AVG(confidence)::numeric, 2) AS avg_confidence,
                SUM(CASE WHEN status = 'corrected' THEN 1 ELSE 0 END) AS corrected
         FROM capture_events WHERE ts >= CURRENT_DATE - ($1::int - 1) GROUP BY 1 ORDER BY reads DESC`,
        [d],
      ),
    ]);
    const total = byFeature.rows.reduce((s, r) => s + Number(r.cost_usd), 0);
    return NextResponse.json(
      { days: d, totalCostUsd: Math.round(total * 10000) / 10000, prices: prices(), byFeature: byFeature.rows, byDay: byDay.rows, captureEngines: engines.rows, recent: recent.rows },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
