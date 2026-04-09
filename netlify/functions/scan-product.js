/* =====================================================================
   POST /scan-product
   Body: { barcode, jobId, crew, scanType, gps, timestamp }
   - Looks up product by barcode for the given job
   - If found: increments Received Quantity, sets status Received, logs scan
   - If not found: returns { found: false }
===================================================================== */

const {
  json,
  handleOptions,
  listAll,
  createRecord,
  updateRecord,
} = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const barcode = (body.barcode || '').trim();
    const jobId = body.jobId;
    const crew = body.crew || 'unknown';
    const scanType = body.scanType || 'Offload';
    const gps = body.gps || '';
    const timestamp = body.timestamp || new Date().toISOString();

    if (!barcode || !jobId) return json(400, { error: 'Missing barcode or jobId' });

    // Find the product for this job
    const formula =
      "AND({Product ID} = '" + barcode.replace(/'/g, "\\'") + "', " +
      "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0)";
    const matches = await listAll('Products', { filterByFormula: formula, maxRecords: 1 });

    if (!matches.length) {
      console.log('scan-product: barcode', barcode, 'not found for job', jobId);
      return json(200, { found: false, barcode });
    }

    const product = matches[0];
    const prevReceived = Number(product.fields['Received Quantity'] || 0);

    // Update product: bump count, set received, stamp crew + time
    const updated = await updateRecord('Products', product.id, {
      'Received Quantity': prevReceived + 1,
      'Scan Status': 'Received',
      'Scanned By': crew,
      'Scanned At': timestamp,
    });

    // Log the scan to Scan Log
    await createRecord('Scan Log', {
      'Product': [product.id],
      'Job': [jobId],
      'Barcode Value': barcode,
      'Timestamp': timestamp,
      'Scanned By': crew,
      'GPS Coordinates': gps,
      'Scan Type': scanType,
    });

    console.log('scan-product OK', barcode, 'by', crew);
    return json(200, {
      found: true,
      product: {
        recordId: updated.id,
        productId: updated.fields['Product ID'] || '',
        description: updated.fields['Description'] || '',
        manufacturer: updated.fields['Manufacturer'] || '',
        expected: updated.fields['Expected Quantity'] || 0,
        received: updated.fields['Received Quantity'] || 0,
        status: updated.fields['Scan Status'] || '',
      }
    });
  } catch (err) {
    console.error('scan-product error', err);
    return json(500, { error: err.message });
  }
};
