/* =====================================================================
   POST /.netlify/functions/dealer-login
   Body: { email, password }
   Looks up DealerUsers table, validates plaintext password (demo-grade).
   Returns: { id, name, email, company }
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { email, password } = body;
  if (!email || !password) {
    return json(400, { error: 'Missing email or password' });
  }

  try {
    // Lookup by email (case-insensitive)
    const safeEmail = email.replace(/'/g, "\\'");
    const records = await listAll('DealerUsers', {
      filterByFormula: `LOWER({Email}) = LOWER('${safeEmail}')`,
      maxRecords: 1,
    });

    if (!records || !records.length) {
      return json(401, { error: 'Invalid email or password' });
    }

    const rec = records[0];
    const f = rec.fields;

    // Plaintext password check (demo-grade; upgrade to bcrypt for production)
    if ((f.Password || '') !== password) {
      return json(401, { error: 'Invalid email or password' });
    }

    return json(200, {
      id: rec.id,
      name: f.Name || '',
      email: f.Email || '',
      company: f.Company || '',
    });
  } catch (err) {
    console.error('dealer-login error:', err.message);
    return json(500, { error: err.message });
  }
};
