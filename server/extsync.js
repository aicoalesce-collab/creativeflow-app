/**
 * ============================================================================
 *  extsync.js — two-way sync with assigners' own Google Sheets (v5 feature).
 *
 *  Two kinds of external sheet, both registered in the "Synced Sheets" tab:
 *   - assigner: a premade template we create + share by link
 *       tabs: "Add Tasks" (intake), "Completed" (Done-task feed), hidden shadow
 *   - calendar: THEIR existing content-calendar sheet (shared to the studio
 *       account); we only ADD tabs "CF Requests" + "CF Completed" + shadow —
 *       their own layout is never touched.
 *
 *  Sync rules (the shadow-copy lessons — see CLAUDE.md):
 *   - Identity is the Task ID, never the row. A deleted row is never a delete.
 *   - Rows with a Title and no Task ID → created as tasks BY that assigner via
 *     the normal apiCreate_ path (cutoff, emails, dashboard — all real).
 *   - App-owned columns (Task ID/Status/Deliverable/Sync Note) flow OUTBOUND.
 *   - User columns (brief/priority/due) flow INBOUND through apiUpdate_ with
 *     the assigner's own permissions (brief edits trigger Accept-brief, etc.).
 *   - The hidden shadow stores what we last wrote/saw, so "assigner edited
 *     this" is distinguishable from "that's my own old write". App wins ties.
 *  Fast path: an intake-range hash is kept in the registry — unchanged sheet +
 *  no outbound deltas pending → skipped in milliseconds (trigger quota safety).
 * ============================================================================
 */

const SYNC_SHEET = 'Synced Sheets';
const SYNC_HEADERS = ['Assigner Name', 'Sheet ID', 'Type', 'Enabled', 'Last Sync', 'Intake Hash', 'Notes'];
const INTAKE_HEADERS = ['Title', 'Team', 'Description', 'Brief / Asset Link', 'Priority', 'Due Date', 'Due Time', 'Assign To (optional)', 'Task ID', 'Status', 'Deliverable Link', 'Sync Note'];
const FEED_HEADERS = ['Task ID', 'Title', 'Team', 'Deliverable Link', 'Completed On', 'Requested By'];
const SHADOW_TAB = '_cf_shadow';
const INTAKE_TAB = { assigner: 'Add Tasks', calendar: 'CF Requests' };
const FEED_TAB = { assigner: 'Completed', calendar: 'CF Completed' };

function syncRegistrySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SYNC_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SYNC_SHEET);
    sh.getRange(1, 1, 1, SYNC_HEADERS.length).setValues([SYNC_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function syncRegistry_() {
  const sh = syncRegistrySheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SYNC_HEADERS.length).getValues()
    .map((r, i) => ({
      row: i + 2, assigner: String(r[0]).trim(), sheetId: String(r[1]).trim(),
      type: String(r[2]).trim() || 'assigner',
      enabled: String(r[3]).trim().toLowerCase() === 'yes',
      lastSync: (r[4] instanceof Date) ? r[4].toISOString() : '',
      hash: String(r[5] || ''), notes: String(r[6] || ''),
    })).filter(x => x.sheetId);
}

/* ── template builders (admin ops) ─────────────────────────────────────── */

/** Creates the premade per-assigner sheet and registers it.
 *  { op:'createAssignerSheet', assigner:'<roster name>', share:'email@…'? } */
function adminCreateAssignerSheet_(req) {
  const assigner = String(req.assigner || '').trim();
  const person = roster_().filter(m => m.name === assigner);
  if (!person.length) return { ok: false, error: 'VALIDATION', message: '"' + assigner + '" is not in the Roster.' };
  const org = String(cfg_('ORG_NAME', 'CreativeFlow'));
  const book = SpreadsheetApp.create(org + ' — Tasks — ' + assigner);
  buildIntakeTab_(book, 'Add Tasks');
  buildFeedTab_(book, 'Completed');
  buildShadowTab_(book);
  const s1 = book.getSheetByName('Sheet1');
  if (s1) book.deleteSheet(s1);
  const shareTo = String(req.share || person[0].email || '').trim();
  if (shareTo && shareTo.indexOf('@example.com') === -1) {
    try { book.addEditor(shareTo); } catch (e) { /* share manually if this fails */ }
  }
  registerSync_(assigner, book.getId(), 'assigner');
  protectAppColumns_(book, 'Add Tasks');
  log_('extsync', '', assigner, 'assigner sheet created ' + book.getId(), true);
  return { ok: true, url: book.getUrl(), sheetId: book.getId(), sharedWith: shareTo || '(nobody yet — share the link manually)' };
}

/** Registers an EXISTING content-calendar sheet (must be shared to the studio
 *  account as editor). Adds CF Requests + CF Completed + shadow tabs only.
 *  { op:'registerCalendarSheet', assigner:'<roster name>', src:'<url|id>' } */
function adminRegisterCalendarSheet_(req) {
  const assigner = String(req.assigner || '').trim();
  const person = roster_().filter(m => m.name === assigner);
  if (!person.length) return { ok: false, error: 'VALIDATION', message: '"' + assigner + '" is not in the Roster.' };
  let book;
  try { book = SpreadsheetApp.openById(oldSheetId_(req.src)); }
  catch (e) { return { ok: false, error: 'VALIDATION', message: 'Cannot open that sheet — is it shared (as editor) with the studio account? ' + String(e) }; }
  if (!book.getSheetByName('CF Requests')) buildIntakeTab_(book, 'CF Requests');
  if (!book.getSheetByName('CF Completed')) buildFeedTab_(book, 'CF Completed');
  buildShadowTab_(book);
  registerSync_(assigner, book.getId(), 'calendar');
  protectAppColumns_(book, 'CF Requests');
  log_('extsync', '', assigner, 'calendar sheet registered ' + book.getId(), true);
  return { ok: true, url: book.getUrl(), sheetId: book.getId(), added: 'CF Requests + CF Completed tabs' };
}

/** { op:'setSyncedSheet', sheetId, enabled:'Yes'|'No' } */
function adminSetSyncedSheet_(req) {
  const sh = syncRegistrySheet_();
  const reg = syncRegistry_().filter(x => x.sheetId === String(req.sheetId || '').trim());
  if (!reg.length) return { ok: false, error: 'NOT_FOUND', message: 'Sheet not registered.' };
  sh.getRange(reg[0].row, 4).setValue(String(req.enabled) === 'No' ? 'No' : 'Yes');
  return { ok: true, sheetId: reg[0].sheetId, enabled: String(req.enabled) !== 'No' };
}

function registerSync_(assigner, sheetId, type) {
  const sh = syncRegistrySheet_();
  const existing = syncRegistry_().filter(x => x.sheetId === sheetId);
  if (existing.length) return;
  sh.appendRow([assigner, sheetId, type, 'Yes', '', '', '']);
}

function buildIntakeTab_(book, name) {
  let sh = book.getSheetByName(name);
  if (!sh) sh = book.insertSheet(name);
  sh.getRange(1, 1, 1, INTAKE_HEADERS.length).setValues([INTAKE_HEADERS])
    .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange(2, 2, 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(teams_().map(t => t.team), true).setAllowInvalid(false).build());
  sh.getRange(2, 5, 999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(PRIORITIES, true).setAllowInvalid(false).build());
  sh.getRange(2, 6, 999, 1).setNumberFormat('dd mmm yyyy');
  sh.getRange(2, 7, 999, 1).setNumberFormat('hh:mm');
  sh.getRange(2, 9, 999, 4).setBackground('#f5f5f5'); // app-owned block, visually distinct
  sh.setColumnWidth(1, 260).setColumnWidth(3, 300).setColumnWidth(4, 180).setColumnWidth(12, 240);
}

function buildFeedTab_(book, name) {
  let sh = book.getSheetByName(name);
  if (!sh) sh = book.insertSheet(name);
  sh.getRange(1, 1, 1, FEED_HEADERS.length).setValues([FEED_HEADERS])
    .setFontWeight('bold').setBackground('#27ae60').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidth(2, 260).setColumnWidth(4, 220);
}

function buildShadowTab_(book) {
  let sh = book.getSheetByName(SHADOW_TAB);
  if (!sh) {
    sh = book.insertSheet(SHADOW_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['Task ID', 'AppJSON', 'UserJSON']]);
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

/** App-owned columns I:L are protected so only the studio account writes them. */
function protectAppColumns_(book, tabName) {
  try {
    const sh = book.getSheetByName(tabName);
    const p = sh.getRange('I:L').protect().setDescription('CreativeFlow writes these — please don\'t edit');
    p.removeEditors(p.getEditors());
  } catch (e) { log_('extsync', '', '', 'protect failed: ' + String(e), false); }
}

/* ── the sync engine (10-min trigger + admin syncNow) ──────────────────── */

function extSync() {
  try { extSyncBody_(false); } catch (e) { log_('extsync', '', '', String(e), false); }
  flushMailQueue_();
}

function extSyncBody_(force) {
  const reg = syncRegistry_().filter(x => x.enabled);
  if (!reg.length) return 'no sheets registered';
  const regSh = syncRegistrySheet_();
  const results = [];
  reg.forEach(entry => {
    try {
      results.push(entry.assigner + '/' + entry.type + ': ' + syncOne_(entry, regSh, force));
    } catch (e) {
      results.push(entry.assigner + ': ERROR ' + String(e));
      log_('extsync', '', entry.assigner, String(e), false);
    }
  });
  return results.join(' · ');
}

function syncOne_(entry, regSh, force) {
  const person = rosterWithCodes_().filter(m => m.name === entry.assigner && m.active);
  if (!person.length) return 'assigner not active in Roster — skipped';
  // the sync acts AS this assigner: same permissions, same notifications
  const user = { name: person[0].name, team: person[0].team, role: person[0].role || 'Assigner', email: person[0].email };
  const prevActor = CURRENT_ACTOR;
  CURRENT_ACTOR = user.email;
  try {
    const book = SpreadsheetApp.openById(entry.sheetId);
    const intake = book.getSheetByName(INTAKE_TAB[entry.type] || 'Add Tasks');
    if (!intake) return 'intake tab missing — skipped';

    const lastRow = intake.getLastRow();
    const rows = lastRow < 2 ? [] : intake.getRange(2, 1, lastRow - 1, INTAKE_HEADERS.length).getValues();

    // fast path: nothing changed inbound AND no outbound deltas pending
    const hash = intakeHash_(rows) + '|' + masterStateHash_(user.name);
    if (!force && hash === entry.hash) {
      regSh.getRange(entry.row, 5).setValue(new Date());
      return 'unchanged';
    }

    const shadow = readShadow_(book);
    const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
    let created = 0, updatedIn = 0, updatedOut = 0, errors = 0;

    rows.forEach((r, i) => {
      const rowN = i + 2;
      const title = String(r[0]).trim();
      const taskId = String(r[8]).trim();
      const tz = tzStr_();

      if (!taskId && title) {
        // NEW row → create as the assigner (cutoff + validation + emails all real)
        const req = {
          title: title, team: String(r[1]).trim(),
          desc: String(r[2] || ''), brief: String(r[3] || ''),
          priority: String(r[4] || 'Medium'),
          dueDate: (r[5] instanceof Date) ? Utilities.formatDate(r[5], tz, 'yyyy-MM-dd') : String(r[5] || '').trim(),
          dueTime: (r[6] instanceof Date) ? Utilities.formatDate(r[6], tz, 'HH:mm') : String(r[6] || '').trim(),
          assignee: String(r[7] || '').trim().split(' — ')[0],
        };
        const cut = createCutoff_(user, req);
        const made = cut || apiCreate_(user, req);
        if (made.ok) {
          intake.getRange(rowN, 9, 1, 4).setValues([[made.task.id, made.task.status, made.task.deliverable || '', '✓ synced ' + Utilities.formatDate(new Date(), tz, 'dd MMM HH:mm')]]);
          shadow[made.task.id] = { app: appSnap_(made.task), user: userSnap_(made.task) };
          created++;
        } else {
          intake.getRange(rowN, 12).setValue('✗ ' + made.message);
          errors++;
        }
        return;
      }

      if (taskId) {
        const mrow = rowById_(master, taskId);
        if (!mrow) {
          if (String(r[11]).indexOf('archived') === -1) intake.getRange(rowN, 12).setValue('archived / deleted in CreativeFlow');
          return;
        }
        const t = taskToApi_(fullRow_(master, mrow));
        const sh = shadow[taskId] || { app: {}, user: {} };

        // INBOUND: did the assigner edit brief/priority/due since our last look?
        const nowUser = { brief: String(r[3] || ''), priority: String(r[4] || ''), dueDate: (r[5] instanceof Date) ? Utilities.formatDate(r[5], tzStr_(), 'yyyy-MM-dd') : '', dueTime: (r[6] instanceof Date) ? Utilities.formatDate(r[6], tzStr_(), 'HH:mm') : '' };
        const patch = {};
        if (sh.user.brief !== undefined && nowUser.brief !== sh.user.brief && nowUser.brief !== t.brief) patch.brief = nowUser.brief;
        if (sh.user.priority !== undefined && nowUser.priority && nowUser.priority !== sh.user.priority && nowUser.priority !== t.priority) patch.priority = nowUser.priority;
        if (sh.user.dueDate !== undefined && nowUser.dueDate && (nowUser.dueDate !== sh.user.dueDate || nowUser.dueTime !== sh.user.dueTime) && (nowUser.dueDate !== t.dueDate || nowUser.dueTime !== t.dueTime)) {
          patch.dueDate = nowUser.dueDate; patch.dueTime = nowUser.dueTime || t.dueTime;
        }
        if (Object.keys(patch).length) {
          const upd = apiUpdate_(user, { id: taskId, patch: patch });
          if (upd.ok) updatedIn++;
          else intake.getRange(rowN, 12).setValue('✗ ' + upd.message);
        }

        // OUTBOUND: status / deliverable back into their row (app wins)
        const t2 = taskToApi_(fullRow_(master, rowById_(master, taskId)));
        if (String(r[9]) !== t2.status || String(r[10]) !== (t2.deliverable || '')) {
          intake.getRange(rowN, 10, 1, 2).setValues([[t2.status, t2.deliverable || '']]);
          updatedOut++;
        }
        shadow[taskId] = { app: appSnap_(t2), user: userSnap_(t2) };
      }
    });

    // FEED: append newly-Done tasks requested by this assigner
    const feed = book.getSheetByName(FEED_TAB[entry.type] || 'Completed');
    if (feed) {
      const have = {};
      if (feed.getLastRow() > 1) feed.getRange(2, 1, feed.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0]) have[String(r[0])] = 1; });
      const doneRows = scopedRows_(user).filter(r => String(r[COL.STATUS - 1]).trim() === 'Done');
      doneRows.forEach(r => {
        const id = String(r[COL.ID - 1]);
        if (have[id]) return;
        const t = taskToApi_(r);
        feed.appendRow([t.id, t.title, t.team, t.deliverable || '', t.completed ? Utilities.formatDate(new Date(t.completed), tzStr_(), 'dd MMM yyyy HH:mm') : '', t.requester]);
        updatedOut++;
      });
    }

    writeShadow_(book, shadow);
    const rows2 = intake.getLastRow() < 2 ? [] : intake.getRange(2, 1, intake.getLastRow() - 1, INTAKE_HEADERS.length).getValues();
    regSh.getRange(entry.row, 5, 1, 2).setValues([[new Date(), intakeHash_(rows2) + '|' + masterStateHash_(user.name)]]);
    const summary = created + ' created, ' + updatedIn + ' edits in, ' + updatedOut + ' out, ' + errors + ' errors';
    if (created || updatedIn || errors) log_('extsync', '', entry.assigner, summary, errors === 0);
    return summary;
  } finally {
    CURRENT_ACTOR = prevActor;
  }
}

