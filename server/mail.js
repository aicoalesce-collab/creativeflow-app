/**
 * mail.js — email building + the v5 send queue.
 *
 * v5 change: handlers still call safeSend_(to, subject, html, cc) exactly like
 * the old code, but safeSend_ only QUEUES. The dispatch wrapper (main.js) and
 * every trigger entry point call flushMailQueue_() AFTER LockService is
 * released — the old system serialized all writes behind SMTP for seconds.
 *
 * Three safety layers (all logged to Alerts Log):
 *  1. Recipient guard  — @example.com addresses are silently dropped (old).
 *  2. Actor guard      — if the authed user driving this request has an
 *                        @example.com email (Test Bot), nothing is sent (new).
 *  3. EMAIL_MUTE=YES   — Config switch: everything is logged, nothing sent (new).
 */

let MAIL_QUEUE = [];
let CURRENT_ACTOR = ''; // set by dispatch for authed calls; '' for triggers/public

/**
 * EMAIL_LEVEL (Config) decides how chatty the system is. Volume matters: a
 * consumer Gmail account sends ~100/day, and the old system burned that in
 * minutes and then failed silently 2,446 times.
 *
 *   all      — every event, immediately (the old behaviour)
 *   balanced — DEFAULT. Time-critical events stay instant; chasers roll up into
 *              one email per person per day; comments notify fewer people and
 *              are throttled per task; heads are copied later in the ladder.
 *   minimal  — only what a person cannot discover by opening the app:
 *              work assigned to them, changes requested, rejections, client
 *              comments, and the morning digest.
 *
 * Every suppressed message is still written to the Alerts Log, so nothing is
 * invisible — it just isn't emailed.
 */
const MAIL_ALWAYS = ['assigned', 'revision', 'send-changes', 'rejected', 'guest-comment', 'digest', 'codes', 'health', 'test'];
const MAIL_BALANCED_ONLY = ['due-soon-each', 'comment-wide', 'claimed', 'reschedule-head'];

function mailLevel_() {
  const v = String(cfg_('EMAIL_LEVEL', 'balanced')).trim().toLowerCase();
  return (v === 'all' || v === 'minimal') ? v : 'balanced';
}

function mailAllowed_(kind) {
  const lvl = mailLevel_();
  if (lvl === 'all') return true;
  if (!kind) return lvl !== 'minimal';
  if (MAIL_ALWAYS.indexOf(kind) > -1) return true;
  if (lvl === 'minimal') return false;
  return MAIL_BALANCED_ONLY.indexOf(kind) === -1; // balanced drops only these
}

/** Per-task throttle so a burst of comments becomes one email, not five. */
function mailThrottled_(key, minutes) {
  if (!key) return false;
  try {
    const c = CacheService.getScriptCache();
    const k = 'mt_' + key;
    if (c.get(k)) return true;
    c.put(k, '1', Math.max(60, minutes * 60));
  } catch (e) {}
  return false;
}

function safeSend_(to, subject, html, cc, kind) {
  if (!to) return;
  // actor is stamped PER MESSAGE — extsync impersonates different assigners in
  // one execution, and CURRENT_ACTOR may already be restored by flush time.
  MAIL_QUEUE.push({ to: String(to), subject: String(subject), html: String(html), cc: String(cc || ''), actor: CURRENT_ACTOR, kind: String(kind || '') });
}

