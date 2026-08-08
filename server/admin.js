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
    case 'installTriggers': installTriggers_(); return { ok: true, result: 'triggers reinstalled for ' + Session.getEffectiveUser().getEmail() };
    /* Triggers belong to the USER who created them, not the project. When the
       web app's executing account changes, the old account's triggers keep
       firing invisibly — every scheduled job would run twice. This op lets the
       OLD account (reachable through the deployment it still owns) clear its
       own set without creating new ones. */
    case 'deleteMyTriggers': {
      const mine = ScriptApp.getProjectTriggers();
      mine.forEach(function (t) { ScriptApp.deleteTrigger(t); });
      log_('triggers', '', user.email, 'deleted ' + mine.length + ' triggers owned by ' + Session.getEffectiveUser().getEmail(), true);
      return { ok: true, deleted: mine.length, owner: Session.getEffectiveUser().getEmail() };
    }
    case 'whoRuns': return { ok: true, runsAs: Session.getEffectiveUser().getEmail(), triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
    case 'applyProtections': applyProtections(); return { ok: true, result: 'protections applied' };
    case 'rebuildMirrors':  buildTeamTabs_(SpreadsheetApp.getActiveSpreadsheet()); rebuildMemberTabs(); buildDashboard_(SpreadsheetApp.getActiveSpreadsheet()); return { ok: true, result: 'mirrors rebuilt' };
    case 'syncForm':        syncFormAssignees(); return { ok: true, result: 'form assignee list synced' };
    case 'generateCodes':   return { ok: true, result: generateAccessCodes() + ' new codes minted (existing codes untouched)' };
    case 'renameMember':    return adminRenameMember_(user, req);
    case 'rosterList':      return { ok: true, roster: rosterWithCodes_() };
    case 'rosterUpsert':    return adminRosterUpsert_(user, req);
    case 'rosterRemove':    return adminRosterRemove_(user, req);
    case 'sendTestAlert':   sendTestAlert(); return { ok: true, result: 'test alert queued' };
    /* Push: the crypto for these is hand-written (Apps Script has no ECDSA,
       ECDH or AES), so it is verified against published RFC/NIST vectors on the
       real runtime before anyone relies on it. */
    case 'pushSelfTest':    return { ok: true, result: pushSelfTest_() };
    case 'pushKeys':        return { ok: true, result: vapidEnsureKeys_(req.force === 'ROTATE-AND-BREAK-EVERY-DEVICE') };
    case 'pushList':        return { ok: true, subs: pushListForAdmin_() };
    case 'pushTest':        return { ok: true, result: pushTestSend_(user, req) };
    /* Called by tools/deploy.ps1 after the prod smoke passes, so nobody sits on
       a stale build without knowing a new one exists. */
    case 'pushAppUpdate':   return { ok: true, result: pushAppUpdate_(String(req.version || '').trim() || latestAppVersion_()) };
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
    sheetOwner: (function () { try { return ss.getOwner().getEmail(); } catch (e) { return '(unavailable)'; } })(),
    runsAs: (function () { try { return Session.getEffectiveUser().getEmail(); } catch (e) { return '(unavailable)'; } })(),
    sheetUrl: ss.getUrl(),
    migratedAt: String(cfg_('MIGRATED_AT', '')),
    serverTime: new Date().toISOString(),
  };
}

/** Guarded Config writer for remote ops (deploy pipeline flips EMAIL_MUTE etc.). */
function adminSetConfig_(req) {
  const key = String(req.key || '').trim();
  const val = req.value;
  const ALLOWED = ['EMAIL_MUTE', 'EMAIL_LEVEL', 'APP_BASE_URL', 'DRIVE_EXPIRY_DAYS', 'DRIVE_PURGE_DAYS', 'ORG_NAME', 'DIGEST_HOUR', 'STORAGE_ACCOUNT', 'GOOGLE_CLIENT_ID', 'GOOGLE_API_KEY',
    'DUE_SOON_HOURS', 'OVERDUE_REPEAT_HOURS', 'CC_HEAD_FROM_ALERT_N', 'AUTO_URGENT_ON_OVERDUE', 'EMAIL_ON_ASSIGNMENT',
    'NOTIFY_REQUESTER_ON_DONE', 'DAILY_DIGEST', 'ARCHIVE_AFTER_DAYS', 'MAX_ROUNDS', 'REVIEW_WINDOW_DAYS',
    'SLOT_EVE', 'SLOT_NOON', 'CREATE_CUTOFF', 'WEEKLY_OFF', 'EXTRA_WORK_DATES', 'HOLIDAY_DATES', 'UPLOAD_MODE', 'DRIVE_EXPIRY_DAYS',
    'PUSH_LEVEL', 'PUSH_MUTE', 'PUSH_CONTACT'];
  if (ALLOWED.indexOf(key) === -1) return { ok: false, error: 'VALIDATION', message: 'Config key not settable remotely: ' + key };
  if (key === 'EMAIL_LEVEL' && ['all', 'balanced', 'minimal'].indexOf(String(val).toLowerCase()) === -1) {
    return { ok: false, error: 'VALIDATION', message: 'EMAIL_LEVEL must be all, balanced or minimal.' };
  }
  if (key === 'PUSH_LEVEL' && ['all', 'balanced', 'minimal'].indexOf(String(val).toLowerCase()) === -1) {
    return { ok: false, error: 'VALIDATION', message: 'PUSH_LEVEL must be all, balanced or minimal.' };
  }
  cfgSet_(key, val);
  // the daily trigger bakes the hour at install time — changing it must reinstall
  if (key === 'DIGEST_HOUR') installTriggers_();
  return { ok: true, key: key, value: String(val), note: key === 'DIGEST_HOUR' ? 'triggers reinstalled at the new hour' : undefined };
}

