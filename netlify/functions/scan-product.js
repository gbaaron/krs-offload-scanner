/* =====================================================================
   POST /scan-product
   Body: {
     barcode, jobId, crew,
     dealer, jobNumber, productName, manufacturer,    // scan context
     scanType, gps, timestamp
   }

   New behavior (create-or-warn, no pre-loaded manifest):
   - Look up barcode in Products table for the given job.
   - If NOT found: create a new Products row with the session context
     (description = productName, manufacturer, dealer), mark Received,
     log the scan, return { created: true, product: {...} }.
   - If FOUND: do NOT create a duplicate. Log the scan event anyway
     (with Notes = "Duplicate scan"), return { alreadyLogged: true,
     product: {...} }.
===================================================================== */

const {
  json,
  handleOptions,
  listAll,
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
    const dealer = body.dealer || '';
    const jobNumber = body.jobNumber || '';
    const productName = body.productName || '';
    const manufacturer = body.manufacturer || '';
    const scanType = body.scanType || 'Offload';
    const gps = body.gps || '';
    const timestamp = body.timestamp || new Date().toISOString();

    if (!barcode || !jobId) return json(400, { error: 'Missing barcode or jobId' });

    // Look up any existing product with this barcode tied to this job
    const formula =
      "AND({Product ID} = '" + barcode.replace(/'/g, "\\'") + "', " +
      "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0)";
    const matches = await listAll('Products', { filterByFormula: formula, maxRecords: 1 });

    if (matches.length) {
      // Already logged — don't duplicate, but log the duplicate scan event
      const existing = matches[0];

      await createRecord('Scan Log', {
        'Product': [existing.id],
        'Job': [jobId],
        'Barcode Value': barcode,
        'Timestamp': timestamp,
        'Scanned By': crew,
        'GPS Coordinates': gps,
        'Scan Type': scanType,
        'Job Number': jobNumber,
        'Notes': 'Duplicate scan — barcode already logged',
      });

      console.log('scan-product: duplicate', barcode, 'for job', jobId);
      return json(200, {
        alreadyLogged: true,
        product: {
          recordId: existing.id,
          productId: existing.fields['Product ID'] || '',
          description: existing.fields['Description'] || '',
          manufacturer: existing.fields['Manufacturer'] || '',
          dealer: existing.fields['Dealer'] || '',
          jobNumber: existing.fields['Job Number'] || '',
          status: existing.fields['Scan Status'] || '',
        }
      });
    }

    // Not found → create a new Products record using session context
    const newProduct = await createRecord('Products', {
      'Product ID': barcode,
      'Description': productName || 'Unlabeled Item',
      'Manufacturer': manufacturer,
      'Dealer': dealer,
      'Job Number': jobNumber,
      'Job': [jobId],
      'Expected Quantity': 1,
      'Received Quantity': 1,
      'Scan Status': 'Received',
      'Scanned By': crew,
      'Scanned At': timestamp,
      'Notes': 'Logged via scanner session context',
    });

    // Log the scan event
    await createRecord('Scan Log', {
      'Product': [newProduct.id],
      'Job': [jobId],
      'Barcode Value': barcode,
      'Timestamp': timestamp,
      'Scanned By': crew,
      'GPS Coordinates': gps,
      'Scan Type': scanType,
      'Job Number': jobNumber,
      'Notes': 'First scan — product row created',
    });

    console.log('scan-product: created new product', barcode, 'for job', jobId);
    return json(200, {
      created: true,
      product: {
        recordId: newProduct.id,
        productId: newProduct.fields['Product ID'] || '',
        description: newProduct.fields['Description'] || '',
        manufacturer: newProduct.fields['Manufacturer'] || '',
        dealer: newProduct.fields['Dealer'] || '',
        jobNumber: newProduct.fields['Job Number'] || '',
        status: newProduct.fields['Scan Status'] || '',
      }
    });
  } catch (err) {
    console.error('scan-product error', err);
    return json(500, { error: err.message });
  }
};
