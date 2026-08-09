/**
 * ============================================================================
 *  tasks.js — bootstrap/paged reads + the full task state machine.
 *  Ported from Api.gs v2.7. Behavioral contract is identical; differences:
 *   - NO LockService here (the dispatch wrapper in main.js locks writes).
 *   - NO lazy migrations/sweeps on the login path (real triggers instead).
 *   - The Master sheet is born with all 30 columns → ensure40_ is gone.
 * ============================================================================
 */

/* ── reads ─────────────────────────────────────────────────────────────── */

function apiBootstrap_(user, req) {
  const out = {
    ok: true,
    me: { name: user.name, team: user.team, role: user.role, email: user.email },
    org: String(cfg_('ORG_NAME', 'Task System')),
    formUrl: String(cfg_('FORM_URL', '')),
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    teams: teams_().map(t => t.team),
    roster: roster_().filter(m => m.active).map(m => ({ name: m.name, team: m.team, role: m.role })),
    serverTime: new Date().toISOString(),
  };
  /* lite mode: small answer — tasks arrive separately via tasksPage */
  if (req && req.lite) { out.total = scopedRows_(user).length; return out; }
  out.tasks = apiTasks_(user);
  return out;
}

/* v5 fix for DIAGNOSTICS R4 (one monster row makes a page BIG): list responses
 * carry only a PREVIEW of desc/notes; the client fetches full text per-task via
 * the taskDetail action. This hard-caps every paged answer — the ping-sized
 * invariant survives any 200KB description someone pastes into a cell. */
const DESC_PREVIEW = 500, NOTES_PREVIEW = 1000, DETAIL_CAP = 50000;

function clip_(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }

function taskToApi_(r) {
  const out = taskToApiFull_(r);
  const desc = String(r[COL.DESC - 1] || '');
  const notes = String(r[COL.NOTES - 1] || '');
  out.desc = clip_(desc, DESC_PREVIEW);
  out.notes = clip_(notes, NOTES_PREVIEW);
  if (desc.length > DESC_PREVIEW) out.descMore = true;
  if (notes.length > NOTES_PREVIEW) out.notesMore = true;
  return out;
}

/** Full single-task read (small: ONE task) — { action:'taskDetail', id }. */
function apiTaskDetail_(user, req) {
  const rows = scopedRows_(user).filter(r => String(r[COL.ID - 1]).trim() === String(req.id || '').trim());
  if (!rows.length) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found in your scope.' };
  return { ok: true, task: taskToApiFull_(rows[0]) };
}

function taskToApiFull_(r) {
  const t = taskFromRow_(r);
  const tz = tzStr_();
  const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
  return {
    id: t.id, requester: t.requester, team: t.team, assignee: t.assignee,
    title: clip_(t.title, 500), desc: clip_(String(r[COL.DESC - 1] || ''), DETAIL_CAP), brief: t.brief,
    deliverable: t.deliverable, priority: t.priority, status: t.status,
    notes: clip_(t.notes, DETAIL_CAP), revisions: Number(r[COL.REVISIONS - 1]) || 0,
    created: (r[COL.CREATED - 1] instanceof Date) ? r[COL.CREATED - 1].toISOString() : null,
    completed: (r[COL.COMPLETED - 1] instanceof Date) ? r[COL.COMPLETED - 1].toISOString() : null,
    dueMs: due ? due.getTime() : null,
    dueDate: due ? Utilities.formatDate(due, tz, 'yyyy-MM-dd') : '',
    dueTime: due ? Utilities.formatDate(due, tz, 'HH:mm') : '',
    startedAt: (r[X.STARTED - 1] instanceof Date) ? r[X.STARTED - 1].toISOString() : null,
    stage: String(r[X.STAGE - 1] || ''),
    qcRounds: Number(r[X.QC_ROUNDS - 1]) || 0,
    reviewDays: Math.round((Number(r[X.REV_DAYS - 1]) || 0) * 10) / 10,
    flags: String(r[X.FLAGS - 1] || ''),
    renewedFrom: String(r[X.RENEWED_FROM - 1] || ''),
    briefPending: String(r[X.BRIEF_PENDING - 1] || '') === 'Yes',
  };
}