function flushMailQueue_() {
  if (!MAIL_QUEUE.length) return;
  const q = MAIL_QUEUE;
  MAIL_QUEUE = [];
  const muted = String(cfg_('EMAIL_MUTE', 'NO')).toUpperCase().indexOf('Y') === 0;
  q.forEach(function (m) {
    const clean = m.to.split(',').map(s => s.trim())
      .filter(s => s && s.indexOf('@') > 0 && s.indexOf('@example.com') === -1).join(',');
    if (!clean) return;
    if (muted) { log_('muted', '', clean, m.subject, true); return; }
    if (/@example\.com$/i.test(m.actor || '')) { log_('muted-actor', '', clean, m.subject + ' (actor ' + m.actor + ')', true); return; }
    // EMAIL_LEVEL gate — suppressed mail is logged, never silently lost
    if (!mailAllowed_(m.kind)) { log_('held-' + mailLevel_(), '', clean, m.subject + ' [' + m.kind + ']', true); return; }
    try {
      if (MailApp.getRemainingDailyQuota() < 1) { log_('quota', '', clean, 'Daily email quota exhausted', false); return; }
      const opts = { to: clean, subject: m.subject, htmlBody: m.html, name: cfg_('ORG_NAME', 'Task System') + ' · Tasks' };
      if (m.cc) opts.cc = m.cc;
      MailApp.sendEmail(opts);
    } catch (err) {
      log_('send-error', '', clean, String(err), false);
    }
  });
}

/* ── HTML builders (ported verbatim from Code.gs / Api.gs) ─────────────── */

function taskCard_(t, color, headline, extraHtml) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [
    ['Task', `<b>${esc_(t.id)}</b> — ${esc_(t.title)}`],
    ['Team', esc_(t.team)],
    ['Assigned to', esc_(t.assignee || '—')],
    ['Requested by', esc_(t.requester || '—')],
    ['Priority', `<span style="color:${PRIORITY_COLORS[t.priority] || '#333'};font-weight:bold;">${esc_(t.priority || '—')}</span>`],
    ['Status', esc_(t.status || '—')],
    ['Due', esc_(t.dueStr || '—')],
  ];
  if (t.brief) rows.push(['Brief link', `<a href="${escAttr_(t.brief)}">${esc_(t.brief)}</a>`]);
  if (t.notes) rows.push(['Notes', esc_(t.notes)]);
  const table = rows.map(x =>
    `<tr><td style="padding:5px 12px 5px 0;color:#888;white-space:nowrap;vertical-align:top;">${x[0]}</td><td style="padding:5px 0;">${x[1]}</td></tr>`).join('');
  return baseCard_(color, headline,
    (extraHtml || '') + `<table style="border-collapse:collapse;font-size:13px;margin-top:6px;">${table}</table>` +
    linkRow_('Open the master sheet', ss.getUrl()) +
    (cfg_('FORM_URL', '') ? linkRow_('Submit a new task', cfg_('FORM_URL', '')) : ''));
}

function baseCard_(color, headline, bodyHtml) {
  const org = esc_(cfg_('ORG_NAME', 'Task System'));
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">` +
    `<div style="background:${color};color:#fff;padding:14px 20px;font-size:16px;font-weight:bold;">${headline}</div>` +
    `<div style="padding:16px 20px;color:#222;font-size:13px;line-height:1.55;">${bodyHtml}` +
    `<p style="color:#999;font-size:11px;margin-top:18px;">${org} · automated task alert · reply to your team head, not to this email</p></div></div>`;
}

function linkRow_(label, url) {
  return `<p style="margin:12px 0 0;"><a href="${escAttr_(url)}" style="background:#1a237e;color:#fff;text-decoration:none;padding:8px 14px;border-radius:5px;font-size:12px;display:inline-block;">${esc_(label)} →</a></p>`;
}

/** Review-room deep-link button. Prefers the hosted PWA (Config APP_BASE_URL),
 *  falls back to the server-served ?page=app. */
function roomBtn_(id) {
  const base = String(cfg_('APP_BASE_URL', '')).trim();
  const link = base
    ? base + (base.indexOf('?') > -1 ? '&' : '?') + 'task=' + encodeURIComponent(id)
    : ScriptApp.getService().getUrl() + '?page=app&task=' + encodeURIComponent(id);
  return '<p style="margin:18px 0 6px"><a href="' + link + '" style="background:#eb5b2d;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 22px;display:inline-block">Open the review room →</a></p><p style="font-size:11px;color:#8a867c">Opens in your browser — comment and mark changes right on the file.</p>';
}

/* ── Standard notifications (ported from Code.gs) ──────────────────────── */

