/* =====================================================================
   POST /update-site-config
   Body: { records: [ { key, value, category?, description? }, ... ] }

   Upserts config records:
   - If a record with the given Key exists → updates its Value
   - If not → creates a new record

   No auth for now (matches dashboard pattern — add auth later).
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
    const incoming = body.records || [];
    if (!incoming.length) return json(400, { error: 'No records provided' });

    // Load all existing config to find matches by Key
    const existing = await listAll('SiteConfig');
    const keyToRecord = {};
    existing.forEach((r) => {
      const k = r.fields['Key'] || '';
      if (k) keyToRecord[k] = r;
    });

    let updated = 0;
    let created = 0;

    for (const item of incoming) {
      const key = (item.key || '').trim();
      if (!key) continue;

      const fields = { 'Key': key, 'Value': item.value || '' };
      if (item.category) fields['Category'] = item.category;
      if (item.description) fields['Description'] = item.description;

      if (keyToRecord[key]) {
        // Update existing record
        await updateRecord('SiteConfig', keyToRecord[key].id, fields);
        updated++;
      } else {
        // Create new record
        await createRecord('SiteConfig', fields);
        created++;
      }
    }

    console.log('update-site-config: updated', updated, 'created', created);
    return json(200, { ok: true, updated, created });
  } catch (err) {
    console.error('update-site-config error', err);
    return json(500, { error: err.message });
  }
};
