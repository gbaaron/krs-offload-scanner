/* =====================================================================
   GET /.netlify/functions/get-dealer-jobs?dealerUserId=recXXX
   Returns only the jobs where the dealer user is listed in
   the "Authorized Users" linked field on the Jobs table.
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const dealerUserId = (event.queryStringParameters || {}).dealerUserId;
  if (!dealerUserId) {
    return json(400, { error: 'Missing dealerUserId' });
  }

  try {
    // Filter Jobs where this dealer user appears in the Authorized Users field
    const records = await listAll('Jobs', {
      filterByFormula: `FIND('${dealerUserId}', ARRAYJOIN({Authorized Users}, ','))`,
    });

    const jobs = records.map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        name: f['Job Name'] || f['Name'] || '',
        jobNumber: f['Job Number'] || '',
        deliveryDate: f['Delivery Date'] || '',
        dealer: f['Dealer'] || '',
        status: f['Status'] || '',
      };
    });

    return json(200, { jobs });
  } catch (err) {
    console.error('get-dealer-jobs error:', err.message);
    return json(500, { error: err.message });
  }
};
