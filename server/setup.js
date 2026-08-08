/**
 * ============================================================================
 *  setup.js — builds the whole sheet system from scratch, idempotently.
 *  v5: ALL tabs (incl. Reviews/Shares/Cycles/Versions) and all 30 Master
 *  columns are created up-front. No migration ladder — SCHEMA_V starts at 5.0.
 *
 *  First run is from the Apps Script editor (the one-time owner consent):
 *    1. run authorize()  → approve the consent screens
 *    2. run setup()      → builds everything, seeds the owner + Test Bot rows
 *  After that, everything is reachable through the admin API action.
 * ============================================================================
 */

/** Touches every scope so ONE consent covers the web app forever. */
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers();
  Session.getActiveUser().getEmail();
  return 'authorized';
}

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  buildConfig_(ss);
  const tz = tzStr_();
  try { ss.setSpreadsheetTimeZone(tz); } catch (e) { /* keep going */ }
  try { ss.setSpreadsheetLocale('en_IN'); } catch (e) { /* keep going */ }
  assertTz_();

  buildRoster_(ss);
  buildMaster_(ss);
  buildArchive_(ss);
  buildLog_(ss);
  reviewsSheet_(); sharesSheet_(); cyclesSheet_(); versionsSheet_(); syncRegistrySheet_();
  buildTeamTabs_(ss);
  buildDashboard_(ss);
  rebuildMemberTabs();

  createOrLinkForm_(ss);
  installTriggers_();
  removeDefaultSheet_(ss);
  orderSheets_(ss);

  const owner = ownerEmail_();
  const formUrl = cfg_('FORM_URL', '');
  safeSend_(owner, '[Task] ✅ CreativeFlow v5 installed',
    baseCard_('#27ae60', 'Your CreativeFlow system is live',
      '<p>The master sheet, dashboard, team tabs and the Task Request form are ready.</p>' +
      '<p><b>Next steps</b>:<br>1. Fill the <b>Roster</b> tab with real names, emails, teams and roles (or run the migration).<br>' +
      '2. Generate access codes, rebuild member tabs, sync the form list.<br>' +
      '3. Apply edit protections once the sheet is shared.</p>' +
      linkRow_('Open the master sheet', ss.getUrl()) +
      (formUrl ? linkRow_('Task Request form', formUrl) : '')), '');
  flushMailQueue_();
  log_('setup', '', owner, 'setup complete v' + API_VERSION, true);
  return 'setup complete';
}

/** v5: the script/sheet/config timezones must agree — slot deadlines and the
 *  sheet's NOW()-based formulas silently shift otherwise. Fails loudly. */
function assertTz_() {
  const cfgTz = tzStr_();
  const scriptTz = Session.getScriptTimeZone();
  const sheetTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  if (scriptTz !== cfgTz || sheetTz !== cfgTz) {
    throw new Error('TIMEZONE MISMATCH: script=' + scriptTz + ' sheet=' + sheetTz + ' config=' + cfgTz +
      ' — set the Apps Script project timezone AND the spreadsheet timezone to ' + cfgTz + ' before going live.');
  }
}

/** Adds the custom menu. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ CreativeFlow')
    .addItem('🔄 Rebuild member tabs', 'rebuildMemberTabs')
    .addItem('👥 Sync form assignee list', 'syncFormAssignees')
    .addItem('🔐 Apply edit protections', 'applyProtections')
    .addSeparator()
    .addItem('📬 Run alerts sweep now', 'sweep')
    .addItem('🎬 Run review sweep now', 'reviewSweep')
    .addItem('🌅 Send daily digest now', 'dailyDigestNow')
    .addItem('🗄️ Archive old done tasks', 'archiveDone')
    .addItem('📊 Sort master by due date', 'sortMasterByDue')
    .addSeparator()
    .addItem('🔑 Generate access codes', 'generateAccessCodes')
    .addItem('✉️ Send me a test alert', 'sendTestAlert')
    .addItem('🔁 Reinstall triggers', 'installTriggers_')
    .addItem('🧰 Re-run full setup', 'setup')
    .addToUi();
}

/* ── builders ──────────────────────────────────────────────────────────── */