/** Scoping: Super Admin = all · Team Head = own team · Assigner = rows they
 *  requested · everyone else = rows assigned to them. */
function scopedRows_(user) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return [];
  const nCols = Math.max(LAST_COL, Math.min(LAST_COL2, master.getMaxColumns()));
  const rows = master.getRange(2, 1, lastRow - 1, nCols).getValues().filter(r => r[COL.ID - 1]);
  let scoped = rows;
  if (user.role === 'Team Head') scoped = rows.filter(r => String(r[COL.TEAM - 1]).trim() === user.team);
  else if (user.role === 'Assigner') scoped = rows.filter(r => String(r[COL.REQUESTER - 1]).trim() === user.name);
  else if (user.role !== 'Super Admin') scoped = rows.filter(r => String(r[COL.ASSIGNEE - 1]).trim() === user.name);
  return scoped;
}

function apiTasks_(user) {
  return scopedRows_(user).map(taskToApi_);
}

/** One page of the task list. { offset, limit } → { tasks, total, next } */
function apiTasksPage_(user, req) {
  const rows = scopedRows_(user);
  const total = rows.length;
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(req.limit) || 25)));
  const page = rows.slice(offset, offset + limit).map(taskToApi_);
  const next = offset + limit < total ? offset + limit : null;
  return { ok: true, tasks: page, total: total, next: next, serverTime: new Date().toISOString() };
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function parseDueParts_(dateStr, timeStr) {
  const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
  let dateCell = '';
  if (dm) {
    // tz-safe: midnight in the STUDIO tz (identical to new Date(...) only while
    // script tz == studio tz — which setup() asserts, but we don't rely on it).
    try { dateCell = Utilities.parseDate(dm[0] + ' 00:00', tzStr_(), 'yyyy-MM-dd HH:mm'); }
    catch (e) { dateCell = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])); }
  }
  return {
    dateCell: dateCell,
    timeCell: tm ? new Date(1899, 11, 30, Number(tm[1]), Number(tm[2])) : '',
  };
}

/** Leaving review: bank the working days used, clear Stage + Stage Since. */
function leaveReview_(master, row) {
  const r = fullRow_(master, row);
  const since = r[X.STAGE_SINCE - 1];
  if (since instanceof Date) {
    const used = (Number(r[X.REV_DAYS - 1]) || 0) + workDaysBetween_(since, new Date());
    master.getRange(row, X.REV_DAYS).setValue(Math.round(used * 1000) / 1000);
  }
  master.getRange(row, X.STAGE).setValue('');
  master.getRange(row, X.STAGE_SINCE).setValue('');
}

/** Assigners can't create same-day tasks at/after the evening cutoff. */
function createCutoff_(user, req) {
  if (user.role !== 'Assigner') return null;
  const tz = tzStr_();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const cutoff = String(cfg_('CREATE_CUTOFF', '17:00'));
  if (String(req.dueDate || '') === today && Utilities.formatDate(new Date(), tz, 'HH:mm') >= cutoff) {
    return { ok: false, error: 'VALIDATION', message: 'Same-day tasks close at ' + cutoff + ' — pick tomorrow or later, or call the team head for a genuine emergency.' };
  }
  return null;
}

/* ── writes ────────────────────────────────────────────────────────────── */

let BULK_QUIET = false;

