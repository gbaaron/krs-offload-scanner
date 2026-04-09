/* =====================================================================
   KRS Dashboard — Live offload/install status
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
  };

  const state = {
    jobId: '',
    jobName: '',
    manifest: [],
    filter: 'all',
    feedTimer: null,
    manifestTimer: null,
  };

  // ====================================================================
  // API helper
  // ====================================================================
  async function api(path) {
    const url = '/.netlify/functions/' + path;
    console.log('Dashboard API ->', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('API ' + path + ' failed: ' + res.status);
    return res.json();
  }

  // ====================================================================
  // Load jobs into the dropdown
  // ====================================================================
  async function loadJobs() {
    try {
      const data = await api('get-jobs');
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
        el.jobSelect.innerHTML = '<option value="">No open jobs</option>';
      }
    } catch (err) {
      console.error(err);
      el.jobSelect.innerHTML = '<option value="">Failed to load jobs</option>';
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
      el.manifestBody.innerHTML = '<tr><td colspan="6" class="empty-state">No items match this filter</td></tr>';
      return;
    }

    const html = rows.map((p) => {
      const status = p.status || 'Pending';
      const badgeClass = 'status-' + status.toLowerCase();
      return '<tr>' +
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
      const d = new Date(iso);
      return d.toLocaleString();
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
    const headers = ['Barcode', 'Description', 'Manufacturer', 'Expected', 'Received', 'Status', 'Scanned By', 'Scanned At', 'Notes'];
    const lines = [headers.join(',')];
    state.manifest.forEach((p) => {
      const row = [
        p.productId || '',
        p.description || '',
        p.manufacturer || '',
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
    state.feedTimer = setInterval(loadFeed, 15000);        // every 15s
    state.manifestTimer = setInterval(loadDashboard, 30000); // every 30s
  }
  function stopTimers() {
    if (state.feedTimer) clearInterval(state.feedTimer);
    if (state.manifestTimer) clearInterval(state.manifestTimer);
    state.feedTimer = null;
    state.manifestTimer = null;
  }

  // ====================================================================
  // Init
  // ====================================================================
  loadJobs();
  console.log('KRS Dashboard ready');
})();
