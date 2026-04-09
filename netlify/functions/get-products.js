/* =====================================================================
   GET /get-products?jobId=recXXXX
   Returns products for a given job (linked record ID).
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    const jobId = (event.queryStringParameters && event.queryStringParameters.jobId) || '';
    if (!jobId) return json(400, { error: 'Missing jobId' });

    // Airtable linked-record filter: use FIND() on the array joined with a separator
    const formula = "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0";
    const records = await listAll('Products', { filterByFormula: formula });

    const products = records.map((r) => ({
      recordId: r.id,
      productId: r.fields['Product ID'] || '',
      description: r.fields['Description'] || '',
      manufacturer: r.fields['Manufacturer'] || '',
      expected: Number(r.fields['Expected Quantity'] || 0),
      received: Number(r.fields['Received Quantity'] || 0),
      status: r.fields['Scan Status'] || 'Pending',
      scannedBy: r.fields['Scanned By'] || '',
      scannedAt: r.fields['Scanned At'] || '',
      notes: r.fields['Notes'] || '',
    }));

    console.log('get-products for', jobId, 'returned', products.length);
    return json(200, { products });
  } catch (err) {
    console.error('get-products error', err);
    return json(500, { error: err.message });
  }
};
