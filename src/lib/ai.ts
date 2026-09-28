import { callGemini, geminiKey, parseJsonAnswer } from '@/lib/gemini';
import { ocrImage, visionKey } from '@/lib/vision';
import { parseOcr } from '@/lib/capture/parse';

export interface ExtractedStockData {
  lot_id?: string;
  quality?: string;
  design?: string;
  meters?: number; // outgoing only
  grey_meters?: number; // incoming: raw (grey) meters on the challan
  finished_meters?: number; // incoming: finished meters on the challan
  mill_name?: string; // incoming: mill the material came from
  weaver_name?: string; // incoming: weaver (may be the same as the mill)
  party?: string; // outgoing only: destination client
  source_doc?: string;
  job_card_id?: number;
  meters_out?: number;
  worker_id?: string;
}

export type ReadEngine = 'ocr' | 'llm_text' | 'llm_vision' | 'mock';

export interface ExtractionResult {
  data: ExtractedStockData;
  confidence: number; // 0.0 to 1.0
  success: boolean;
  rawResponse?: string;
  engine?: ReadEngine;
  meta?: Record<string, unknown>; // what the router did and why (stored with the read for audit)
}

export interface PhotoInput {
  buffer: Buffer;
  filename: string; // original upload name (used only by the mock reader)
  mediaType: string; // e.g. image/jpeg
}

type CaptureKind = 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';

/** Mock reads are for local development only; in production a failed read must never invent data. */
function mockAllowed() {
  return process.env.ALLOW_MOCK_AI === '1' || (process.env.NODE_ENV !== 'production' && !process.env.VERCEL);
}

/** Below this mean OCR word confidence the photo is treated as unreadable by OCR (blurry, handwritten). */
function ocrMinConfidence() {
  const v = parseFloat(process.env.OCR_MIN_CONFIDENCE ?? '');
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.75;
}

function fieldsPrompt(type: CaptureKind) {
  return type === 'incoming_stock'
    ? '"lot_id" (lot number), "quality" (fabric quality), "design" (design code, if any), "grey_meters" (total grey / raw meters), "finished_meters" (total finished / received meters), "mill_name", "weaver_name" (can be the same as the mill), "source_doc" (challan number). Grey and finished meters are different numbers — never copy one into the other. Do not extract a party for incoming stock.'
    : type === 'outgoing_stock'
    ? '"lot_id", "meters" (total dispatch meters), "party" (client receiving the goods), "source_doc" (dispatch challan or invoice number).'
    : '"lot_id", "job_card_id" (number, if printed), "meters_out" (total cut / folded / received meters), "worker_id" (if printed).';
}

const RULES = `Rules:
1. Return ONLY a JSON object with those keys plus "confidence" (0.0–1.0, your overall confidence; lower it for blur, handwriting or anything ambiguous).
2. A value you cannot read is null. Never guess numbers.
3. Numbers are plain numbers without commas or units.`;

function splitConfidence(raw: Record<string, unknown>): { data: ExtractedStockData; confidence: number } {
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.6;
  const data = { ...raw } as Record<string, unknown>;
  delete data.confidence;
  return { data: data as ExtractedStockData, confidence };
}

function required(type: CaptureKind, d: ExtractedStockData): boolean {
  if (type === 'incoming_stock') return !!d.lot_id && (d.grey_meters != null || d.finished_meters != null);
  if (type === 'outgoing_stock') return !!d.lot_id && d.meters != null && !!d.party;
  return !!d.lot_id && d.meters_out != null;
}

/** Low tier: read already-OCR'd text (cheap, no image tokens). */
async function llmFromText(ocrText: string, type: CaptureKind, ref: string): Promise<ExtractionResult> {
  const prompt = `You extract fields from OCR text of an Indian textile challan / job card (English, Hindi or Gujarati).
Extract: ${fieldsPrompt(type)}
${RULES}

OCR text (rows are in reading order):
"""
${ocrText.slice(0, 12000)}
"""`;
  const text = await callGemini({ tier: 'low', feature: 'capture.llm_text', parts: [{ text: prompt }], json: true, ref });
  const { data, confidence } = splitConfidence(parseJsonAnswer(text));
  return { data, confidence, success: true, rawResponse: text, engine: 'llm_text' };
}

/** High tier: read the photo itself (most expensive; used when OCR can't read it). */
async function llmFromImage(photo: PhotoInput, type: CaptureKind, ref: string): Promise<ExtractionResult> {
  const prompt = `You read photos of Indian textile challans, lot tags and job cards (English, Hindi or Gujarati).
Extract: ${fieldsPrompt(type)}
${RULES}`;
  const text = await callGemini({
    tier: 'high', feature: 'capture.llm_vision', json: true, ref,
    parts: [{ text: prompt }, { inlineData: { mimeType: photo.mediaType, data: photo.buffer.toString('base64') } }],
  });
  const { data, confidence } = splitConfidence(parseJsonAnswer(text));
  return { data, confidence, success: true, rawResponse: text, engine: 'llm_vision' };
}

/**
 * Mock OCR extraction for local development and demonstration
 */
