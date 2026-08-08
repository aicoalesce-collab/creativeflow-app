/**
 * admin.js — Super-Admin-only op dispatch over the normal /exec POST channel.
 * Replaces `clasp run` (needs a GCP project) and editor-only maintenance.
 *   { action:'admin', email, code, op:'…', ...opArgs }
 * Every op is logged to the Alerts Log.
 */

function apiAdmin_(user, req) {
  if (user.role !== 'Super Admin') return { ok: false, error: 'FORBIDDEN', message: 'Admin ops are Super Admin only.' };
  const op = String(req.op || '');
  log_('admin-op', '', user.email, op, true);
  switch (op) {
    case 'setup':           return { ok: true, result: setup() };
    case 'installTriggers': installTriggers_(); return { ok: true, result: 'triggers reinstalled' };
    case 'applyProtections': applyProtections(); return { ok: true, result: 'protections applied' };
    case 'rebuildMirrors':  buildTeamTabs_(SpreadsheetApp.getActiveSpreadsheet()); rebuildMemberTabs(); buildDashboard_(SpreadsheetApp.getActiveSpreadsheet()); return { ok: true, result: 'mirrors rebuilt' };
    case 'syncForm':        syncFormAssignees(); return { ok: true, result: 'form assignee list synced' };
    case 'generateCodes':   return { ok: true, result: generateAccessCodes() + ' new codes minted (existing codes untouched)' };
    case 'renameMember':    return adminRenameMember_(user, req);
    case 'sendTestAlert':   sendTestAlert(); return { ok: true, result: 'test alert queued' };
    case 'archiveNow':      archiveDone(); return { ok: true, result: 'archive pass done' };
    case 'sweepNow':        sweep(); return { ok: true, result: 'sweep done' };
    case 'reviewSweepNow':  reviewSweep(); return { ok: true, result: 'review sweep done' };
    case 'digestNow':       dailyDigestNow(); return { ok: true, result: 'digest pass done' };
    case 'backupNow':       return { ok: true, result: weeklyBackupBody_() };
    case 'report':          return adminReport_();
    case 'setConfig':       return adminSetConfig_(req);
    // migration (migrate.js)
    case 'migratePreflight': return migratePreflight_(req);
    case 'migrateStep':     return migrateStep_(req);
    case 'migrateReport':   return migrateReport_(req);
    case 'wipeImport':      return wipeImport_(req);
    case 'checkOldActivity': return checkOldSheetActivity_(req);
    case 'newSinceCutover': return newSinceCutover_();
    // assigner external sheets (extsync.js)
    case 'createAssignerSheet': return adminCreateAssignerSheet_(req);
    case 'registerCalendarSheet': return adminRegisterCalendarSheet_(req);
    case 'listSyncedSheets': return { ok: true, sheets: syncRegistry_() };
    case 'setSyncedSheet':  return adminSetSyncedSheet_(req);
    case 'syncNow':         return { ok: true, result: extSyncBody_(true) };
    default:                return { ok: false, error: 'UNKNOWN_ACTION', message: 'admin op: ' + op };
  }
}

/** Health/state snapshot — the post-deploy smoke check reads this. */
function adminReport_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = {};
  ss.getSheets().forEach(sh => { tabs[sh.getName()] = sh.getLastRow() - 1; });
  let tzOk = true, tzMsg = '';
  try { assertTz_(); } catch (e) { tzOk = false; tzMsg = String(e); }
  return {
    ok: true,
    apiVersion: API_VERSION,
    appVersion: latestAppVersion_(),
    schemaV: String(cfg_('SCHEMA_V', '')),
    emailMute: String(cfg_('EMAIL_MUTE', 'NO')).toUpperCase().indexOf('Y') === 0,
    mailQuotaLeft: (function () { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return -1; } })(),
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()),
    tabs: tabs,
    tzOk: tzOk, tzMsg: tzMsg,
    scriptTz: Session.getScriptTimeZone(),
    sheetUrl: ss.getUrl(),
    migratedAt: String(cfg_('MIGRATED_AT', '')),
    serverTime: new Date().toISOString(),
  };
}

/** Guarded Config writer for remote ops (deploy pipeline flips EMAIL_MUTE etc.). */
function adminSetConfig_(req) {
  const key = String(req.key || '').trim();
  const val = req.value;
  const ALLOWED = ['EMAIL_MUTE', 'APP_BASE_URL', 'ORG_NAME', 'DIGEST_HOUR', 'STORAGE_ACCOUNT', 'GOOGLE_CLIENT_ID', 'GOOGLE_API_KEY',
    'DUE_SOON_HOURS', 'OVERDUE_REPEAT_HOURS', 'CC_HEAD_FROM_ALERT_N', 'AUTO_URGENT_ON_OVERDUE', 'EMAIL_ON_ASSIGNMENT',
    'NOTIFY_REQUESTER_ON_DONE', 'DAILY_DIGEST', 'ARCHIVE_AFTER_DAYS', 'MAX_ROUNDS', 'REVIEW_WINDOW_DAYS',
    'SLOT_EVE', 'SLOT_NOON', 'CREATE_CUTOFF', 'WEEKLY_OFF', 'EXTRA_WORK_DATES', 'HOLIDAY_DATES', 'UPLOAD_MODE', 'DRIVE_EXPIRY_DAYS'];
  if (ALLOWED.indexOf(key) === -1) return { ok: false, error: 'VALIDATION', message: 'Config key not settable remotely: ' + key };
  cfgSet_(key, val);
  return { ok: true, key: key, value: String(val) };
}

/** Atomically renames a person across every name-keyed column, then rebuilds
 *  the mirrors. Closes the "rename orphans all their tasks" hazard. */
function adminRenameMember_(user, req) {
  const from = String(req.from || '').trim();
  const to = String(req.to || '').trim();
  if (!from || !to || from === to) return { ok: false, error: 'VALIDATION', message: 'Need distinct from + to names.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let changed = 0;

  function swapCol_(sheetName, col) {
    const sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return;
    const rng = sh.getRange(2, col, sh.getLastRow() - 1, 1);
    const vals = rng.getValues();
    let dirty = false;
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === from) { vals[i][0] = to; changed++; dirty = true; }
    }
    if (dirty) rng.setValues(vals);
  }

  swapCol_(SHEETS.ROSTER, 1);
  swapCol_(SHEETS.MASTER, COL.REQUESTER); swapCol_(SHEETS.MASTER, COL.ASSIGNEE);
  swapCol_(SHEETS.ARCHIVE, COL.REQUESTER); swapCol_(SHEETS.ARCHIVE, COL.ASSIGNEE);
  swapCol_(SHEETS.REVIEWS, 7); swapCol_(SHEETS.REVIEWS, 12);
  swapCol_(SHEETS.SHARES, 4);
  swapCol_(SHEETS.CYCLES, 4);
  swapCol_(SHEETS.VERSIONS, 4);

  rebuildMemberTabs();
  syncFormAssignees();
  log_('rename', '', user.email, from + ' -> ' + to + ' (' + changed + ' cells)', true);
  return { ok: true, renamed: changed + ' cells', from: from, to: to };
}
