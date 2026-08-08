/**
 * history.js — Cycles (append-only event log) + Versions (deliverable history).
 * Tabs are built up-front by setup(); the lazy insertSheet fallbacks stay only
 * as a belt-and-braces guard.
 */

function cyclesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.CYCLES);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.CYCLES);
    sh.getRange(1, 1, 1, 5).setValues([['Task ID', 'Event', 'At', 'By', 'Info']])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function cycle_(taskId, event, by, info) {
  try { cyclesSheet_().appendRow([taskId, event, new Date(), by || '', info || '']); } catch (e) {}
}

function versionsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.VERSIONS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.VERSIONS);
    sh.getRange(1, 1, 1, 7).setValues([['Task ID', 'Version', 'Link', 'By', 'At', 'File ID', 'Expires']])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function versionsFor_(taskId) {
  const sh = versionsSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues()
    .filter(function (r) { return String(r[0]) === taskId; })
    .map(function (r) {
      return { v: Number(r[1]) || 0, link: String(r[2]), by: String(r[3]),
               at: (r[4] instanceof Date) ? r[4].toISOString() : '',
               fileId: String(r[5] || ''), expires: (r[6] instanceof Date) ? r[6].toISOString() : '' };
    }).sort(function (a, b) { return a.v - b.v; });
}

function latestVersionOf_(taskId) {
  const vs = versionsFor_(taskId);
  return vs.length ? vs[vs.length - 1].v : 1;
}

function addVersion_(taskId, link, by, fileId, hadBefore) {
  const vs = versionsFor_(taskId);
  const base = vs.length ? vs[vs.length - 1].v : (hadBefore ? 1 : 0);
  const v = base + 1;
  let expires = '';
  const days = Number(cfg_('DRIVE_EXPIRY_DAYS', 0)) || 0;
  if (days > 0 && (fileId || /drive\.google\.com/.test(link))) {
    expires = new Date(Date.now() + days * 86400000);
  }
  versionsSheet_().appendRow([taskId, v, link, by, new Date(), fileId || '', expires]);
  return v;
}
