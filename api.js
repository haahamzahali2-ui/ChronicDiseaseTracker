/* ═══════════════════════════════════════════════════════════════
   HELPING HANDS — api.js
   Google Apps Script ↔ Frontend bridge
   ═══════════════════════════════════════════════════════════════ */

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxXQhn3QR1DtBrADUeDMQ2PqHAKRgc2kOCiRgMx_7-K2XAs9ZlnexFi2Ss_YEWVUCTZPg/exec';

async function _post(payload) {
  if (!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set in api.js');
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  const res  = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: form });
  const text = await res.text();
  const clean = text.replace(/^\/\*-secure-[\w-]+\*\//, '').trim();
  let data;
  try { data = JSON.parse(clean); } catch { throw new Error('Invalid response: ' + clean.slice(0, 120)); }
  if (data.error) throw new Error(data.error);
  return data;
}

async function _get(params = {}) {
  if (!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set in api.js');
  const url = new URL(APPS_SCRIPT_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res  = await fetch(url.toString());
  const text = await res.text();
  const clean = text.replace(/^\/\*-secure-[\w-]+\*\//, '').trim();
  let data;
  try { data = JSON.parse(clean); } catch { throw new Error('Invalid response: ' + clean.slice(0, 120)); }
  if (data.error) throw new Error(data.error);
  return data;
}

async function _uploadToDrive(file, onProgress) {
  const { token, folderId } = await _get({ action: 'token' });

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

  if (!initRes.ok) throw new Error('Drive upload init failed: ' + (await initRes.text()).slice(0, 120));
  const uploadUrl = initRes.headers.get('Location');

  // Upload bytes and capture the response JSON
  const uploadResult = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error('Upload failed: ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });

  // File ID comes straight from Drive's response — no findFile call needed
  const fileId = uploadResult.id;

  return {
    fileId,
    viewLink: `https://drive.google.com/file/d/${fileId}/view`,
  };
}
const API = {
  async loadDocuments() {
    const rows = await _get({ action: 'list' });
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

  async addDocument({ name, desc, labels, file, linkUrl }, onProgress) {
    let driveFileId = '';
    let url  = linkUrl || '#';
    let type = 'link';

    if (file) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'pdf')                           type = 'pdf';
      else if (['doc','docx'].includes(ext))       type = 'docx';
      else if (['xls','xlsx'].includes(ext))       type = 'xlsx';
      else if (['png','jpg','jpeg'].includes(ext)) type = 'img';
      else                                         type = 'gen';

      const { fileId, viewLink } = await _uploadToDrive(file, onProgress);
      driveFileId = fileId;
      url = viewLink;
    }

    const result = await _post({ action: 'add', name, type, labels: labels.join(','), desc, driveFileId, url });
    return { id: result.doc.id, name: result.doc.name, type, labels, desc: result.doc.desc, date: result.doc.date, starred: false, driveFileId, url };
  },

  async editDocument({ id, name, desc, labels, starred }) {
    await _post({ action: 'edit', id: String(id), name, desc, labels: labels.join(','), starred: starred ? 'TRUE' : 'FALSE' });
  },

  async deleteDocument(id, driveFileId = '') {
    await _post({ action: 'delete', id: String(id), driveFileId: driveFileId || '' });
  },

  async healthCheck() {
    if (!APPS_SCRIPT_URL) return { configured: false, reachable: false, error: 'APPS_SCRIPT_URL not set' };
    try {
      await _get({ action: 'ping' });
      return { configured: true, reachable: true, error: null };
    } catch (e) {
      return { configured: true, reachable: false, error: e.message };
    }
  },
};
