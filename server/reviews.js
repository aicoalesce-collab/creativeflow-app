/**
 * reviews.js — the Review Room: timestamped video markers, image pins,
 * comments, send-changes, plus the public guest (share-token) endpoints.
 * Ported from Api.gs v2.7; locking moved to the dispatch wrapper.
 */

const REVIEW_HEADERS = ['ID', 'Task ID', 'Type', 'Timecode', 'X%', 'Y%', 'Author', 'Guest', 'Text', 'Status', 'Created', 'Resolved By', 'Resolved At', 'Version'];

function reviewsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.REVIEWS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.REVIEWS);
    sh.getRange(1, 1, 1, REVIEW_HEADERS.length).setValues([REVIEW_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function reviewRowToObj_(r) {
  return {
    id: String(r[0]), taskId: String(r[1]), type: String(r[2]),
    tc: r[3] === '' ? null : Number(r[3]), x: r[4] === '' ? null : Number(r[4]), y: r[5] === '' ? null : Number(r[5]),
    author: String(r[6]), guest: String(r[7]) === 'Yes', text: String(r[8]),
    status: String(r[9]), created: (r[10] instanceof Date) ? r[10].toISOString() : String(r[10]),
    version: Number(r[13]) || 1,
  };
}

function reviewsFor_(taskId) {
  const sh = reviewsSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, REVIEW_HEADERS.length).getValues()
    .filter(function (r) { return String(r[1]) === taskId; }).map(reviewRowToObj_);
}

/** Task access for review actions (mirrors task scoping, plus requesters).
 *  decide = may add markers / send changes / approve: heads always, assigners
 *  only once the task has reached them (Assigner stage, In Review). */
function taskRowIfAllowed_(user, taskId) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const row = rowById_(master, taskId);
  if (!row) return { err: { ok: false, error: 'NOT_FOUND', message: 'Task ' + taskId + ' was not found.' } };
  const cur = fullRow_(master, row);
  const team = String(cur[COL.TEAM - 1]).trim();
  const isReq = String(cur[COL.REQUESTER - 1]).trim() === user.name;
  const allowed = user.role === 'Super Admin' || (user.role === 'Team Head' && user.team === team) ||
    String(cur[COL.ASSIGNEE - 1]).trim() === user.name || isReq;
  if (!allowed) return { err: { ok: false, error: 'FORBIDDEN', message: 'This task is outside your scope.' } };
  const manage = canManage_(user, team);
  const stage = String(cur[X.STAGE - 1] || '');
  const own = manage || (user.role === 'Assigner' && isReq);
  const decide = manage || (user.role === 'Assigner' && isReq && stage === 'Assigner' && String(cur[COL.STATUS - 1]).trim() === 'In Review');
  return { row: row, cur: cur, team: team, manage: manage, own: own, decide: decide, isReq: isReq, stage: stage };
}

function nextReviewId_() {
  const sh = reviewsSheet_();
  let max = 0;
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).match(/^RV-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return 'RV-' + ('00000' + (max + 1)).slice(-5);
}

function apiListReview_(user, req) {
  const t = taskRowIfAllowed_(user, String(req.taskId || '').trim());
  if (t.err) return t.err;
  const out = { ok: true, items: reviewsFor_(String(req.taskId).trim()), canManage: t.manage, versions: versionsFor_(String(req.taskId).trim()) };
  if (t.manage) {
    const sh = sharesSheet_();
    out.shares = sh.getLastRow() < 2 ? [] :
      sh.getRange(2, 1, sh.getLastRow() - 1, SHARE_HEADERS.length).getValues()
        .filter(function (r) { return String(r[1]) === String(req.taskId).trim() && String(r[5]) !== 'Yes'; })
        .map(function (r) { return { token: String(r[0]), mode: String(r[2]), created: (r[4] instanceof Date) ? r[4].toISOString() : '' }; });
  }
  return out;
}

