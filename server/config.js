/**
 * ============================================================================
 *  CREATIVEFLOW v5 — config.js · schema constants + config/roster/data helpers
 *  Ported from Code.gs v1.1 + Api.gs v2.7 (see D:\claude test\Main Creative Flow).
 *  ONE definition of every constant/helper — the old split between Code.gs and
 *  Api.gs (setCfg_ vs cfgSet_, two dailyDigests) is deliberately gone.
 * ============================================================================
 */

const SHEETS = {
  MASTER: 'Master Tasks',
  ROSTER: 'Roster',
  CONFIG: 'Config',
  DASH: 'Dashboard',
  ARCHIVE: 'Archive',
  LOG: 'Alerts Log',
  REVIEWS: 'Reviews',
  SHARES: 'Shares',
  CYCLES: 'Cycles',
  VERSIONS: 'Versions',
  PUSH: 'Push Devices',   // hidden: rows are device credentials, not data to browse
  PORTFOLIO: 'Portfolio', // finished work + its permanent still (gallery.js)
};
const MEMBER_TAB_PREFIX = '👤 ';
const TEAM_TAB_SUFFIX = ' Team';

// Master Tasks columns (1-based). v5 merges the old COL (1–22) and X (23–30)
// maps into one 30-column layout, built up-front by setup() — no migrations.
const COL = {
  ID: 1, CREATED: 2, REQUESTER: 3, TEAM: 4, ASSIGNEE: 5,
  TITLE: 6, DESC: 7, BRIEF: 8, DELIVERABLE: 9,
  PRIORITY: 10, STATUS: 11, DUE_DATE: 12, DUE_TIME: 13,
  OVERDUE: 14, COMPLETED: 15, ON_TIME: 16, DAYS_LATE: 17,
  REVISIONS: 18, NOTES: 19,
  H_REMINDED: 20, H_OD_COUNT: 21, H_OD_LAST: 22,
};
const X = { STARTED: 23, STAGE: 24, QC_ROUNDS: 25, REV_DAYS: 26, STAGE_SINCE: 27, FLAGS: 28, RENEWED_FROM: 29, BRIEF_PENDING: 30 };
const LAST_COL = 22;      // width of the v1 core block
const LAST_COL2 = 30;     // full row width
const VISIBLE_COLS = 19;  // A..S — what members / mirrors / Archive see

const HEADERS = [
  'Task ID', 'Created On', 'Requested By', 'Team', 'Assigned To',
  'Task Title', 'Description / Brief', 'Brief / Asset Link', 'Deliverable Link',
  'Priority', 'Status', 'Due Date', 'Due Time',
  'Overdue?', 'Completed On', 'On Time?', 'Days Late',
  'Revisions', 'Notes', '_ReminderSent', '_OverdueAlerts', '_LastOverdueAlert',
];
const X_HEADERS = ['Started At', 'Stage', 'QC Rounds', 'Review Days Used', 'Stage Since', 'Flags', 'Renewed From', 'Brief Pending'];

const STATUSES = ['New', 'In Progress', 'In Review', 'Revisions', 'Done', 'On Hold'];
// v5 fix: Rejected is a real status the API writes — it belongs in the sheet's
// validation list too (old sheets showed a validation warning on those cells).
const STATUSES_ALL = STATUSES.concat(['Rejected']);
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const ROLES = ['Super Admin', 'Team Head', 'Member', 'Assigner'];

const PRIORITY_COLORS = { Urgent: '#c0392b', High: '#e67e22', Medium: '#b7950b', Low: '#7f8c8d' };

// Form field titles (the submission-parsing contract — must never drift)
const F_NAME = 'Your Name';
const F_TEAM = 'Team';
const F_TITLE = 'Task Title';
const F_DESC = 'Task Description / Brief';
const F_BRIEF = 'Brief / Asset Link (optional)';
const F_PRIORITY = 'Priority';
const F_DUE = 'Due Date';
const F_TIME = 'Due Time (optional)';
const F_ASSIGN = 'Assign To';
const ASSIGN_PLACEHOLDER = '(Let the team head decide)';

/* ── Config tab (A:C settings, E:F team→prefix) ────────────────────────── */

function cfgSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG); }

function cfg_(key, fallback) {
  const sh = cfgSheet_();
  if (!sh) return fallback;
  const data = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      const v = data[i][1];
      return (v === '' || v === null) ? fallback : v;
    }
  }
  return fallback;
}

function cfgSet_(key, value) {
  const sh = cfgSheet_();
  const data = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) { sh.getRange(i + 2, 2).setValue(value); return; }
  }
  sh.appendRow([key, value, 'Managed by the app.']);
}

function yes_(key) { return String(cfg_(key, 'YES')).toUpperCase().indexOf('Y') === 0; }