function apiCreate_(user, req) {
  const title = String(req.title || '').trim();
  if (!title) return { ok: false, error: 'VALIDATION', message: 'Task title is required.' };
  let team = String(req.team || '').trim();
  let assignee = String(req.assignee || '').trim();
  if (assignee) {
    const m = roster_().filter(x => x.active && x.name === assignee);
    if (!m.length) return { ok: false, error: 'VALIDATION', message: 'Assignee not found in the Roster.' };
    team = m[0].team;
  }
  if (teams_().map(t => t.team).indexOf(team) === -1) return { ok: false, error: 'VALIDATION', message: 'Unknown team: ' + team };
  const due = parseDueParts_(req.dueDate, req.dueTime);
  if (!due.dateCell) return { ok: false, error: 'VALIDATION', message: 'A due date is required.' };

  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = nextId_(team);
  const row = master.getLastRow() + 1;
  master.getRange(row, 1, 1, 13).setValues([[
    id, new Date(), user.name, team, assignee, title,
    String(req.desc || ''), String(req.brief || ''), '',
    PRIORITIES.indexOf(String(req.priority)) > -1 ? String(req.priority) : 'Medium',
    'New', due.dateCell, due.timeCell,
  ]]);
  master.getRange(row, COL.REVISIONS, 1, 2).setValues([[0, '']]);

  let info;
  if (BULK_QUIET) {
    info = 'created (bulk)';
  } else if (assignee) {
    notifyAssignee_(master, row, 'assigned');
    info = 'assignment alert emailed to ' + assignee;
  } else {
    const task = taskAt_(master, row);
    const to = headsOf_(team).map(h => h.email).join(',') || ownerEmail_();
    safeSend_(to, '[Task] 🙋 New ' + team + ' task needs an assignee — ' + id,
      taskCard_(task, '#8e44ad', 'New task waiting for assignment',
        '<p><b>' + esc_(user.name) + '</b> added this from the dashboard. Assign it and the member is notified automatically.</p>'), '', 'needs-assignee');
    to.split(',').forEach(function (em) { pushToEmail_(em.trim(), 'New ' + team + ' task needs an assignee', id + ' · ' + task.title, { taskId: id, kind: 'review' }); });
    info = 'sent to the ' + team + ' head for assignment';
  }
  log_('api-create', id, user.email, info, true);
  return { ok: true, info: info, task: taskToApi_(fullRow_(master, row)) };
}

/** Delete: Super Admin / Team Head, or the Assigner-requester while the task is
 *  still New and unstarted. A copy lands in Archive first — nothing is lost. */
function apiDelete_(user, req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const master = ss.getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found (it may already be deleted or archived).' };
  const cur = master.getRange(row, 1, 1, VISIBLE_COLS).getValues()[0];
  const team = String(cur[COL.TEAM - 1]).trim();
  const isReqD = user.role === 'Assigner' && String(cur[COL.REQUESTER - 1]).trim() === user.name;
  if (!canManage_(user, team) && !isReqD) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can delete tasks.' };
  if (isReqD && !canManage_(user, team)) {
    const fullD = fullRow_(master, row);
    if (String(cur[COL.STATUS - 1]).trim() !== 'New' || (fullD[X.STARTED - 1] instanceof Date)) {
      return { ok: false, error: 'VALIDATION', message: 'The team has already started this one — use ✗ Reject (with a reason) instead of deleting.' };
    }
  }

  const stamp = '[DELETED by ' + user.name + ' on ' + Utilities.formatDate(new Date(), tzStr_(), 'dd MMM yyyy HH:mm') + '] ';
  cur[COL.NOTES - 1] = stamp + String(cur[COL.NOTES - 1] || '');
  ss.getSheetByName(SHEETS.ARCHIVE).appendRow(cur);
  master.deleteRow(row);
  log_('api-delete', id, user.email, String(cur[COL.TITLE - 1]), true);
  return { ok: true, deletedId: id };
}

