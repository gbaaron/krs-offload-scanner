/* =====================================================================
   POST /.netlify/functions/dealer-chat
   Dealer-facing chatbot backed by Claude + live Airtable job data.

   Body: { dealerUserId, dealerName, jobId?, message, conversationId?, history? }

   Flow:
   1. Fetch dealer's job/product context from Airtable
   2. Send to Claude (Haiku — fast enough for chat)
   3. If Claude replies ESCALATE: → send Telegram to Aaron, mark escalated
   4. Save all messages to DealerConversations table
   5. Return { reply, conversationId, escalated }

   Env vars required:
   ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
===================================================================== */

const { json, handleOptions, listAll, createRecord, updateRecord } = require('./_airtable');

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const TG_API = 'https://api.telegram.org/bot';

// ---- Telegram helper ----
async function sendTelegram(token, chatId, text) {
  const res = await fetch(TG_API + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return res.json();
}

// ---- Build job context string for Claude ----
async function buildJobContext(dealerUserId, jobId) {
  let ctx = '';
  try {
    if (jobId) {
      // Specific job selected — fetch products + scan summary
      const formula = "FIND('" + jobId.replace(/'/g, "\\'") + "', ARRAYJOIN({Job})) > 0";
      const products = await listAll('Products', { filterByFormula: formula, maxRecords: 100 });
      const scans = await listAll('Scan Log', {
        filterByFormula: formula,
        maxRecords: 20,
      }).catch(() => []);

      if (products.length) {
        const byStatus = {};
        products.forEach((p) => {
          const s = p.fields['Scan Status'] || 'Pending';
          byStatus[s] = (byStatus[s] || 0) + 1;
        });
        ctx += '\nProduct manifest (' + products.length + ' items):\n';
        ctx += Object.entries(byStatus).map(([s, n]) => `  ${s}: ${n}`).join('\n') + '\n';
        ctx += '\nSample items:\n';
        products.slice(0, 20).forEach((p) => {
          const f = p.fields;
          ctx += `  - ${f['Description'] || 'Unknown'} | ${f['Manufacturer'] || ''} | Status: ${f['Scan Status'] || 'Pending'} | Qty: ${f['Expected Quantity'] || 1}\n`;
        });
      } else {
        ctx += '\nNo products loaded for this job yet.\n';
      }

      if (scans.length) {
        ctx += '\nRecent scans:\n';
        scans.slice(0, 8).forEach((s) => {
          const f = s.fields;
          ctx += `  - ${f['Description'] || f['Barcode'] || 'Item'} — ${f['Scan Status'] || ''} by ${f['Crew Member'] || 'crew'}\n`;
        });
      }
    } else if (dealerUserId) {
      // No specific job — summarise all dealer jobs
      const jobs = await listAll('Jobs', {
        filterByFormula: `FIND('${dealerUserId}', ARRAYJOIN({Authorized Users}, ','))`,
        maxRecords: 20,
      }).catch(() => []);
      if (jobs.length) {
        ctx += '\nYour jobs:\n';
        jobs.forEach((j) => {
          const f = j.fields;
          ctx += `  - ${f['Job Name'] || 'Unnamed'} | Date: ${f['Delivery Date'] || 'TBD'} | Status: ${f['Status'] || 'Active'} | Location: ${f['Location/Site Name'] || ''}\n`;
        });
      }
    }
  } catch (err) {
    console.warn('buildJobContext error:', err.message);
  }
  return ctx;
}

// ---- Save / update conversation in Airtable ----
async function saveMessages(convId, newMessages, extras) {
  try {
    const existing = convId
      ? await listAll('DealerConversations', {
          filterByFormula: `{ConversationId} = '${convId}'`,
          maxRecords: 1,
        })
      : [];

    const now = new Date().toISOString();

    if (existing[0]) {
      let msgs = [];
      try { msgs = JSON.parse(existing[0].fields.Messages || '[]'); } catch (e) {}
      msgs.push(...newMessages);
      await updateRecord('DealerConversations', existing[0].id, {
        Messages: JSON.stringify(msgs).substring(0, 99000),
        UpdatedAt: now,
        ...extras,
      });
      return { recordId: existing[0].id, convId };
    }

    // New conversation
    const newConvId = convId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const rec = await createRecord('DealerConversations', {
      ConversationId: newConvId,
      Messages: JSON.stringify(newMessages).substring(0, 99000),
      CreatedAt: now,
      UpdatedAt: now,
      ...extras,
    }).catch((err) => { console.error('createRecord failed:', err.message); return null; });

    return { recordId: rec ? rec.id : null, convId: newConvId };
  } catch (err) {
    console.error('saveMessages error:', err.message);
    return { recordId: null, convId };
  }
}

// ---- Main handler ----
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Invalid JSON' }); }

  const { dealerUserId, dealerName, jobId, jobName, message, conversationId, history } = body;
  if (!message || !message.trim()) return json(400, { error: 'Missing message' });

  const jobContext = await buildJobContext(dealerUserId, jobId);

  const systemPrompt = `You are a helpful assistant for Michigan Office Environments (MOE), a furniture dealer working with KRS Moving Solutions on furniture delivery and installation.
${jobContext
  ? '\nCurrent job data:\n' + jobContext
  : '\nNo specific job is selected — answer generally about the delivery process.'}

Your role:
- Answer questions about delivery status, item counts, damage reports, scan progress, and scheduling using the data above
- Be concise, friendly, and professional
- If a question requires information you genuinely do not have (e.g. why a specific item is delayed, internal KRS scheduling decisions, or anything not in the data), respond with exactly: ESCALATE: [one sentence summarising what the KRS team needs to address]
- Never make up information that is not in the data`;

  // Build messages array for Claude
  const msgs = (history || []).map((m) => ({ role: m.role === 'krs' ? 'assistant' : m.role, content: m.content }));
  msgs.push({ role: 'user', content: message });

  try {
    const claudeRes = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 512, system: systemPrompt, messages: msgs }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error('Claude API error ' + claudeRes.status + ': ' + errText.substring(0, 200));
    }

    const claudeData = await claudeRes.json();
    const rawReply = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';

    const escalated = rawReply.trimStart().startsWith('ESCALATE:');
    const escalationSummary = escalated ? rawReply.replace(/^ESCALATE:\s*/i, '').trim() : null;
    const displayReply = escalated
      ? "I don't have enough information to answer that directly. I've messaged the KRS team — they'll respond here shortly."
      : rawReply;

    const now = new Date().toISOString();
    const newMessages = [
      { role: 'user', content: message, ts: now },
      { role: 'assistant', content: displayReply, ts: now, escalated },
    ];

    const extras = {
      DealerUserId: dealerUserId || '',
      DealerName: dealerName || '',
      JobId: jobId || '',
      Status: escalated ? 'Escalated' : 'Active',
      ...(escalationSummary ? { EscalatedQuestion: escalationSummary } : {}),
    };

    const { recordId, convId } = await saveMessages(conversationId, newMessages, extras);

    // Send Telegram if escalated
    if (escalated && botToken && tgChatId) {
      try {
        const tgText = [
          '<b>📦 MOE Dealer Question</b>',
          '',
          '<b>From:</b> ' + (dealerName || 'Dealer'),
          jobName ? '<b>Job:</b> ' + jobName : '',
          '',
          '<b>Question:</b> ' + escalationSummary,
          '',
          '<i>Reply to this message to send your answer back to the dealer.</i>',
          '',
          '<code>conv:' + convId + '</code>',
        ].filter(Boolean).join('\n');

        const tgRes = await sendTelegram(botToken, tgChatId, tgText);
        if (tgRes.ok && tgRes.result && recordId) {
          await updateRecord('DealerConversations', recordId, {
            TelegramMessageId: String(tgRes.result.message_id),
          }).catch(() => {});
        }
      } catch (tgErr) {
        console.error('Telegram send failed:', tgErr.message);
      }
    }

    return json(200, { reply: displayReply, conversationId: convId, escalated });

  } catch (err) {
    console.error('dealer-chat error:', err.message);
    return json(500, { error: err.message });
  }
};
