/* =====================================================================
   KRS Scanner — Mobile barcode scanning app
   - Camera barcode scanning via native BarcodeDetector w/ QuaggaJS fallback
   - Airtable lookups via Netlify serverless functions
   - Offline queue in localStorage, auto-sync when back online
   - Big, glove-friendly UI with toast feedback + vibration + beep
===================================================================== */

(function () {
  'use strict';

  // ---- State ----
  const state = {
    crew: '',
    jobId: '',           // Airtable record ID of selected job
    jobName: '',
    products: [],        // manifest for selected job
    scanMode: 'offload', // 'offload' | 'damage'
    gps: null,           // {lat, lon} or null
    usingNativeDetector: false,
    quaggaRunning: false,
    lastScanValue: '',
    lastScanAt: 0,
  };

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const el = {
    activeInfo: $('activeInfo'),
    setupScreen: $('setupScreen'),
    scanScreen: $('scanScreen'),
    crewSelect: $('crewSelect'),
    jobSelect: $('jobSelect'),
    startBtn: $('startBtn'),
    setupStatus: $('setupStatus'),
    switchBtn: $('switchBtn'),
    tallyScanned: $('tallyScanned'),
    tallyTotal: $('tallyTotal'),
    tallyProgress: $('tallyProgress'),
    scanBtn: $('scanBtn'),
    damageBtn: $('damageBtn'),
    lastScanBody: $('lastScanBody'),
    offlineBar: $('offlineBar'),
    offlineCount: $('offlineCount'),
    cameraModal: $('cameraModal'),
    cameraViewport: $('cameraViewport'),
    cameraModeLabel: $('cameraModeLabel'),
    cancelCameraBtn: $('cancelCameraBtn'),
    unknownModal: $('unknownModal'),
    unknownBarcodeReadout: $('unknownBarcodeReadout'),
    unknownDesc: $('unknownDesc'),
    unknownMfr: $('unknownMfr'),
    unknownCancel: $('unknownCancel'),
    unknownSave: $('unknownSave'),
    damageModal: $('damageModal'),
    damageBarcodeReadout: $('damageBarcodeReadout'),
    damageNotes: $('damageNotes'),
    damagePhoto: $('damagePhoto'),
    damageCancel: $('damageCancel'),
    damageSave: $('damageSave'),
    toastStack: $('toastStack'),
    beepAudio: $('beepAudio'),
  };

  // Temporary holder for the barcode that triggered a modal
  let pendingBarcode = '';

  // ====================================================================
  // Toast notifications
  // ====================================================================
  function toast(msg, type) {
    type = type || 'info';
    console.log('[toast:' + type + ']', msg);
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    el.toastStack.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3800);
  }

  // ====================================================================
  // Feedback: beep + vibrate
  // ====================================================================
  function feedbackSuccess() {
    try {
      // Use Web Audio API to synthesize a short beep (data URI above is a placeholder)
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.15;
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 140);
      }
    } catch (e) { console.warn('Beep failed', e); }
    if (navigator.vibrate) navigator.vibrate(80);
  }

  function feedbackError() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 220;
        gain.gain.value = 0.15;
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 240);
      }
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  }

  // ====================================================================
  // GPS capture (non-blocking)
  // ====================================================================
  function captureGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.gps = {
          lat: pos.coords.latitude.toFixed(6),
          lon: pos.coords.longitude.toFixed(6)
        };
        console.log('GPS locked', state.gps);
      },
      (err) => console.warn('GPS error', err),
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
    );
  }

  function gpsString() {
    if (!state.gps) return '';
    return state.gps.lat + ',' + state.gps.lon;
  }

  // ====================================================================
  // API helper — all calls go through Netlify functions
  // ====================================================================
  async function api(path, opts) {
    opts = opts || {};
    const url = '/.netlify/functions/' + path;
    console.log('API call ->', url, opts);
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('API ' + path + ' failed: ' + res.status + ' ' + text);
    }
    return res.json();
  }

  // ====================================================================
  // Load jobs into the job dropdown
  // ====================================================================
  async function loadJobs() {
    el.setupStatus.textContent = 'Loading jobs...';
    try {
      const data = await api('get-jobs');
      const jobs = (data && data.jobs) || [];
      el.jobSelect.innerHTML = '<option value="">-- Select a job --</option>';
      if (!jobs.length) {
        el.jobSelect.innerHTML = '<option value="">No open jobs</option>';
      }
      jobs.forEach((j) => {
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.dataset.name = j.name || '(Unnamed Job)';
        opt.textContent = (j.name || 'Unnamed') + (j.deliveryDate ? ' — ' + j.deliveryDate : '');
        el.jobSelect.appendChild(opt);
      });
      el.setupStatus.textContent = jobs.length + ' job(s) available';
    } catch (err) {
      console.error(err);
      el.setupStatus.textContent = 'Could not load jobs. Check connection.';
      el.jobSelect.innerHTML = '<option value="">Unable to load jobs</option>';
      toast('Failed to load jobs', 'error');
    }
  }

  // ====================================================================
  // Load products for selected job
  // ====================================================================
  async function loadProducts() {
    if (!state.jobId) return;
    try {
      const data = await api('get-products?jobId=' + encodeURIComponent(state.jobId));
      state.products = (data && data.products) || [];
      updateTally();
    } catch (err) {
      console.error(err);
      toast('Failed to load manifest', 'error');
    }
  }

  // ====================================================================
  // Tally counter update
  // ====================================================================
  function updateTally() {
    const total = state.products.reduce((sum, p) => sum + (p.expected || 1), 0);
    const scanned = state.products.reduce((sum, p) => sum + (p.received || 0), 0);
    el.tallyScanned.textContent = scanned;
    el.tallyTotal.textContent = total;
    const pct = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
    el.tallyProgress.style.width = pct + '%';
  }

  // ====================================================================
  // Validate setup + show scan screen
  // ====================================================================
  function validateSetup() {
    const ok = !!(el.crewSelect.value && el.jobSelect.value);
    el.startBtn.disabled = !ok;
  }

  function beginScanning() {
    state.crew = el.crewSelect.value;
    state.jobId = el.jobSelect.value;
    state.jobName = el.jobSelect.options[el.jobSelect.selectedIndex].dataset.name || '';
    el.activeInfo.textContent = state.crew + ' @ ' + state.jobName;
    el.setupScreen.classList.add('hidden');
    el.scanScreen.classList.remove('hidden');
    loadProducts();
    captureGPS();
    syncOfflineQueue();
  }

  // ====================================================================
  // Camera + scanning (native BarcodeDetector preferred, QuaggaJS fallback)
  // ====================================================================
  async function openCamera(mode) {
    state.scanMode = mode;
    el.cameraModeLabel.textContent = mode === 'damage'
      ? 'Scan damaged item'
      : 'Scanning for offload';
    el.cameraModal.classList.remove('hidden');
    el.cameraViewport.innerHTML = '';

    // Try native BarcodeDetector first (Chrome Android)
    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({
          formats: ['code_128', 'code_39', 'upc_a', 'ean_13', 'qr_code']
        });
        state.usingNativeDetector = true;
        await runNativeDetector(detector);
        return;
      } catch (err) {
        console.warn('Native BarcodeDetector failed, falling back to QuaggaJS', err);
      }
    }

    // Fallback: QuaggaJS
    state.usingNativeDetector = false;
    startQuagga();
  }

  async function runNativeDetector(detector) {
    const video = document.createElement('video');
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    el.cameraViewport.appendChild(video);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
    } catch (err) {
      console.error('Camera permission denied', err);
      toast('Camera permission needed', 'error');
      closeCamera();
      return;
    }
    video.srcObject = stream;
    await video.play();

    video._stream = stream;
    state._nativeVideo = video;

    // Loop: detect every ~300ms
    async function tick() {
      if (el.cameraModal.classList.contains('hidden')) return;
      try {
        const barcodes = await detector.detect(video);
        if (barcodes && barcodes.length) {
          handleScan(barcodes[0].rawValue);
          return;
        }
      } catch (err) { /* ignore per-frame errors */ }
      setTimeout(tick, 300);
    }
    tick();
  }

  function startQuagga() {
    if (typeof Quagga === 'undefined') {
      toast('Scanner library missing', 'error');
      closeCamera();
      return;
    }
    Quagga.init({
      inputStream: {
        name: 'Live',
        type: 'LiveStream',
        target: el.cameraViewport,
        constraints: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
      },
      decoder: {
        readers: [
          'code_128_reader',
          'code_39_reader',
          'upc_reader',
          'ean_reader'
        ]
      },
      locate: true,
    }, function (err) {
      if (err) {
        console.error('Quagga init error', err);
        toast('Camera error: ' + err.message, 'error');
        closeCamera();
        return;
      }
      Quagga.start();
      state.quaggaRunning = true;
    });

    Quagga.offDetected();
    Quagga.onDetected(function (result) {
      const code = result && result.codeResult && result.codeResult.code;
      if (code) handleScan(code);
    });
  }

  function closeCamera() {
    el.cameraModal.classList.add('hidden');
    if (state.quaggaRunning) {
      try { Quagga.stop(); } catch (e) {}
      state.quaggaRunning = false;
    }
    if (state._nativeVideo && state._nativeVideo._stream) {
      state._nativeVideo._stream.getTracks().forEach((t) => t.stop());
      state._nativeVideo = null;
    }
    el.cameraViewport.innerHTML = '';
  }

  // ====================================================================
  // Handle a decoded barcode
  // ====================================================================
  function handleScan(code) {
    // Debounce duplicate scans within 1.5s
    const now = Date.now();
    if (code === state.lastScanValue && now - state.lastScanAt < 1500) return;
    state.lastScanValue = code;
    state.lastScanAt = now;

    console.log('Scanned:', code, 'mode=', state.scanMode);
    closeCamera();

    if (state.scanMode === 'damage') {
      pendingBarcode = code;
      el.damageBarcodeReadout.textContent = code;
      el.damageNotes.value = '';
      el.damagePhoto.value = '';
      el.damageModal.classList.remove('hidden');
      feedbackSuccess();
      return;
    }

    // Offload mode: submit scan to API
    submitOffloadScan(code);
  }

  async function submitOffloadScan(code) {
    const payload = {
      barcode: code,
      jobId: state.jobId,
      crew: state.crew,
      scanType: 'Offload',
      gps: gpsString(),
      timestamp: new Date().toISOString(),
    };

    // Offline? queue it
    if (!navigator.onLine) {
      queueOffline(payload);
      el.lastScanBody.textContent = code + ' (queued - offline)';
      toast('Queued offline: ' + code, 'warn');
      feedbackSuccess();
      return;
    }

    try {
      const result = await api('scan-product', { method: 'POST', body: payload });
      if (result && result.found) {
        el.lastScanBody.textContent = (result.product && result.product.description)
          ? result.product.description
          : code;
        toast('Scanned: ' + (result.product.description || code), 'success');
        feedbackSuccess();
        // Optimistically bump local received count
        const hit = state.products.find((p) => p.productId === code);
        if (hit) { hit.received = (hit.received || 0) + 1; hit.status = 'Received'; }
        else await loadProducts();
        updateTally();
      } else {
        // Not found → prompt user to add it
        feedbackError();
        pendingBarcode = code;
        el.unknownBarcodeReadout.textContent = code;
        el.unknownDesc.value = '';
        el.unknownMfr.value = '';
        el.unknownModal.classList.remove('hidden');
      }
    } catch (err) {
      console.error(err);
      toast('Scan failed, queued offline', 'warn');
      queueOffline(payload);
      feedbackSuccess();
    }
  }

  // ====================================================================
  // Add-unknown-barcode flow
  // ====================================================================
  async function saveUnknownProduct() {
    const desc = (el.unknownDesc.value || '').trim();
    const mfr = (el.unknownMfr.value || '').trim();
    if (!desc) { toast('Description required', 'error'); return; }

    const payload = {
      barcode: pendingBarcode,
      jobId: state.jobId,
      crew: state.crew,
      description: desc,
      manufacturer: mfr,
      gps: gpsString(),
      timestamp: new Date().toISOString(),
    };

    try {
      el.unknownSave.disabled = true;
      await api('add-product', { method: 'POST', body: payload });
      toast('Added: ' + desc, 'success');
      el.unknownModal.classList.add('hidden');
      el.lastScanBody.textContent = desc + ' (NEW)';
      feedbackSuccess();
      await loadProducts();
    } catch (err) {
      console.error(err);
      toast('Failed to add product', 'error');
    } finally {
      el.unknownSave.disabled = false;
    }
  }

  // ====================================================================
  // Damage report flow
  // ====================================================================
  async function saveDamageReport() {
    const notes = (el.damageNotes.value || '').trim();
    const file = el.damagePhoto.files && el.damagePhoto.files[0];

    let photoBase64 = null;
    if (file) {
      try {
        photoBase64 = await fileToBase64(file);
      } catch (err) {
        console.warn('Photo read failed', err);
      }
    }

    const payload = {
      barcode: pendingBarcode,
      jobId: state.jobId,
      crew: state.crew,
      notes: notes,
      gps: gpsString(),
      timestamp: new Date().toISOString(),
      photoBase64: photoBase64,        // raw base64 (no data: prefix)
      photoFilename: file ? file.name : null,
      photoType: file ? file.type : null,
    };

    try {
      el.damageSave.disabled = true;
      await api('report-damage', { method: 'POST', body: payload });
      toast('Damage reported', 'warn');
      el.damageModal.classList.add('hidden');
      el.lastScanBody.textContent = pendingBarcode + ' (DAMAGED)';
      feedbackSuccess();
      await loadProducts();
    } catch (err) {
      console.error(err);
      toast('Damage report failed', 'error');
    } finally {
      el.damageSave.disabled = false;
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const comma = String(result).indexOf(',');
        resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ====================================================================
  // Offline queue in localStorage
  // ====================================================================
  const OFFLINE_KEY = 'krs_scan_queue';

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function writeQueue(arr) {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(arr));
    updateOfflineBar();
  }
  function queueOffline(payload) {
    const q = readQueue();
    q.push(payload);
    writeQueue(q);
  }
  function updateOfflineBar() {
    const q = readQueue();
    if (q.length > 0 || !navigator.onLine) {
      el.offlineBar.classList.remove('hidden');
      el.offlineCount.textContent = q.length + ' queued';
    } else {
      el.offlineBar.classList.add('hidden');
    }
  }

  async function syncOfflineQueue() {
    if (!navigator.onLine) return;
    const q = readQueue();
    if (!q.length) { updateOfflineBar(); return; }
    console.log('Syncing', q.length, 'queued scans');
    const remaining = [];
    for (const item of q) {
      try {
        await api('scan-product', { method: 'POST', body: item });
      } catch (err) {
        console.warn('Sync failed, keeping in queue', err);
        remaining.push(item);
      }
    }
    writeQueue(remaining);
    if (remaining.length === 0) {
      toast('Offline scans synced', 'success');
      await loadProducts();
    }
  }

  // ====================================================================
  // Event listeners
  // ====================================================================
  el.crewSelect.addEventListener('change', validateSetup);
  el.jobSelect.addEventListener('change', validateSetup);
  el.startBtn.addEventListener('click', beginScanning);

  el.switchBtn.addEventListener('click', () => {
    el.scanScreen.classList.add('hidden');
    el.setupScreen.classList.remove('hidden');
  });

  el.scanBtn.addEventListener('click', () => openCamera('offload'));
  el.damageBtn.addEventListener('click', () => openCamera('damage'));
  el.cancelCameraBtn.addEventListener('click', closeCamera);

  el.unknownCancel.addEventListener('click', () => el.unknownModal.classList.add('hidden'));
  el.unknownSave.addEventListener('click', saveUnknownProduct);

  el.damageCancel.addEventListener('click', () => el.damageModal.classList.add('hidden'));
  el.damageSave.addEventListener('click', saveDamageReport);

  window.addEventListener('online', () => {
    console.log('Back online');
    updateOfflineBar();
    syncOfflineQueue();
  });
  window.addEventListener('offline', () => {
    console.log('Went offline');
    updateOfflineBar();
    toast('Offline — scans will queue', 'warn');
  });

  // ====================================================================
  // Init
  // ====================================================================
  loadJobs();
  updateOfflineBar();
  console.log('KRS Scanner ready');
})();
