/* =====================================================================
   KRS Import Paperwork — upload manufacturer PDF, AI extracts items,
   review + edit, then push to Airtable Products as Pending manifest.

   Actions available after extraction:
   - Save Changes   → logs AI original vs user edits to Extraction Training
   - Room Document  → generates copy-paste text grouped by room
   - Quote          → calls generate-quote, shows pricing table
   - Import         → prompts job number, then pushes to Airtable
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
    supplementDropZone: $('supplementDropZone'),
    supplementFileInput: $('supplementFileInput'),
    supplementList: $('supplementList'),
    extractBtn: $('extractBtn'),
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
    // meta editor
    metaDocType: $('metaDocType'),
    metaOrderNumber: $('metaOrderNumber'),
    metaDealer: $('metaDealer'),
    metaShipDate: $('metaShipDate'),
    metaTotalQty: $('metaTotalQty'),
    // action buttons
    saveChangesBtn: $('saveChangesBtn'),
    roomDocBtn: $('roomDocBtn'),
    quoteBtn: $('quoteBtn'),
    saveBadge: $('saveBadge'),
    // room doc modal
    roomDocModal: $('roomDocModal'),
    roomDocClose: $('roomDocClose'),
    roomDocText: $('roomDocText'),
    roomDocCopy: $('roomDocCopy'),
    // quote modal
    quoteModal: $('quoteModal'),
    quoteClose: $('quoteClose'),
    quoteSpinner: $('quoteSpinner'),
    quoteContent: $('quoteContent'),
    quoteBody: $('quoteBody'),
    quoteFoot: $('quoteFoot'),
    quoteUnmatched: $('quoteUnmatched'),
    quoteUnmatchedList: $('quoteUnmatchedList'),
    quoteCopy: $('quoteCopy'),
    // job number modal
    jobNumModal: $('jobNumModal'),
    jobNumInput: $('jobNumInput'),
    jobNumSkip: $('jobNumSkip'),
    jobNumConfirm: $('jobNumConfirm'),
  };

  let uploadedFile = null;
  let supplementalFiles = [];
  const MAX_FILE_BYTES = 4 * 1024 * 1024;
  const MAX_COMBINED_BYTES = 4.5 * 1024 * 1024; // Netlify request cap after base64 inflation
  let extractedItems = [];
  let extractedMeta = {};
  let aiOriginalSnapshot = null; // frozen copy of what Claude originally returned

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
      el.jobSelect.innerHTML = '<option value="">-- No active jobs --</option>';
      console.warn('Could not load jobs:', err.message);
    }
  }

  // ---- File handling ----
  function handleFile(file) {
    if (!file || file.type !== 'application/pdf') {
      showError('Please upload a PDF file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
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

  // ---- Supplemental files (spec sheets, etc.) ----
  function addSupplementalFiles(files) {
    const added = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f || f.type !== 'application/pdf') {
        showError('Supplements must be PDFs. Skipped: ' + (f && f.name));
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        showError('Supplement too large (max 4 MB): ' + f.name);
        continue;
      }
      supplementalFiles.push(f);
      added.push(f);
    }
    renderSupplementList();
    validateStep1();
    return added.length;
  }

  function removeSupplementalAt(idx) {
    supplementalFiles.splice(idx, 1);
    renderSupplementList();
    validateStep1();
  }

  function renderSupplementList() {
    el.supplementList.innerHTML = '';
    supplementalFiles.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'import-file-info';
      row.innerHTML =
        '<span>' + esc(f.name) + ' (' + (f.size / 1024).toFixed(0) + ' KB)</span>' +
        '<button class="import-remove-btn" data-idx="' + idx + '">&times;</button>';
      row.querySelector('button').addEventListener('click', () => removeSupplementalAt(idx));
      el.supplementList.appendChild(row);
    });
  }

  function combinedFileBytes() {
    let total = uploadedFile ? uploadedFile.size : 0;
    supplementalFiles.forEach((f) => { total += f.size; });
    return total;
  }

  function validateStep1() {
    el.extractBtn.disabled = !uploadedFile;
  }

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  el.removeFileBtn.addEventListener('click', removeFile);
  el.jobSelect.addEventListener('change', validateStep1);

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

  // Supplemental (spec sheets, multi-file) drop zone
  el.supplementDropZone.addEventListener('click', () => el.supplementFileInput.click());
  el.supplementFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) addSupplementalFiles(e.target.files);
    el.supplementFileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((evt) => {
    el.supplementDropZone.addEventListener(evt, (e) => { e.preventDefault(); el.supplementDropZone.classList.add('import-drop-active'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    el.supplementDropZone.addEventListener(evt, (e) => { e.preventDefault(); el.supplementDropZone.classList.remove('import-drop-active'); });
  });
  el.supplementDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length) addSupplementalFiles(e.dataTransfer.files);
  });

  // ---- Generate a simple unique job ID ----
  function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---- Poll get-extraction until done or failed ----
  async function pollExtraction(jobId, maxWaitMs) {
    const start = Date.now();
    const interval = 3000; // poll every 3 seconds
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, interval));
      const status = await api('get-extraction?jobId=' + encodeURIComponent(jobId));
      if (status.status === 'done') return status;
      if (status.status === 'failed') throw new Error(status.error || 'Extraction failed in background');
      // status === 'processing' — keep polling
    }
    throw new Error('Extraction timed out after ' + Math.round(maxWaitMs / 1000) + 's. Try a smaller PDF.');
  }

  // ---- Extract items (Step 1 → 2 → 3) ----
  el.extractBtn.addEventListener('click', async () => {
    if (!uploadedFile) return;
    if (combinedFileBytes() > MAX_COMBINED_BYTES) {
      showError('Combined file size too large. Remove a supplement or use a smaller PDF.');
      return;
    }
    showStep(2);

    try {
      const base64 = await fileToBase64(uploadedFile);
      const supplements = [];
      for (const f of supplementalFiles) {
        supplements.push({ name: f.name, pdfBase64: await fileToBase64(f) });
      }

      // Fire background extraction — returns 202 immediately with no body
      const jobId = generateJobId();
      await api('parse-paperwork-background', {
        method: 'POST',
        body: {
          jobId,
          pdfBase64: base64,
          supplementalPdfs: supplements,
          manufacturer: el.manufacturer.value.trim(),
          dealer: el.dealer.value.trim(),
        },
      });

      // Poll for result (up to 3 minutes)
      const result = await pollExtraction(jobId, 180000);

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

      // Freeze a deep copy of AI's original output for the training log
      aiOriginalSnapshot = {
        items: JSON.parse(JSON.stringify(extractedItems)),
        meta: JSON.parse(JSON.stringify(extractedMeta)),
      };

      populateMetaEditor();
      renderReview();
      showStep(3);
    } catch (err) {
      showError('Extraction failed: ' + err.message);
      showStep(1);
    }
  });

  // ---- Populate editable meta fields ----
  function populateMetaEditor() {
    el.metaDocType.value     = extractedMeta.documentType   || '';
    el.metaOrderNumber.value = extractedMeta.orderNumber    || '';
    el.metaDealer.value      = extractedMeta.dealer         || el.dealer.value.trim() || '';
    el.metaShipDate.value    = extractedMeta.shipDate       || '';
    el.metaTotalQty.value    = extractedMeta.totalItemCount != null ? extractedMeta.totalItemCount : '';
  }

  // Read current meta editor values back into an object
  function readMeta() {
    return {
      documentType:   el.metaDocType.value,
      orderNumber:    el.metaOrderNumber.value.trim(),
      dealer:         el.metaDealer.value.trim(),
      shipDate:       el.metaShipDate.value,
      totalItemCount: el.metaTotalQty.value !== '' ? parseInt(el.metaTotalQty.value, 10) : null,
    };
  }

  // ---- Render review table ----
  function renderReview() {
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

  el.backBtn.addEventListener('click', () => showStep(1));

  // ---- Save Changes → Extraction Training ----
  el.saveChangesBtn.addEventListener('click', async () => {
    el.saveChangesBtn.disabled = true;
    el.saveChangesBtn.textContent = 'Saving...';
    try {
      await api('save-extraction', {
        method: 'POST',
        body: {
          documentName: uploadedFile ? uploadedFile.name : 'Unknown',
          manufacturerHint: el.manufacturer.value.trim(),
          dealerHint: el.dealer.value.trim(),
          jobNumber: el.jobNumber.value.trim(),
          user: '',
          aiOriginal: aiOriginalSnapshot,
          userApproved: {
            items: JSON.parse(JSON.stringify(extractedItems)),
            meta: readMeta(),
          },
        },
      });
      el.saveBadge.classList.remove('hidden');
      setTimeout(() => el.saveBadge.classList.add('hidden'), 3000);
    } catch (err) {
      showError('Could not save training log: ' + err.message);
    } finally {
      el.saveChangesBtn.disabled = false;
      el.saveChangesBtn.textContent = '\uD83D\uDCBE Save Changes';
    }
  });

  // ---- Room Document ----
  el.roomDocBtn.addEventListener('click', () => {
    const meta = readMeta();
    const text = buildRoomDocument(extractedItems, meta);
    el.roomDocText.value = text;
    el.roomDocModal.classList.remove('hidden');
  });

  el.roomDocClose.addEventListener('click', () => el.roomDocModal.classList.add('hidden'));
  el.roomDocModal.addEventListener('click', (e) => {
    if (e.target === el.roomDocModal) el.roomDocModal.classList.add('hidden');
  });

  el.roomDocCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(el.roomDocText.value).then(() => {
      el.roomDocCopy.textContent = '\u2713 Copied!';
      setTimeout(() => { el.roomDocCopy.textContent = 'Copy to Clipboard'; }, 2000);
    });
  });

  function buildRoomDocument(items, meta) {
    const lines = [];
    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    lines.push('KRS MOVING SOLUTIONS');
    lines.push('Delivery / Installation Summary');
    lines.push('Generated: ' + date);
    if (meta.dealer) lines.push('Customer: ' + meta.dealer);
    if (meta.orderNumber) lines.push('Order #: ' + meta.orderNumber);
    if (meta.documentType) lines.push('Document: ' + meta.documentType);
    lines.push('');

    // Group by room
    var rooms = {};
    items.forEach(function (item) {
      var room = (item.room || 'General / Unassigned').trim();
      if (!rooms[room]) rooms[room] = [];
      rooms[room].push(item);
    });

    Object.keys(rooms).sort().forEach(function (room) {
      lines.push('\u2500\u2500 ' + room.toUpperCase() + ' \u2500\u2500');
      rooms[room].forEach(function (item) {
        var qty = item.quantity || 1;
        var sku = item.sku ? ' [' + item.sku + ']' : '';
        var mfr = item.manufacturer ? ' (' + item.manufacturer + ')' : '';
        var notes = item.notes ? ' \u2014 ' + item.notes : '';
        lines.push('  ' + qty + 'x  ' + (item.description || 'Item') + mfr + sku + notes);
      });
      lines.push('');
    });

    var totalQty = items.reduce(function (s, i) { return s + (parseInt(i.quantity, 10) || 1); }, 0);
    lines.push('TOTAL ITEMS: ' + totalQty);

    return lines.join('\n');
  }

  // ---- Generate Quote ----
  el.quoteBtn.addEventListener('click', async () => {
    el.quoteModal.classList.remove('hidden');
    el.quoteSpinner.classList.remove('hidden');
    el.quoteContent.classList.add('hidden');

    try {
      const result = await api('generate-quote', {
        method: 'POST',
        body: {
          items: extractedItems,
          jobNumber: el.jobNumber.value.trim(),
          dealer: readMeta().dealer || el.dealer.value.trim(),
        },
      });
      renderQuote(result);
    } catch (err) {
      el.quoteModal.classList.add('hidden');
      showError('Quote failed: ' + err.message);
    }
  });

  el.quoteClose.addEventListener('click', () => el.quoteModal.classList.add('hidden'));
  el.quoteModal.addEventListener('click', (e) => {
    if (e.target === el.quoteModal) el.quoteModal.classList.add('hidden');
  });

  function renderQuote(result) {
    el.quoteSpinner.classList.add('hidden');
    el.quoteBody.innerHTML = '';
    el.quoteFoot.innerHTML = '';

    result.lines.forEach((line) => {
      const tr = document.createElement('tr');
      if (!line.matched) tr.classList.add('import-quote-unmatched-row');
      tr.innerHTML =
        '<td>' + esc(line.description) + '</td>' +
        '<td>' + esc(line.sku) + '</td>' +
        '<td>' + line.quantity + '</td>' +
        '<td>' + (line.matched ? '$' + line.unitPrice.toFixed(2) : '\u2014') + '</td>' +
        '<td>' + (line.matched ? '$' + line.laborPerUnit.toFixed(2) : '\u2014') + '</td>' +
        '<td>' + (line.matched ? '$' + line.lineTotal.toFixed(2) : '\u2014') + '</td>';
      el.quoteBody.appendChild(tr);
    });

    el.quoteFoot.innerHTML =
      '<tr class="import-quote-subtotal"><td colspan="5">Product Subtotal</td><td>$' + result.subtotalProduct.toFixed(2) + '</td></tr>' +
      '<tr class="import-quote-subtotal"><td colspan="5">Labor Subtotal</td><td>$' + result.subtotalLabor.toFixed(2) + '</td></tr>' +
      '<tr class="import-quote-total"><td colspan="5"><strong>Grand Total</strong></td><td><strong>$' + result.grandTotal.toFixed(2) + '</strong></td></tr>';

    if (result.unmatched && result.unmatched.length) {
      el.quoteUnmatched.classList.remove('hidden');
      el.quoteUnmatchedList.innerHTML = '';
      result.unmatched.forEach((u) => {
        const li = document.createElement('li');
        li.textContent = (u.description || 'Unknown') + (u.sku ? ' [' + u.sku + ']' : '');
        el.quoteUnmatchedList.appendChild(li);
      });
    } else {
      el.quoteUnmatched.classList.add('hidden');
    }

    el.quoteContent.classList.remove('hidden');
  }

  el.quoteCopy.addEventListener('click', () => {
    const lines = ['KRS Moving Solutions \u2014 Pricing Quote'];
    const meta = readMeta();
    if (meta.dealer) lines.push('Customer: ' + meta.dealer);
    if (meta.orderNumber) lines.push('Order #: ' + meta.orderNumber);
    lines.push('');
    lines.push('Description\tSKU\tQty\tUnit $\tLabor\tLine Total');
    el.quoteBody.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      lines.push(Array.from(cells).map((c) => c.textContent.trim()).join('\t'));
    });
    lines.push('');
    el.quoteFoot.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      lines.push(Array.from(cells).map((c) => c.textContent.trim()).join('\t'));
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      el.quoteCopy.textContent = '\u2713 Copied!';
      setTimeout(() => { el.quoteCopy.textContent = 'Copy Quote Text'; }, 2000);
    });
  });

  // ---- Import button → job number prompt ----
  el.importBtn.addEventListener('click', () => {
    el.jobNumInput.value = el.jobNumber.value.trim();
    el.jobNumModal.classList.remove('hidden');
    el.jobNumInput.focus();
  });

  el.jobNumSkip.addEventListener('click', () => {
    el.jobNumModal.classList.add('hidden');
    doImport(el.jobNumber.value.trim());
  });

  el.jobNumConfirm.addEventListener('click', () => {
    el.jobNumModal.classList.add('hidden');
    doImport(el.jobNumInput.value.trim());
  });

  el.jobNumInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      el.jobNumModal.classList.add('hidden');
      doImport(el.jobNumInput.value.trim());
    }
  });

  async function doImport(jobNumber) {
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
          jobNumber: jobNumber,
          dealer: readMeta().dealer || el.dealer.value.trim(),
          items: items,
        },
      });

      el.doneMsg.textContent = (result.created || 0) + ' items added as Pending products for this job.';
      showStep(4);
    } catch (err) {
      showError('Import failed: ' + err.message);
      el.importBtn.disabled = false;
      el.importBtn.textContent = 'Import ' + items.length + ' items';
    }
  }

  // ---- Start over ----
  el.anotherBtn.addEventListener('click', () => {
    removeFile();
    supplementalFiles = [];
    renderSupplementList();
    extractedItems = [];
    extractedMeta = {};
    aiOriginalSnapshot = null;
    el.importBody.innerHTML = '';
    el.importBtn.textContent = 'Import 0 items';
    el.saveBadge.classList.add('hidden');
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