function buildConfig_(ss) {
  let sh = ss.getSheetByName(SHEETS.CONFIG);
  if (!sh) sh = ss.insertSheet(SHEETS.CONFIG);
  if (sh.getRange('A1').getValue() !== 'Setting') {
    // Complete v5 key set, seeded in one shot — no migration ladder.
    const rows = [
      ['Setting', 'Value', 'What it does'],
      ['ORG_NAME', 'Coalesce Eventz', 'Name used in alert emails.'],
      ['TIMEZONE', 'Asia/Calcutta', 'Timezone for all dates, reminders and reports.'],
      ['DUE_SOON_HOURS', 24, 'Send a "due soon" reminder this many hours before the deadline.'],
      ['DEFAULT_DUE_TIME', '18:00', 'Deadline time used when a task has a date but no time (24h format).'],
      ['OVERDUE_REPEAT_HOURS', 24, 'Repeat the overdue alert every N hours until the task is done.'],
      ['CC_HEAD_FROM_ALERT_N', 2, 'CC the team head from this overdue alert number (1 = immediately).'],
      ['AUTO_URGENT_ON_OVERDUE', 'YES', 'Automatically raise the priority to Urgent when a task goes overdue.'],
      ['EMAIL_ON_ASSIGNMENT', 'YES', 'Email the member the moment a task is assigned to them.'],
      ['NOTIFY_REQUESTER_ON_DONE', 'YES', 'Email the requester (and head) when a task is marked Done.'],
      ['DAILY_DIGEST', 'YES', 'Send the morning digest (members + team heads).'],
      ['DIGEST_HOUR', 10, 'Hour of the day (0–23) for the daily digest.'],
      ['ARCHIVE_AFTER_DAYS', 30, 'Move Done tasks to the Archive tab after this many days.'],
      ['MAX_ROUNDS', 3, 'Revision rounds before the ⚠ over-limit flag.'],
      ['REVIEW_WINDOW_DAYS', 7, 'Working days of review before auto-Done.'],
      ['SLOT_EVE', '17:00', 'Evening revision slot (changes before this → due same day at this time).'],
      ['SLOT_NOON', '12:00', 'Noon revision slot (changes after SLOT_EVE → next working day at this time).'],
      ['CREATE_CUTOFF', '17:00', 'Assigners cannot create same-day tasks at/after this time.'],
      ['WEEKLY_OFF', 'Sunday', 'Comma list of weekly off days.'],
      ['EXTRA_WORK_DATES', '', 'Comma list yyyy-mm-dd — off days that ARE working (e.g. a working Sunday).'],
      ['HOLIDAY_DATES', '', 'Comma list yyyy-mm-dd — extra holidays.'],
      ['DRIVE_EXPIRY_DAYS', 0, 'Uploaded files expire after this many days (0 = never).'],
      ['UPLOAD_MODE', 'central', 'central = everything lands on the studio Drive; own = each member\'s Drive.'],
      ['STORAGE_ACCOUNT', '', 'The studio Google account whose Drive holds all uploads.'],
      ['GOOGLE_CLIENT_ID', '', 'Web OAuth client id — enables in-app Drive uploads.'],
      ['GOOGLE_API_KEY', '', 'Drive API key — enables realtime video playback in the review room.'],
      ['APP_BASE_URL', '', 'The hosted app URL (GitHub Pages) — used in email deep links.'],
      ['EMAIL_MUTE', 'YES', 'YES = log every email instead of sending (testing / migration). Set NO to go live.'],
      ['FORM_URL', '', 'Filled automatically — link to the Task Request form.'],
      ['FORM_EDIT_URL', '', 'Filled automatically — link to edit the form.'],
      ['SCHEMA_V', '5.0', 'Managed by the app — do not edit.'],
    ];
    sh.getRange(1, 1, rows.length, 3).setValues(rows);
  }
  if (sh.getRange('E1').getValue() !== 'Team') {
    sh.getRange(1, 5, 4, 2).setValues([
      ['Team', 'Task ID Prefix'],
      ['Graphic', 'GD'],
      ['Video', 'VD'],
      ['', ''],
    ]);
  }
  // The helper note must live OUTSIDE the teams range E2:E11 (v1.0 lesson).
  if (!String(sh.getRange('E13').getValue())) sh.getRange('E13').setValue('Add more teams in the two columns above (rows 2–11), then re-run setup from the menu.');
  sh.getRange('A1:C1').setFontWeight('bold').setBackground('#263238').setFontColor('#ffffff');
  sh.getRange('E1:F1').setFontWeight('bold').setBackground('#263238').setFontColor('#ffffff');
  sh.setColumnWidth(1, 210).setColumnWidth(2, 300).setColumnWidth(3, 420).setColumnWidths(5, 2, 130);
  sh.setFrozenRows(1);
}

function buildRoster_(ss) {
  let sh = ss.getSheetByName(SHEETS.ROSTER);
  if (!sh) sh = ss.insertSheet(SHEETS.ROSTER);
  if (sh.getRange('A1').getValue() !== 'Name') {
    const owner = ownerEmail_();
    const rows = [
      ['Name', 'Email', 'Team', 'Role', 'WhatsApp Number (optional)', 'Active', 'Access Code'],
      ['You (rename me)', owner, 'Graphic', 'Super Admin', '', 'Yes', ''],
      ['Test Bot', 'testbot@example.com', 'Graphic', 'Member', '', 'Yes', 'TB6363'],
    ];
    sh.getRange(1, 1, rows.length, 7).setValues(rows);
  }
  sh.getRange('A1:G1').setFontWeight('bold').setBackground('#263238').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidths(1, 7, 190);
  const teamsRange = ss.getSheetByName(SHEETS.CONFIG).getRange('E2:E11');
  sh.getRange('C2:C200').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(teamsRange, true).setAllowInvalid(false).build());
  // v5: Assigner is in the Role list from day one (old sheets needed migrate45_)
  sh.getRange('D2:D200').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).setAllowInvalid(false).build());
  sh.getRange('F2:F200').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build());
}

