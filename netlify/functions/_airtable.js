/* =====================================================================
   Shared Airtable helper for all Netlify functions.
   Uses native fetch (Node 18+ on Netlify).
   Expects env vars: AIRTABLE_API_KEY, AIRTABLE_BASE_ID
===================================================================== */

const BASE_URL = 'https://api.airtable.com/v0';

function getConfig() {
  const key = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!key || !baseId) {
    throw new Error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID env vars');
  }
  return { key, baseId };
}

// Default CORS / JSON headers for responses
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body) {
  return {
    statusCode: status,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

function handleOptions() {
  return { statusCode: 204, headers: DEFAULT_HEADERS, body: '' };
}

// Low-level Airtable fetch wrapper
async function airtableRequest(path, opts) {
  opts = opts || {};
  const { key, baseId } = getConfig();
  const url = BASE_URL + '/' + baseId + '/' + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error('Airtable ' + res.status + ': ' + (data.error && data.error.message || text));
    err.status = res.status;
    err.airtable = data;
    throw err;
  }
  return data;
}

// Page through all records in a table with optional query string
async function listAll(table, query) {
  const records = [];
  let offset = '';
  const base = encodeURIComponent(table);
  do {
    const qs = new URLSearchParams(query || {});
    if (offset) qs.set('offset', offset);
    const path = base + (qs.toString() ? '?' + qs.toString() : '');
    const data = await airtableRequest(path);
    if (data.records) records.push.apply(records, data.records);
    offset = data.offset || '';
  } while (offset);
  return records;
}

async function createRecord(table, fields) {
  const path = encodeURIComponent(table);
  return airtableRequest(path, {
    method: 'POST',
    body: { fields: fields, typecast: true },
  });
}

async function updateRecord(table, id, fields) {
  const path = encodeURIComponent(table) + '/' + id;
  return airtableRequest(path, {
    method: 'PATCH',
    body: { fields: fields, typecast: true },
  });
}

async function getRecord(table, id) {
  const path = encodeURIComponent(table) + '/' + id;
  return airtableRequest(path);
}

module.exports = {
  DEFAULT_HEADERS,
  json,
  handleOptions,
  airtableRequest,
  listAll,
  createRecord,
  updateRecord,
  getRecord,
};
