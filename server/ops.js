/**
 * ops.js — after-cutover operations: weekly sheet backup + daily self-check.
 */

/** Sunday 03:00 — Drive copy of the whole spreadsheet, keep the newest 8. */
function weeklyBackup() {
  try { weeklyBackupBody_(); } catch (e) { log_('backup', '', '', String(e), false); }
}

function weeklyBackupBody_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = tzStr_();
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const folderName = 'CreativeFlow Backups';
  let folder;
  const it = DriveApp.getFoldersByName(folderName);
  folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  DriveApp.getFileById(ss.getId()).makeCopy('CF Backup ' + stamp, folder);
  // prune to the newest 8
  const files = [];
  const fit = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (fit.hasNext()) files.push(fit.next());
  files.sort((a, b) => b.getDateCreated().getTime() - a.getDateCreated().getTime());
  for (let i = 8; i < files.length; i++) files[i].setTrashed(true);
  log_('backup', '', '', 'CF Backup ' + stamp + ' (' + Math.min(files.length + 1, 9) + ' kept)', true);
  return 'backup made: CF Backup ' + stamp;
}

/**
 * Daily 08:00 — two-signal health check.
 * Signal 1: fetch our own prod /exec ping (server-side fetch of /exec can be
 * flaky — that alone is not proof of an outage).
 * Signal 2: LAST_CLIENT_PING, stamped by apiPing_ traffic via CacheService.
 * Alert the owner only when BOTH look dead. Monday = an "all green" heartbeat
 * so silence is never mistaken for health.
 */
function selfCheck() {
  try {
    const prodUrl = String(cfg_('PROD_EXEC_URL', '')).trim() || ScriptApp.getService().getUrl();
    let fetchOk = false;
    try {
      const res = UrlFetchApp.fetch(prodUrl + '?action=ping', { muteHttpExceptions: true, followRedirects: true });
      fetchOk = res.getResponseCode() === 200 && res.getContentText().indexOf('"ok":true') !== -1;
    } catch (e) { fetchOk = false; }
    const lastPing = Number(CacheService.getScriptCache().get('LAST_CLIENT_PING')
      || PropertiesService.getScriptProperties().getProperty('LAST_CLIENT_PING_AT') || 0) || 0;
    const clientRecent = (Date.now() - lastPing) < 24 * 3600 * 1000;
    const owner = ownerEmail_();
    if (!fetchOk && !clientRecent) {
      safeSend_(owner, 'CreativeFlow health FAIL ' + Utilities.formatDate(new Date(), tzStr_(), 'yyyy-MM-dd'),
        baseCard_('#c0392b', 'CreativeFlow may be down',
          '<p>The daily self-check could not reach the deployment AND no client has pinged in 24h.</p>' +
          '<p>Recovery: open docs/DEPLOY.md in the creativeflow-v5 repo — verify the deployment via a real browser first (fetch tools lie about /exec).</p>'), '', 'health');
    } else if (Utilities.formatDate(new Date(), tzStr_(), 'EEEE') === 'Monday') {
      safeSend_(owner, '[Task] ✅ CreativeFlow weekly health: all green',
        baseCard_('#27ae60', 'Monitor heartbeat',
          '<p>Self-check ran and the system looks healthy. (This Monday note proves the monitor itself is alive.)</p>' +
          (function () {
            const n = retentionForecast_();
            return n ? '<p>🗄 <b>' + n + '</b> uploaded file' + (n > 1 ? 's' : '') + ' will move to Drive Trash in the next 7 days (' + cfg_('DRIVE_EXPIRY_DAYS', 45) + '-day retention).</p>' : '';
          })()), '', 'health');
    }
    log_('selfcheck', '', '', 'fetchOk=' + fetchOk + ' clientRecent=' + clientRecent, true);
  } catch (e) { log_('selfcheck', '', '', String(e), false); }
  flushMailQueue_();
  flushPushQueue_();
}

/** Called from apiPing_ traffic — cheap passive heartbeat.
 *  Cache maxes out at 6h TTL, so also persist durably (Script Properties)
 *  or the daily selfCheck could never see a ping older than ~6 hours. */
function stampClientPing_() {
  try {
    CacheService.getScriptCache().put('LAST_CLIENT_PING', String(Date.now()), 21600);
    PropertiesService.getScriptProperties().setProperty('LAST_CLIENT_PING_AT', String(Date.now()));
  } catch (e) {}
}
