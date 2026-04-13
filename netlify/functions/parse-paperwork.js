/* =====================================================================
   POST /parse-paperwork
   Body: { pdfBase64, manufacturer?, dealer?, notes? }

   Sends the PDF to Claude API and asks it to extract structured line
   items (description, quantity, SKU, manufacturer, etc.) as JSON.

   Returns { items: [...], meta: { documentType, orderNumber, ... } }
   so the client can show a review table before committing to Airtable.

   Env var needed: ANTHROPIC_API_KEY
===================================================================== */

const { json, handleOptions } = require('./_airtable');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const body = JSON.parse(event.body || '{}');
    const pdfBase64 = body.pdfBase64;
    const hintManufacturer = body.manufacturer || '';
    const hintDealer = body.dealer || '';
    const hintNotes = body.notes || '';

    if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });

    // Build the extraction prompt
    const systemPrompt = `You are a logistics document parser for a furniture moving company called KRS Moving Solutions. You extract structured product line items from delivery tickets, packing slips, bills of lading, and similar shipping documents.

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
- SKU can be a model number, catalog number, or part number — whatever uniquely identifies the product.
- barcode should only be filled if an actual barcode value (not just a SKU) is printed.
- Be thorough — extract EVERY line item, even small accessories and components.
- If manufacturer is not on the document but was provided as a hint, use the hint.
- totalItemCount should be the sum of all quantities.`;

    const userContent = [];

    // Attach the PDF as a document
    userContent.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBase64,
      },
    });

    // Add the extraction instruction
    let instruction = 'Extract all product line items from this document as JSON.';
    if (hintManufacturer) instruction += ' The manufacturer is: ' + hintManufacturer + '.';
    if (hintDealer) instruction += ' The dealer/customer is: ' + hintDealer + '.';
    if (hintNotes) instruction += ' Additional context: ' + hintNotes;

    userContent.push({ type: 'text', text: instruction });

    // Call Claude API
    console.log('Calling Claude API for paperwork extraction...');
    const claudeRes = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      return json(502, { error: 'Claude API error: ' + claudeRes.status });
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    console.log('Claude returned', rawText.length, 'chars');

    // Parse the JSON response (Claude sometimes wraps in markdown fencing)
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse Claude JSON:', parseErr, 'Raw:', cleaned.substring(0, 500));
      return json(200, {
        items: [],
        meta: {},
        rawText: cleaned,
        parseError: 'Claude returned non-JSON. See rawText field.',
      });
    }

    const items = parsed.items || [];
    const meta = parsed.meta || {};

    console.log('Extracted', items.length, 'items from paperwork');
    return json(200, { items, meta });
  } catch (err) {
    console.error('parse-paperwork error', err);
    return json(500, { error: err.message });
  }
};