function buildMaster_(ss) {
  let sh = ss.getSheetByName(SHEETS.MASTER);
  if (!sh) sh = ss.insertSheet(SHEETS.MASTER);

  // v5: full 30-column layout from birth
  if (sh.getMaxColumns() < LAST_COL2) sh.insertColumnsAfter(sh.getMaxColumns(), LAST_COL2 - sh.getMaxColumns());
  sh.getRange(1, 1, 1, LAST_COL).setValues([HEADERS]);
  sh.getRange(1, X.STARTED, 1, X_HEADERS.length).setValues([X_HEADERS]);
  sh.getRange(1, 1, 1, LAST_COL2).setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff').setWrap(false);
  sh.getRange(1, X.STARTED, 1, X_HEADERS.length).setBackground('#455a64');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);

  // Computed columns (array formulas live in the header row only).
  // Overdue formula = the v3.3 variant: In Review / Rejected pause the clock.
  setHeaderFormula_(sh, COL.OVERDUE,
    `={"Overdue?"; ARRAYFORMULA(IF(($A$2:$A="")+($L$2:$L=""),, IF(($K$2:$K<>"Done")*($K$2:$K<>"On Hold")*($K$2:$K<>"In Review")*($K$2:$K<>"Rejected")*(($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M))<NOW()), "🚨 OVERDUE", "")))}`);
  setHeaderFormula_(sh, COL.ON_TIME,
    `={"On Time?"; ARRAYFORMULA(IF(($O$2:$O="")+($L$2:$L=""),, IF($O$2:$O<=($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M)), "✅ On time", "⏰ Late")))}`);
  setHeaderFormula_(sh, COL.DAYS_LATE,
    `={"Days Late"; ARRAYFORMULA(IF(($A$2:$A="")+($L$2:$L=""),, IF($O$2:$O<>"", ROUND(IF($O$2:$O>($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M)), $O$2:$O-($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M)), 0),1), IF(($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M))<NOW(), ROUND(NOW()-($L$2:$L+IF($M$2:$M="",TIMEVALUE("23:59"),$M$2:$M)),1), ""))))}`);

  // Data validation
  const cfgSheet = ss.getSheetByName(SHEETS.CONFIG);
  const rosterSheet = ss.getSheetByName(SHEETS.ROSTER);
  sh.getRange(2, COL.TEAM, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(cfgSheet.getRange('E2:E11'), true).setAllowInvalid(true).build());
  sh.getRange(2, COL.ASSIGNEE, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(rosterSheet.getRange('A2:A200'), true).setAllowInvalid(true).build());
  sh.getRange(2, COL.PRIORITY, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(PRIORITIES, true).setAllowInvalid(false).build());
  // v5: Rejected included — the API writes it, the sheet must accept it
  sh.getRange(2, COL.STATUS, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES_ALL, true).setAllowInvalid(false).build());

  // Number formats
  sh.getRange(2, COL.CREATED, sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy hh:mm');
  sh.getRange(2, COL.DUE_DATE, sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy');
  sh.getRange(2, COL.DUE_TIME, sh.getMaxRows() - 1, 1).setNumberFormat('hh:mm am/pm');
  sh.getRange(2, COL.COMPLETED, sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy hh:mm');
  sh.getRange(2, X.STARTED, sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy hh:mm');
  sh.getRange(2, X.STAGE_SINCE, sh.getMaxRows() - 1, 1).setNumberFormat('dd mmm yyyy hh:mm');

  // Column widths
  const widths = { 1: 90, 2: 130, 3: 130, 4: 90, 5: 130, 6: 260, 7: 320, 8: 170, 9: 170, 10: 90, 11: 110, 12: 110, 13: 90, 14: 110, 15: 130, 16: 100, 17: 90, 18: 80, 19: 220 };
  Object.keys(widths).forEach(c => sh.setColumnWidth(Number(c), widths[c]));
  sh.hideColumns(COL.H_REMINDED, 3);
  sh.hideColumns(X.STARTED, X_HEADERS.length);

  applyMasterConditionalFormatting_(sh);
}

function setHeaderFormula_(sh, col, formula) {
  const cell = sh.getRange(1, col);
  const current = cell.getFormula();
  if (!current || current.indexOf('ARRAYFORMULA') !== -1) cell.setFormula(formula);
}

function applyMasterConditionalFormatting_(sh) {
  const rules = [];
  const fullRange = sh.getRange('A2:S1000');

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$K2="Done"').setBackground('#e8f5e9')
    .setRanges([fullRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$N2="🚨 OVERDUE"').setBackground('#fdecea')
    .setRanges([fullRange]).build());

  const pCol = sh.getRange('J2:J1000');
  Object.keys(PRIORITY_COLORS).forEach(p => {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(p).setFontColor(PRIORITY_COLORS[p]).setBold(true)
      .setRanges([pCol]).build());
  });
  sh.setConditionalFormatRules(rules);
}

function buildArchive_(ss) {
  let sh = ss.getSheetByName(SHEETS.ARCHIVE);
  if (!sh) sh = ss.insertSheet(SHEETS.ARCHIVE);
  if (sh.getRange('A1').getValue() !== 'Task ID') {
    sh.getRange(1, 1, 1, VISIBLE_COLS).setValues([HEADERS.slice(0, VISIBLE_COLS)]);
  }
  sh.getRange(1, 1, 1, VISIBLE_COLS).setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

function buildLog_(ss) {
  let sh = ss.getSheetByName(SHEETS.LOG);
  if (!sh) sh = ss.insertSheet(SHEETS.LOG);
  if (sh.getRange('A1').getValue() !== 'Time') {
    sh.getRange(1, 1, 1, 6).setValues([['Time', 'Type', 'Task', 'To', 'Info', 'OK?']]);
  }
  sh.getRange('A1:F1').setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.hideSheet();
}

function removeDefaultSheet_(ss) {
  const sh = ss.getSheetByName('Sheet1');
  if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
}

/* ── protections / sorting ─────────────────────────────────────────────── */

function sortMasterByDue() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const lastRow = sh.getLastRow();
  if (lastRow < 3) return;
  sh.getRange(2, 1, lastRow - 1, LAST_COL2).sort([{ column: COL.DUE_DATE, ascending: true }, { column: COL.PRIORITY, ascending: true }]);
}

/**
 * Locks the sheet down: admins (Super Admin + Team Heads) can edit everything;
 * everyone else can only edit Status, Deliverable Link and Notes on the master.
 * v5: the hidden workflow block W:AD is admin-only too.
 */
function applyProtections() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const admins = roster_().filter(m => m.active && (m.role === 'Super Admin' || m.role === 'Team Head'))
    .map(m => m.email).filter(x => x && x.indexOf('@example.com') === -1);
  const master = ss.getSheetByName(SHEETS.MASTER);

  // clear old protections
  ss.getSheets().forEach(sh => {
    sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => { try { p.remove(); } catch (e) {} });
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => { try { p.remove(); } catch (e) {} });
  });

  // Master: lock everything except Status (K), Deliverable (I), Notes (S)
  ['A:H', 'J:J', 'L:R', 'T:V', 'W:AD'].forEach(a1 => {
    try {
      const p = master.getRange(a1).protect().setDescription('Admins only');
      p.removeEditors(p.getEditors());
      if (admins.length) p.addEditors(admins);
    } catch (e) { log_('protect', '', '', a1 + ' ' + String(e), false); }
  });

  // Whole-sheet protection for admin tabs and read-only mirrors
  const lockSheets = [SHEETS.ROSTER, SHEETS.CONFIG, SHEETS.DASH, SHEETS.ARCHIVE, SHEETS.REVIEWS, SHEETS.SHARES, SHEETS.CYCLES, SHEETS.VERSIONS];
  ss.getSheets().forEach(sh => {
    const n = sh.getName();
    if (lockSheets.indexOf(n) !== -1 || n.indexOf(MEMBER_TAB_PREFIX) === 0 || n.indexOf(TEAM_TAB_SUFFIX) !== -1) {
      try {
        const p = sh.protect().setDescription('Admins only');
        p.removeEditors(p.getEditors());
        if (admins.length) p.addEditors(admins);
      } catch (e) { log_('protect', '', '', n + ' ' + String(e), false); }
    }
  });
}

/* ── triggers ──────────────────────────────────────────────────────────── */

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger('handleFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('sweep').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('reviewSweep').timeBased().everyHours(1).create();          // v5: real trigger
  ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1).atHour(Number(cfg_('DIGEST_HOUR', 10))).create();
  ScriptApp.newTrigger('archiveDone').timeBased().onMonthDay(1).atHour(3).create();
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create(); // v5
  ScriptApp.newTrigger('selfCheck').timeBased().everyDays(1).atHour(8).create();   // v5
  ScriptApp.newTrigger('extSync').timeBased().everyMinutes(10).create();           // v5: assigner sheets (10 min + hash fast-path keeps trigger quota safe)
  log_('triggers', '', '', '9 triggers installed', true);
}
