/**
 * form.js — the Task Request Google Form: creation, assignee-list sync, and
 * the onFormSubmit handler. The F_* titles in config.js are the parsing
 * contract between form creation and submission handling.
 */

function createOrLinkForm_(ss) {
  if (cfg_('FORM_URL', '')) { syncFormAssignees(); return; }
  const org = cfg_('ORG_NAME', 'Our Studio');
  const form = FormApp.create(org + ' — Task Request');
  form.setDescription('Add a new task to the master task sheet. The assignee (or the team head) is notified automatically.');
  form.setCollectEmail(true);

  form.addTextItem().setTitle(F_NAME).setHelpText('Your name exactly as it appears in the Roster.').setRequired(true);
  form.addListItem().setTitle(F_TEAM).setChoiceValues(teams_().map(t => t.team)).setRequired(true);
  form.addTextItem().setTitle(F_TITLE).setRequired(true);
  form.addParagraphTextItem().setTitle(F_DESC);
  form.addTextItem().setTitle(F_BRIEF).setHelpText('Google Drive / reference link.');
  form.addListItem().setTitle(F_PRIORITY).setChoiceValues(PRIORITIES).setRequired(true);
  form.addDateItem().setTitle(F_DUE).setRequired(true);
  form.addTimeItem().setTitle(F_TIME);
  form.addListItem().setTitle(F_ASSIGN).setChoiceValues([ASSIGN_PLACEHOLDER]).setHelpText('Pick a person, or leave it to the team head.');

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  cfgSet_('FORM_URL', form.getPublishedUrl());
  cfgSet_('FORM_EDIT_URL', form.getEditUrl());
  syncFormAssignees();
}

/** Refreshes the "Assign To" dropdown in the form from the Roster tab. */
function syncFormAssignees() {
  const editUrl = cfg_('FORM_EDIT_URL', '');
  if (!editUrl) return;
  try {
    const form = FormApp.openByUrl(editUrl);
    const names = roster_().filter(m => m.active && m.name.indexOf('Sample') !== 0).map(m => m.name + ' — ' + m.team);
    const items = form.getItems(FormApp.ItemType.LIST);
    items.forEach(it => {
      if (it.getTitle() === F_ASSIGN) {
        it.asListItem().setChoiceValues([ASSIGN_PLACEHOLDER].concat(names));
      }
      if (it.getTitle() === F_TEAM) {
        it.asListItem().setChoiceValues(teams_().map(t => t.team));
      }
    });
  } catch (err) { log_('sync-form', '', '', String(err), false); }
}

/** Installable trigger: a Task Request form was submitted. */
function handleFormSubmit(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const respSheet = e.range.getSheet();
    const headers = respSheet.getRange(1, 1, 1, respSheet.getLastColumn()).getValues()[0];
    const vals = respSheet.getRange(e.range.getRow(), 1, 1, respSheet.getLastColumn()).getValues()[0];
    const rec = {};
    headers.forEach((h, i) => rec[h] = vals[i]);

    const requesterEmail = String(rec['Email Address'] || '').trim();
    const requesterName = String(rec[F_NAME] || '').trim() || nameByEmail_(requesterEmail) || requesterEmail;
    const team = String(rec[F_TEAM] || '').trim() || (teams_()[0] || {}).team || '';
    let assignee = String(rec[F_ASSIGN] || '').trim();
    if (!assignee || assignee.indexOf('(') === 0) assignee = '';
    if (assignee.indexOf(' — ') !== -1) assignee = assignee.split(' — ')[0];

    const master = ss.getSheetByName(SHEETS.MASTER);
    const id = nextId_(team);
    const row = master.getLastRow() + 1;
    master.getRange(row, 1, 1, 13).setValues([[
      id, new Date(), requesterName, team, assignee,
      String(rec[F_TITLE] || '').trim(), String(rec[F_DESC] || '').trim(), String(rec[F_BRIEF] || '').trim(), '',
      String(rec[F_PRIORITY] || 'Medium').trim(), 'New',
      rec[F_DUE] instanceof Date ? rec[F_DUE] : '', rec[F_TIME] instanceof Date ? rec[F_TIME] : '',
    ]]);
    master.getRange(row, COL.REVISIONS, 1, 2).setValues([[0, '']]);

    const task = taskAt_(master, row);
    if (assignee) {
      notifyAssignee_(master, row, 'assigned');
      log_('task-created', id, emailByName_(assignee), 'Assigned via form by ' + requesterName, true);
    } else {
      const heads = headsOf_(team);
      const to = heads.map(h => h.email).join(',') || ownerEmail_();
      safeSend_(to, `[Task] 🙋 New ${team} task needs an assignee — ${id}`,
        taskCard_(task, '#8e44ad', 'New task waiting for assignment',
          `<p><b>${esc_(requesterName)}</b> submitted this task without an assignee. Open the master sheet and pick a person in the <b>Assigned To</b> column — they'll be notified automatically.</p>`), '');
      log_('task-created', id, to, 'Unassigned; head notified', true);
    }
  } catch (err) {
    log_('form-error', '', '', String(err), false);
  } finally {
    lock.releaseLock();
  }
  flushMailQueue_();
}
