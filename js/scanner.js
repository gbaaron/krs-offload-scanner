/* =====================================================================
   KRS Scanner — Mobile barcode scanning app

   New model:
   - No pre-loaded manifest. Barcodes are not searched — they are logged.
   - A "Scan Context" (Dealer + Product Name + Manufacturer) is set at
     session start and persists until the user changes it.
   - Each scan:
       * If barcode is NEW for this job → creates a new Products row
         using the current Scan Context, status = Received.
       * If barcode is ALREADY logged for this job → warns "Already
         logged" and does NOT duplicate. Scan event is still written
         to Scan Log (full audit trail).
   - Offline resilient: queues in localStorage, syncs when back online.
===================================================================== */

(function () {
  'use strict';

  // ---- Persistent state keys ----
  const LS_CONTEXT = 'krs_scan_context';
  const LS_QUEUE = 'krs_scan_queue';

  // ---- State ----
  const state = {
    crew: '',
    jobId: '',
    jobName: '',
    jobNumber: '',
    dealer: 'Michigan Office Environments',
    productName: '',
    manufacturer: '',
    scanMode: 'offload',
    gps: null,
    quaggaRunning: false,
    sessionCount: 0,
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
    dealerInput: $('dealerInput'),
    jobNumberInput: $('jobNumberInput'),
    productInput: $('productInput'),
    manufacturerInput: $('manufacturerInput'),
    startBtn: $('startBtn'),
    setupStatus: $('setupStatus'),
    switchBtn: $('switchBtn'),
    ctxProduct: $('ctxProduct'),
    ctxManufacturer: $('ctxManufacturer'),
    ctxDealer: $('ctxDealer'),
    ctxJobNumber: $('ctxJobNumber'),
    changeContextBtn: $('changeContextBtn'),
    tallyScanned: $('tallyScanned'),
    scanBtn: $('scanBtn'),
    damageBtn: $('damageBtn'),
    lastScanBody: $('lastScanBody'),
    offlineBar: $('offlineBar'),
    offlineCount: $('offlineCount'),
    cameraModal: $('cameraModal'),
    cameraViewport: $('cameraViewport'),
    cameraModeLabel: $('cameraModeLabel'),
    cancelCameraBtn: $('cancelCameraBtn'),
    contextModal: $('contextModal'),
    ctxEditProduct: $('ctxEditProduct'),
    ctxEditManufacturer: $('ctxEditManufacturer'),
    ctxEditDealer: $('ctxEditDealer'),
    ctxEditJobNumber: $('ctxEditJobNumber'),
    ctxCancel: $('ctxCancel'),
    ctxSave: $('ctxSave'),
    damageModal: $('damageModal'),
    damageBarcodeReadout: $('damageBarcodeReadout'),
    damageNotes: $('damageNotes'),
    damagePhoto: $('damagePhoto'),
    damageCancel: $('damageCancel'),
    damageSave: $('damageSave'),
    toastStack: $('toastStack'),
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
    playBeep(880, 0.15, 140);
    if (navigator.vibrate) navigator.vibrate(80);
  }
  function feedbackWarn() {
    playBeep(500, 0.15, 180);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  }
  function feedbackError() {
    playBeep(220, 0.15, 240);
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  }
  function playBeep(freq, gainVal, ms) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = gainVal;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, ms);
    } catch (e) { console.warn('Beep failed', e); }
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
  // API helper
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
        opt.dataset.dealer = j.dealer || '';
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
  // Persist / restore scan context
  // ====================================================================
  function saveContext() {
    const payload = {
      dealer: state.dealer,
      jobNumber: state.jobNumber,
      productName: state.productName,
      manufacturer: state.manufacturer,
    };
    try { localStorage.setItem(LS_CONTEXT, JSON.stringify(payload)); } catch (e) {}
  }
  function restoreContext() {
    try {
      const raw = localStorage.getItem(LS_CONTEXT);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.dealer) { state.dealer = p.dealer; el.dealerInput.value = p.dealer; }
      if (p.jobNumber) { state.jobNumber = p.jobNumber; el.jobNumberInput.value = p.jobNumber; }
      if (p.productName) { state.productName = p.productName; el.productInput.value = p.productName; }
      if (p.manufacturer) { state.manufacturer = p.manufacturer; el.manufacturerInput.value = p.manufacturer; }
    } catch (e) { console.warn('restoreContext failed', e); }
  }

  // ====================================================================
  // Render the on-screen context card
  // ====================================================================
  function renderContextCard() {
    el.ctxProduct.textContent = state.productName || 'Product not set';
    el.ctxManufacturer.textContent = state.manufacturer || 'No manufacturer';
    el.ctxDealer.textContent = state.dealer || 'No dealer';
    el.ctxJobNumber.textContent = 'Job #: ' + (state.jobNumber || '—');
  }

  // ====================================================================
  // Validate setup
  // ====================================================================
  function validateSetup() {
    const ok = !!(
      el.crewSelect.value &&
      el.jobSelect.value &&
      (el.productInput.value || '').trim()
    );
    el.startBtn.disabled = !ok;
  }

  function beginScanning() {
    state.crew = el.crewSelect.value;
    state.jobId = el.jobSelect.value;
    const jobOpt = el.jobSelect.options[el.jobSelect.selectedIndex];
    state.jobName = jobOpt.dataset.name || '';
    state.dealer = (el.dealerInput.value || '').trim() || jobOpt.dataset.dealer || '';
    state.jobNumber = (el.jobNumberInput.value || '').trim();
    state.productName = (el.productInput.value || '').trim();
    state.manufacturer = (el.manufacturerInput.value || '').trim();
    saveContext();

    el.activeInfo.textContent = state.crew + ' @ ' + state.jobName;
    el.setupScreen.classList.add('hidden');
    el.scanScreen.classList.remove('hidden');
    renderContextCard();
    captureGPS();
    syncOfflineQueue();
  }

  // ====================================================================
  // Change Scan Context modal
  // ====================================================================
  function openContextModal() {
    el.ctxEditProduct.value = state.productName;
    el.ctxEditManufacturer.value = state.manufacturer;
    el.ctxEditDealer.value = state.dealer;
    el.ctxEditJobNumber.value = state.jobNumber;
    el.contextModal.classList.remove('hidden');
  }
  function saveContextModal() {
    const product = (el.ctxEditProduct.value || '').trim();
    if (!product) {
      toast('Product name is required', 'error');
      return;
    }
    state.productName = product;
    state.manufacturer = (el.ctxEditManufacturer.value || '').trim();
    state.dealer = (el.ctxEditDealer.value || '').trim();
    state.jobNumber = (el.ctxEditJobNumber.value || '').trim();
    saveContext();
    renderContextCard();
    el.contextModal.classList.add('hidden');
    toast('Context updated', 'success');
  }

  // ====================================================================
  // Camera + scanning (native BarcodeDetector preferred, QuaggaJS fallback)
  // ====================================================================
  async function openCamera(mode) {
    state.scanMode = mode;
    el.cameraModeLabel.textContent = mode === 'damage'
      ? 'Scan damaged item'
      : 'Scanning — ' + (state.productName || 'no product set');
    el.cameraModal.classList.remove('hidden');
    el.cameraViewport.innerHTML = '';

    if ('BarcodeDetector' in window) {
      try {
        const detector = new BarcodeDetector({
          formats: ['code_128', 'code_39', 'upc_a', 'ean_13', 'qr_code']
        });
        await runNativeDetector(detector);
        return;
      } catch (err) {
        console.warn('Native BarcodeDetector failed, falling back to QuaggaJS', err);
      }
    }
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
        readers: ['code_128_reader', 'code_39_reader', 'upc_reader', 'ean_reader']
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
    // Debounce duplicate scans within 1.5s (same physical detection)
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
      feedbackWarn();
      return;
    }

    submitScan(code);
  }

  // ====================================================================
  // Submit a scan — create-or-warn flow
  // ====================================================================
  async function submitScan(code) {
    if (!state.productName) {
      toast('Set a product name first', 'error');
      feedbackError();
      return;
    }

    const payload = {
      barcode: code,
      jobId: state.jobId,
      crew: state.crew,
      dealer: state.dealer,
      jobNumber: state.jobNumber,
      productName: state.productName,
      manufacturer: state.manufacturer,
      scanType: 'Offload',
      gps: gpsString(),
      timestamp: new Date().toISOString(),
    };

    if (!navigator.onLine) {
      queueOffline(payload);
      el.lastScanBody.textContent = code + ' (queued - offline)';
      toast('Queued offline: ' + code, 'warn');
      feedbackSuccess();
      return;
    }

    try {
      const result = await api('scan-product', { method: 'POST', body: payload });

      if (result && result.alreadyLogged) {
        // Warn — already in the database for this job
        const desc = (result.product && result.product.description) || 'item';
        el.lastScanBody.textContent = code + ' — already logged as ' + desc;
        toast('Already logged: ' + desc, 'warn');
        feedbackWarn();
        return;
      }

      if (result && result.created) {
        state.sessionCount += 1;
        el.tallyScanned.textContent = state.sessionCount;
        const desc = (result.product && result.product.description) || code;
        el.lastScanBody.textContent = desc;
        toast('Logged: ' + desc, 'success');
        feedbackSuccess();
        return;
      }

      console.warn('Unexpected scan response', result);
      toast('Scan saved', 'success');
      feedbackSuccess();
    } catch (err) {
      console.error(err);
      toast('Scan failed, queued offline', 'warn');
      queueOffline(payload);
      feedbackSuccess();
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
      try { photoBase64 = await fileToBase64(file); }
      catch (err) { console.warn('Photo read failed', err); }
    }

    const payload = {
      barcode: pendingBarcode,
      jobId: state.jobId,
      crew: state.crew,
      dealer: state.dealer,
      jobNumber: state.jobNumber,
      productName: state.productName,
      manufacturer: state.manufacturer,
      notes: notes,
      gps: gpsString(),
      timestamp: new Date().toISOString(),
      photoBase64: photoBase64,
      photoFilename: file ? file.name : null,
      photoType: file ? file.type : null,
    };

    try {
      el.damageSave.disabled = true;
      await api('report-damage', { method: 'POST', body: payload });
      toast('Damage reported', 'warn');
      el.damageModal.classList.add('hidden');
      el.lastScanBody.textContent = pendingBarcode + ' (DAMAGED)';
      feedbackWarn();
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
  // Offline queue
  // ====================================================================
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || '[]'); }
    catch (e) { return []; }
  }
  function writeQueue(arr) {
    localStorage.setItem(LS_QUEUE, JSON.stringify(arr));
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
      try { await api('scan-product', { method: 'POST', body: item }); }
      catch (err) { console.warn('Sync failed, keeping in queue', err); remaining.push(item); }
    }
    writeQueue(remaining);
    if (remaining.length === 0) toast('Offline scans synced', 'success');
  }

  // ====================================================================
  // Event listeners
  // ====================================================================
  el.crewSelect.addEventListener('change', validateSetup);
  el.jobSelect.addEventListener('change', validateSetup);
  el.productInput.addEventListener('input', validateSetup);
  el.dealerInput.addEventListener('input', validateSetup);
  el.manufacturerInput.addEventListener('input', validateSetup);
  el.startBtn.addEventListener('click', beginScanning);

  el.switchBtn.addEventListener('click', () => {
    el.scanScreen.classList.add('hidden');
    el.setupScreen.classList.remove('hidden');
  });

  el.changeContextBtn.addEventListener('click', openContextModal);
  el.ctxCancel.addEventListener('click', () => el.contextModal.classList.add('hidden'));
  el.ctxSave.addEventListener('click', saveContextModal);

  el.scanBtn.addEventListener('click', () => openCamera('offload'));
  el.damageBtn.addEventListener('click', () => openCamera('damage'));
  el.cancelCameraBtn.addEventListener('click', closeCamera);

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
  restoreContext();
  loadJobs();
  updateOfflineBar();
  validateSetup();
  console.log('KRS Scanner ready');
})();