/** Add or update one roster person, keyed by email (the stable identity).
 *  { op:'rosterUpsert', member:'<email>', name?, team?, role?, active?, code? }
 *  NOTE the target is `member`, never `email` — `email` is the CALLER's auth
 *  field on every request and would silently clobber the target. */
function adminRosterUpsert_(user, req) {
  const email = String(req.member || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 1) return { ok: false, error: 'VALIDATION', message: 'Pass member:"<email>".' };
  if (req.role !== undefined && ROLES.indexOf(String(req.role)) === -1) return { ok: false, error: 'VALIDATION', message: 'Role must be one of: ' + ROLES.join(', ') };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROSTER);
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 7).getValues() : [];
  let row = -1;
  for (let i = 0; i < rows.length; i++) if (String(rows[i][1]).trim().toLowerCase() === email) { row = i + 2; break; }

  if (row === -1) {
    const vals = [String(req.name || email.split('@')[0]), email, String(req.team || (teams_()[0] || {}).team || ''),
      String(req.role || 'Member'), String(req.phone || ''), String(req.active) === 'No' ? 'No' : 'Yes',
      String(req.code || randomCode_()).toUpperCase()];
    sh.appendRow(vals);
    row = sh.getLastRow();
  } else {
    const cur = rows[row - 2];
    const vals = [
      req.name !== undefined ? String(req.name) : cur[0],
      email,
      req.team !== undefined ? String(req.team) : cur[2],
      req.role !== undefined ? String(req.role) : cur[3],
      req.phone !== undefined ? String(req.phone) : cur[4],
      req.active !== undefined ? (String(req.active) === 'No' ? 'No' : 'Yes') : cur[5],
      req.code !== undefined ? String(req.code).toUpperCase() : (String(cur[6]).trim() || randomCode_()),
    ];
    sh.getRange(row, 1, 1, 7).setValues([vals]);
  }
  rebuildMemberTabs();
  syncFormAssignees();
  const saved = sh.getRange(row, 1, 1, 7).getValues()[0];
  log_('roster', '', user.email, 'upsert ' + email + ' role=' + saved[3], true);
  return { ok: true, person: { name: saved[0], email: saved[1], team: saved[2], role: saved[3], active: saved[5], code: saved[6] } };
}

/** Remove one roster person. Their TASKS are untouched — history is keyed by
 *  name and stays readable; they simply can no longer sign in.
 *  { op:'rosterRemove', member:'<email>', confirm:'REMOVE' } */
function adminRosterRemove_(user, req) {
  if (String(req.confirm) !== 'REMOVE') return { ok: false, error: 'VALIDATION', message: 'Pass confirm:"REMOVE".' };
  const email = String(req.member || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'VALIDATION', message: 'Pass member:"<email>" (the person to remove).' };
  if (email === String(ownerEmail_()).trim().toLowerCase()) return { ok: false, error: 'FORBIDDEN', message: 'The sheet owner cannot be removed from the Roster.' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROSTER);
  const last = sh.getLastRow();
  if (last < 2) return { ok: false, error: 'NOT_FOUND', message: 'Roster is empty.' };
  const rows = sh.getRange(2, 1, last - 1, 7).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][1]).trim().toLowerCase() === email) {
      const gone = rows[i];
      sh.deleteRow(i + 2);
      rebuildMemberTabs();
      syncFormAssignees();
      log_('roster', '', user.email, 'removed ' + email + ' (' + gone[0] + ', ' + gone[3] + ')', true);
      return { ok: true, removed: { name: gone[0], email: gone[1], role: gone[3] }, note: 'Their tasks and history are untouched; they can no longer sign in.' };
    }
  }
  return { ok: false, error: 'NOT_FOUND', message: email + ' is not in the Roster.' };
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
  swapCol_(SYNC_SHEET, 1); // external-sheet registry keys on the assigner name too

  rebuildMemberTabs();
  syncFormAssignees();
  log_('rename', '', user.email, from + ' -> ' + to + ' (' + changed + ' cells)', true);
  return { ok: true, renamed: changed + ' cells', from: from, to: to };
}
