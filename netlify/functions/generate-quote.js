/* =====================================================================
   POST /generate-quote
   Body: {
     items: [{ description, manufacturer, sku, quantity, room }],
     jobNumber?: string,
     dealer?: string
   }

   Looks up each item in the Pricing table by SKU (Item Key) or
   by manufacturer + keyword match, then returns a structured quote
   with line-item prices, labor, and totals.

   Returns:
   {
     lines: [{ description, sku, manufacturer, quantity, unitPrice, laborPerUnit, lineTotal, matched }],
     subtotalProduct: 0.00,
     subtotalLabor:   0.00,
     grandTotal:      0.00,
     unmatched:       [{ description, sku }]  // items we couldn't price
   }
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!items.length) return json(400, { error: 'No items provided' });

    // Load all pricing records once
    const pricingRecords = await listAll('Pricing');
    const pricing = pricingRecords.map((r) => ({
      id: r.id,
      itemKey: (r.fields['Item Key'] || '').toLowerCase().trim(),
      manufacturer: (r.fields['Manufacturer'] || '').toLowerCase().trim(),
      category: (r.fields['Category'] || '').toLowerCase().trim(),
      unitPrice: parseFloat(r.fields['Unit Price'] || 0),
      laborPerUnit: parseFloat(r.fields['Install Labor'] || 0),
      displayName: r.fields['Name'] || r.fields['Item Key'] || '',
    }));

    const lines = [];
    const unmatched = [];

    for (const item of items) {
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const skuKey = (item.sku || '').toLowerCase().trim();
      const mfrKey = (item.manufacturer || '').toLowerCase().trim();
      const descKey = (item.description || '').toLowerCase();

      let match = null;

      // 1. Exact SKU match
      if (skuKey) {
        match = pricing.find((p) => p.itemKey === skuKey);
      }

      // 2. Manufacturer keyword match (first word of description in item key)
      if (!match && mfrKey) {
        const descWords = descKey.split(/\s+/).filter((w) => w.length > 3);
        match = pricing.find((p) =>
          p.manufacturer === mfrKey &&
          descWords.some((w) => p.itemKey.includes(w))
        );
      }

      // 3. Category fallback — match just by manufacturer
      if (!match && mfrKey) {
        match = pricing.find((p) => p.manufacturer === mfrKey);
      }

      if (match) {
        const lineTotal = qty * (match.unitPrice + match.laborPerUnit);
        lines.push({
          description: item.description || '',
          sku: item.sku || '',
          manufacturer: item.manufacturer || '',
          room: item.room || '',
          quantity: qty,
          unitPrice: match.unitPrice,
          laborPerUnit: match.laborPerUnit,
          lineTotal: Math.round(lineTotal * 100) / 100,
          matchedKey: match.displayName,
          matched: true,
        });
      } else {
        lines.push({
          description: item.description || '',
          sku: item.sku || '',
          manufacturer: item.manufacturer || '',
          room: item.room || '',
          quantity: qty,
          unitPrice: 0,
          laborPerUnit: 0,
          lineTotal: 0,
          matchedKey: '',
          matched: false,
        });
        unmatched.push({ description: item.description, sku: item.sku, manufacturer: item.manufacturer });
      }
    }

    const subtotalProduct = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const subtotalLabor   = lines.reduce((s, l) => s + l.quantity * l.laborPerUnit, 0);
    const grandTotal      = subtotalProduct + subtotalLabor;

    console.log('generate-quote: priced', lines.filter((l) => l.matched).length, '/', lines.length, 'items');
    return json(200, {
      lines,
      subtotalProduct: Math.round(subtotalProduct * 100) / 100,
      subtotalLabor:   Math.round(subtotalLabor   * 100) / 100,
      grandTotal:      Math.round(grandTotal       * 100) / 100,
      unmatched,
    });
  } catch (err) {
    console.error('generate-quote error', err);
    return json(500, { error: err.message });
  }
};
