/* =====================================================================
   GET /.netlify/functions/get-extraction?jobId=xxx
   Polling endpoint — returns the status of a background extraction job.

   Response shapes:
   { status: 'processing' }
   { status: 'done', items: [...], meta: {...} }
   { status: 'failed', error: '...' }
   { status: 'not_found' }
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const jobId = (event.queryStringParameters || {}).jobId;
  if (!jobId) return json(400, { error: 'Missing jobId' });

  try {
    const records = await listAll('ExtractionJobs', {
      filterByFormula: `{JobId} = '${jobId}'`,
      maxRecords: 1,
    });

    if (!records || !records.length) {
      // Job may not be written yet — treat as still processing
      return json(200, { status: 'processing' });
    }

    const f = records[0].fields;
    const status = f.Status || 'processing';

    if (status === 'done' && f.Result) {
      let parsed;
      try {
        parsed = JSON.parse(f.Result);
      } catch (e) {
        return json(200, { status: 'failed', error: 'Could not parse stored result' });
      }
      return json(200, {
        status: 'done',
        items: parsed.items || [],
        meta: parsed.meta || {},
        parseError: parsed.parseError || false,
        cost: parsed.cost || null,
        usage: parsed.usage || null,
        model: parsed.model || null,
      });
    }

    if (status === 'failed') {
      return json(200, { status: 'failed', error: f.Error || 'Extraction failed' });
    }

    return json(200, { status: 'processing' });

  } catch (err) {
    console.error('get-extraction error:', err.message);
    return json(500, { error: err.message });
  }
};
