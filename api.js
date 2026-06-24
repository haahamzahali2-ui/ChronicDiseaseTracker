/* ═══════════════════════════════════════════════════════════════
   HELPING HANDS — api.js
   Google Apps Script ↔ Frontend bridge
   ───────────────────────────────────────────────────────────────
   HOW TO USE:
     1. Complete SETUP.md to get your Apps Script Web App URL
     2. Paste it as APPS_SCRIPT_URL below
     3. Add <script src="api.js"></script> before your closing </body>
        (must come BEFORE your inline <script> block in index.html)
     4. In index.html, replace the `let docs = [...]` dummy array
        with a call to API.loadDocuments() — see WIRING GUIDE below
   ═══════════════════════════════════════════════════════════════ */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxXQhn3QR1DtBrADUeDMQ2PqHAKRgc2kOCiRgMx_7-K2XAs9ZlnexFi2Ss_YEWVUCTZPg/exec';  // ← paste your Web App URL here
                              // e.g. 'https://script.google.com/macros/s/AKfycb.../exec'

/* ═══════════════════════════════════════════════════════════════
   INTERNAL HELPERS
   ═══════════════════════════════════════════════════════════════ */

/**
 * POST a JSON payload to the Apps Script web app.
 * Apps Script requires CORS requests go through no-cors mode,
 * so we use a form-encoded POST which doesn't trigger a preflight.
 */
async function _post(payload) {
  if (!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set in api.js');

  const form = new FormData();
  form.append('payload', JSON.stringify(payload));

  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: form,
  });

  const text = await res.text();

  // Apps Script sometimes wraps JSON in /*O_o*/ ... safety strip
  const clean = text.replace(/^\/\*-secure-[\w-]+\*\//, '').trim();

  let data;
  try {
    data = JSON.parse(clean);
  } catch {
    throw new Error('Invalid response from server: ' + clean.slice(0, 120));
  }

  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * GET request — used for listing documents and fetching upload tokens.
 */
async function _get(params = {}) {
  if (!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set in api.js');

  const url = new URL(APPS_SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res  = await fetch(url.toString());
  const text = await res.text();
  const clean = text.replace(/^\/\*-secure-[\w-]+\*\//, '').trim();

  let data;
  try {
    data = JSON.parse(clean);
  } catch {
    throw new Error('Invalid response from server: ' + clean.slice(0, 120));
  }

  if (data.error) throw new Error(data.error);
  return data;
}

/* ═══════════════════════════════════════════════════════════════
   UPLOAD — sends file directly to Google Drive
   Uses a short-lived OAuth token fetched from Apps Script so
   the service-account credentials never touch the browser.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Upload a File object to the clinic's Google Drive folder.
 * Returns the Drive file ID and a shareable view link.
 *
 * @param {File}     file       — the File object from <input type="file">
 * @param {Function} onProgress — optional callback(percent: 0–100)
 * @returns {{ fileId: string, viewLink: string }}
 */
async function _uploadToDrive(file, onProgress) {
  // 1. Get a short-lived OAuth token from Apps Script
  const { token, folderId } = await _get({ action: 'token' });

  // 2. Initiate a resumable upload session
  const initRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        parents: [folderId],
      }),
    }
  );

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error('Drive upload init failed: ' + err.slice(0, 120));
  }

  const uploadUrl = initRes.headers.get('Location');

  // 3. Upload the file bytes with progress tracking
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    if (onProgress) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('Upload failed: ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });

  // 4. Get the file ID from Drive (Apps Script returns it after creating)
  //    We re-use the token request but now ask Apps Script to find the file by name
  const { fileId, viewLink } = await _get({ action: 'findFile', name: file.name });
  return { fileId, viewLink };
}

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API  —  import these functions into index.html
   ═══════════════════════════════════════════════════════════════ */

