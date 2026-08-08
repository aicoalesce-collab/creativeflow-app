/**
 * sweep.js — scheduled work (REAL time triggers in v5, not lazy piggybacks):
 *  - sweep(): every 15 min — due-soon reminders + the overdue escalation ladder
 *  - reviewSweep(): hourly — review budget reminders (rem3/rem6) + auto-Done
 * The old SWEEP40_AT hourly throttle is retired with the lazy pattern.
 */

function sweep() {
  sweepBody_();
  flushMailQueue_();
}

function sweepBody_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const master = ss.getSheetByName(SHEETS.MASTER);
  const lastRow = master.getLastRow();
  if (lastRow < 2) return;
  const data = master.getRange(2, 1, lastRow - 1, LAST_COL).getValues();
  const now = new Date();
  const soonMs = Number(cfg_('DUE_SOON_HOURS', 24)) * 3600 * 1000;
  const repeatMs = Number(cfg_('OVERDUE_REPEAT_HOURS', 24)) * 3600 * 1000;
  const ccFrom = Number(cfg_('CC_HEAD_FROM_ALERT_N', 2));

  data.forEach((r, i) => {
    const row = i + 2;
    const id = r[COL.ID - 1], status = r[COL.STATUS - 1];
    if (!id || status === 'Done' || status === 'On Hold' || status === 'In Review' || status === 'Rejected') return;
    const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
    if (!due) return;
    const task = taskFromRow_(r);

    if (due.getTime() > now.getTime()) {
      // Due soon?
      const reminded = r[COL.H_REMINDED - 1];
      if (!reminded && (due.getTime() - now.getTime()) <= soonMs) {
        const email = emailByName_(task.assignee);
        if (email) {
          safeSend_(email, `[Task] ⏰ Due soon — ${id}: ${task.title}`,
            taskCard_(task, '#e67e22', 'This task is due soon',
              `<p>Deadline: <b>${fmtDT_(due)}</b>. Update the status in the sheet once it's moving.</p>`), '');
          master.getRange(row, COL.H_REMINDED).setValue(new Date());
          log_('due-soon', id, email, '', true);
        }
      }
    } else {
      // Overdue → escalation ladder
      const count = Number(r[COL.H_OD_COUNT - 1]) || 0;
      const last = r[COL.H_OD_LAST - 1];
      const shouldSend = count === 0 || !(last instanceof Date) || (now.getTime() - last.getTime()) >= repeatMs;
      if (!shouldSend) return;

      const n = count + 1;
      const email = emailByName_(task.assignee);
      const heads = headsOf_(task.team).map(h => h.email).filter(x => x && x !== email);
      const cc = (n >= ccFrom) ? heads.join(',') : '';
      const to = email || heads.join(',') || ownerEmail_();

      safeSend_(to, `[Task] 🚨 OVERDUE (alert ${n}) — ${id}: ${task.title}`,
        taskCard_(task, '#c0392b', 'This task is OVERDUE — please finish it first',
          `<p>The deadline was <b>${fmtDT_(due)}</b>. This task now takes priority over everything else on your list.` +
          (cc ? ' Your team head has been copied on this alert.' : '') + '</p>'), cc);

      master.getRange(row, COL.H_OD_COUNT).setValue(n);
      master.getRange(row, COL.H_OD_LAST).setValue(new Date());
      if (yes_('AUTO_URGENT_ON_OVERDUE') && r[COL.PRIORITY - 1] !== 'Urgent') {
        master.getRange(row, COL.PRIORITY).setValue('Urgent');
      }
      log_('overdue-' + n, id, to + (cc ? ' cc:' + cc : ''), '', true);
    }
  });
}

/** Hourly: the review-window budget — reminders at 3 days and last day, then
 *  auto-Done with the auto-done flag once REVIEW_WINDOW_DAYS is used up. */
function reviewSweep() {
  reviewSweepBody_();
  flushMailQueue_();
}

