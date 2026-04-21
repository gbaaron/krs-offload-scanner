/* =====================================================================
   POST /report-damage
   Body: { barcode, jobId, crew,
           dealer, jobNumber, productName, manufacturer,
           notes, gps, timestamp,
           photoBase64, photoFilename, photoType }
   - Looks for existing Products row matching barcode + job
   - If found: marks it Damaged, attaches photo, updates notes
   - If not found: creates a new Damaged Products row using the
     session context (product name / manufacturer / dealer)
   - Either way, logs the damage event to Scan Log
   - Airtable attachments via API need a public URL — we attempt
     to pass a data URL, but in production you'd upload to a host.
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
    const dealer = body.dealer || '';
    const jobNumber = body.jobNumber || '';
    const productName = body.productName || '';
    const manufacturer = body.manufacturer || '';
    const notes = body.notes || 'Damage reported';
    const gps = body.gps || '';
    const timestamp = body.timestamp || new Date().toISOString();
    const photoBase64 = body.photoBase64 || null;
    const photoFilename = body.photoFilename || 'damage.jpg';
    const photoType = body.photoType || 'image/jpeg';

    if (!barcode || !jobId) return json(400, { error: 'Missing barcode or jobId' });

    // Lookup existing product
    const formula =
      "AND({Product ID} = '" + barcode.replace(/'/g, "\\'") + "', " +
      "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0)";
    const matches = await listAll('Products', { filterByFormula: formula, maxRecords: 1 });

    let productRecordId;
    if (matches.length) {
      productRecordId = matches[0].id;
      const fields = {
        'Scan Status': 'Damaged',
        'Notes': notes,
        'Scanned By': crew,
        'Scanned At': timestamp,
      };
      // Only overwrite Job Number if crew provided one in the current context
      if (jobNumber) fields['Job Number'] = jobNumber;
      // Airtable only accepts attachments by public URL via API.
      // If caller provided a data URL, try that (Airtable will reject
      // raw base64 — so we prepend a data: URL and let Airtable attempt
      // to fetch it; in practice the dealer will upload via the Airtable
      // UI for permanent storage). We still log it.
      if (photoBase64) {
        try {
          const dataUrl = 'data:' + photoType + ';base64,' + photoBase64;
          fields['Photo'] = [{ url: dataUrl, filename: photoFilename }];
        } catch (e) {
          console.warn('Photo attach failed', e);
        }
      }
      await updateRecord('Products', productRecordId, fields);
    } else {
      // No matching product — create a damaged entry using session context
      const created = await createRecord('Products', {
        'Product ID': barcode,
        'Description': productName || 'Damaged item (unknown barcode)',
        'Manufacturer': manufacturer,
        'Dealer': dealer,
        'Job Number': jobNumber,
        'Job': [jobId],
        'Expected Quantity': 1,
        'Received Quantity': 0,
        'Scan Status': 'Damaged',
        'Scanned By': crew,
        'Scanned At': timestamp,
        'Notes': notes,
      });
      productRecordId = created.id;
    }

    // Log the damage event
    await createRecord('Scan Log', {
      'Product': [productRecordId],
      'Job': [jobId],
      'Barcode Value': barcode,
      'Timestamp': timestamp,
      'Scanned By': crew,
      'GPS Coordinates': gps,
      'Scan Type': 'Damage Report',
      'Job Number': jobNumber,
      'Notes': notes,
    });

    console.log('report-damage OK for', barcode);
    return json(200, { ok: true, productRecordId });
  } catch (err) {
    console.error('report-damage error', err);
    return json(500, { error: err.message });
  }
};
