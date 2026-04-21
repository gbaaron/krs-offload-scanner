/* =====================================================================
   KRS Dashboard — Live offload/install status
   - Dealer login overlay: Airtable DealerUsers auth
   - Polls Netlify functions for job manifest + scan log
   - Progress bar, summary cards, filterable manifest table
   - Live scan feed, CSV export, auto-refresh
===================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    jobSelect: $('dashJobSelect'),
    refreshBtn: $('refreshBtn'),
    exportBtn: $('exportBtn'),
    progressLabel: $('progressLabel'),
    progressPct: $('progressPct'),
    progressBarFill: $('progressBarFill'),
    sumExpected: $('sumExpected'),
    sumReceived: $('sumReceived'),
    sumDamaged: $('sumDamaged'),
    sumMissing: $('sumMissing'),
    manifestBody: $('manifestBody'),
    feedList: $('feedList'),
    lastUpdated: $('lastUpdated'),
    filterBtns: document.querySelectorAll('.filter-btn'),
    // Dealer login overlay
    loginOverlay: $('dealerLoginOverlay'),
    loginEmail: $('loginEmail'),
    loginPassword: $('loginPassword'),
    loginError: $('loginError'),
    loginBtn: $('loginBtn'),
    // Dealer session display
    dealerSession: $('dealerSession'),
    dealerSessionName: $('dealerSessionName'),
    dealerSessionCompany: $('dealerSessionCompany'),
    logoutBtn: $('logoutBtn'),
  };

  const state = {
    jobId: '',
    jobName: '',
    manifest: [],
    filter: 'all',
    feedTimer: null,
    manifestTimer: null,
    feedRefreshMs: 15000,
    manifestRefreshMs: 30000,
    dealer: null, // { id, name, email, company } from localStorage
  };

  const DEALER_KEY = 'krs_dealer';

  // ====================================================================
  // API helper
  // ====================================================================
  async function api(path, opts) {
    const url = '/.netlify/functions/' + path;
    console.log('Dashboard API ->', url);
    const res = await fetch(url, opts || {});
    if (!res.ok) throw new Error('API ' + path + ': ' + res.status);
    return res.json();
  }

  // ====================================================================
  // Dealer session management
  // ====================================================================
  function getDealerSession() {
    try {
      const raw = localStorage.getItem(DEALER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveDealerSession(dealer) {
    localStorage.setItem(DEALER_KEY, JSON.stringify(dealer));
    state.dealer = dealer;
  }

  function clearDealerSession() {
    localStorage.removeItem(DEALER_KEY);
    state.dealer = null;
  }

  function showDealerSession(dealer) {
    el.dealerSessionName.textContent = dealer.name;
    el.dealerSessionCompany.textContent = dealer.company || 'Dealer Portal';
    el.dealerSession.style.display = 'flex';
    el.loginOverlay.classList.add('hidden');
  }

  // ====================================================================
  // Login form
  // ====================================================================
  async function handleLogin() {
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    el.loginError.textContent = '';

    if (!email || !password) {
      el.loginError.textContent = 'Please enter your email and password.';
      return;
    }

    el.loginBtn.disabled = true;
    el.loginBtn.textContent = 'Signing in…';

    try {
      const result = await api('dealer-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      saveDealerSession(result);
      showDealerSession(result);
      showChatToggle(true);
      loadJobs();
    } catch (err) {
      el.loginError.textContent = err.message.includes('401')
        ? 'Invalid email or password.'
        : 'Login failed. Please try again.';
    } finally {
      el.loginBtn.disabled = false;
      el.loginBtn.textContent = 'Sign In';
    }
  }

  el.loginBtn.addEventListener('click', handleLogin);
  el.loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginPassword.focus(); });
  el.loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });

  el.logoutBtn.addEventListener('click', () => {
    clearDealerSession();
    stopTimers();
    if (chat.pollTimer) { clearInterval(chat.pollTimer); chat.pollTimer = null; }
    showChatToggle(false);
    chatEl.panel.classList.remove('open');
    el.dealerSession.style.display = 'none';
    el.jobSelect.innerHTML = '<option value="">-- Select a job --</option>';
    el.manifestBody.innerHTML = '<tr><td colspan="7" class="empty-state">Select a job to view manifest</td></tr>';
    el.feedList.innerHTML = '<li class="feed-empty">No scans yet</li>';
    state.jobId = '';
    el.loginOverlay.classList.remove('hidden');
  });

  // ====================================================================
  // Load jobs into the dropdown
  // ====================================================================
  async function loadJobs() {
    try {
      let data;
      if (state.dealer) {
        // Dealer: only show authorized jobs
        data = await api('get-dealer-jobs?dealerUserId=' + encodeURIComponent(state.dealer.id));
      } else {
        data = await api('get-jobs');
      }
      const jobs = (data && data.jobs) || [];
      el.jobSelect.innerHTML = '<option value="">-- Select a job --</option>';
      jobs.forEach((j) => {
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.dataset.name = j.name || '';
        opt.textContent = (j.name || 'Unnamed') +
          (j.deliveryDate ? ' — ' + j.deliveryDate : '') +
          (j.dealer ? ' (' + j.dealer + ')' : '');
        el.jobSelect.appendChild(opt);
      });
      if (!jobs.length) {
        el.jobSelect.innerHTML = '<option value="">No jobs assigned</option>';
      }
    } catch (err) {
      console.error(err);
      el.jobSelect.innerHTML = '<option value="">-- No active jobs --</option>';
    }
  }

  // ====================================================================
  // Load manifest / dashboard data for selected job
  // ====================================================================
  async function loadDashboard() {
    if (!state.jobId) return;
    try {
      const data = await api('get-dashboard-data?jobId=' + encodeURIComponent(state.jobId));
      state.manifest = (data && data.products) || [];
      renderSummary();
      renderManifest();
      el.lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      console.error(err);
      el.manifestBody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load manifest</td></tr>';
    }
  }

  // ====================================================================
  // Render the progress bar + summary cards
  // ====================================================================
  function renderSummary() {
    const totalExpected = state.manifest.reduce((s, p) => s + (p.expected || 0), 0);
    const totalReceived = state.manifest.reduce((s, p) => s + (p.received || 0), 0);
    const damaged = state.manifest.filter((p) => p.status === 'Damaged').length;
    const missing = state.manifest.filter((p) => p.status === 'Missing' || p.status === 'Pending').length;

    el.sumExpected.textContent = totalExpected;
    el.sumReceived.textContent = totalReceived;
    el.sumDamaged.textContent = damaged;
    el.sumMissing.textContent = missing;

    const pct = totalExpected > 0 ? Math.round((totalReceived / totalExpected) * 100) : 0;
    el.progressLabel.textContent = totalReceived + ' of ' + totalExpected + ' items received';
    el.progressPct.textContent = pct + '%';
    el.progressBarFill.style.width = Math.min(100, pct) + '%';
  }

  // ====================================================================
  // Render manifest table (with filter)
  // ====================================================================
  function renderManifest() {
    let rows = state.manifest.slice();
    if (state.filter !== 'all') {
      rows = rows.filter((p) => (p.status || 'Pending') === state.filter);
    }
    if (!rows.length) {
      el.manifestBody.innerHTML = '<tr><td colspan="7" class="empty-state">No items match this filter</td></tr>';
      return;
    }

    const html = rows.map((p) => {
      const status = p.status || 'Pending';
      const badgeClass = 'status-' + status.toLowerCase();
      return '<tr>' +
        '<td>' + escapeHtml(p.jobNumber || '—') + '</td>' +
        '<td>' + escapeHtml(p.productId || '') + '</td>' +
        '<td>' + escapeHtml(p.description || '') + '</td>' +
        '<td>' + escapeHtml(p.manufacturer || '') + '</td>' +
        '<td><span class="status-badge ' + badgeClass + '">' + status + '</span></td>' +
        '<td>' + escapeHtml(p.scannedBy || '') + '</td>' +
        '<td>' + formatDate(p.scannedAt) + '</td>' +
        '</tr>';
    }).join('');
    el.manifestBody.innerHTML = html;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  // ====================================================================
  // Live scan feed (polls every 15s)
  // ====================================================================
  async function loadFeed() {
    if (!state.jobId) return;
    try {
      const data = await api('get-scan-log?jobId=' + encodeURIComponent(state.jobId) + '&limit=10');
      const scans = (data && data.scans) || [];
      if (!scans.length) {
        el.feedList.innerHTML = '<li class="feed-empty">No scans yet</li>';
        return;
      }
      el.feedList.innerHTML = scans.map((s) => {
        return '<li>' +
          '<div class="feed-item-title">' + escapeHtml(s.description || s.barcode || 'Unknown') + '</div>' +
          '<div class="feed-item-meta">' +
            escapeHtml(s.scannedBy || 'unknown') + ' &middot; ' +
            formatDate(s.timestamp) +
            (s.scanType ? ' &middot; ' + escapeHtml(s.scanType) : '') +
            (s.jobNumber ? ' &middot; Job #' + escapeHtml(s.jobNumber) : '') +
          '</div>' +
        '</li>';
      }).join('');
    } catch (err) {
      console.error('Feed failed', err);
    }
  }

  // ====================================================================
  // CSV export
  // ====================================================================
  function exportCSV() {
    if (!state.manifest.length) {
      alert('Nothing to export yet.');
      return;
    }
    const headers = ['Job Number', 'Barcode', 'Description', 'Manufacturer', 'Dealer', 'Expected', 'Received', 'Status', 'Scanned By', 'Scanned At', 'Notes'];
    const lines = [headers.join(',')];
    state.manifest.forEach((p) => {
      const row = [
        p.jobNumber || '',
        p.productId || '',
        p.description || '',
        p.manufacturer || '',
        p.dealer || '',
        p.expected || 0,
        p.received || 0,
        p.status || 'Pending',
        p.scannedBy || '',
        p.scannedAt || '',
        (p.notes || '').replace(/\n/g, ' ')
      ].map(csvEscape).join(',');
      lines.push(row);
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    const safeName = (state.jobName || 'job').replace(/[^a-z0-9]+/gi, '_');
    a.href = URL.createObjectURL(blob);
    a.download = 'KRS_' + safeName + '_manifest.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ====================================================================
  // Filtering
  // ====================================================================
  el.filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      el.filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.getAttribute('data-filter') || 'all';
      renderManifest();
    });
  });

  // ====================================================================
  // Event listeners
  // ====================================================================
  el.jobSelect.addEventListener('change', () => {
    state.jobId = el.jobSelect.value;
    state.jobName = el.jobSelect.options[el.jobSelect.selectedIndex].dataset.name || '';
    if (state.jobId) {
      loadDashboard();
      loadFeed();
      startTimers();
    } else {
      stopTimers();
    }
  });
  el.refreshBtn.addEventListener('click', () => { loadDashboard(); loadFeed(); });
  el.exportBtn.addEventListener('click', exportCSV);

  // ====================================================================
  // Auto-refresh timers
  // ====================================================================
  function startTimers() {
    stopTimers();
    state.feedTimer = setInterval(loadFeed, state.feedRefreshMs);
    state.manifestTimer = setInterval(loadDashboard, state.manifestRefreshMs);
  }
  function stopTimers() {
    if (state.feedTimer) clearInterval(state.feedTimer);
    if (state.manifestTimer) clearInterval(state.manifestTimer);
    state.feedTimer = null;
    state.manifestTimer = null;
  }

  // ====================================================================
  // Load site config (refresh intervals, branding)
  // ====================================================================
  async function loadSiteConfig() {
    try {
      const data = await api('get-site-config');
      const cfg = (data && data.config) || {};
      if (cfg.feed_refresh_ms) state.feedRefreshMs = parseInt(cfg.feed_refresh_ms, 10) || 15000;
      if (cfg.dashboard_refresh_ms) state.manifestRefreshMs = parseInt(cfg.dashboard_refresh_ms, 10) || 30000;
      if (cfg.dashboard_title) {
        const sub = document.querySelector('.dash-brand-sub');
        if (sub) sub.textContent = cfg.dashboard_title;
      }
      if (cfg.company_name) {
        const brand = document.querySelector('.dash-brand-main');
        if (brand) brand.textContent = cfg.company_name;
      }
      if (cfg.partner_name) {
        const partner = document.querySelector('.partner-name');
        if (partner) partner.textContent = cfg.partner_name;
      }
    } catch (err) {
      console.warn('Could not load site config, using defaults', err);
    }
  }

  // ====================================================================
  // Dealer chatbot
  // ====================================================================
  const chat = {
    open: false,
    history: [],       // { role, content, ts } for conversation context
    conversationId: null,
    escalated: false,
    pollTimer: null,
    unread: 0,
  };

  const chatEl = {
    toggle: $('chatToggle'),
    panel: $('chatPanel'),
    close: $('chatClose'),
    messages: $('chatMessages'),
    typing: $('chatTyping'),
    input: $('chatInput'),
    send: $('chatSend'),
    badge: $('chatBadge'),
  };

  function chatAddMessage(role, content) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = content;
    chatEl.messages.appendChild(div);
    chatEl.messages.scrollTop = chatEl.messages.scrollHeight;
    if (!chat.open && role !== 'user') {
      chat.unread++;
      chatEl.badge.textContent = chat.unread;
      chatEl.badge.classList.add('visible');
    }
    return div;
  }

  function chatSetTyping(visible) {
    chatEl.typing.classList.toggle('visible', visible);
    if (visible) chatEl.messages.scrollTop = chatEl.messages.scrollHeight;
  }

  async function chatSend() {
    const text = chatEl.input.value.trim();
    if (!text || chatEl.send.disabled) return;

    chatEl.input.value = '';
    chatEl.input.style.height = 'auto';
    chatEl.send.disabled = true;
    chatAddMessage('user', text);
    chatSetTyping(true);

    // Keep last 6 turns as context (3 user + 3 assistant)
    const history = chat.history.slice(-6);

    try {
      const result = await api('dealer-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealerUserId: state.dealer ? state.dealer.id : null,
          dealerName: state.dealer ? state.dealer.name : null,
          jobId: state.jobId || null,
          jobName: state.jobName || null,
          message: text,
          conversationId: chat.conversationId,
          history,
        }),
      });

      chatSetTyping(false);
      chatAddMessage('bot', result.reply);
      chat.history.push({ role: 'user', content: text });
      chat.history.push({ role: 'assistant', content: result.reply });
      chat.conversationId = result.conversationId;

      if (result.escalated) {
        chat.escalated = true;
        const notice = document.createElement('div');
        notice.className = 'chat-msg escalated-notice';
        notice.textContent = '⏳ Waiting for KRS team response…';
        chatEl.messages.appendChild(notice);
        chatEl.messages.scrollTop = chatEl.messages.scrollHeight;
        startConversationPoll();
      }
    } catch (err) {
      chatSetTyping(false);
      chatAddMessage('bot', 'Sorry, something went wrong. Please try again.');
      console.error('chat send error:', err);
    } finally {
      chatEl.send.disabled = false;
      chatEl.input.focus();
    }
  }

  // Poll for Aaron's Telegram reply
  function startConversationPoll() {
    if (chat.pollTimer || !chat.conversationId) return;
    chat.pollTimer = setInterval(async () => {
      try {
        const data = await api('poll-conversation?conversationId=' + encodeURIComponent(chat.conversationId));
        if (data.status === 'Resolved' && data.krsResponse) {
          clearInterval(chat.pollTimer);
          chat.pollTimer = null;
          chat.escalated = false;
          // Remove waiting notice
          const notices = chatEl.messages.querySelectorAll('.escalated-notice');
          notices.forEach((n) => n.remove());
          chatAddMessage('krs', data.krsResponse);
          chat.history.push({ role: 'krs', content: data.krsResponse });
        }
      } catch (e) { /* silent — keep polling */ }
    }, 10000); // poll every 10 seconds
  }

  // Toggle chat open/closed
  function toggleChat() {
    chat.open = !chat.open;
    chatEl.panel.classList.toggle('open', chat.open);
    if (chat.open) {
      chat.unread = 0;
      chatEl.badge.classList.remove('visible');
      chatEl.input.focus();
    }
  }

  chatEl.toggle.addEventListener('click', toggleChat);
  chatEl.close.addEventListener('click', toggleChat);
  chatEl.send.addEventListener('click', chatSend);
  chatEl.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  // Auto-grow textarea
  chatEl.input.addEventListener('input', () => {
    chatEl.input.style.height = 'auto';
    chatEl.input.style.height = Math.min(chatEl.input.scrollHeight, 80) + 'px';
  });

  // Show chat button only when dealer is logged in
  function showChatToggle(show) {
    if (chatEl.toggle) chatEl.toggle.style.display = show ? 'flex' : 'none';
  }

  // ====================================================================
  // Init
  // ====================================================================
  loadSiteConfig();

  const existingSession = getDealerSession();
  if (existingSession) {
    state.dealer = existingSession;
    showDealerSession(existingSession);
    showChatToggle(true);
    loadJobs();
  }
  // If no session, the overlay stays visible — user must log in

  console.log('KRS Dashboard ready');
})();
