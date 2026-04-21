/* =====================================================================
   POST /.netlify/functions/parse-paperwork-background
   Netlify BACKGROUND function — runs async up to 15 min, returns 202
   immediately so the CDN never times out.

   Body: { jobId, pdfBase64, supplementalPdfs?, manufacturer?, dealer? }

   Flow:
   1. Client generates a jobId and calls this function with the PDF.
   2. Client gets 202 immediately and starts polling get-extraction?jobId=...
   3. This function calls Claude, then writes result to ExtractionJobs table.

   Requires Airtable table: ExtractionJobs
   Fields: JobId (text), Status (text), Result (long text), Error (text)
===================================================================== */

const { createRecord, listAll, updateRecord } = require('./_airtable');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_SINGLE = 'claude-haiku-4-5';
const MODEL_MULTI  = 'claude-sonnet-4-5';

// Pricing per token (USD) — update if Anthropic changes rates
const PRICING = {
  [MODEL_SINGLE]: { input: 0.80 / 1e6, output: 4.00 / 1e6 },  // Haiku
  [MODEL_MULTI]:  { input: 3.00 / 1e6, output: 15.00 / 1e6 }, // Sonnet
};

function calcCost(model, usage) {
  const p = PRICING[model] || PRICING[MODEL_SINGLE];
  return (usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output;
}

const SYSTEM_PROMPT = `You are a logistics document parser for a furniture moving company called KRS Moving Solutions. You extract structured product line items from delivery tickets, packing slips, bills of lading, and similar shipping documents.

Always return ONLY valid JSON with no markdown fencing, no explanation text. The JSON must have this exact structure:
{
  "items": [
    {
      "description": "Human-readable product name",
      "manufacturer": "Manufacturer name",
      "sku": "Model/SKU/part number if visible",
      "quantity": 1,
      "barcode": "Barcode value if printed on the document",
      "room": "Room or location if specified",
      "notes": "Any extra info (color, fabric, options)"
    }
  ],
  "meta": {
    "documentType": "Packing List | Bill of Lading | Delivery Ticket | Invoice | Other",
    "orderNumber": "PO or order number if visible",
    "dealer": "Dealer/customer name if visible",
    "shipDate": "Ship date if visible (YYYY-MM-DD)",
    "totalItemCount": 0
  }
}

Rules:
- Each distinct product gets its own item entry. Do NOT lump different products into one row.
- If quantity is listed, use it. If not, default to 1.
- If the same product appears in multiple rooms, create separate items per room.
- SKU can be a model number, catalog number, or part number.
- barcode should only be filled if an actual barcode value (not just a SKU) is printed.
- Be thorough — extract EVERY line item, even small accessories and components.
- If manufacturer is not on the document but was provided as a hint, use the hint.
- totalItemCount should be the sum of all quantities.`;

const SYSTEM_PROMPT_MULTI = SYSTEM_PROMPT + `

Multi-document handling:
- The FIRST document is the pack list / primary doc. It is the SOURCE OF TRUTH for which items exist and their quantities.
- Any ADDITIONAL documents are spec sheets or supplements. Use them ONLY to enrich existing items with extra detail (dimensions, fabric, finish, color, options).
- Do NOT create new line items from the spec sheets.
- Match items between documents by SKU/model number first, then by description.`;

async function storeResult(jobId, recordId, fields) {
  try {
    if (recordId) {
      await updateRecord('ExtractionJobs', recordId, fields);
      return;
    }
    const recs = await listAll('ExtractionJobs', {
      filterByFormula: `{JobId} = '${jobId}'`,
      maxRecords: 1,
    });
    if (recs[0]) await updateRecord('ExtractionJobs', recs[0].id, fields);
  } catch (err) {
    console.error('storeResult error:', err.message);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: 'ANTHROPIC_API_KEY not configured' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const { jobId, pdfBase64, supplementalPdfs, manufacturer, dealer } = body;
  if (!jobId || !pdfBase64) {
    return { statusCode: 400, body: 'Missing jobId or pdfBase64' };
  }

  // Create Airtable record so the poller can find it immediately
  let recordId = null;
  try {
    const rec = await createRecord('ExtractionJobs', {
      JobId: jobId,
      Status: 'processing',
    });
    recordId = rec.id;
  } catch (err) {
    console.error('Could not create ExtractionJobs record:', err.message);
    // Continue — poller will handle "not found" as still-processing
  }

  const supplements = Array.isArray(supplementalPdfs) ? supplementalPdfs : [];
  const hasSupplements = supplements.length > 0;

  // Build Claude message content
  const userContent = [];
  userContent.push({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
  });
  supplements.forEach((s) => {
    if (s && s.pdfBase64) {
      userContent.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: s.pdfBase64 },
      });
    }
  });

  let instruction = hasSupplements
    ? 'The first document is the pack list (source of truth). The following ' +
      supplements.length + ' document(s) are supplemental spec sheets — use them only to enrich existing items, not to create new ones. Extract all product line items from the pack list as JSON.'
    : 'Extract all product line items from this document as JSON.';
  if (manufacturer) instruction += ' The manufacturer is: ' + manufacturer + '.';
  if (dealer) instruction += ' The dealer/customer is: ' + dealer + '.';
  userContent.push({ type: 'text', text: instruction });

  try {
    console.log('Calling Claude for extraction, jobId:', jobId);
    const claudeRes = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: hasSupplements ? MODEL_MULTI : MODEL_SINGLE,
        max_tokens: 8192,
        system: hasSupplements ? SYSTEM_PROMPT_MULTI : SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API error ' + claudeRes.status + ': ' + errText.substring(0, 200));
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    const usage = claudeData.usage || { input_tokens: 0, output_tokens: 0 };
    const modelUsed = hasSupplements ? MODEL_MULTI : MODEL_SINGLE;
    const cost = calcCost(modelUsed, usage);
    console.log('Claude returned', rawText.length, 'chars for jobId:', jobId,
      '| tokens in:', usage.input_tokens, 'out:', usage.output_tokens,
      '| cost: $' + cost.toFixed(6));

    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed for jobId:', jobId, parseErr.message);
      parsed = { items: [], meta: {}, parseError: true };
    }

    const resultStr = JSON.stringify({
      items: parsed.items || [],
      meta: parsed.meta || {},
      parseError: parsed.parseError || false,
      cost,
      usage,
      model: modelUsed,
    });

    await storeResult(jobId, recordId, {
      Status: 'done',
      Result: resultStr.substring(0, 99000),
      Cost: cost,
    });
    console.log('Extraction done for jobId:', jobId, '—', (parsed.items || []).length, 'items | cost: $' + cost.toFixed(6));

  } catch (err) {
    console.error('Extraction failed for jobId:', jobId, err.message);
    await storeResult(jobId, recordId, {
      Status: 'failed',
      Error: err.message.substring(0, 500),
    });
  }

  return { statusCode: 200, body: 'done' };
};
