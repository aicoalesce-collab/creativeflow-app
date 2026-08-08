/**
 * ============================================================================
 *  upload.js — Drive uploads with NO per-PC Google sign-in.
 *
 *  The old design made the BROWSER authenticate to Google on every machine:
 *  each PC had to sign in as the studio account, uploads only worked where the
 *  origin had been registered, and the desktop app was the only reliable place.
 *
 *  Instead the SERVER — which is permanently authorised as the account that
 *  owns the sheet — opens a Drive resumable-upload session with its own token
 *  and hands the client just that session URL. The bytes then go straight from
 *  the PC to Google; nothing passes through Apps Script, so there is no size
 *  limit and no execution-time problem. Nobody signs into anything.
 *
 *  The session URL is a short-lived, single-file capability: it can only append
 *  to the one file it was minted for, and only a caller who already passed our
 *  own email+code check can obtain one.
 * ============================================================================
 */

const UPLOAD_ROOT = 'CreativeFlow';

/** Origins allowed to receive a CORS-enabled upload session. The hosted app,
 *  the desktop app and the local dev/preview servers — nothing else. */
function allowedOrigin_(raw) {
  const o = String(raw || '').trim().replace(/\/$/, '');
  if (!o) return '';
  const base = String(cfg_('APP_BASE_URL', '')).trim();
  const ok = [];
  if (base) { try { ok.push(base.split('/').slice(0, 3).join('/')); } catch (e) {} }
  ok.push('http://127.0.0.1:4879', 'http://localhost:4879',   // the desktop app
          'http://127.0.0.1:4173', 'http://localhost:4173',   // preview
          'http://127.0.0.1:5173', 'http://localhost:5173');  // dev
  return ok.indexOf(o) > -1 ? o : '';
}

function driveHeaders_() {
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
}

/** Finds (or creates) CreativeFlow/<YYYY-MM> in the executing account's Drive. */
function uploadFolder_() {
  const month = Utilities.formatDate(new Date(), tzStr_(), 'yyyy-MM');
  const cacheKey = 'updir_' + month;
  try {
    const hit = CacheService.getScriptCache().get(cacheKey);
    if (hit) return hit;
  } catch (e) {}

  const findOrMake = function (name, parent) {
    const it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
    return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  };
  const root = findOrMake(UPLOAD_ROOT, null);
  const dir = findOrMake(month, root);
  const id = dir.getId();
  try { CacheService.getScriptCache().put(cacheKey, id, 21600); } catch (e) {}
  return id;
}

/** May this user attach a deliverable to this task? Mirrors updateTask's rule. */
function canAttach_(user, taskId) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const row = rowById_(master, taskId);
  if (!row) return { err: { ok: false, error: 'NOT_FOUND', message: 'Task ' + taskId + ' was not found.' } };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const mine = String(cur[COL.ASSIGNEE - 1]).trim() === user.name;
  const isReq = String(cur[COL.REQUESTER - 1]).trim() === user.name;
  if (!canManage_(user, team) && !mine && !isReq) {
    return { err: { ok: false, error: 'FORBIDDEN', message: 'Only the assignee, the team head or the requester can attach a file.' } };
  }
  return { row: row, cur: cur };
}

/**
 * { action:'uploadTicket', taskId, name, mimeType, size }
 *   → { ok, uploadUrl, folderId }
 * The client then PUTs the bytes to uploadUrl in chunks.
 */
function apiUploadTicket_(user, req) {
  const taskId = String(req.taskId || '').trim();
  const gate = canAttach_(user, taskId);
  if (gate.err) return gate.err;

  const name = String(req.name || 'upload').trim().slice(0, 240).replace(/[\r\n]/g, ' ');
  const mimeType = String(req.mimeType || 'application/octet-stream').trim();
  const size = Math.max(0, Math.floor(Number(req.size) || 0));
  if (!size) return { ok: false, error: 'VALIDATION', message: 'That file looks empty.' };

  const folderId = uploadFolder_();
  const meta = { name: taskId + ' · ' + name, parents: [folderId], mimeType: mimeType };

  /* CORS: a resumable session only accepts browser requests if the ORIGIN was
     declared when the session was created. Without this the client's PUT is
     blocked with "No 'Access-Control-Allow-Origin' header" — verified in a real
     browser. We echo back only origins we recognise, so this can never be used
     to mint a session for someone else's site. */
  const origin = allowedOrigin_(req.origin);
  const initHeaders = Object.assign(driveHeaders_(), {
    'X-Upload-Content-Type': mimeType,
    'X-Upload-Content-Length': String(size),
  });
  if (origin) initHeaders.Origin = origin;

  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: initHeaders,
    payload: JSON.stringify(meta),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    return { ok: false, error: 'SERVER', message: 'Drive would not start the upload (HTTP ' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200) };
  }
  const headers = res.getAllHeaders();
  const location = headers['Location'] || headers['location'];
  if (!location) return { ok: false, error: 'SERVER', message: 'Drive did not return an upload session.' };

  log_('upload-ticket', taskId, user.email, name + ' (' + Math.round(size / 1048576) + ' MB)', true);
  return { ok: true, uploadUrl: String(location), folderId: folderId, storedAs: meta.name };
}

/**
 * { action:'uploadFinish', taskId, fileId }
 * Shares the file by link, writes the deliverable onto the task (which mints a
 * Version row through the normal path) and returns the updated task.
 */
function apiUploadFinish_(user, req) {
  const taskId = String(req.taskId || '').trim();
  const fileId = String(req.fileId || '').trim();
  if (!fileId) return { ok: false, error: 'VALIDATION', message: 'No file id came back from Drive.' };
  const gate = canAttach_(user, taskId);
  if (gate.err) return gate.err;

  // link-viewable so the review room, guests and the team can all see it
  const perm = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/permissions?supportsAllDrives=true', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: driveHeaders_(),
    payload: JSON.stringify({ role: 'reader', type: 'anyone' }),
    muteHttpExceptions: true,
  });
  const permOk = perm.getResponseCode() === 200;

  const link = 'https://drive.google.com/file/d/' + fileId + '/view';
  const upd = apiUpdate_(user, { id: taskId, patch: { deliverable: link }, fileId: fileId });
  if (!upd.ok) return upd;
  log_('upload-done', taskId, user.email, fileId + (permOk ? '' : ' (sharing failed)'), permOk);
  return {
    ok: true, link: link, task: upd.task, info: upd.info,
    warning: permOk ? '' : 'The file uploaded but could not be made link-viewable — open it in Drive and share it manually.',
  };
}
