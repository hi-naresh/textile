import fs from 'fs';
import path from 'path';

export interface ExtractedStockData {
  lot_id?: string;
  quality?: string;
  design?: string;
  meters?: number;
  party?: string;
  source_doc?: string;
  job_card_id?: number;
  meters_out?: number;
  worker_id?: string;
}

export interface ExtractionResult {
  data: ExtractedStockData;
  confidence: number; // 0.0 to 1.0
  success: boolean;
  rawResponse?: string;
}

/**
 * Encodes a local file to base64
 */
function fileToBase64(filePath: string): { data: string; mediaType: string } {
  const ext = path.extname(filePath).toLowerCase();
  let mediaType = 'image/jpeg';
  if (ext === '.png') mediaType = 'image/png';
  else if (ext === '.webp') mediaType = 'image/webp';
  
  const fileData = fs.readFileSync(filePath);
  return {
    data: fileData.toString('base64'),
    mediaType
  };
}

/**
 * Call Anthropic Claude API for vision extraction
 */
async function extractWithClaude(
  base64Data: string,
  mediaType: string,
  type: 'incoming_stock' | 'outgoing_stock' | 'job_card_folding',
  apiKey: string
): Promise<ExtractionResult> {
  const systemPrompt = `You are a specialized OCR and data extraction system for a textile mill in Surat.
Your job is to read images of challans, lot tags, or meter displays and extract the required information in a strict JSON format.

${
  type === 'incoming_stock'
    ? 'For incoming stock, extract: "lot_id" (e.g. LOT-5021), "quality" (fabric quality name, e.g. Poly-Crepe, Georgette), "design" (design code, e.g. Design-104A), "meters" (numeric total meters), "party" (supplier name), "source_doc" (challan number).'
    : type === 'outgoing_stock'
    ? 'For outgoing stock, extract: "lot_id" (e.g. LOT-5021), "meters" (numeric total dispatch meters), "party" (client/buyer name), "source_doc" (dispatch challan or invoice number).'
    : 'For job card folding, extract: "lot_id" (e.g. LOT-5021), "job_card_id" (numeric, if visible), "meters_out" (numeric folded meters out), "worker_id" (worker ID, e.g. wrk-04 if visible).'
}

Rules:
1. Return ONLY a JSON object. No conversational text, no markdown block wrappers (do not include \`\`\`json).
2. If any field is not readable or missing, set its value to null.
3. In addition to the fields, add a field "confidence" which is a decimal between 0.0 and 1.0 representing your overall confidence in the extraction (lower confidence if text is blurry, hand-written, or ambiguous).
`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              {
                type: 'text',
                text: systemPrompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${errText}`);
    }

    const resJson = await response.json();
    const content = resJson.content?.[0]?.text || '';
    
    // Parse response
    const cleaned = content.trim().replace(/^```json\s*/, '').replace(/```$/, '');
    const data = JSON.parse(cleaned);
    
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0.85;
    delete data.confidence; // Remove confidence from data fields
    
    return {
      data,
      confidence,
      success: true,
      rawResponse: content
    };
  } catch (error) {
    console.error('Error in Claude Vision Extraction:', error);
    return {
      data: {},
      confidence: 0,
      success: false,
      rawResponse: String(error)
    };
  }
}

/**
 * Mock OCR extraction for local development and demonstration
 */
function extractWithMock(
  filename: string,
  type: 'incoming_stock' | 'outgoing_stock' | 'job_card_folding'
): ExtractionResult {
  const nameLower = filename.toLowerCase();
  
  // Set confidence based on filename keywords
  let confidence = 0.95; // High confidence default
  if (nameLower.includes('low') || nameLower.includes('blur') || nameLower.includes('pending')) {
    confidence = 0.62; // Low confidence, triggers pending confirm queue
  }

  // Generate realistic data
  if (type === 'incoming_stock') {
    const lotNum = Math.floor(Math.random() * 9000) + 1000;
    return {
      data: {
        lot_id: `LOT-${lotNum}`,
        quality: nameLower.includes('silk') ? 'Silk Premium' : 'Poly-Crepe Super',
        design: `Design-${Math.floor(Math.random() * 800) + 100}A`,
        meters: parseFloat((Math.random() * 500 + 400).toFixed(2)),
        party: 'Surat Textiles Ltd',
        source_doc: `CH-${Math.floor(Math.random() * 9000) + 1000}`
      },
      confidence,
      success: true
    };
  } else if (type === 'outgoing_stock') {
    return {
      data: {
        lot_id: 'LOT-5021', // Existing lot
        meters: parseFloat((Math.random() * 100 + 400).toFixed(2)),
        party: 'Mumbai Fabrics Distributor',
        source_doc: `DISP-${Math.floor(Math.random() * 900) + 100}`
      },
      confidence,
      success: true
    };
  } else {
    // job_card_folding
    return {
      data: {
        lot_id: 'LOT-5021',
        job_card_id: 1,
        meters_out: 485.50, // Slightly less than 500.00 (shortage 14.50)
        worker_id: 'wrk-04'
      },
      confidence,
      success: true
    };
  }
}

/**
 * Main API to extract data from a photo
 */
export async function extractDataFromPhoto(
  filePath: string,
  type: 'incoming_stock' | 'outgoing_stock' | 'job_card_folding'
): Promise<ExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const filename = path.basename(filePath);

  if (apiKey) {
    console.log(`[AI Extraction] Connecting to Claude API for ${filename}...`);
    try {
      const { data, mediaType } = fileToBase64(filePath);
      return await extractWithClaude(data, mediaType, type, apiKey);
    } catch (e) {
      console.error('[AI Extraction] Claude extraction failed, falling back to mock.', e);
      return extractWithMock(filename, type);
    }
  } else {
    console.log(`[AI Extraction] No Anthropic API key found. Using mock OCR for ${filename}.`);
    // Simulate slight delay to feel real
    await new Promise(resolve => setTimeout(resolve, 800));
    return extractWithMock(filename, type);
  }
}
