/**
 * sheetedit.js — installable onEdit trigger: humans editing the Master sheet
 * directly still fire the same notifications and stamps as the app.
 */

function handleEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== SHEETS.MASTER) return;
    if (e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;
    const row = e.range.getRow(), col = e.range.getColumn();
    if (row < 2) return;
    const id = sh.getRange(row, COL.ID).getValue();
    if (!id) return;
    const val = (e.value !== undefined && e.value !== null) ? String(e.value) : '';

    if (col === COL.STATUS) {
      if (val === 'Done') {
        sh.getRange(row, COL.COMPLETED).setValue(new Date());
        if (yes_('NOTIFY_REQUESTER_ON_DONE')) notifyDone_(sh, row);
      } else {
        if (e.oldValue === 'Done') sh.getRange(row, COL.COMPLETED).clearContent();
        if (val === 'Revisions') {
          const rc = sh.getRange(row, COL.REVISIONS);
          rc.setValue((Number(rc.getValue()) || 0) + 1);
          notifyAssignee_(sh, row, 'revision');
        }
      }
    } else if (col === COL.ASSIGNEE) {
      if (val && yes_('EMAIL_ON_ASSIGNMENT')) notifyAssignee_(sh, row, 'assigned');
    } else if (col === COL.DUE_DATE || col === COL.DUE_TIME) {
      sh.getRange(row, COL.H_REMINDED, 1, 3).clearContent(); // re-arm reminders
      notifyAssignee_(sh, row, 'due-changed');
    }
  } catch (err) {
    log_('edit-error', '', '', String(err), false);
  }
  flushMailQueue_();
  flushPushQueue_();
}
