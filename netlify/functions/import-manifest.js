/* =====================================================================
   POST /import-manifest
   Body: {
     jobId: "recXXX",
     jobNumber: "MOE-2026-0412",
     dealer: "Michigan Office Environments",
     items: [
       { description, manufacturer, sku, quantity, barcode, room, notes },
       ...
     ]
   }

   Creates Products rows in Airtable for each item, status = Pending,
   with Expected Quantity set from the paperwork. These become the
   manifest that the scanner checks against.

   Airtable allows max 10 records per create call, so we batch.
===================================================================== */

const { json, handleOptions, airtableRequest } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const jobId = body.jobId;
    const jobNumber = body.jobNumber || '';
    const dealer = body.dealer || '';
    const items = body.items || [];

    if (!jobId) return json(400, { error: 'Missing jobId' });
    if (!items.length) return json(400, { error: 'No items to import' });

    // Build Airtable records
    const records = items.map((item) => ({
      fields: {
        'Product ID': item.sku || item.barcode || '',
        'Description': item.description || 'Imported item',
        'Manufacturer': item.manufacturer || '',
        'Dealer': dealer,
        'Job Number': jobNumber,
        'Job': [jobId],
        'Expected Quantity': Math.max(1, parseInt(item.quantity, 10) || 1),
        'Received Quantity': 0,
        'Scan Status': 'Pending',
        'Notes': buildNotes(item),
      }
    }));

    // Airtable max 10 records per create call — batch them
    let created = 0;
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      const path = encodeURIComponent('Products');
      await airtableRequest(path, {
        method: 'POST',
        body: { records: batch, typecast: true },
      });
      created += batch.length;
    }

    console.log('import-manifest: created', created, 'Products for job', jobId);
    return json(200, { ok: true, created });
  } catch (err) {
    console.error('import-manifest error', err);
    return json(500, { error: err.message });
  }
};

function buildNotes(item) {
  const parts = ['Imported from paperwork'];
  if (item.room) parts.push('Room: ' + item.room);
  if (item.notes) parts.push(item.notes);
  if (item.barcode && item.sku && item.barcode !== item.sku) {
    parts.push('Barcode: ' + item.barcode);
  }
  return parts.join(' | ');
}