function apiAddReview_(user, req) {
  const taskId = String(req.taskId || '').trim();
  const t = taskRowIfAllowed_(user, taskId);
  if (t.err) return t.err;
  const type = String(req.type || 'comment');
  if (['comment', 'marker', 'pin'].indexOf(type) === -1) return { ok: false, error: 'VALIDATION', message: 'Bad type.' };
  if (type !== 'comment' && !t.decide) return { ok: false, error: 'FORBIDDEN', message: t.isReq && t.stage !== 'Assigner' ? 'The team is still on its internal check — you can comment now and mark changes once it reaches you.' : 'Only the team head, super admin or the task\'s requester (at review stage) can add change markers.' };
  const text = String(req.text || '').trim();
  if (!text) return { ok: false, error: 'VALIDATION', message: 'Write something first.' };
  const id = nextReviewId_();
  const rowVals = [
    id, taskId, type,
    (type === 'marker' && req.tc != null) ? Number(req.tc) : '',
    (type === 'pin' && req.x != null) ? Number(req.x) : '',
    (type === 'pin' && req.y != null) ? Number(req.y) : '',
    user.name, '', text, (type === 'comment') ? '' : 'Open', new Date(), '', '',
    Number(req.version) || latestVersionOf_(taskId),
  ];
  reviewsSheet_().appendRow(rowVals);
  if (type === 'comment') {
    const assignee = String(t.cur[COL.ASSIGNEE - 1]).trim();
    const requester = String(t.cur[COL.REQUESTER - 1]).trim();
    /* Balanced: the two people actually doing the work, not the whole chain,
       and at most one email per task per hour however many comments land. */
    const wide = mailLevel_() === 'all';
    const people = [emailByName_(assignee), emailByName_(requester)]
      .concat(wide ? headsOf_(t.team).map(function (h) { return h.email; }) : []);
    const to = people.filter(function (x, i, a) { return x && a.indexOf(x) === i && x !== user.email; }).join(',');
    const throttled = !wide && mailThrottled_('cmt_' + taskId, 60);
    if (throttled) log_('held-throttle', taskId, to, 'comment burst on ' + taskId, true);
    if (to && !throttled) safeSend_(to, '[Task] 💬 New comment on ' + taskId,
      baseCard_('#5b5bd6', 'New comment · ' + taskId,
        '<p><b>' + esc_(user.name) + '</b> commented on “' + esc_(String(t.cur[COL.TITLE - 1])) + '”:</p><p style="background:#f4f4f0;border-radius:8px;padding:10px 12px">' + esc_(text) + '</p>'), '', 'comment');
  }
  log_('review-add', taskId, user.email, type + ': ' + text.slice(0, 60), true);
  return { ok: true, item: reviewRowToObj_(rowVals) };
}

