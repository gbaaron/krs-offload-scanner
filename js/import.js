/* =====================================================================
   KRS Import Paperwork — upload manufacturer PDF, AI extracts items,
   review table, then push to Airtable Products as Pending manifest.
===================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    step1: $('step1'),
    step2: $('step2'),
    step3: $('step3'),
    step4: $('step4'),
    jobSelect: $('importJobSelect'),
    jobNumber: $('importJobNumber'),
    manufacturer: $('importManufacturer'),
    dealer: $('importDealer'),
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    fileInfo: $('fileInfo'),
    fileInfoName: $('fileInfoName'),
    removeFileBtn: $('removeFileBtn'),
    extractBtn: $('extractBtn'),
    metaRow: $('metaRow'),
    importBody: $('importBody'),
    importBtn: $('importBtn'),
    importCount: $('importCount'),
    checkAll: $('checkAll'),
    backBtn: $('backBtn'),
    doneMsg: $('doneMsg'),
    anotherBtn: $('anotherBtn'),
    errorBar: $('errorBar'),
    errorMsg: $('errorMsg'),
    errorClose: $('errorClose'),
  };

  let uploadedFile = null;
  let extractedItems = [];
  let extractedMeta = {};

  // ---- API helper ----
  async function api(path, opts) {
    opts = opts || {};
    const url = '/.netlify/functions/' + path;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('API ' + path + ': ' + res.status + ' ' + text);
    }
    return res.json();
  }

  // ---- Error display ----
  function showError(msg) {
    el.errorMsg.textContent = msg;
    el.errorBar.classList.remove('hidden');
    console.error(msg);
  }
  el.errorClose.addEventListener('click', () => el.errorBar.classList.add('hidden'));

  // ---- Step navigation ----
  function showStep(n) {
    [el.step1, el.step2, el.step3, el.step4].forEach((s, i) => {
      s.classList.toggle('hidden', i !== n - 1);
    });
    window.scrollTo(0, 0);
  }

  // ---- Load jobs ----
  async function loadJobs() {
    try {
      const data = await api('get-jobs');
      const jobs = (data && data.jobs) || [];
      el.jobSelect.innerHTML = '<option value="">-- Select a job --</option>';
      jobs.forEach((j) => {
        const opt = document.createElement('option');
        opt.value = j.id;
        opt.textContent = (j.name || 'Unnamed') + (j.deliveryDate ? ' — ' + j.deliveryDate : '');
        el.jobSelect.appendChild(opt);
      });
    } catch (err) {
      el.jobSelect.innerHTML = '<option value="">Failed to load jobs</option>';
      showError('Could not load jobs: ' + err.message);
    }
  }

  // ---- File handling ----
  function handleFile(file) {
    if (!file || file.type !== 'application/pdf') {
      showError('Please upload a PDF file.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showError('File too large (max 4 MB). For bigger documents, split the PDF first.');
      return;
    }
    uploadedFile = file;
    el.fileInfoName.textContent = file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';
    el.fileInfo.classList.remove('hidden');
    el.dropZone.classList.add('hidden');
    validateStep1();
  }

  function removeFile() {
    uploadedFile = null;
    el.fileInput.value = '';
    el.fileInfo.classList.add('hidden');
    el.dropZone.classList.remove('hidden');
    validateStep1();
  }

  function validateStep1() {
    el.extractBtn.disabled = !(uploadedFile && el.jobSelect.value);
  }

  // Click to upload
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  el.removeFileBtn.addEventListener('click', removeFile);
  el.jobSelect.addEventListener('change', validateStep1);

  // Drag and drop
  ['dragenter', 'dragover'].forEach((evt) => {
    el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.add('import-drop-active'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.remove('import-drop-active'); });
  });
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // ---- Extract items (Step 1 → 2 → 3) ----
  el.extractBtn.addEventListener('click', async () => {
    if (!uploadedFile || !el.jobSelect.value) return;
    showStep(2);

    try {
      const base64 = await fileToBase64(uploadedFile);
      const result = await api('parse-paperwork', {
        method: 'POST',
        body: {
          pdfBase64: base64,
          manufacturer: el.manufacturer.value.trim(),
          dealer: el.dealer.value.trim(),
        },
      });

      extractedItems = result.items || [];
      extractedMeta = result.meta || {};

      if (!extractedItems.length) {
        if (result.parseError) {
          showError('AI could not parse the document. Try a different file or add a manufacturer hint.');
        } else {
          showError('No items found in the document.');
        }
        showStep(1);
        return;
      }

      renderReview();
      showStep(3);
    } catch (err) {
      showError('Extraction failed: ' + err.message);
      showStep(1);
    }
  });

  // ---- Render review table ----
  function renderReview() {
    // Meta info
    const metaParts = [];
    if (extractedMeta.documentType) metaParts.push('Type: ' + extractedMeta.documentType);
    if (extractedMeta.orderNumber) metaParts.push('Order #: ' + extractedMeta.orderNumber);
    if (extractedMeta.dealer) metaParts.push('Dealer: ' + extractedMeta.dealer);
    if (extractedMeta.totalItemCount) metaParts.push('Total qty: ' + extractedMeta.totalItemCount);
    el.metaRow.textContent = metaParts.join('  ·  ') || '';

    // Table rows
    el.importBody.innerHTML = '';
    extractedItems.forEach((item, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><input type="checkbox" class="item-check" data-idx="' + idx + '" checked></td>' +
        '<td><input class="import-cell-input" data-idx="' + idx + '" data-field="description" value="' + esc(item.description || '') + '"></td>' +
        '<td><input class="import-cell-input import-cell-sm" data-idx="' + idx + '" data-field="manufacturer" value="' + esc(item.manufacturer || '') + '"></td>' +
        '<td><input class="import-cell-input import-cell-sm" data-idx="' + idx + '" data-field="sku" value="' + esc(item.sku || '') + '"></td>' +
        '<td><input class="import-cell-input import-cell-xs" data-idx="' + idx + '" data-field="quantity" type="number" min="1" value="' + (item.quantity || 1) + '"></td>' +
        '<td><input class="import-cell-input import-cell-sm" data-idx="' + idx + '" data-field="room" value="' + esc(item.room || '') + '"></td>' +
        '<td><input class="import-cell-input" data-idx="' + idx + '" data-field="notes" value="' + esc(item.notes || '') + '"></td>';
      el.importBody.appendChild(tr);
    });

    updateImportCount();

    // Wire inline edits back to extractedItems
    el.importBody.querySelectorAll('.import-cell-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = parseInt(inp.dataset.idx, 10);
        const field = inp.dataset.field;
        if (field === 'quantity') {
          extractedItems[idx][field] = parseInt(inp.value, 10) || 1;
        } else {
          extractedItems[idx][field] = inp.value;
        }
      });
    });

    // Wire checkboxes
    el.importBody.querySelectorAll('.item-check').forEach((cb) => {
      cb.addEventListener('change', updateImportCount);
    });
  }

  function updateImportCount() {
    const checked = el.importBody.querySelectorAll('.item-check:checked').length;
    el.importCount.textContent = checked;
    el.importBtn.disabled = checked === 0;
  }

  el.checkAll.addEventListener('change', () => {
    const val = el.checkAll.checked;
    el.importBody.querySelectorAll('.item-check').forEach((cb) => { cb.checked = val; });
    updateImportCount();
  });

  // ---- Back to step 1 ----
  el.backBtn.addEventListener('click', () => showStep(1));

  // ---- Import to Airtable (Step 3 → 4) ----
  el.importBtn.addEventListener('click', async () => {
    const checked = el.importBody.querySelectorAll('.item-check:checked');
    const items = [];
    checked.forEach((cb) => {
      const idx = parseInt(cb.dataset.idx, 10);
      items.push(extractedItems[idx]);
    });

    if (!items.length) return;
    el.importBtn.disabled = true;
    el.importBtn.textContent = 'Importing...';

    try {
      const result = await api('import-manifest', {
        method: 'POST',
        body: {
          jobId: el.jobSelect.value,
          jobNumber: el.jobNumber.value.trim(),
          dealer: el.dealer.value.trim(),
          items: items,
        },
      });

      el.doneMsg.textContent = (result.created || 0) + ' items added as Pending products for this job.';
      showStep(4);
    } catch (err) {
      showError('Import failed: ' + err.message);
      el.importBtn.disabled = false;
      el.importBtn.textContent = 'Import ' + items.length + ' items to Airtable';
    }
  });

  // ---- Start over ----
  el.anotherBtn.addEventListener('click', () => {
    removeFile();
    extractedItems = [];
    extractedMeta = {};
    el.importBody.innerHTML = '';
    el.importBtn.textContent = 'Import 0 items to Airtable';
    showStep(1);
  });

  // ---- Helpers ----
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

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- Init ----
  loadJobs();
  console.log('KRS Import ready');
})();