const API = {

  /**
   * Load all documents from Google Sheets.
   * Returns an array of document objects matching the shape used
   * by index.html's `docs` array.
   *
   * @returns {Promise<Array>}
   *
   * WIRE IN: replace `let docs = [...]` in index.html with:
   *   let docs = [];
   *   API.loadDocuments().then(result => {
   *     docs = result;
   *     renderDocs();
   *     updateStats();
   *     updateCounts();
   *   }).catch(err => showToast(err.message, 'error'));
   */
  async loadDocuments() {
    const rows = await _get({ action: 'list' });
    // rows is an array of objects matching Sheet columns:
    // { id, name, type, labels, desc, date, starred, driveFileId, url }
    return rows.map(r => ({
      id:          r.id,
      name:        r.name        || '',
      type:        r.type        || 'gen',
      labels:      r.labels      ? r.labels.split(',').map(l => l.trim()).filter(Boolean) : [],
      desc:        r.desc        || '',
      date:        r.date        || new Date().toISOString().split('T')[0],
      starred:     r.starred     === 'TRUE' || r.starred === true,
      driveFileId: r.driveFileId || '',
      url:         r.url         || '#',
    }));
  },

  /**
   * Add a new document: uploads the file to Drive, then records
   * metadata in Google Sheets.
   *
   * @param {{
   *   name:    string,
   *   desc:    string,
   *   labels:  string[],
   *   file:    File|null,     — null when adding a link
   *   linkUrl: string|null,   — null when uploading a file
   * }} docData
   * @param {Function} onProgress — optional upload progress callback(percent)
   * @returns {Promise<Object>} — the saved document object
   *
   * WIRE IN: in submitDocument() replace the `docs.unshift(newDoc)` block with:
   *   API.addDocument({ name, desc, labels: selectedLabels, file: pendingFiles[0] ?? null, linkUrl: isLinkPane ? linkUrl : null }, pct => { ... })
   *     .then(saved => { docs.unshift(saved); closeModal('modal-upload'); renderDocs(); updateStats(); showToast(`"${saved.name}" added.`, 'success'); })
   *     .catch(err => showToast(err.message, 'error'));
   */
  async addDocument({ name, desc, labels, file, linkUrl }, onProgress) {
    let driveFileId = '';
    let url = linkUrl || '#';
    let type = 'link';

    if (file) {
      // Determine file type
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'pdf')                         type = 'pdf';
      else if (['doc','docx'].includes(ext))     type = 'docx';
      else if (['xls','xlsx'].includes(ext))     type = 'xlsx';
      else if (['png','jpg','jpeg'].includes(ext)) type = 'img';
      else                                        type = 'gen';

      // Upload to Drive
      const { fileId, viewLink } = await _uploadToDrive(file, onProgress);
      driveFileId = fileId;
      url = viewLink;
    }

    // Save metadata to Sheet via Apps Script
    const result = await _post({
      action: 'add',
      name,
      type,
      labels: labels.join(','),
      desc,
      driveFileId,
      url,
    });

    // Return in the shape index.html expects
    return {
      id:          result.doc.id,
      name:        result.doc.name,
      type,
      labels,
      desc:        result.doc.desc,
      date:        result.doc.date,
      starred:     false,
      driveFileId,
      url,
    };
  },

  /**
   * Edit an existing document's metadata in Google Sheets.
   * Does NOT re-upload the file — file swapping is a future feature.
   *
   * @param {{
   *   id:      string|number,
   *   name:    string,
   *   desc:    string,
   *   labels:  string[],
   *   starred: boolean,
   * }} docData
   * @returns {Promise<void>}
   *
   * WIRE IN: in saveEdit() replace the direct mutation block with:
   *   API.editDocument({ id: state.pendingEditId, name, desc, labels: editSelectedLabels, starred })
   *     .then(() => { /* update local docs array, re-render *\/ })
   *     .catch(err => showToast(err.message, 'error'));
   */
  async editDocument({ id, name, desc, labels, starred }) {
    await _post({
      action:  'edit',
      id:      String(id),
      name,
      desc,
      labels:  labels.join(','),
      starred: starred ? 'TRUE' : 'FALSE',
    });
  },

  /**
   * Delete a document: removes its row from Google Sheets and
   * optionally trashes the Drive file.
   *
   * @param {string|number} id          — document id
   * @param {string}        driveFileId — Drive file id (pass '' to skip Drive deletion)
   * @returns {Promise<void>}
   *
   * WIRE IN: in confirmDelete() replace `docs = docs.filter(...)` with:
   *   const doc = docs.find(d => d.id == state.pendingDeleteId);
   *   API.deleteDocument(doc.id, doc.driveFileId)
   *     .then(() => { docs = docs.filter(d => d.id != state.pendingDeleteId); renderDocs(); updateStats(); showToast(`"${doc.name}" deleted.`, 'info'); })
   *     .catch(err => showToast(err.message, 'error'));
   */
  async deleteDocument(id, driveFileId = '') {
    await _post({
      action:      'delete',
      id:          String(id),
      driveFileId: driveFileId || '',
    });
  },

  /**
   * Check whether the API is configured and reachable.
   * Useful to show a setup banner if APPS_SCRIPT_URL is empty.
   *
   * @returns {{ configured: boolean, reachable: boolean, error: string|null }}
   *
   * WIRE IN: in your DOMContentLoaded handler:
   *   API.healthCheck().then(({ configured, reachable, error }) => {
   *     if (!configured) showSetupBanner();
   *     else if (!reachable) showToast('Cannot reach server: ' + error, 'error');
   *     else API.loadDocuments().then(...);
   *   });
   */
  async healthCheck() {
    if (!APPS_SCRIPT_URL) {
      return { configured: false, reachable: false, error: 'APPS_SCRIPT_URL not set' };
    }
    try {
      await _get({ action: 'ping' });
      return { configured: true, reachable: true, error: null };
    } catch (e) {
      return { configured: true, reachable: false, error: e.message };
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   WIRING GUIDE — what to change in index.html
   ───────────────────────────────────────────────────────────────

   1. ADD THIS SCRIPT TAG just before your closing </body>:
      <script src="api.js"></script>

   2. IN YOUR DOMContentLoaded, replace the current init:

      BEFORE:
        document.addEventListener('DOMContentLoaded', () => {
          buildSidebarLabels();
          renderDocs();
          updateStats();
        });

      AFTER:
        document.addEventListener('DOMContentLoaded', async () => {
          buildSidebarLabels();

          const { configured, reachable, error } = await API.healthCheck();
          if (!configured) {
            // Show a setup notice — APPS_SCRIPT_URL is blank
            showToast('API not configured. See api.js to set your URL.', 'error');
            renderDocs(); // still renders with empty docs
            return;
          }
          if (!reachable) {
            showToast('Cannot reach server: ' + error, 'error');
            return;
          }

          try {
            docs = await API.loadDocuments();
          } catch (e) {
            showToast('Failed to load documents: ' + e.message, 'error');
          }

          renderDocs();
          updateStats();
          updateCounts();
        });

   3. IN submitDocument(), replace `docs.unshift(newDoc)` with:

        const btn = document.querySelector('#modal-upload .btn-primary');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const saved = await API.addDocument({
            name,
            desc,
            labels: [...selectedLabels],
            file:    pendingFiles[0] ?? null,
            linkUrl: isLinkPane ? (linkUrl || '') : null,
          }, pct => {
            btn.textContent = `Uploading… ${pct}%`;
          });
          docs.unshift(saved);
          closeModal('modal-upload');
          resetUploadForm();
          renderDocs();
          updateStats();
          showToast(`"${saved.name}" added successfully.`, 'success');
        } catch (e) {
          showToast(e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Save Document';
        }

   4. IN saveEdit(), replace the direct mutation block with:

        try {
          await API.editDocument({
            id:      state.pendingEditId,
            name:    document.getElementById('edit-name-input').value.trim(),
            desc:    document.getElementById('edit-desc-input').value.trim(),
            labels:  [...editSelectedLabels],
            starred: document.getElementById('edit-starred').checked,
          });
          // Update local copy
          const idx = docs.findIndex(d => d.id == state.pendingEditId);
          if (idx !== -1) {
            docs[idx].name    = document.getElementById('edit-name-input').value.trim() || docs[idx].name;
            docs[idx].desc    = document.getElementById('edit-desc-input').value.trim();
            docs[idx].labels  = [...editSelectedLabels];
            docs[idx].starred = document.getElementById('edit-starred').checked;
          }
          closeModal('modal-edit');
          renderDocs();
          showToast('Document updated.', 'success');
          state.pendingEditId = null;
        } catch (e) {
          showToast(e.message, 'error');
        }

   5. IN confirmDelete(), replace `docs = docs.filter(...)` with:

        const doc = docs.find(d => d.id == state.pendingDeleteId);
        if (!doc) return;
        try {
          await API.deleteDocument(doc.id, doc.driveFileId);
          docs = docs.filter(d => d.id != state.pendingDeleteId);
          closeModal('modal-delete');
          renderDocs();
          updateStats();
          showToast(`"${doc.name}" deleted.`, 'info');
          state.pendingDeleteId = null;
        } catch (e) {
          showToast(e.message, 'error');
        }

   ═══════════════════════════════════════════════════════════════ */