function apiUpdate_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found (it may have been archived).' };

  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const curAssignee = String(cur[COL.ASSIGNEE - 1]).trim();
  const curStatus = String(cur[COL.STATUS - 1]).trim();
  const manage = canManage_(user, team);
  const isMine = curAssignee === user.name;
  const isReqA = user.role === 'Assigner' && String(cur[COL.REQUESTER - 1]).trim() === user.name;
  if (!manage && !isMine && !isReqA) return { ok: false, error: 'FORBIDDEN', message: 'You can only update your own tasks.' };

  const p = req.patch || {};
  if (isReqA && !manage && !isMine) {
    const allowedA = ['status', 'brief', 'priority', 'notes', 'dueDate', 'dueTime'];
    for (const k in p) {
      if (allowedA.indexOf(k) === -1) return { ok: false, error: 'FORBIDDEN', message: 'As the requester you can change the verdict, brief, priority and deadline — "' + k + '" belongs to the team.' };
    }
    if (p.status !== undefined) {
      if (['Done', 'Revisions'].indexOf(String(p.status)) === -1) return { ok: false, error: 'FORBIDDEN', message: 'Your call is ✓ Approve (Done) or ↺ send changes (Revisions) — other statuses are the team\'s.' };
      if (curStatus !== 'In Review' || String(cur[X.STAGE - 1] || '') !== 'Assigner') return { ok: false, error: 'VALIDATION', message: 'This task hasn\'t reached you yet — the team is still on it.' };
    }
    if ((p.dueDate !== undefined || p.dueTime !== undefined) && ['Done', 'Rejected'].indexOf(curStatus) > -1) return { ok: false, error: 'VALIDATION', message: 'This task is closed — renew or create a new one instead.' };
  } else if (!manage && !isReqA) {
    const allowed = ['status', 'deliverable', 'notes', 'dueDate', 'dueTime'];
    for (const k in p) {
      if (allowed.indexOf(k) === -1) return { ok: false, error: 'FORBIDDEN', message: 'Only your team head can change "' + k + '".' };
    }
    if (p.status === 'Done' || p.status === 'Rejected') return { ok: false, error: 'FORBIDDEN', message: p.status === 'Done' ? 'Set it to In Review — your team head marks it Done.' : 'Only the team head or super admin can reject a task.' };
  }
  if (p.status !== undefined && STATUSES_ALL.indexOf(String(p.status)) === -1) return { ok: false, error: 'VALIDATION', message: 'Unknown status.' };
  if (p.priority !== undefined && PRIORITIES.indexOf(String(p.priority)) === -1) return { ok: false, error: 'VALIDATION', message: 'Unknown priority.' };

  if (p.status === 'In Review' && String(p.status) !== curStatus) {
    if (!(cur[X.STARTED - 1] instanceof Date) && !(manage && p.startedAt)) return { ok: false, error: 'VALIDATION', message: 'Press ▶ Start work first — it stamps the start time. (Heads can also type the real start time in the task card and save.)' };
    if (String(cur[X.BRIEF_PENDING - 1]) === 'Yes' && !manage) return { ok: false, error: 'VALIDATION', message: 'The brief was updated — press “Accept updated brief” on the task first.' };
  }

  const notes = [];

  if (manage && p.assignee !== undefined) {
    const a = String(p.assignee || '').trim();
    if (a) {
      const m = roster_().filter(x => x.active && x.name === a && x.team === team);
      if (!m.length) return { ok: false, error: 'VALIDATION', message: 'Assignee must be an active ' + team + ' member.' };
    }
    master.getRange(row, COL.ASSIGNEE).setValue(a);
    if (a && a !== curAssignee) { notifyAssignee_(master, row, 'assigned'); notes.push('assignment alert emailed to ' + a); }
  }
  if ((manage || isReqA) && p.priority !== undefined) master.getRange(row, COL.PRIORITY).setValue(String(p.priority));
  if ((manage || isReqA) && p.brief !== undefined) {
    const newBrief = String(p.brief);
    master.getRange(row, COL.BRIEF).setValue(newBrief);
    if (newBrief !== String(cur[COL.BRIEF - 1] || '') && (cur[X.STARTED - 1] instanceof Date) && ['Done', 'Rejected'].indexOf(curStatus) === -1) {
      master.getRange(row, X.BRIEF_PENDING).setValue('Yes');
      cycle_(id, 'brief-edit', user.name, '');
      const aEmail = emailByName_(curAssignee);
      if (aEmail && aEmail !== user.email) safeSend_(aEmail, '[Task] ✍️ Brief updated — ' + id,
        taskCard_(taskAt_(master, row), '#e67e22', 'The brief changed mid-work',
          '<p><b>' + esc_(user.name) + '</b> updated the brief after you started. Open the task and press <b>Accept updated brief</b> to continue — this keeps everyone honest about scope.</p>'), '', 'brief-updated');
      pushToEmail_(aEmail, 'Brief changed mid-work', id + ' · ' + user.name + ' updated the brief', { taskId: id, kind: 'brief' });
      notes.push('brief flagged for re-accept');
    }
  }

  if (p.startedAt !== undefined) {
    if (!manage) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head or super admin can set or backdate the start time.' };
    const sd = new Date(String(p.startedAt));
    if (isNaN(sd.getTime())) return { ok: false, error: 'VALIDATION', message: 'Start time not understood — use the date-time picker.' };
    if (sd.getTime() > Date.now() + 10 * 60000) return { ok: false, error: 'VALIDATION', message: 'The start time can\'t be in the future.' };
    const oldSd = (cur[X.STARTED - 1] instanceof Date) ? cur[X.STARTED - 1].toISOString() : 'none';
    master.getRange(row, X.STARTED).setValue(sd);
    cycle_(id, 'start-backdated', user.name, oldSd + ' -> ' + sd.toISOString());
    notes.push('start time set (logged)');
  }

  if (p.dueDate !== undefined || p.dueTime !== undefined) {
    const due = parseDueParts_(p.dueDate, p.dueTime);
    if (due.dateCell) master.getRange(row, COL.DUE_DATE).setValue(due.dateCell);
    master.getRange(row, COL.DUE_TIME).setValue(due.timeCell);
    master.getRange(row, COL.H_REMINDED, 1, 3).clearContent(); // re-arm reminders + overdue ladder
    if (manage) {
      notifyAssignee_(master, row, 'due-changed');
      notes.push('reschedule alert emailed');
    } else {
      // a member (or requester) moved the deadline — keep the head in the loop
      const heads = headsOf_(team).map(h => h.email).join(',');
      const task = taskAt_(master, row);
      if (heads) safeSend_(heads, '[Task] 📅 ' + user.name + ' rescheduled ' + id,
        taskCard_(task, '#e67e22', 'Deadline moved by the assignee',
          '<p><b>' + esc_(user.name) + '</b> moved this task to <b>' + esc_(task.dueStr) + '</b> from the dashboard.</p>'), '', 'reschedule-head');
      notes.push('team head notified of the move');
    }
  }
  if (p.deliverable !== undefined) {
    const newDel = String(p.deliverable);
    master.getRange(row, COL.DELIVERABLE).setValue(newDel);
    if (newDel && newDel !== String(cur[COL.DELIVERABLE - 1] || '')) {
      const hadBefore = String(cur[COL.DELIVERABLE - 1] || '') !== '';
      const v = addVersion_(id, newDel, user.name, String(req.fileId || ''), hadBefore);
      cycle_(id, 'version', user.name, 'v' + v);
      notes.push('saved as v' + v);
    }
  }
  if (p.notes !== undefined) master.getRange(row, COL.NOTES).setValue(String(p.notes));

  if (p.status !== undefined && String(p.status) !== curStatus) {
    const s = String(p.status);
    master.getRange(row, COL.STATUS).setValue(s);
    if (s === 'Done') {
      leaveReview_(master, row);
      cycle_(id, 'approve', user.name, '');
      master.getRange(row, COL.COMPLETED).setValue(new Date());
      if (yes_('NOTIFY_REQUESTER_ON_DONE')) { notifyDone_(master, row); notes.push('requester + head notified'); }
      portfolioCapture_(master, row);   // grab the still while the file is alive
    } else {
      if (curStatus === 'Done') master.getRange(row, COL.COMPLETED).clearContent();
      if (curStatus === 'Done') portfolioRemove_(id);   // no longer finished work
      if (curStatus === 'In Review' && s !== 'Revisions') leaveReview_(master, row);
      if (s === 'In Progress') {
        if (!(cur[X.STARTED - 1] instanceof Date)) master.getRange(row, X.STARTED).setValue(new Date());
        cycle_(id, curStatus === 'Revisions' ? 'accepted' : 'start', user.name, '');
      }
      if (s === 'Revisions') {
        const wasQC = String(cur[X.STAGE - 1] || '') === 'QC';
        if (wasQC) {
          const qc = master.getRange(row, X.QC_ROUNDS);
          qc.setValue((Number(qc.getValue()) || 0) + 1);
          cycle_(id, 'changes-sent', user.name, 'QC round');
          notes.push('sent back at QC (does not use the round limit)');
        } else {
          const rc = master.getRange(row, COL.REVISIONS);
          const n = (Number(rc.getValue()) || 0) + 1;
          rc.setValue(n);
          const maxR = Number(cfg_('MAX_ROUNDS', 3)) || 3;
          if (n > maxR) { addFlag_(master, row, 'over-limit'); notes.push('⚠ round ' + n + ' — over the ' + maxR + '-round limit'); }
          cycle_(id, 'changes-sent', user.name, 'round ' + n);
        }
        leaveReview_(master, row);
        const slotAt = slotDue_(new Date());
        const tzS = tzStr_();
        const dueP = parseDueParts_(Utilities.formatDate(slotAt, tzS, 'yyyy-MM-dd'), Utilities.formatDate(slotAt, tzS, 'HH:mm'));
        if (dueP.dateCell) master.getRange(row, COL.DUE_DATE).setValue(dueP.dateCell);
        master.getRange(row, COL.DUE_TIME).setValue(dueP.timeCell);
        master.getRange(row, COL.H_REMINDED, 1, 3).clearContent();
        notes.push('deadline auto-set: ' + Utilities.formatDate(slotAt, tzS, 'EEE d MMM, h:mm a'));
        notifyAssignee_(master, row, 'revision');
        notes.push('revision alert emailed');
      }
      if (s === 'In Review') {
        const stage = manage ? 'Assigner' : 'QC';
        master.getRange(row, X.STAGE).setValue(stage);
        master.getRange(row, X.STAGE_SINCE).setValue(new Date());
        cycle_(id, 'in-review', user.name, stage === 'Assigner' ? 'straight to assigner (submitted by manager)' : 'QC first');
        const task = taskAt_(master, row);
        if (stage === 'QC') {
          const heads = headsOf_(team).map(function (h) { return h.email; }).filter(function (em) { return em && em !== user.email; }).join(',');
          if (heads) safeSend_(heads, '[Task] 🔎 QC check — ' + id + ': ' + task.title,
            taskCard_(task, '#5b5bd6', 'Quality-check this first',
              '<p><b>' + esc_(user.name) + '</b> finished this task. Open the review room, check it, then <b>✓ Pass QC</b> to send it to the requester — or send changes back.</p>' + roomBtn_(id)), '', 'qc-request');
          heads.split(',').forEach(function (em) { pushToEmail_(em.trim(), 'Ready to QC', id + ' · ' + task.title, { taskId: id, kind: 'review', urgency: 'high' }); });
          notes.push('head asked to QC');
        } else {
          pingRequester_(master, row, team, user, task);
          notes.push('requester pinged to review');
        }
      }
    }
  }

  log_('api-update', id, user.email, notes.join('; '), true);
  return { ok: true, info: notes.join(' · '), task: taskToApi_(fullRow_(master, row)) };
}

