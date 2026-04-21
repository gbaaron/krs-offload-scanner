/* =====================================================================
   GET /get-site-config
   Returns all config from the SiteConfig table as a key→value map.
   Optionally filter by ?category=Branding (etc.)
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  try {
    const category = (event.queryStringParameters && event.queryStringParameters.category) || '';
    const query = {};
    if (category) {
      query.filterByFormula = "{Category} = '" + category.replace(/'/g, "\\'") + "'";
    }

    const records = await listAll('SiteConfig', query);

    // Build key→value map (also include description + category for admin)
    const config = {};
    const details = [];
    records.forEach((r) => {
      const key = r.fields['Key'] || '';
      if (!key) return;
      config[key] = r.fields['Value'] || '';
      details.push({
        id: r.id,
        key: key,
        value: r.fields['Value'] || '',
        category: r.fields['Category'] || '',
        description: r.fields['Description'] || '',
      });
    });

    console.log('get-site-config returned', Object.keys(config).length, 'keys');
    return json(200, { config, details });
  } catch (err) {
    console.error('get-site-config error', err);
    return json(500, { error: err.message });
  }
};
