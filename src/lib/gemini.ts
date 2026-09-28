// Google Gemini connection settings + a cached health check used to warn users
// when AI photo reading / chat is not available.

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Model tiers. "low" = cheap/fast (chat intent, reading OCR text), "high" = strongest (reading a photo directly).
 * GEMINI_MODEL_LOW / GEMINI_MODEL_HIGH override each tier; GEMINI_MODEL sets both.
 */
export function geminiModel(tier: 'low' | 'high' = 'high'): string {
  const own = tier === 'low' ? process.env.GEMINI_MODEL_LOW : process.env.GEMINI_MODEL_HIGH;
  return (own || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

export function geminiKey(): string | null {
  const k = process.env.GEMINI_API_KEY?.trim();
  return k ? k : null;
}

/** generateContent endpoint; the key goes in a header so it never appears in URLs or logs. */
export function geminiRequest(apiKey: string, tier: 'low' | 'high' = 'high') {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel(tier))}:generateContent`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
  };
}

export type AiState = 'connected' | 'missing' | 'invalid_key' | 'model_unavailable' | 'unreachable' | 'demo';

export interface AiStatus {
  state: AiState;
  model: string;
  message: string; // plain-English explanation for the banner
  fix: string; // what the owner/admin should do
  checkedAt: string;
}

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; status: AiStatus } | null = null;

function demoAllowed() {
  return process.env.ALLOW_MOCK_AI === '1' || (process.env.NODE_ENV !== 'production' && !process.env.VERCEL);
}

function make(state: AiState, message: string, fix: string): AiStatus {
  return { state, model: geminiModel(), message, fix, checkedAt: new Date().toISOString() };
}

/** Record a failure seen during a real AI call so the banner shows up without waiting for the next check. */
export function reportAiFailure(httpStatus: number | null, detail: string) {
  const status =
    httpStatus === 404
      ? make('model_unavailable', `The AI model "${geminiModel()}" is not available.`, 'Set GEMINI_MODEL to a current Gemini model in the server settings.')
      : httpStatus === 400 || httpStatus === 401 || httpStatus === 403
        ? make('invalid_key', 'The AI key was rejected by Google.', 'Check GEMINI_API_KEY in the server settings (Vercel → Environment Variables).')
        : make('unreachable', `The AI service could not be reached${detail ? ` (${detail.slice(0, 80)})` : ''}.`, 'Usually temporary. If it keeps happening, check the Gemini API status and your quota.');
  cached = { at: Date.now(), status };
}

export function reportAiSuccess() {
  if (cached?.status.state !== 'connected') cached = { at: Date.now(), status: make('connected', 'AI photo reading and chat are working.', '') };
}

export async function getAiStatus(force = false): Promise<AiStatus> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.status;
  const key = geminiKey();
  let status: AiStatus;
  if (!key) {
    status = demoAllowed()
      ? make('demo', 'AI is not connected — photo reads use fake demo data.', 'Add GEMINI_API_KEY to .env.local to use real AI reading.')
      : make('missing', 'AI is not connected, so photos cannot be read automatically.', 'Add GEMINI_API_KEY in Vercel → Project → Settings → Environment Variables, then redeploy.');
  } else {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}`, {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(6000),
        cache: 'no-store',
      });
      if (res.ok) status = make('connected', 'AI photo reading and chat are working.', '');
      else if (res.status === 404) status = make('model_unavailable', `The AI model "${geminiModel()}" is not available.`, 'Set GEMINI_MODEL to a current Gemini model in the server settings.');
      else if ([400, 401, 403].includes(res.status)) status = make('invalid_key', 'The AI key was rejected by Google.', 'Check GEMINI_API_KEY in the server settings (Vercel → Environment Variables).');
      else status = make('unreachable', `The AI service answered with an error (${res.status}).`, 'Usually temporary. If it keeps happening, check your Gemini quota.');
    } catch (e) {
      status = make('unreachable', 'The AI service could not be reached.', `Check the server's internet access. (${e instanceof Error ? e.message : 'network error'})`);
    }
  }
  cached = { at: Date.now(), status };
  return status;
}

// ---------- One call path for every Gemini request: tier choice + usage/cost log ----------
type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiCall {
  tier: 'low' | 'high';
  feature: string; // for the usage log, e.g. chat.intent
  parts: Part[];
  json?: boolean;
  temperature?: number;
  ref?: string | null;
  timeoutMs?: number;
}

export class GeminiError extends Error {}

/** Returns the model's text. Throws GeminiError when not configured or the call fails (after logging it). */
export async function callGemini(c: GeminiCall): Promise<string> {
  const key = geminiKey();
  if (!key) throw new GeminiError('GEMINI_API_KEY is not set.');
  const model = geminiModel(c.tier);
  const started = Date.now();
  const { logUsage } = await import('./usage');
  try {
    const req = geminiRequest(key, c.tier);
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      signal: AbortSignal.timeout(c.timeoutMs ?? 45_000),
      body: JSON.stringify({
        contents: [{ parts: c.parts }],
        generationConfig: { temperature: c.temperature ?? 0.1, ...(c.json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const errText = await res.text();
      reportAiFailure(res.status, errText);
      await logUsage({ feature: c.feature, provider: 'gemini', model, tier: c.tier, latencyMs, success: false, error: `${res.status} ${errText.slice(0, 200)}`, ref: c.ref });
      throw new GeminiError(`Gemini error ${res.status}`);
    }
    const data = await res.json();
    reportAiSuccess();
    const meta = data.usageMetadata ?? {};
    await logUsage({
      feature: c.feature, provider: 'gemini', model, tier: c.tier, latencyMs, success: true, ref: c.ref,
      tokensIn: meta.promptTokenCount ?? 0,
      tokensOut: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    });
    return (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('').trim();
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    reportAiFailure(null, String(e));
    await logUsage({ feature: c.feature, provider: 'gemini', model, tier: c.tier, latencyMs: Date.now() - started, success: false, error: String(e), ref: c.ref });
    throw new GeminiError(String(e));
  }
}

/** Parse a JSON answer, tolerating ```json fences. */
export function parseJsonAnswer<T = Record<string, unknown>>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned) as T;
}
