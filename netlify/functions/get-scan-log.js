/* =====================================================================
   GET /get-scan-log?jobId=recXXX&limit=10
   Returns the most recent scans for a given job, newest first.
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    const qs = event.queryStringParameters || {};
    const jobId = qs.jobId || '';
    const limit = Math.min(parseInt(qs.limit || '10', 10) || 10, 100);
    if (!jobId) return json(400, { error: 'Missing jobId' });

    const formula = "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0";
    const records = await listAll('Scan Log', {
      filterByFormula: formula,
      'sort[0][field]': 'Timestamp',
      'sort[0][direction]': 'desc',
      maxRecords: String(limit),
    });

    const scans = records.slice(0, limit).map((r) => ({
      id: r.id,
      barcode: r.fields['Barcode Value'] || '',
      scannedBy: r.fields['Scanned By'] || '',
      timestamp: r.fields['Timestamp'] || '',
      gps: r.fields['GPS Coordinates'] || '',
      scanType: r.fields['Scan Type'] || '',
      jobNumber: r.fields['Job Number'] || '',
      notes: r.fields['Notes'] || '',
      // Description isn't directly on scan log, but the dashboard will fall back to barcode
      description: r.fields['Barcode Value'] || '',
    }));

    console.log('get-scan-log: job', jobId, 'returned', scans.length, 'scans');
    return json(200, { scans });
  } catch (err) {
    console.error('get-scan-log error', err);
    return json(500, { error: err.message });
  }
};