function notifyAssignee_(sheet, row, kind) {
  const task = taskAt_(sheet, row);
  const email = emailByName_(task.assignee);
  if (!email) return;
  let subject, color, headline, note;
  if (kind === 'assigned') {
    subject = `[Task] 🆕 New task for you — ${task.id}: ${task.title}`;
    color = '#1a73e8'; headline = 'A task has been assigned to you';
    note = `<p>Due: <b>${task.dueStr || 'no deadline set'}</b>. It's on your personal tab in the master sheet — set the status to <b>In Progress</b> when you start.</p>`;
  } else if (kind === 'revision') {
    subject = `[Task] 🔁 Revisions requested — ${task.id}: ${task.title}`;
    color = '#8e44ad'; headline = 'Revisions requested on your task';
    note = `<p>Check the Notes column for details, make the changes, and set the status back to <b>In Review</b>.</p>`;
  } else {
    subject = `[Task] 📅 Deadline changed — ${task.id}: ${task.title}`;
    color = '#e67e22'; headline = 'The deadline for this task changed';
    note = `<p>New deadline: <b>${task.dueStr || '—'}</b>.</p>`;
  }
  safeSend_(email, subject, taskCard_(task, color, headline, note), '', kind === 'assigned' ? 'assigned' : (kind === 'revision' ? 'revision' : 'reschedule'));
  log_(kind, task.id, email, '', true);
}

function notifyDone_(sheet, row) {
  const task = taskAt_(sheet, row);
  const requesterEmail = emailByName_(task.requester) || '';
  const heads = headsOf_(task.team).map(h => h.email);
  const to = [requesterEmail].concat(heads).filter(x => x).filter((x, i, a) => a.indexOf(x) === i).join(',');
  if (!to) return;
  safeSend_(to, `[Task] ✅ Completed — ${task.id}: ${task.title}`,
    taskCard_(task, '#27ae60', 'Task completed',
      `<p><b>${esc_(task.assignee)}</b> marked this task Done.` +
      (task.deliverable ? ` Deliverable: <a href="${escAttr_(task.deliverable)}">open link</a>.` : '') + '</p>'), '', 'done');
  log_('done', task.id, to, '', true);
}

function pingRequester_(master, row, team, user, task) {
  const cur = fullRow_(master, row);
  const reqEmail = emailByName_(String(cur[COL.REQUESTER - 1]).trim());
  const already = [user.email].concat(headsOf_(team).map(function (h) { return h.email; }));
  if (reqEmail && already.indexOf(reqEmail) === -1) {
    safeSend_(reqEmail, '[Task] 🎬 Your assignment is ready — ' + String(cur[COL.ID - 1]) + ': ' + task.title,
      taskCard_(task, '#5b5bd6', 'Here is your assignment — please review',
        '<p>The ' + esc_(team) + ' team finished <b>' + esc_(task.title) + '</b> and it passed the internal check. Watch it, drop comments or change markers exactly where they belong, and approve or ask for changes — the sooner you review, the sooner it ships.</p>' + roomBtn_(String(cur[COL.ID - 1]))), '');
    return true;
  }
  return false;
}

function sendTestAlert() {
  const me = Session.getActiveUser().getEmail() || ownerEmail_();
  const demo = {
    id: 'GD-0000', title: 'Test task — instagram reel thumbnail', team: 'Graphic',
    assignee: 'You', requester: 'Task System', priority: 'High', status: 'New',
    dueStr: fmtDT_(new Date(Date.now() + 24 * 3600 * 1000)), brief: '', deliverable: '', notes: '',
  };
  safeSend_(me, '[Task] ✉️ Test alert — your notifications work',
    taskCard_(demo, '#1a73e8', 'This is what task alerts look like',
      '<p>If you can read this, email notifications are working. Tip: create a Gmail filter for subject <b>[Task]</b> → label it, and switch ON phone notifications for that label in the Gmail app.</p>'), '', 'test');
  flushMailQueue_();
}