function listCfg_(key) {
  return String(cfg_(key, '')).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function tzStr_() { return String(cfg_('TIMEZONE', 'Asia/Kolkata')); }

/** Asia/Calcutta and Asia/Kolkata are the SAME zone — Google normalises the
 *  legacy name, and the old sheet's Config carries the legacy one. Compare
 *  timezones through this or the setup assertion fails on a false mismatch. */
function tzEq_(a, b) {
  const norm = z => String(z || '').replace(/^Asia\/Calcutta$/, 'Asia/Kolkata');
  return norm(a) === norm(b);
}

function teams_() {
  const sh = cfgSheet_();
  if (!sh) return [{ team: 'Graphic', prefix: 'GD' }, { team: 'Video', prefix: 'VD' }];
  const data = sh.getRange(2, 5, 10, 2).getValues();
  const out = [];
  data.forEach(r => {
    const name = String(r[0]).trim();
    if (!name || name.length > 30 || name.indexOf('Add more teams') === 0) return;
    out.push({ team: name, prefix: String(r[1] || 'T').trim() });
  });
  return out.length ? out : [{ team: 'Graphic', prefix: 'GD' }, { team: 'Video', prefix: 'VD' }];
}

/* ── Roster ────────────────────────────────────────────────────────────── */

function roster_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROSTER);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  return data.filter(r => r[0]).map(r => ({
    name: String(r[0]).trim(), email: String(r[1]).trim(), team: String(r[2]).trim(),
    role: String(r[3]).trim(), phone: String(r[4]).trim(), active: String(r[5]).trim().toLowerCase() === 'yes',
  }));
}

function rosterWithCodes_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROSTER);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  return data.filter(r => r[0]).map(r => ({
    name: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(),
    team: String(r[2]).trim(), role: String(r[3]).trim(),
    active: String(r[5]).trim().toLowerCase() === 'yes', code: String(r[6]).trim(),
  }));
}

function headsOf_(team) {
  const heads = roster_().filter(m => m.active && m.role === 'Team Head' && m.team === team);
  if (heads.length) return heads;
  return roster_().filter(m => m.active && m.role === 'Super Admin');
}

function emailByName_(name) {
  if (!name) return '';
  const m = roster_().filter(x => x.name === String(name).trim());
  return m.length ? m[0].email : '';
}

function nameByEmail_(email) {
  if (!email) return '';
  const m = roster_().filter(x => x.email.toLowerCase() === String(email).trim().toLowerCase());
  return m.length ? m[0].name : '';
}

function ownerEmail_() {
  try { return SpreadsheetApp.getActiveSpreadsheet().getOwner().getEmail(); }
  catch (e) { return Session.getEffectiveUser().getEmail(); }
}

/* ── Task IDs + row readers ────────────────────────────────────────────── */

function nextId_(team) {
  const t = teams_().filter(x => x.team === team);
  const prefix = t.length ? t[0].prefix : 'T';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let max = 0;
  [SHEETS.MASTER, SHEETS.ARCHIVE].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(r => {
      const m = String(r[0]).match(new RegExp('^' + prefix + '-(\\d+)$'));
      if (m) max = Math.max(max, Number(m[1]));
    });
  });
  return prefix + '-' + ('0000' + (max + 1)).slice(-4);
}

function rowById_(master, id) {
  const lastRow = master.getLastRow();
  if (lastRow < 2) return 0;
  const ids = master.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) return i + 2;
  }
  return 0;
}

function fullRow_(sh, row) {
  const n = Math.max(LAST_COL, Math.min(LAST_COL2, sh.getMaxColumns()));
  return sh.getRange(row, 1, 1, n).getValues()[0];
}

function taskAt_(sheet, row) {
  return taskFromRow_(sheet.getRange(row, 1, 1, LAST_COL).getValues()[0]);
}

function taskFromRow_(r) {
  const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
  return {
    id: r[COL.ID - 1], requester: r[COL.REQUESTER - 1], team: r[COL.TEAM - 1],
    assignee: r[COL.ASSIGNEE - 1], title: r[COL.TITLE - 1], desc: r[COL.DESC - 1],
    brief: r[COL.BRIEF - 1], deliverable: r[COL.DELIVERABLE - 1],
    priority: r[COL.PRIORITY - 1], status: r[COL.STATUS - 1], notes: r[COL.NOTES - 1],
    dueMs: due ? due.getTime() : null, dueStr: due ? fmtDT_(due) : '',
  };
}

function hasFlag_(r, f) { return String(r[X.FLAGS - 1] || '').split(',').indexOf(f) > -1; }

function addFlag_(sh, row, f) {
  const cell = sh.getRange(row, X.FLAGS);
  const cur = String(cell.getValue() || '').split(',').filter(function (x) { return x; });
  if (cur.indexOf(f) === -1) { cur.push(f); cell.setValue(cur.join(',')); }
}

/* ── Dates + formatting ────────────────────────────────────────────────── */

function dueDateTime_(dateVal, timeVal) {
  if (!(dateVal instanceof Date)) return null;
  const tz = tzStr_();
  const dateStr = Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd');
  let timeStr = String(cfg_('DEFAULT_DUE_TIME', '18:00'));
  if (timeVal instanceof Date) timeStr = Utilities.formatDate(timeVal, tz, 'HH:mm');
  if (!/^\d{1,2}:\d{2}$/.test(timeStr)) timeStr = '23:59';
  try { return Utilities.parseDate(dateStr + ' ' + timeStr, tz, 'yyyy-MM-dd HH:mm'); }
  catch (e) { return dateVal; }
}

function fmtDT_(d) {
  return Utilities.formatDate(d, tzStr_(), 'EEE, dd MMM yyyy · hh:mm a');
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr_(s) { return esc_(s).replace(/"/g, '&quot;'); }

/* ── Alerts Log ────────────────────────────────────────────────────────── */

function log_(type, taskId, to, info, ok) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.LOG);
    if (sh) sh.appendRow([new Date(), type, taskId, to, info, ok ? 'OK' : 'FAIL']);
  } catch (e) { /* never let logging break the flow */ }
}
