/* =====================================================================
   GET /get-jobs
   Returns open jobs (Status != Completed) for the scanner + dashboard
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    // Filter out completed jobs via Airtable formula
    const records = await listAll('Jobs', {
      filterByFormula: "NOT({Status} = 'Completed')",
      'sort[0][field]': 'Delivery Date',
      'sort[0][direction]': 'asc',
    });

    const jobs = records.map((r) => ({
      id: r.id,
      name: r.fields['Job Name'] || '',
      dealer: r.fields['Dealer'] || '',
      deliveryDate: r.fields['Delivery Date'] || '',
      status: r.fields['Status'] || '',
      location: r.fields['Location/Site Name'] || '',
      notes: r.fields['Notes'] || '',
    }));

    console.log('get-jobs returned', jobs.length, 'jobs');
    return json(200, { jobs });
  } catch (err) {
    console.error('get-jobs error', err);
    return json(500, { error: err.message });
  }
};
