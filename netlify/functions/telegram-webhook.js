/* =====================================================================
   POST /.netlify/functions/telegram-webhook
   Receives updates from Telegram when Aaron replies to an escalated
   dealer question. Finds the matching conversation and saves the response.

   Register this webhook once:
   curl "https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://YOUR_NETLIFY_SITE/.netlify/functions/telegram-webhook"

   Matching priority:
   1. reply_to_message.message_id → TelegramMessageId field
   2. conv:XXXXX tag in the original message text
   3. Fallback: most recently escalated conversation
===================================================================== */

const { listAll, updateRecord } = require('./_airtable');

exports.handler = async function (event) {
  // Telegram always expects 200 — never return an error status
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };

  let update;
  try { update = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 200, body: 'ok' }; }

  const message = update.message;
  if (!message || !message.text) return { statusCode: 200, body: 'ok' };

  // Ignore bot messages
  if (message.from && message.from.is_bot) return { statusCode: 200, body: 'ok' };

  const replyText = message.text.trim();
  const replyTo = message.reply_to_message;

  try {
    let convRecord = null;

    // 1. Match by Telegram message ID (most reliable — Aaron replied-to the bot message)
    if (replyTo && replyTo.message_id) {
      const msgId = String(replyTo.message_id);
      const records = await listAll('DealerConversations', {
        filterByFormula: `{TelegramMessageId} = '${msgId}'`,
        maxRecords: 1,
      });
      if (records[0]) convRecord = records[0];
    }

    // 2. Extract conv:XXXXX tag from the original message text
    if (!convRecord && replyTo && replyTo.text) {
      const match = replyTo.text.match(/conv:([a-z0-9]+)/i);
      if (match) {
        const records = await listAll('DealerConversations', {
          filterByFormula: `{ConversationId} = '${match[1]}'`,
          maxRecords: 1,
        });
        if (records[0]) convRecord = records[0];
      }
    }

    // 3. Fallback: most recent escalated conversation
    if (!convRecord) {
      const records = await listAll('DealerConversations', {
        filterByFormula: `{Status} = 'Escalated'`,
        maxRecords: 1,
      });
      if (records[0]) convRecord = records[0];
    }

    if (!convRecord) {
      console.log('telegram-webhook: no matching conversation found');
      return { statusCode: 200, body: 'ok' };
    }

    // Append KRS response to the conversation messages
    const now = new Date().toISOString();
    let msgs = [];
    try { msgs = JSON.parse(convRecord.fields.Messages || '[]'); } catch (e) {}
    msgs.push({ role: 'krs', content: replyText, ts: now });

    await updateRecord('DealerConversations', convRecord.id, {
      Messages: JSON.stringify(msgs).substring(0, 99000),
      KRSResponse: replyText,
      Status: 'Resolved',
      UpdatedAt: now,
    });

    console.log('telegram-webhook: KRS response saved for conv', convRecord.fields.ConversationId);
  } catch (err) {
    console.error('telegram-webhook error:', err.message);
  }

  return { statusCode: 200, body: 'ok' };
};