function extractWithMock(
  filename: string,
  type: 'incoming_stock' | 'outgoing_stock' | 'job_card_folding'
): ExtractionResult {
  const nameLower = filename.toLowerCase();
  
  // Set confidence to 0.65 as default to trigger confirmation queue for presentation
  let confidence = 0.65;
  if (nameLower.includes('high') || nameLower.includes('sure') || nameLower.includes('autocommit')) {
    confidence = 0.95; // Allow forcing high-confidence if needed
  }

  // Generate realistic data based on user's real lot sheets (Lot 257A)
  if (type === 'incoming_stock') {
    return {
      data: {
        lot_id: '257A',
        quality: 'DON-2',
        design: 'Design-DON2',
        grey_meters: 9240.00,
        finished_meters: 8988.00,
        mill_name: 'HARIDWAR TEXTILES',
        weaver_name: 'HARIDWAR TEXTILES',
        source_doc: '51'
      },
      confidence,
      success: true
    };
  } else if (type === 'outgoing_stock') {
    return {
      data: {
        lot_id: '257A',
        meters: 7704.00,
        party: 'Retail Distributor',
        source_doc: 'DISP-51'
      },
      confidence,
      success: true
    };
  } else {
    // job_card_folding
    return {
      data: {
        lot_id: '257A',
        job_card_id: undefined, // Simulates missing job_card_id to test dynamic fallback lookup
        meters_out: 7704.00,
        worker_id: 'wrk-05' // mock data (demo seed worker)
      },
      confidence,
      success: true
    };
  }
}

/**
 * Decision layer for reading a photo — cheapest path first:
 *   1. OCR (Google Vision) + deterministic parser with arithmetic cross-checks → accepted as is when the
 *      read is complete and nothing contradicts itself (no LLM call at all).
 *   2. OCR text is readable but the read is incomplete / contradicts itself → low-tier LLM on the OCR text.
 *   3. OCR can't read the photo (low confidence) or isn't configured, or step 2 is still incomplete → high-tier vision LLM.
 *   4. Nothing configured → demo reads in local development only.
 * Every OCR/LLM call is logged with tokens, latency and cost (llm_usage).
 */
export async function extractDataFromPhoto(photo: PhotoInput, type: CaptureKind, ref = 'capture'): Promise<ExtractionResult> {
  const steps: Record<string, unknown>[] = [];
  const hasLlm = !!geminiKey();
  let best: ExtractionResult | null = null;

  if (visionKey()) {
    try {
      const ocr = await ocrImage(photo.buffer, ref);
      const parsed = parseOcr(ocr.lines, ocr.confidence, type);
      const failed = parsed.checks.filter((c) => !c.ok);
      steps.push({ step: 'ocr', ocr_confidence: Math.round(ocr.confidence * 100) / 100, words: ocr.words, format: parsed.format, complete: parsed.complete, checks: parsed.checks });
      const ocrRead: ExtractionResult = { data: parsed.data as ExtractedStockData, confidence: parsed.confidence, success: true, engine: 'ocr', rawResponse: ocr.text.slice(0, 4000) };
      const readable = ocr.confidence >= ocrMinConfidence() && ocr.words > 5;
      if (readable && parsed.complete && failed.length === 0) return { ...ocrRead, meta: { steps, decision: 'ocr accepted: complete and cross-checks agree' } };
      best = parsed.complete ? ocrRead : null;
      if (readable && hasLlm) {
        try {
          const r = await llmFromText(ocr.text, type, ref);
          steps.push({ step: 'llm_text', confidence: r.confidence, complete: required(type, r.data) });
          if (required(type, r.data)) return { ...r, meta: { steps, decision: 'OCR read incomplete or inconsistent → low-tier LLM on OCR text' } };
        } catch (e) {
          steps.push({ step: 'llm_text', error: String(e).slice(0, 200) });
        }
      }
    } catch (e) {
      steps.push({ step: 'ocr', error: String(e).slice(0, 200) });
    }
  } else {
    steps.push({ step: 'ocr', skipped: 'GOOGLE_VISION_API_KEY not set' });
  }

  if (hasLlm) {
    try {
      const r = await llmFromImage(photo, type, ref);
      steps.push({ step: 'llm_vision', confidence: r.confidence, complete: required(type, r.data) });
      return { ...r, meta: { steps, decision: 'photo read by high-tier vision LLM' } };
    } catch (e) {
      steps.push({ step: 'llm_vision', error: String(e).slice(0, 200) });
    }
  }

  if (best) return { ...best, confidence: Math.min(best.confidence, 0.6), meta: { steps, decision: 'OCR read kept for review (LLM not available)' } };

  if (mockAllowed()) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const m = extractWithMock(photo.filename, type);
    return { ...m, engine: 'mock', meta: { steps, decision: 'demo read (OCR/AI not configured or failing; local development only)' } };
  }
  const why = !visionKey() && !hasLlm ? 'Neither GOOGLE_VISION_API_KEY nor GEMINI_API_KEY is set on the server.' : 'The photo could not be read.';
  return { data: {}, confidence: 0, success: false, rawResponse: why, engine: undefined, meta: { steps } };
}