function findReviewRow_(id) {
  const sh = reviewsSheet_();
  if (sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

function apiResolveReview_(user, req) {
  const sh = reviewsSheet_();
  const row = findReviewRow_(String(req.id || ''));
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Marker not found.' };
  const r = sh.getRange(row, 1, 1, REVIEW_HEADERS.length).getValues()[0];
  const t = taskRowIfAllowed_(user, String(r[1]));
  if (t.err) return t.err;
  if (!t.decide && !t.manage) return { ok: false, error: 'FORBIDDEN', message: 'Only reviewers can resolve markers.' };
  const resolved = req.resolved !== false;
  sh.getRange(row, 10).setValue(resolved ? 'Resolved' : 'Open');
  sh.getRange(row, 12).setValue(resolved ? user.name : '');
  sh.getRange(row, 13).setValue(resolved ? new Date() : '');
  return { ok: true, item: reviewRowToObj_(sh.getRange(row, 1, 1, REVIEW_HEADERS.length).getValues()[0]) };
}

function apiDeleteReview_(user, req) {
  const sh = reviewsSheet_();
  const row = findReviewRow_(String(req.id || ''));
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Entry not found.' };
  const r = sh.getRange(row, 1, 1, REVIEW_HEADERS.length).getValues()[0];
  const t = taskRowIfAllowed_(user, String(r[1]));
  if (t.err) return t.err;
  if (!t.manage && !t.decide && String(r[6]) !== user.name) return { ok: false, error: 'FORBIDDEN', message: 'You can only delete your own entries.' };
  sh.deleteRow(row);
  return { ok: true, deletedId: String(r[0]) };
}

function tcStr_(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
}

/** Send every open marker to the assignee as a change list (drives Revisions). */
function apiSendChanges_(user, req) {
  const taskId = String(req.taskId || '').trim();
  const t = taskRowIfAllowed_(user, taskId);
  if (t.err) return t.err;
  if (!t.decide) return { ok: false, error: 'FORBIDDEN', message: t.isReq && t.stage !== 'Assigner' ? 'This is still in the internal check — the head sends it to you first.' : 'Only reviewers can send changes.' };
  const open = reviewsFor_(taskId).filter(function (i) { return i.type !== 'comment' && i.status === 'Open'; });
  if (!open.length) return { ok: false, error: 'VALIDATION', message: 'No open markers to send — add change markers first.' };

  const upd = apiUpdate_(user, { id: taskId, patch: { status: 'Revisions' } });
  if (!upd.ok) return upd;

  let n = 0;
  const rows = open.map(function (i) {
    n++;
    const where = (i.type === 'marker') ? '⏱ ' + tcStr_(i.tc) : '📍 pin #' + n;
    return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap"><b>' + where + '</b></td><td style="padding:6px 10px;border-bottom:1px solid #eee;">' + esc_(i.text) + '</td></tr>';
  }).join('');
  const assignee = String(t.cur[COL.ASSIGNEE - 1]).trim();
  const to = emailByName_(assignee);
  const cc = headsOf_(t.team).map(function (h) { return h.email; }).filter(function (e) { return e && e !== to; }).join(',');
  if (to) safeSend_(to, '[Task] 🔁 ' + open.length + ' change' + (open.length > 1 ? 's' : '') + ' requested — ' + taskId,
    baseCard_('#8e44ad', open.length + ' change' + (open.length > 1 ? 's' : '') + ' on “' + esc_(String(t.cur[COL.TITLE - 1])) + '”',
      '<p><b>' + esc_(user.name) + '</b> reviewed your work. Open the Review room in CreativeFlow to see each point in place.</p>' +
      '<table style="border-collapse:collapse;font-size:13px;width:100%">' + rows + '</table>'), cc, 'send-changes');
  log_('send-changes', taskId, user.email, open.length + ' markers', true);
  return { ok: true, count: open.length, task: upd.task };
}

/* ── public guest endpoints (token-scoped, no login) ───────────────────── */

function apiGuestReview_(req) {
  const share = shareByToken_(String(req.token || '').trim());
  if (!share) return { ok: false, error: 'AUTH', message: 'This review link is invalid or has been revoked.' };
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const row = rowById_(master, share.taskId);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'This review is no longer available.' };
  const cur = master.getRange(row, 1, 1, VISIBLE_COLS).getValues()[0];
  return {
    ok: true, mode: share.mode,
    task: {
      id: share.taskId,
      title: String(cur[COL.TITLE - 1]),
      team: String(cur[COL.TEAM - 1]),
      deliverable: String(cur[COL.DELIVERABLE - 1]),
      brief: String(cur[COL.BRIEF - 1]),
    },
    items: reviewsFor_(share.taskId),
    versions: versionsFor_(share.taskId),
    org: String(cfg_('ORG_NAME', 'CreativeFlow')),
    googleApiKey: String(cfg_('GOOGLE_API_KEY', '')),
  };
}

function apiGuestComment_(req) {
  const share = shareByToken_(String(req.token || '').trim());
  if (!share) return { ok: false, error: 'AUTH', message: 'This review link is invalid or has been revoked.' };
  if (share.mode !== 'comment') return { ok: false, error: 'FORBIDDEN', message: 'This link is view-only.' };
  const name = String(req.name || '').trim().slice(0, 40);
  const text = String(req.text || '').trim().slice(0, 2000);
  if (name.length < 2) return { ok: false, error: 'VALIDATION', message: 'Enter your name first.' };
  if (!text) return { ok: false, error: 'VALIDATION', message: 'Write something first.' };
  const id = nextReviewId_();
  const rowVals = [id, share.taskId, 'comment', '', '', '', name, 'Yes', text, '', new Date(), '', '', latestVersionOf_(share.taskId)];
  reviewsSheet_().appendRow(rowVals);
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const row = rowById_(master, share.taskId);
  if (row) {
    const cur = master.getRange(row, 1, 1, VISIBLE_COLS).getValues()[0];
    const team = String(cur[COL.TEAM - 1]).trim();
    const to = [emailByName_(String(cur[COL.ASSIGNEE - 1]).trim())]
      .concat(headsOf_(team).map(function (h) { return h.email; }))
      .filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(',');
    if (to) safeSend_(to, '[Task] 💬 Client comment on ' + share.taskId,
      baseCard_('#eb5b2d', 'Guest comment · ' + share.taskId,
        '<p><b>' + esc_(name) + '</b> (via share link) commented on “' + esc_(String(cur[COL.TITLE - 1])) + '”:</p><p style="background:#f4f4f0;border-radius:8px;padding:10px 12px">' + esc_(text) + '</p>'), '', 'guest-comment');
  }
  log_('guest-comment', share.taskId, name, text.slice(0, 60), true);
  return { ok: true, item: reviewRowToObj_(rowVals) };
}
