/**
 * digest.js — THE one daily digest (the old project had two definitions; the
 * Api.gs top-4 version was the live one and is what's ported). Members get
 * their own top-4 pending tasks, Team Heads get the team's top-4; Assigners
 * and Super Admins are skipped by design.
 *
 * v5: fired by a real daily time trigger at DIGEST_HOUR. Internal guards
 * (hour check, DIGEST_SENT date stamp, working-day check, DAILY_DIGEST switch)
 * stay, so double-fires and off-day sends are impossible.
 */

function taskRank_(r) {
  const pr = { 'Urgent': 0, 'High': 1, 'Medium': 2, 'Low': 3 };
  const od = String(r[COL.OVERDUE - 1]).indexOf('OVERDUE') > -1 ? 0 : 1;
  const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
  return [od, pr[String(r[COL.PRIORITY - 1])] !== undefined ? pr[String(r[COL.PRIORITY - 1])] : 9, due ? due.getTime() : 9e15];
}

function digestRows_(list) {
  return list.map(function (r) {
    const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
    const tz = tzStr_();
    const od = String(r[COL.OVERDUE - 1]).indexOf('OVERDUE') > -1;
    return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap"><b>' + esc_(String(r[COL.ID - 1])) + '</b></td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee">' + esc_(String(r[COL.TITLE - 1])) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">' + esc_(String(r[COL.PRIORITY - 1])) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;' + (od ? 'color:#c0392b;font-weight:700' : '') + '">' + (od ? '🚨 ' : '') + (due ? Utilities.formatDate(due, tz, 'EEE d MMM') : '—') + '</td></tr>';
  }).join('');
}

function dailyDigest() {
  dailyDigestBody_(false);
  flushMailQueue_();
}

/** Menu / admin "send now" — bypasses the hour + already-sent guards. */
function dailyDigestNow() {
  dailyDigestBody_(true);
  flushMailQueue_();
}

function dailyDigestBody_(force) {
  try {
    if (!yes_('DAILY_DIGEST')) return; // v5 fix: the live Api.gs version forgot this switch
    const tz = tzStr_();
    const now = new Date();
    const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    if (!force) {
      if (Number(Utilities.formatDate(now, tz, 'H')) < Number(cfg_('DIGEST_HOUR', 10))) return;
      if (String(cfg_('DIGEST_SENT', '')) === today) return;
    }
    cfgSet_('DIGEST_SENT', today);
    if (!isWorkDay_(now)) return;
    const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
    if (master.getLastRow() < 2) return;
    const rows = master.getRange(2, 1, master.getLastRow() - 1, LAST_COL).getValues()
      .filter(function (r) { return r[COL.ID - 1] && ['Done', 'Rejected'].indexOf(String(r[COL.STATUS - 1]).trim()) === -1; });
    if (!rows.length) return;
    const byRank = function (a, b) {
      const ra = taskRank_(a), rb = taskRank_(b);
      for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    };
    const people = roster_().filter(function (m) { return m.active && m.email; });
    people.forEach(function (m) {
      let list;
      if (m.role === 'Team Head') list = rows.filter(function (r) { return String(r[COL.TEAM - 1]).trim() === m.team; });
      else if (m.role === 'Assigner' || m.role === 'Super Admin') return; // heads+members only, per the brief
      else list = rows.filter(function (r) { return String(r[COL.ASSIGNEE - 1]).trim() === m.name; });
      list = list.sort(byRank).slice(0, 4);
      if (!list.length) return;
      const what = m.role === 'Team Head' ? 'your team\'s top ' + list.length : 'your top ' + list.length;
      safeSend_(m.email, '[Task] ☀ ' + (m.role === 'Team Head' ? m.team + ' — today\'s top ' + list.length : 'Your top ' + list.length + ' tasks today'),
        baseCard_('#eb5b2d', 'Good morning — ' + what + ' pending task' + (list.length > 1 ? 's' : ''),
          '<table style="border-collapse:collapse;font-size:13px;width:100%">' + digestRows_(list) + '</table>' +
          '<p style="font-size:11px;color:#8a867c">Sorted: overdue first, then priority, then deadline. Open CreativeFlow to act on them.</p>'), '');
    });
    log_('digest', 'daily', 'system', people.length + ' people considered', true);
  } catch (e) { log_('digest-error', '', '', String(e), false); }
}
