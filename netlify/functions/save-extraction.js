/* =====================================================================
   POST /save-extraction
   Body: {
     documentName, manufacturerHint, dealerHint, jobNumber, user,
     aiOriginal:  { items: [...], meta: {...} },
     userApproved: { items: [...], meta: {...} }
   }

   Writes a row to the Extraction Training table so we can:
   - Review what Claude got right/wrong per document
   - Eventually feed recent corrections back into the prompt
     for the same manufacturer to make future extractions smarter
===================================================================== */

const { json, handleOptions, createRecord } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const aiOriginal = body.aiOriginal || { items: [], meta: {} };
    const userApproved = body.userApproved || { items: [], meta: {} };

    // Compute a simple correction summary
    const summary = buildCorrectionSummary(aiOriginal, userApproved);

    const record = await createRecord('Extraction Training', {
      'Document Name': body.documentName || 'Unnamed document',
      'Timestamp': new Date().toISOString(),
      'Manufacturer Hint': body.manufacturerHint || '',
      'Dealer': body.dealerHint || '',
      'Job Number': body.jobNumber || '',
      'User': body.user || '',
      'Items Count Original': (aiOriginal.items || []).length,
      'Items Count Approved': (userApproved.items || []).length,
      'Correction Summary': summary,
      'AI Original JSON': truncate(JSON.stringify(aiOriginal, null, 2), 95000),
      'User Approved JSON': truncate(JSON.stringify(userApproved, null, 2), 95000),
    });

    console.log('save-extraction: saved training record', record.id, summary);
    return json(200, { ok: true, recordId: record.id, summary });
  } catch (err) {
    console.error('save-extraction error', err);
    return json(500, { error: err.message });
  }
};

// ---- Build a short human-readable diff ----
function buildCorrectionSummary(original, approved) {
  const lines = [];
  const origItems = original.items || [];
  const apprItems = approved.items || [];

  lines.push('Items: ' + origItems.length + ' → ' + apprItems.length);

  // Line-level diffs for items that exist in both (matched by index after edits)
  let changedDesc = 0, changedQty = 0, changedMfr = 0, changedSku = 0, changedRoom = 0;
  const maxLen = Math.max(origItems.length, apprItems.length);
  for (let i = 0; i < maxLen; i++) {
    const a = origItems[i] || {};
    const b = apprItems[i] || {};
    if ((a.description || '') !== (b.description || '')) changedDesc++;
    if ((parseInt(a.quantity, 10) || 1) !== (parseInt(b.quantity, 10) || 1)) changedQty++;
    if ((a.manufacturer || '') !== (b.manufacturer || '')) changedMfr++;
    if ((a.sku || '') !== (b.sku || '')) changedSku++;
    if ((a.room || '') !== (b.room || '')) changedRoom++;
  }
  if (changedDesc) lines.push('Descriptions changed: ' + changedDesc);
  if (changedQty) lines.push('Quantities changed: ' + changedQty);
  if (changedMfr) lines.push('Manufacturers changed: ' + changedMfr);
  if (changedSku) lines.push('SKUs changed: ' + changedSku);
  if (changedRoom) lines.push('Rooms changed: ' + changedRoom);

  // Meta diffs
  const origMeta = original.meta || {};
  const apprMeta = approved.meta || {};
  ['documentType', 'orderNumber', 'dealer', 'shipDate', 'totalItemCount'].forEach((k) => {
    const a = String(origMeta[k] == null ? '' : origMeta[k]);
    const b = String(apprMeta[k] == null ? '' : apprMeta[k]);
    if (a !== b) lines.push('meta.' + k + ': "' + a + '" → "' + b + '"');
  });

  if (lines.length === 1) lines.push('No edits — AI got it right on this one');
  return lines.join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\n... [truncated]' : s;
}