/** Reject — reason mandatory, lands in Notes + everyone's inbox. */
function apiRejectTask_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'VALIDATION', message: 'A reject needs a reason — one honest line.' };
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const isReqR = user.role === 'Assigner' && String(cur[COL.REQUESTER - 1]).trim() === user.name;
  if (!canManage_(user, team) && !isReqR) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can reject a task.' };
  if (String(cur[COL.STATUS - 1]).trim() === 'Done') return { ok: false, error: 'VALIDATION', message: 'This task is already Done — reopen it first if it truly must be rejected.' };
  leaveReview_(master, row);
  cycle_(id, 'reject', user.name, reason.slice(0, 60));
  master.getRange(row, COL.STATUS).setValue('Rejected');
  const oldNotes = String(cur[COL.NOTES - 1] || '');
  master.getRange(row, COL.NOTES).setValue(('✗ Rejected by ' + user.name + ' — ' + reason + (oldNotes ? '\n' + oldNotes : '')).slice(0, 4000));
  const task = taskAt_(master, row);
  const to = [emailByName_(String(cur[COL.ASSIGNEE - 1]).trim())]
    .concat(headsOf_(team).map(function (h) { return h.email; }))
    .filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== user.email; }).join(',');
  if (to) safeSend_(to, '[Task] ✗ Rejected — ' + id + ': ' + task.title,
    taskCard_(task, '#c0392b', 'Task rejected',
      '<p><b>' + esc_(user.name) + '</b> rejected this task.</p><p style="background:#fdecea;border-radius:8px;padding:10px 12px"><b>Reason:</b> ' + esc_(reason) + '</p><p>The task stays in the sheet for the record — it does not count as Done.</p>'), '', 'rejected');
    to.split(',').forEach(function (em) { pushToEmail_(em.trim(), 'Task rejected', id + ' · ' + reason.slice(0, 90), { taskId: id, kind: 'rejected', urgency: 'high' }); });
  log_('reject', id, user.email, reason.slice(0, 80), true);
  return { ok: true, task: taskToApi_(fullRow_(master, row)) };
}

