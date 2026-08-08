/**
 * ============================================================================
 *  push.js — device subscriptions, the send queue, and who gets told what.
 *
 *  Shaped deliberately like mail.js: queue during the handler, flush AFTER the
 *  ScriptLock is released. Sending inside the lock is what made the old system
 *  serialise every write behind SMTP, and a push round trip to Google's push
 *  service is no faster than an email.
 *
 *  Push is set to 'all' by default while email stays 'balanced'. That asymmetry
 *  is the point: a notification is free and instant, an email is one of ~100
 *  the account can send in a day. Chatty push, quiet inbox.
 * ============================================================================
 */

let PUSH_QUEUE = [];

const PUSH_HEADERS = ['Endpoint', 'p256dh', 'Auth', 'Member', 'Device', 'Created', 'Last OK', 'Fails', 'Active'];

function pushSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.PUSH);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.PUSH);
    sh.getRange(1, 1, 1, PUSH_HEADERS.length).setValues([PUSH_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');   // machine-tab styling
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 320);
    sh.hideSheet();   // endpoints are device credentials, not something to browse
  }
  return sh;
}

/**
 * PUSH_LEVEL mirrors EMAIL_LEVEL but defaults to 'all'.
 *   all      — DEFAULT. Every event, instantly. This is the point of push.
 *   balanced — skips the low-value ones (comments, brief edits)
 *   minimal  — only work assigned to you and changes requested on it
 */
function pushLevel_() {
  const v = String(cfg_('PUSH_LEVEL', 'all')).trim().toLowerCase();
  return (v === 'balanced' || v === 'minimal') ? v : 'all';
}

function pushAllowed_(kind) {
  const lvl = pushLevel_();
  if (lvl === 'all') return true;
  const critical = ['assigned', 'changes', 'rejected', 'overdue'];
  if (lvl === 'minimal') return ['assigned', 'changes'].indexOf(kind) > -1;
  return critical.concat(['done', 'review', 'update']).indexOf(kind) > -1;
}

/* ── subscription storage ──────────────────────────────────────────────── */

function pushRows_() {
  const sh = pushSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, PUSH_HEADERS.length).getValues()
    .map(function (r, i) {
      return {
        row: i + 2, endpoint: String(r[0]), p256dh: String(r[1]), auth: String(r[2]),
        member: String(r[3]), device: String(r[4]), created: r[5], lastOk: r[6],
        fails: Number(r[7]) || 0, active: String(r[8]).toUpperCase() !== 'NO',
      };
    })
    .filter(function (r) { return r.endpoint; });
}

function pushSubsFor_(email) {
  const who = String(email || '').trim().toLowerCase();
  if (!who) return [];
  return pushRows_().filter(function (r) { return r.active && r.member.toLowerCase() === who; });
}

/**
 * { action:'pushSubscribe', endpoint, p256dh, auth, device } → { ok }
 *
 * Re-subscribing with the same endpoint updates in place. Browsers hand back
 * the same endpoint for the same install, so without this the sheet would grow
 * a duplicate row on every login and the member would get three copies of
 * every notification.
 */
