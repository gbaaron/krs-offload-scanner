/* =====================================================================
   POST /add-product
   Body: { barcode, jobId, crew, description, manufacturer, gps, timestamp }
   - Creates a new Products record for an unknown barcode
   - Marks it Received (count=1) since the scan just happened
   - Also logs to Scan Log
===================================================================== */

const {
  json,
  handleOptions,
  createRecord,
} = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const barcode = (body.barcode || '').trim();
    const jobId = body.jobId;
    const crew = body.crew || 'unknown';
    const description = body.description || '';
    const manufacturer = body.manufacturer || '';
    const gps = body.gps || '';
    const timestamp = body.timestamp || new Date().toISOString();

    if (!barcode || !jobId || !description) {
      return json(400, { error: 'Missing barcode, jobId, or description' });
    }

    // Create the product record
    const product = await createRecord('Products', {
      'Product ID': barcode,
      'Description': description,
      'Manufacturer': manufacturer,
      'Job': [jobId],
      'Expected Quantity': 1,
      'Received Quantity': 1,
      'Scan Status': 'Received',
      'Scanned By': crew,
      'Scanned At': timestamp,
      'Notes': 'Added on-the-fly during offload (unknown barcode)',
    });

    // Log the scan
    await createRecord('Scan Log', {
      'Product': [product.id],
      'Job': [jobId],
      'Barcode Value': barcode,
      'Timestamp': timestamp,
      'Scanned By': crew,
      'GPS Coordinates': gps,
      'Scan Type': 'Offload',
      'Notes': 'New product added on scan',
    });

    console.log('add-product created', barcode, 'for job', jobId);
    return json(200, {
      created: true,
      product: {
        recordId: product.id,
        productId: product.fields['Product ID'] || '',
        description: product.fields['Description'] || '',
        manufacturer: product.fields['Manufacturer'] || '',
      }
    });
  } catch (err) {
    console.error('add-product error', err);
    return json(500, { error: err.message });
  }
};
