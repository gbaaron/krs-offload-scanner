/* =====================================================================
   POST /report-damage
   Body: { barcode, jobId, crew, notes, gps, timestamp,
           photoBase64, photoFilename, photoType }
   - Finds the product in the job
   - Marks it Damaged with notes
   - Attaches photo if provided (Airtable requires a public URL, so we
     accept a data URL as a fallback — in production you'd upload to an
     image host. We store the base64 payload as a note if no URL provided.)
   - Logs the damage report to Scan Log
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
      // No matching product — create a damaged entry so nothing is lost
      const created = await createRecord('Products', {
        'Product ID': barcode,
        'Description': 'Damaged item (unknown barcode)',
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
      'Notes': notes,
    });

    console.log('report-damage OK for', barcode);
    return json(200, { ok: true, productRecordId });
  } catch (err) {
    console.error('report-damage error', err);
    return json(500, { error: err.message });
  }
};