function reviewSweepBody_() {
  try {
    const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
    const lastRow = master.getLastRow();
    if (lastRow < 2) return;
    const budget = Number(cfg_('REVIEW_WINDOW_DAYS', 7)) || 7;
    const rows = master.getRange(2, 1, lastRow - 1, LAST_COL2).getValues();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r[COL.ID - 1] || String(r[COL.STATUS - 1]).trim() !== 'In Review') continue;
      const row = i + 2;
      const id = String(r[COL.ID - 1]);
      const team = String(r[COL.TEAM - 1]).trim();
      const since = (r[X.STAGE_SINCE - 1] instanceof Date) ? r[X.STAGE_SINCE - 1] : null;
      const used = (Number(r[X.REV_DAYS - 1]) || 0) + (since ? workDaysBetween_(since, new Date()) : 0);
      const reqEmail = emailByName_(String(r[COL.REQUESTER - 1]).trim());
      const task = taskAt_(master, row);
      if (used >= budget) {
        leaveReview_(master, row);
        master.getRange(row, COL.STATUS).setValue('Done');
        master.getRange(row, COL.COMPLETED).setValue(new Date());
        addFlag_(master, row, 'auto-done');
        cycle_(id, 'auto-done', 'system', budget + ' working days of review used');
        const to = [reqEmail, emailByName_(String(r[COL.ASSIGNEE - 1]).trim())]
          .concat(headsOf_(team).map(function (h) { return h.email; }))
          .filter(function (x, ix, a) { return x && a.indexOf(x) === ix; }).join(',');
        if (to) safeSend_(to, '[Task] ⏰ Auto-approved (review window over) — ' + id,
          taskCard_(task, '#8e44ad', 'Closed automatically — nobody reviewed in time',
            '<p>The ' + budget + '-working-day review window ran out, so this task closed as Done with an <b>auto-approved</b> flag. If changes are still needed, the assignee can press <b>Renew</b> — it becomes a fresh task and is counted.</p>'), '');
      } else if (used >= budget - 1 && !hasFlag_(r, 'rem6')) {
        addFlag_(master, row, 'rem6');
        if (reqEmail) safeSend_(reqEmail, '[Task] ⏳ LAST DAY to review — ' + id,
          taskCard_(task, '#c0392b', 'Review closes tomorrow',
            '<p>One working day left. If nobody reviews, this auto-approves as Done.</p>' + roomBtn_(id)), '');
      } else if (used >= 3 && !hasFlag_(r, 'rem3')) {
        addFlag_(master, row, 'rem3');
        if (reqEmail) safeSend_(reqEmail, '[Task] ⏳ Still waiting for your review — ' + id,
          taskCard_(task, '#e67e22', 'Waiting on your review',
            '<p>This has been in review for ' + Math.floor(used) + ' working days. It auto-approves at ' + budget + '.</p>' + roomBtn_(id)), '');
      }
    }
  } catch (e) { log_('sweep-error', '', '', String(e), false); }
}

/** Monthly: move old Done tasks to Archive + trim the Alerts Log to 5,000 rows. */
function archiveDone() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const master = ss.getSheetByName(SHEETS.MASTER);
  const archive = ss.getSheetByName(SHEETS.ARCHIVE);
  const lastRow = master.getLastRow();
  if (lastRow >= 2) {
    const days = Number(cfg_('ARCHIVE_AFTER_DAYS', 30));
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const data = master.getRange(2, 1, lastRow - 1, VISIBLE_COLS).getValues();
    const toDelete = [];
    data.forEach((r, i) => {
      const status = r[COL.STATUS - 1], done = r[COL.COMPLETED - 1];
      if (r[COL.ID - 1] && status === 'Done' && done instanceof Date && done.getTime() < cutoff) {
        archive.appendRow(r.slice(0, VISIBLE_COLS));
        toDelete.push(i + 2);
      }
    });
    toDelete.reverse().forEach(row => master.deleteRow(row));
    if (toDelete.length) log_('archive', '', '', toDelete.length + ' tasks archived', true);
  }
  // v5: the Alerts Log can no longer grow forever
  try {
    const logSh = ss.getSheetByName(SHEETS.LOG);
    const n = logSh.getLastRow();
    const cap = 5000;
    if (n - 1 > cap) logSh.deleteRows(2, n - 1 - cap);
  } catch (e) {}
}
