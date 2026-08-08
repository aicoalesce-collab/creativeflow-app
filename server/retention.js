/**
 * ============================================================================
 *  retention.js — reclaim Drive storage on a schedule.
 *
 *  DRIVE_EXPIRY_DAYS (45) : move the uploaded file to Drive Trash
 *  DRIVE_PURGE_DAYS  (60) : delete it permanently — this is when the storage
 *                           actually comes back, because trashed files still
 *                           count against the quota until they are purged.
 *  Either set to 0 disables that stage.
 *
 *  Two hard safeguards:
 *   1. A file is NEVER touched while its task is still open. Only tasks that
 *      are Done / Rejected (or gone to Archive) can expire, however old.
 *   2. Nothing disappears silently: the Versions row is stamped, and the task's
 *      Notes gain one line, so a dead link is explained rather than mysterious.
 * ============================================================================
 */

const RETENTION_BATCH = 60; // files per run — well inside the 6-minute ceiling

function retentionSweep() {
  try { retentionSweepBody_(); }
  catch (e) { log_('retention', '', '', String(e), false); }
  flushMailQueue_();
  flushPushQueue_();
}

/** Closed = safe to expire. Unknown/missing task = closed (it was archived). */
function taskIsOpen_(statusById, taskId) {
  const st = statusById[taskId];
  if (!st) return false;
  return ['Done', 'Rejected'].indexOf(st) === -1;
}

function retentionSweepBody_() {
  const expiryDays = Number(cfg_('DRIVE_EXPIRY_DAYS', 0)) || 0;
  const purgeDays = Number(cfg_('DRIVE_PURGE_DAYS', 0)) || 0;
  if (!expiryDays && !purgeDays) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vs = versionsSheet_();
  if (vs.getLastRow() < 2) return;

  // current status of every live task, so open work is never touched
  const statusById = {};
  const master = ss.getSheetByName(SHEETS.MASTER);
  if (master.getLastRow() > 1) {
    master.getRange(2, 1, master.getLastRow() - 1, COL.STATUS).getValues().forEach(function (r) {
      if (r[COL.ID - 1]) statusById[String(r[COL.ID - 1]).trim()] = String(r[COL.STATUS - 1]).trim();
    });
  }

  const rows = vs.getRange(2, 1, vs.getLastRow() - 1, 7).getValues();
  const now = Date.now();
  let trashed = 0, purged = 0, skippedOpen = 0, done = 0;

  for (let i = 0; i < rows.length && done < RETENTION_BATCH; i++) {
    const r = rows[i];
    const taskId = String(r[0]).trim();
    const fileId = String(r[5] || '').trim();
    const at = r[4];
    const note = String(r[6] || '');           // the Expires column doubles as our state stamp
    if (!fileId || !(at instanceof Date)) continue;
    if (note.indexOf('purged') === 0) continue; // already fully handled

    const ageDays = (now - at.getTime()) / 86400000;
    if (expiryDays && ageDays < expiryDays) continue;

    if (taskIsOpen_(statusById, taskId)) { skippedOpen++; continue; }

    try {
      const file = DriveApp.getFileById(fileId);
      if (purgeDays && ageDays >= purgeDays) {
        // permanent delete via the Drive REST API using the script's own token
        // (avoids requiring the "Advanced Drive Service" toggle in the editor)
        const resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), {
          method: 'delete',
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          muteHttpExceptions: true,
        });
        const code = resp.getResponseCode();
        if (code !== 204 && code !== 404) throw new Error('Drive delete HTTP ' + code + ' ' + resp.getContentText().slice(0, 80));
        vs.getRange(i + 2, 7).setValue('purged ' + Utilities.formatDate(new Date(), tzStr_(), 'dd MMM yyyy'));
        stampTaskRetention_(master, taskId, 'file permanently removed after ' + purgeDays + ' days (retention policy)');
        purged++; done++;
      } else if (expiryDays && ageDays >= expiryDays && !file.isTrashed()) {
        file.setTrashed(true);                 // recoverable until the purge date
        vs.getRange(i + 2, 7).setValue('trashed ' + Utilities.formatDate(new Date(), tzStr_(), 'dd MMM yyyy'));
        stampTaskRetention_(master, taskId, 'file moved to Drive Trash after ' + expiryDays + ' days — recoverable until day ' + (purgeDays || '∞'));
        trashed++; done++;
      }
    } catch (e) {
      // already deleted by hand, or no access — record it and move on
      vs.getRange(i + 2, 7).setValue('gone ' + Utilities.formatDate(new Date(), tzStr_(), 'dd MMM yyyy'));
      log_('retention', taskId, '', 'file ' + fileId + ': ' + String(e).slice(0, 90), false);
      done++;
    }
  }

  if (trashed || purged || skippedOpen) {
    log_('retention', '', '', trashed + ' trashed, ' + purged + ' purged, ' + skippedOpen + ' skipped (task still open)', true);
  }
}

/** One explanatory line on the task, so a dead link is never a mystery. */
function stampTaskRetention_(master, taskId, msg) {
  try {
    const row = rowById_(master, taskId);
    if (!row) return;
    const cell = master.getRange(row, COL.NOTES);
    const cur = String(cell.getValue() || '');
    const line = '🗄 ' + msg;
    if (cur.indexOf(line) === -1) cell.setValue((line + (cur ? '\n' + cur : '')).slice(0, 4000));
  } catch (e) {}
}

/** Files due to expire in the next 7 days — surfaced in the Monday health note. */
function retentionForecast_() {
  const expiryDays = Number(cfg_('DRIVE_EXPIRY_DAYS', 0)) || 0;
  if (!expiryDays) return null;
  const vs = versionsSheet_();
  if (vs.getLastRow() < 2) return null;
  const rows = vs.getRange(2, 1, vs.getLastRow() - 1, 7).getValues();
  const now = Date.now();
  let soon = 0;
  rows.forEach(function (r) {
    if (!String(r[5] || '').trim() || !(r[4] instanceof Date)) return;
    if (String(r[6] || '').indexOf('purged') === 0) return;
    const ageDays = (now - r[4].getTime()) / 86400000;
    if (ageDays >= expiryDays - 7 && ageDays < expiryDays) soon++;
  });
  return soon;
}
