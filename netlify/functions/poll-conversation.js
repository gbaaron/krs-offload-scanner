/* =====================================================================
   GET /.netlify/functions/poll-conversation?conversationId=xxx
   Frontend polls this after an escalation to check if Aaron has replied.
   Returns { status, krsResponse } — frontend shows the reply when it arrives.
===================================================================== */

const { json, handleOptions, listAll } = require('./_airtable');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const { conversationId } = event.queryStringParameters || {};
  if (!conversationId) return json(400, { error: 'Missing conversationId' });

  try {
    const records = await listAll('DealerConversations', {
      filterByFormula: `{ConversationId} = '${conversationId}'`,
      maxRecords: 1,
    });

    if (!records[0]) return json(404, { error: 'Conversation not found' });

    const f = records[0].fields;
    return json(200, {
      status: f.Status || 'Active',
      krsResponse: f.KRSResponse || null,
    });
  } catch (err) {
    console.error('poll-conversation error:', err.message);
    return json(500, { error: err.message });
  }
};
