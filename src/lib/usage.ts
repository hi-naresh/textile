// Developer-facing log of every paid AI call (OCR + LLM): feature, model tier, tokens, latency, cost.
// Read it at /dev/usage (needs DEV_ACCESS_TOKEN). Logging never breaks the calling feature.
import { query } from './db';

export type Tier = 'ocr' | 'low' | 'high';

export interface UsageEntry {
  feature: string; // capture.ocr, capture.llm_text, capture.llm_vision, chat.intent, chat.rag
  provider: 'google_vision' | 'gemini';
  model: string;
  tier: Tier;
  tokensIn?: number;
  tokensOut?: number;
  units?: number; // OCR images
  latencyMs: number;
  success: boolean;
  error?: string | null;
  ref?: string | null;
}

const num = (name: string, fallback: number) => {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/**
 * Prices in USD. Defaults are estimates — set the env vars to your actual Google price list.
 * LLM prices are per 1 million tokens; OCR is per image.
 */
export function prices() {
  return {
    low: { in: num('LLM_PRICE_LOW_IN', 0.1), out: num('LLM_PRICE_LOW_OUT', 0.4) },
    high: { in: num('LLM_PRICE_HIGH_IN', 0.3), out: num('LLM_PRICE_HIGH_OUT', 2.5) },
    ocrPerImage: num('OCR_PRICE_PER_IMAGE', 0.0015),
  };
}

export function costUsd(e: Pick<UsageEntry, 'tier' | 'tokensIn' | 'tokensOut' | 'units'>): number {
  const p = prices();
  if (e.tier === 'ocr') return (e.units ?? 0) * p.ocrPerImage;
  const t = p[e.tier];
  return ((e.tokensIn ?? 0) * t.in + (e.tokensOut ?? 0) * t.out) / 1_000_000;
}

export async function logUsage(e: UsageEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO llm_usage (feature, provider, model, tier, tokens_in, tokens_out, units, latency_ms, cost_usd, success, error, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [e.feature, e.provider, e.model.slice(0, 80), e.tier, e.tokensIn ?? 0, e.tokensOut ?? 0, e.units ?? 0, Math.round(e.latencyMs), costUsd(e), e.success, e.error ? e.error.slice(0, 500) : null, e.ref ?? null],
    );
  } catch (err) {
    console.error('[usage] could not log AI usage', err);
  }
}
