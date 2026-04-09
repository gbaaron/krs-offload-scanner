/* =====================================================================
   GET /get-dashboard-data?jobId=recXXX
   Returns the manifest (products) for the dashboard view, ordered
   for display with computed progress info.
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    const jobId = (event.queryStringParameters && event.queryStringParameters.jobId) || '';
    if (!jobId) return json(400, { error: 'Missing jobId' });

    const formula = "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0";
    const records = await listAll('Products', {
      filterByFormula: formula,
      'sort[0][field]': 'Scan Status',
      'sort[0][direction]': 'asc',
    });

    const products = records.map((r) => ({
      recordId: r.id,
      productId: r.fields['Product ID'] || '',
      description: r.fields['Description'] || '',
      manufacturer: r.fields['Manufacturer'] || '',
      dealer: r.fields['Dealer'] || '',
      jobNumber: r.fields['Job Number'] || '',
      expected: Number(r.fields['Expected Quantity'] || 0),
      received: Number(r.fields['Received Quantity'] || 0),
      status: r.fields['Scan Status'] || 'Pending',
      scannedBy: r.fields['Scanned By'] || '',
      scannedAt: r.fields['Scanned At'] || '',
      notes: r.fields['Notes'] || '',
    }));

    const totals = {
      expected: products.reduce((s, p) => s + (p.expected || 0), 0),
      received: products.reduce((s, p) => s + (p.received || 0), 0),
      damaged: products.filter((p) => p.status === 'Damaged').length,
      missing: products.filter((p) => p.status === 'Missing' || p.status === 'Pending').length,
    };

    console.log('get-dashboard-data: job', jobId, 'returned', products.length, 'products');
    return json(200, { products, totals });
  } catch (err) {
    console.error('get-dashboard-data error', err);
    return json(500, { error: err.message });
  }
};