/** Start work. Starting an UNASSIGNED task on your own team claims it. */
function apiStartTask_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const assignee = String(cur[COL.ASSIGNEE - 1]).trim();
  const mine = assignee === user.name;
  const teammate = user.team === team && user.role !== 'Assigner';
  if (!mine && !canManage_(user, team) && !(teammate && !assignee)) {
    return { ok: false, error: 'FORBIDDEN', message: assignee ? 'This task is assigned to ' + assignee + ' — only they (or the head) can start it.' : 'Only the ' + team + ' team can start this task.' };
  }
  const st = String(cur[COL.STATUS - 1]).trim();
  if (['Done', 'Rejected', 'In Review'].indexOf(st) > -1) return { ok: false, error: 'VALIDATION', message: 'This task is in ' + st + ' — nothing to start.' };
  let claimed = false;
  if (!assignee && user.role !== 'Assigner') {
    master.getRange(row, COL.ASSIGNEE).setValue(user.name);
    claimed = true;
  }
  if (!(cur[X.STARTED - 1] instanceof Date)) master.getRange(row, X.STARTED).setValue(new Date());
  if (st === 'New' || st === 'On Hold') master.getRange(row, COL.STATUS).setValue('In Progress');
  cycle_(id, st === 'Revisions' ? 'accepted' : 'start', user.name, claimed ? 'claimed unassigned task' : '');
  if (claimed) {
    try {
      const task = taskAt_(master, row);
      const to = headsOf_(team).map(function (h) { return h.email; }).filter(function (em) { return em && em !== user.email; }).join(',');
      if (to) safeSend_(to, '[Task] 🙋 ' + user.name + ' picked up ' + id,
        taskCard_(task, '#5c8a72', 'Unassigned task claimed',
          '<p><b>' + esc_(user.name) + '</b> started this unassigned task — it\'s now theirs. Reassign it from the dashboard if that\'s wrong.</p>'), '', 'claimed');
    } catch (e) {}
  }
  log_('start', id, user.email, claimed ? 'claimed' : '', true);
  const out = { ok: true, task: taskToApi_(fullRow_(master, row)) };
  if (claimed) out.info = 'it was unassigned — it\'s yours now, head notified';
  return out;
}