function apiPushSubscribe_(user, req) {
  const endpoint = String(req.endpoint || '').trim();
  const p256dh = String(req.p256dh || '').trim();
  const auth = String(req.auth || '').trim();
  if (!/^https:\/\//.test(endpoint)) return { ok: false, error: 'VALIDATION', message: 'That is not a push endpoint.' };
  if (!p256dh || !auth) return { ok: false, error: 'VALIDATION', message: 'The subscription is missing its keys.' };

  const device = String(req.device || '').trim().slice(0, 60).replace(/[\r\n]/g, ' ');
  const sh = pushSheet_();
  const existing = pushRows_().filter(function (r) { return r.endpoint === endpoint; })[0];
  const now = new Date();
  if (existing) {
    sh.getRange(existing.row, 1, 1, PUSH_HEADERS.length)
      .setValues([[endpoint, p256dh, auth, user.email, device || existing.device, existing.created || now, existing.lastOk || '', 0, 'Yes']]);
  } else {
    sh.appendRow([endpoint, p256dh, auth, user.email, device, now, '', 0, 'Yes']);
  }
  log_('push-subscribe', '', user.email, device || 'device', true);
  return { ok: true, subscribed: true };
}

/** { action:'pushUnsubscribe', endpoint } — turning notifications off. */
function apiPushUnsubscribe_(user, req) {
  const endpoint = String(req.endpoint || '').trim();
  const sh = pushSheet_();
  const hit = pushRows_().filter(function (r) { return r.endpoint === endpoint; })[0];
  if (hit) {
    /* Only the owner of the row, or an admin, may drop it — an endpoint is
       guessable-ish and this action is authed but not otherwise scoped. */
    if (hit.member.toLowerCase() !== user.email.toLowerCase() && user.role !== 'Super Admin') {
      return { ok: false, error: 'FORBIDDEN', message: 'That subscription belongs to another account.' };
    }
    sh.deleteRow(hit.row);
    log_('push-unsubscribe', '', user.email, '', true);
  }
  return { ok: true, subscribed: false };
}

function deactivateSub_(endpoint, why) {
  const sh = pushSheet_();
  const hit = pushRows_().filter(function (r) { return r.endpoint === endpoint; })[0];
  if (!hit) return;
  sh.getRange(hit.row, 9).setValue('No');
  log_('push-dead', '', hit.member, why, false);
}

/* ── queue + flush ─────────────────────────────────────────────────────── */

/**
 * Queue a notification for one roster member, by name.
 *
 * Mirrors safeSend_: takes a NAME because that is what task rows hold, resolves
 * to an email, and stamps the actor so the same guard that keeps test accounts
 * from mailing real people also keeps them from buzzing real phones.
 */
function pushToMember_(name, title, body, opts) {
  const email = emailByName_(String(name || '').trim());
  if (!email) return;
  pushToEmail_(email, title, body, opts);
}

function pushToEmail_(email, title, body, opts) {
  const o = opts || {};
  PUSH_QUEUE.push({
    email: String(email), title: String(title), body: String(body),
    taskId: String(o.taskId || ''), kind: String(o.kind || ''), topic: String(o.topic || ''),
    urgency: o.urgency || 'normal', actor: CURRENT_ACTOR,
  });
}

/** Everyone with a live subscription — used for the "new version" nudge. */
function pushToEveryone_(title, body, opts) {
  const seen = {};
  pushRows_().filter(function (r) { return r.active; }).forEach(function (r) {
    if (seen[r.member.toLowerCase()]) return;
    seen[r.member.toLowerCase()] = true;
    pushToEmail_(r.member, title, body, opts);
  });
}

/**
 * Sends everything queued. Called from dispatch_ after the lock is released,
 * exactly like flushMailQueue_, and like it this never throws: a push failure
 * must not roll back a sheet write that already committed.
 */
function flushPushQueue_() {
  if (!PUSH_QUEUE.length) return;
  const q = PUSH_QUEUE;
  PUSH_QUEUE = [];
  /* Do NOT return from this catch: the queue was already emptied above, so
     bailing out here would drop every queued notification with nothing logged.
     An unreadable Config means "not muted", same as the default. */
  let muted = false;
  try { muted = String(cfg_('PUSH_MUTE', 'NO')).toUpperCase().indexOf('Y') === 0; } catch (e) { muted = false; }

  try {
    if (!vapidPublicKeyB64_()) return;   // push was never set up; stay silent

    /* Load subscriptions ONCE for the whole flush. A single task update can
       queue five notifications, and re-reading the sheet per message would
       make the write path slower than the email path it replaced. */
    let all = null;
    const subsFor = function (email) {
      if (!all) {
        all = {};
        pushRows_().forEach(function (r) {
          if (!r.active) return;
          const k = r.member.toLowerCase();
          (all[k] = all[k] || []).push(r);
        });
      }
      return all[String(email).toLowerCase()] || [];
    };

    q.forEach(function (m) {
      /* Same three safety layers as email: test-domain recipients are never
         contacted, actions BY a test account never reach a real person, and
         PUSH_MUTE silences everything while it is set. */
      if (!m.email || m.email.indexOf('@example.com') > -1) return;
      if (String(m.actor || '').indexOf('@example.com') > -1) return;
      if (muted) { log_('push-muted', m.taskId, m.email, m.title, true); return; }
      if (!pushAllowed_(m.kind)) { log_('push-held-' + pushLevel_(), m.taskId, m.email, m.kind, true); return; }

      const payload = JSON.stringify({
        title: m.title, body: m.body, taskId: m.taskId, kind: m.kind, at: new Date().toISOString(),
      });
      subsFor(m.email).forEach(function (sub) {
        let res;
        try { res = webPushSend_(sub, payload, { topic: m.topic || m.taskId, urgency: m.urgency }); }
        catch (err) { res = { ok: false, code: 0, gone: false, error: String(err) }; }
        if (res.gone) { deactivateSub_(sub.endpoint, 'HTTP ' + res.code + ' — device unsubscribed'); return; }
        try {
          const sh = pushSheet_();
          if (res.ok) sh.getRange(sub.row, 7, 1, 2).setValues([[new Date(), 0]]);
          else {
            const fails = (sub.fails || 0) + 1;
            sh.getRange(sub.row, 8).setValue(fails);
            /* Ten consecutive failures is a device that is never coming back.
               Left alone these accumulate and slow every future flush. */
            if (fails >= 10) deactivateSub_(sub.endpoint, 'gave up after 10 failures');
            log_('push-fail', m.taskId, m.email, 'HTTP ' + res.code + ' ' + res.error, false);
          }
        } catch (e) { /* bookkeeping must never break delivery */ }
      });
    });
  } catch (err) {
    try { log_('push-error', '', '', String(err).slice(0, 200), false); } catch (e) {}
  }
}

/* ── admin helpers ─────────────────────────────────────────────────────── */

function pushListForAdmin_() {
  return pushRows_().map(function (r) {
    return {
      member: r.member, device: r.device, active: r.active, fails: r.fails,
      created: r.created instanceof Date ? r.created.toISOString() : '',
      lastOk: r.lastOk instanceof Date ? r.lastOk.toISOString() : '',
      host: String(r.endpoint).split('/').slice(0, 3).join('/'),
    };
  });
}

/** Fires a real notification at one person so a device can be proven end to end. */
function pushTestSend_(user, req) {
  const target = String(req.member || user.email).trim();
  const subs = pushSubsFor_(target);
  if (!subs.length) return { sent: 0, note: 'No active device for ' + target + '.' };
  const payload = JSON.stringify({
    title: 'CreativeFlow', body: 'Test notification — everything is working.',
    taskId: '', kind: 'test', at: new Date().toISOString(),
  });
  let sent = 0;
  const results = subs.map(function (s) {
    const r = webPushSend_(s, payload, { topic: 'test', urgency: 'high' });
    if (r.ok) sent++;
    if (r.gone) deactivateSub_(s.endpoint, 'HTTP ' + r.code + ' during test');
    return { device: s.device, code: r.code, ok: r.ok, error: r.error };
  });
  return { sent: sent, of: subs.length, results: results };
}

/** Told to everyone after a release, so nobody sits on a stale build. */
function pushAppUpdate_(version) {
  pushToEveryone_('CreativeFlow updated',
    'Version ' + version + ' is ready — open the app to get it.',
    { kind: 'update', topic: 'appupdate' });
  flushPushQueue_();
  return { queued: true, version: version };
}