function appSnap_(t) { return { status: t.status, deliverable: t.deliverable || '' }; }
function userSnap_(t) { return { brief: t.brief || '', priority: t.priority || '', dueDate: t.dueDate || '', dueTime: t.dueTime || '' }; }

function intakeHash_(rows) {
  let s = '';
  rows.forEach(r => { s += r.slice(0, 9).join('') + ''; });
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

/** Cheap outbound-delta detector: hash of this assigner's task ids+status+deliverable. */
function masterStateHash_(assignerName) {
  const user = { name: assignerName, role: 'Assigner' };
  let s = '';
  scopedRows_(user).forEach(r => {
    s += String(r[COL.ID - 1]) + '' + String(r[COL.STATUS - 1]) + '' + String(r[COL.DELIVERABLE - 1]) + '';
  });
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
}

function readShadow_(book) {
  const sh = buildShadowTab_(book);
  const out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
    if (!r[0]) return;
    try { out[String(r[0])] = { app: JSON.parse(String(r[1] || '{}')), user: JSON.parse(String(r[2] || '{}')) }; }
    catch (e) { out[String(r[0])] = { app: {}, user: {} }; }
  });
  return out;
}

function writeShadow_(book, shadow) {
  const sh = buildShadowTab_(book);
  const ids = Object.keys(shadow);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  if (!ids.length) return;
  const vals = ids.map(id => [id, JSON.stringify(shadow[id].app || {}), JSON.stringify(shadow[id].user || {})]);
  if (sh.getMaxRows() < 1 + vals.length) sh.insertRowsAfter(sh.getMaxRows(), 1 + vals.length - sh.getMaxRows());
  sh.getRange(2, 1, vals.length, 3).setValues(vals);
}