function apiAcceptChanges_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  if (String(cur[COL.ASSIGNEE - 1]).trim() !== user.name && !canManage_(user, team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee can accept the changes.' };
  if (String(cur[COL.STATUS - 1]).trim() !== 'Revisions') return { ok: false, error: 'VALIDATION', message: 'This task is not in a revision round.' };
  master.getRange(row, COL.STATUS).setValue('In Progress');
  cycle_(id, 'accepted', user.name, '');
  return { ok: true, task: taskToApi_(fullRow_(master, row)) };
}

function apiQcPass_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  if (!canManage_(user, team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head or super admin can pass QC.' };
  if (String(cur[COL.STATUS - 1]).trim() !== 'In Review') return { ok: false, error: 'VALIDATION', message: 'This task is not in review.' };
  if (String(cur[X.STAGE - 1] || '') === 'Assigner') return { ok: false, error: 'VALIDATION', message: 'Already with the requester.' };
  master.getRange(row, X.STAGE).setValue('Assigner');
  cycle_(id, 'qc-pass', user.name, '');
  const task = taskAt_(master, row);
  const pinged = pingRequester_(master, row, team, user, task);
  log_('qc-pass', id, user.email, pinged ? 'requester pinged' : 'no requester email', true);
  return { ok: true, task: taskToApi_(fullRow_(master, row)), info: pinged ? 'passed QC · requester emailed a review link' : 'passed QC (requester has no email in the Roster — share the room link yourself)' };
}

/** Renew an auto-done task as a fresh, counted task due next workday at SLOT_EVE. */
function apiRenewTask_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const mine = String(cur[COL.ASSIGNEE - 1]).trim() === user.name;
  if (!mine && !canManage_(user, team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee or head can renew this task.' };
  if (!hasFlag_(cur, 'auto-done')) return { ok: false, error: 'VALIDATION', message: 'Renewal is only for tasks that auto-closed because the review window ran out.' };
  const tz = tzStr_();
  const nd = atLocal_(nextWorkDay_(new Date()), String(cfg_('SLOT_EVE', '17:00')));
  const made = apiCreate_(user, {
    team: team,
    assignee: String(cur[COL.ASSIGNEE - 1]).trim(),
    title: String(cur[COL.TITLE - 1]) + ' — renewal',
    desc: String(cur[COL.DESC - 1] || ''),
    brief: String(cur[COL.BRIEF - 1] || ''),
    priority: String(cur[COL.PRIORITY - 1] || 'Medium'),
    dueDate: Utilities.formatDate(nd, tz, 'yyyy-MM-dd'),
    dueTime: Utilities.formatDate(nd, tz, 'HH:mm'),
  });
  if (!made.ok) return made;
  const nrow = rowById_(master, made.task.id);
  if (nrow) master.getRange(nrow, X.RENEWED_FROM).setValue(id);
  cycle_(id, 'renewed', user.name, '-> ' + made.task.id);
  cycle_(made.task.id, 'renewal-of', user.name, id);
  log_('renew', id, user.email, '-> ' + made.task.id, true);
  made.task.renewedFrom = id;
  made.info = 'renewed as ' + made.task.id + ' — counted in reports';
  return made;
}

function apiAcceptBrief_(user, req) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const id = String(req.id || '').trim();
  const row = rowById_(master, id);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + id + ' was not found.' };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  if (String(cur[COL.ASSIGNEE - 1]).trim() !== user.name && !canManage_(user, team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee accepts the updated brief.' };
  master.getRange(row, X.BRIEF_PENDING).setValue('');
  cycle_(id, 'brief-accept', user.name, '');
  return { ok: true, task: taskToApi_(fullRow_(master, row)) };
}

/** Bulk creation — per-row validation + cutoff, ONE digest email per team. */
function apiBulkCreate_(user, req) {
  if (['Assigner', 'Team Head', 'Super Admin'].indexOf(user.role) === -1) {
    return { ok: false, error: 'FORBIDDEN', message: 'Bulk add is for requesters and heads.' };
  }
  const rows = (req.rows || []).slice(0, 50);
  if (!rows.length) return { ok: false, error: 'VALIDATION', message: 'No rows to create.' };
  const created = [], errors = [];
  BULK_QUIET = true;
  try {
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i] || {};
      const cut = createCutoff_(user, x);
      if (cut) { errors.push({ i: i, title: String(x.title || ''), message: cut.message }); continue; }
      const r2 = apiCreate_(user, x);
      if (r2.ok) created.push(r2.task);
      else errors.push({ i: i, title: String(x.title || ''), message: r2.message });
    }
  } finally { BULK_QUIET = false; }
  /* one digest per team */
  try {
    const byTeam = {};
    created.forEach(function (t) { (byTeam[t.team] = byTeam[t.team] || []).push(t); });
    Object.keys(byTeam).forEach(function (team) {
      const list = byTeam[team];
      const to = headsOf_(team).map(function (h) { return h.email; }).join(',');
      if (!to) return;
      const rowsHtml = list.map(function (t) {
        return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap"><b>' + esc_(t.id) + '</b></td><td style="padding:6px 10px;border-bottom:1px solid #eee">' + esc_(t.title) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">' + esc_(t.dueDate) + '</td></tr>';
      }).join('');
      safeSend_(to, '[Task] 🧺 ' + list.length + ' new ' + team + ' task' + (list.length > 1 ? 's' : '') + ' from ' + user.name,
        baseCard_('#8e44ad', list.length + ' tasks added in bulk',
          '<p><b>' + esc_(user.name) + '</b> added these from the dashboard — assign the unassigned ones and everyone gets notified as usual.</p><table style="border-collapse:collapse;font-size:13px;width:100%">' + rowsHtml + '</table>'), '', 'bulk-digest');
    });
  } catch (e) {}
  log_('bulk-create', created.map(function (t) { return t.id; }).join(' '), user.email, created.length + ' created, ' + errors.length + ' errors', true);
  return { ok: true, created: created, errors: errors };
}
