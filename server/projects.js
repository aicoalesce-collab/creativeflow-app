/**
 * ============================================================================
 *  projects.js — campaigns.
 *
 *  A project groups tasks that belong to one campaign: the Diwali launch, a
 *  product film, an event. Tasks carry the project NAME, not an id.
 *
 *  Name-keyed, like the Roster's members, because the sheet is read by people:
 *  "Great White Launch" in a cell beats "PRJ-0004". The cost is that a rename
 *  has to rewrite every task that points at it, which is exactly what
 *  renameMember_ already does for people — so there is one idiom here, not two.
 * ============================================================================
 */

const PROJECT_HEADERS = ['Name', 'Status', 'Client', 'Starts', 'Ends', 'Colour', 'Created By', 'Created At'];
const PNOTE_HEADERS = ['ID', 'Project', 'Author', 'Text', 'Created'];
const PROJECT_STATUSES = ['Active', 'On Hold', 'Done'];
const NOTE_PREVIEW = 600;   // keeps a notes page comfortably ping-sized

/** May this person see this campaign at all? Heads and admins run the studio;
 *  everyone else must have a task in it. */
function canSeeProject_(user, name) {
  if (['Super Admin', 'Team Head'].indexOf(user.role) > -1) return true;
  const want = String(name || '').trim().toLowerCase();
  return scopedTaskRows_(user).some(function (r) {
    return String(r[COL.PROJECT - 1] || '').trim().toLowerCase() === want;
  });
}

/* A campaign gets a colour so its tasks and gallery read as a set. Picked from
   a fixed wheel rather than at random, so two campaigns created in a row never
   land on near-identical hues. */
const PROJECT_COLOURS = ['#eb5b2d', '#5b5bd6', '#0f9d58', '#b7950b', '#8e44ad', '#e91e63', '#00897b', '#e67e22'];

function projectsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.PROJECTS);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.PROJECTS);
    sh.getRange(1, 1, 1, PROJECT_HEADERS.length).setValues([PROJECT_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 240);
    try {
      sh.getRange(2, 2, 500).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(PROJECT_STATUSES, true).setAllowInvalid(false).build());
    } catch (e) {}
  }
  return sh;
}

function projectNotesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.PNOTES);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.PNOTES);
    sh.getRange(1, 1, 1, PNOTE_HEADERS.length).setValues([PNOTE_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(4, 520);
  }
  return sh;
}

function projectRows_() {
  const sh = projectsSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, PROJECT_HEADERS.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r, i) {
      return {
        row: i + 2,
        name: String(r[0]).trim(),
        status: PROJECT_STATUSES.indexOf(String(r[1]).trim()) > -1 ? String(r[1]).trim() : 'Active',
        client: String(r[2] || '').trim(),
        starts: r[3] instanceof Date ? r[3] : null,
        ends: r[4] instanceof Date ? r[4] : null,
        colour: String(r[5] || '').trim() || PROJECT_COLOURS[i % PROJECT_COLOURS.length],
        createdBy: String(r[6] || '').trim(),
        created: r[7] instanceof Date ? r[7] : null,
      };
    });
}

function projectByName_(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const hit = projectRows_().filter(function (p) { return p.name.toLowerCase() === want; });
  return hit.length ? hit[0] : null;
}

/** Tasks the caller may see, already role-scoped, as raw Master rows. */
function scopedTaskRows_(user) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  if (!master || master.getLastRow() < 2) return [];
  const nCols = Math.max(LAST_COL, Math.min(LAST_COL2, master.getMaxColumns()));
  const rows = master.getRange(2, 1, master.getLastRow() - 1, nCols).getValues().filter(function (r) { return r[COL.ID - 1]; });
  if (user.role === 'Super Admin') return rows;
  if (user.role === 'Team Head') return rows.filter(function (r) { return String(r[COL.TEAM - 1]).trim() === user.team; });
  if (user.role === 'Assigner') return rows.filter(function (r) { return String(r[COL.REQUESTER - 1]).trim() === user.name; });
  return rows.filter(function (r) { return String(r[COL.ASSIGNEE - 1]).trim() === user.name; });
}

/**
 * { action:'projects' } -> { ok, projects:[…], colours:{} }
 *
 * Counts are computed from the caller's OWN scope, so a member sees a campaign
 * sized by their share of it, not the studio's. Aggregates only — no titles,
 * no links; the task list itself comes from the tasks the client already holds.
 */
function apiProjects_(user, req) {
  const defined = projectRows_();
  const rows = scopedTaskRows_(user);
  const now = Date.now();

  const bucket = {};
  const blank = function () { return { total: 0, open: 0, overdue: 0, inReview: 0, done: 0 }; };
  defined.forEach(function (p) { bucket[p.name.toLowerCase()] = blank(); });

  rows.forEach(function (r) {
    const name = String(r[COL.PROJECT - 1] || '').trim();
    if (!name) return;
    const k = name.toLowerCase();
    if (!bucket[k]) bucket[k] = blank();          // a project deleted from the sheet still has tasks
    const b = bucket[k];
    const status = String(r[COL.STATUS - 1]).trim();
    const closed = status === 'Done' || status === 'Rejected';
    b.total++;
    if (!closed) {
      b.open++;
      if (status === 'In Review') b.inReview++;
      else {
        const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
        if (status !== 'On Hold' && due && due.getTime() < now) b.overdue++;
      }
    }
    if (status === 'Done') b.done++;
  });

  /* Every project the caller can see: the ones on the sheet, plus any name
     found on their tasks that has no row (renamed or hand-typed). */
  const seen = {};
  const out = defined.map(function (p, i) {
    seen[p.name.toLowerCase()] = true;
    const c = bucket[p.name.toLowerCase()] || blank();
    return {
      name: p.name, status: p.status, client: p.client,
      colour: p.colour || PROJECT_COLOURS[i % PROJECT_COLOURS.length],
      starts: p.starts ? Utilities.formatDate(p.starts, tzStr_(), 'yyyy-MM-dd') : '',
      ends: p.ends ? Utilities.formatDate(p.ends, tzStr_(), 'yyyy-MM-dd') : '',
      onSheet: true, counts: c,
    };
  });
  rows.forEach(function (r) {
    const name = String(r[COL.PROJECT - 1] || '').trim();
    if (!name || seen[name.toLowerCase()]) return;
    seen[name.toLowerCase()] = true;
    out.push({
      name: name, status: 'Active', client: '', colour: PROJECT_COLOURS[out.length % PROJECT_COLOURS.length],
      starts: '', ends: '', onSheet: false, counts: bucket[name.toLowerCase()] || blank(),
    });
  });

  /* Members and assigners see only campaigns they actually have work in — an
     empty list of other people's campaigns is noise, and the names themselves
     can be commercially sensitive. */
  const mine = ['Super Admin', 'Team Head'].indexOf(user.role) > -1
    ? out : out.filter(function (p) { return p.counts.total > 0; });

  /* Busiest first, but a campaign with nothing open sinks below one that needs
     attention — the tab is a worklist, not an archive. */
  mine.sort(function (a, b) { return (b.counts.open - a.counts.open) || (b.counts.total - a.counts.total) || a.name.localeCompare(b.name); });
  return { ok: true, projects: mine };
}

/** { action:'projectCreate', name, client, starts, ends } */
function apiProjectCreate_(user, req) {
  if (['Super Admin', 'Team Head', 'Assigner'].indexOf(user.role) === -1) {
    return { ok: false, error: 'FORBIDDEN', message: 'Members cannot start a campaign — ask your team head.' };
  }
  const name = String(req.name || '').trim().slice(0, 80).replace(/[\r\n\t]/g, ' ');
  if (name.length < 2) return { ok: false, error: 'VALIDATION', message: 'Give the campaign a name.' };
  if (projectByName_(name)) return { ok: false, error: 'VALIDATION', message: 'There is already a campaign called “' + name + '”.' };

  const sh = projectsSheet_();
  const n = projectRows_().length;
  sh.appendRow([name, 'Active', String(req.client || '').trim().slice(0, 80),
    parseDateCell_(req.starts), parseDateCell_(req.ends),
    PROJECT_COLOURS[n % PROJECT_COLOURS.length], user.name, new Date()]);
  /* Refresh the Master dropdown now, so someone typing straight into the
     sheet can pick the campaign that was just created. */
  try { ensureProjectSchema_(); } catch (e) {}
  log_('project-create', '', user.email, name, true);
  return { ok: true, project: { name: name, status: 'Active', client: String(req.client || '').trim(), colour: PROJECT_COLOURS[n % PROJECT_COLOURS.length], starts: '', ends: '', onSheet: true, counts: { total: 0, open: 0, overdue: 0, inReview: 0, done: 0 } } };
}

/** yyyy-mm-dd -> Date in the studio's timezone, or '' if absent/unparseable. */
function parseDateCell_(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  try { return Utilities.parseDate(s + ' 12:00', tzStr_(), 'yyyy-MM-dd HH:mm'); } catch (e) { return ''; }
}

/** { action:'projectUpdate', name, patch:{status,client,starts,ends} } */
function apiProjectUpdate_(user, req) {
  if (['Super Admin', 'Team Head', 'Assigner'].indexOf(user.role) === -1) {
    return { ok: false, error: 'FORBIDDEN', message: 'Only heads, admins and assigners can change a campaign.' };
  }
  const p = projectByName_(req.name);
  if (!p) return { ok: false, error: 'NOT_FOUND', message: 'No campaign called “' + String(req.name || '') + '”.' };
  const patch = req.patch || {};
  const sh = projectsSheet_();
  if (patch.status !== undefined) {
    const s = String(patch.status);
    if (PROJECT_STATUSES.indexOf(s) === -1) return { ok: false, error: 'VALIDATION', message: 'Status must be Active, On Hold or Done.' };
    sh.getRange(p.row, 2).setValue(s);
  }
  if (patch.client !== undefined) sh.getRange(p.row, 3).setValue(String(patch.client).slice(0, 80));
  if (patch.starts !== undefined) sh.getRange(p.row, 4).setValue(parseDateCell_(patch.starts));
  if (patch.ends !== undefined) sh.getRange(p.row, 5).setValue(parseDateCell_(patch.ends));
  log_('project-update', '', user.email, p.name, true);
  return { ok: true };
}

/* ── campaign notes ────────────────────────────────────────────────────────
   A feed, not one shared text box: several people keep notes on a campaign at
   once, and a single field would mean whoever saved last wiped the others. */

function apiProjectNotes_(user, req) {
  const name = String(req.project || '').trim();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Which campaign?' };
  /* Notes carry briefs and client feedback. Without this any signed-in account
     could read any campaign by guessing its name — the action is authed but
     was not SCOPED, which is not the same thing. */
  if (!canSeeProject_(user, name)) {
    return { ok: false, error: 'FORBIDDEN', message: 'That campaign is outside your work.' };
  }
  const sh = projectNotesSheet_();
  if (sh.getLastRow() < 2) return { ok: true, notes: [] };
  const notes = sh.getRange(2, 1, sh.getLastRow() - 1, PNOTE_HEADERS.length).getValues()
    .filter(function (r) { return String(r[1]).trim().toLowerCase() === name.toLowerCase(); })
    .map(function (r) {
      return {
        id: String(r[0]), author: String(r[2]), text: String(r[3]),
        created: (r[4] instanceof Date) ? r[4].toISOString() : '',
      };
    });
  notes.sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });
  /* Ping-sized rule: 60 notes of 4,000 characters is a quarter of a megabyte,
     which is exactly the shape of answer that broke the studio PC. Cap the
     count, preview the text, and let a long note be opened on its own. */
  const page = notes.slice(0, 30).map(function (n) {
    const full = n.text;
    if (full.length <= NOTE_PREVIEW) return n;
    return { id: n.id, author: n.author, created: n.created, text: full.slice(0, NOTE_PREVIEW), more: true };
  });
  return { ok: true, notes: page, total: notes.length };
}

function apiProjectNoteAdd_(user, req) {
  const name = String(req.project || '').trim();
  const text = String(req.text || '').trim().slice(0, 4000);
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Which campaign?' };
  if (!text) return { ok: false, error: 'VALIDATION', message: 'Write something first.' };
  const sh = projectNotesSheet_();
  let max = 0;
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).match(/^PN-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  const id = 'PN-' + ('0000' + (max + 1)).slice(-5);
  const at = new Date();
  sh.appendRow([id, name, user.name, text, at]);
  log_('project-note', '', user.email, name, true);
  return { ok: true, note: { id: id, author: user.name, text: text, created: at.toISOString() } };
}

function apiProjectNoteDelete_(user, req) {
  const id = String(req.id || '').trim();
  const sh = projectNotesSheet_();
  if (sh.getLastRow() < 2) return { ok: false, error: 'NOT_FOUND', message: 'That note is already gone.' };
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, PNOTE_HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== id) continue;
    const mine = String(rows[i][2]).trim() === user.name;
    if (!mine && ['Super Admin', 'Team Head'].indexOf(user.role) === -1) {
      return { ok: false, error: 'FORBIDDEN', message: 'You can only remove your own notes.' };
    }
    sh.deleteRow(i + 2);
    return { ok: true, deletedId: id };
  }
  return { ok: false, error: 'NOT_FOUND', message: 'That note is already gone.' };
}

/**
 * Renames a campaign and repoints every task at it.
 *
 * The same hazard renameMember_ exists for: the name IS the key, so renaming
 * the row alone would orphan every task silently.
 */
function adminRenameProject_(user, req) {
  const from = String(req.from || '').trim();
  const to = String(req.to || '').trim().slice(0, 80);
  if (!from || !to) return { ok: false, error: 'VALIDATION', message: 'Need both from and to.' };
  const p = projectByName_(from);
  const dest = projectByName_(to);
  /* Tolerate a half-finished rename: if the row was already renamed but the
     tasks were not, let it run again rather than dead-ending. */
  if (!p && !dest) return { ok: false, error: 'NOT_FOUND', message: 'No campaign called “' + from + '”.' };
  if (p && dest) return { ok: false, error: 'VALIDATION', message: '“' + to + '” already exists.' };
  if (p) projectsSheet_().getRange(p.row, 1).setValue(to);

  let touched = 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEETS.MASTER, SHEETS.ARCHIVE].forEach(function (sheetName) {
    const sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return;
    const col = sheetName === SHEETS.MASTER ? COL.PROJECT : ARCHIVE_PROJECT_COL;
    if (sh.getMaxColumns() < col) return;
    const rng = sh.getRange(2, col, sh.getLastRow() - 1, 1);
    const vals = rng.getValues();
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim().toLowerCase() === from.toLowerCase()) { vals[i][0] = to; changed = true; touched++; }
    }
    if (changed) rng.setValues(vals);
  });

  // notes and portfolio point at the name too
  [[projectNotesSheet_(), 2], [portfolioSheet_(), PORTFOLIO_PROJECT_COL]].forEach(function (pair) {
    const sh = pair[0], col = pair[1];
    if (!sh || sh.getLastRow() < 2 || sh.getMaxColumns() < col) return;
    const rng = sh.getRange(2, col, sh.getLastRow() - 1, 1);
    const vals = rng.getValues();
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim().toLowerCase() === from.toLowerCase()) { vals[i][0] = to; changed = true; }
    }
    if (changed) rng.setValues(vals);
  });

  log_('project-rename', '', user.email, from + ' -> ' + to + ' (' + touched + ' tasks)', true);
  return { ok: true, from: from, to: to, tasks: touched };
}

/* ── schema migration ──────────────────────────────────────────────────────
   Deliberately NOT setup(): that rebuilds headers, validations, formulas and
   protections across a sheet holding the studio's live work. This does the one
   thing needed, is safe to run twice, and reports exactly what it touched. */

function ensureProjectSchema_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const did = [];

  const master = ss.getSheetByName(SHEETS.MASTER);
  if (master) {
    if (master.getMaxColumns() < COL.PROJECT) {
      master.insertColumnsAfter(master.getMaxColumns(), COL.PROJECT - master.getMaxColumns());
      did.push('Master widened to ' + COL.PROJECT);
    }
    const head = String(master.getRange(1, COL.PROJECT).getValue()).trim();
    if (head !== 'Project') {
      master.getRange(1, COL.PROJECT).setValue('Project')
        .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
      master.setColumnWidth(COL.PROJECT, 170);
      did.push('Master header set');
    }
  }

  const arch = ss.getSheetByName(SHEETS.ARCHIVE);
  if (arch) {
    if (arch.getMaxColumns() < ARCHIVE_PROJECT_COL) {
      arch.insertColumnsAfter(arch.getMaxColumns(), ARCHIVE_PROJECT_COL - arch.getMaxColumns());
      did.push('Archive widened');
    }
    if (String(arch.getRange(1, ARCHIVE_PROJECT_COL).getValue()).trim() !== 'Project') {
      arch.getRange(1, ARCHIVE_PROJECT_COL).setValue('Project')
        .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
      did.push('Archive header set');
    }
  }

  const pf = portfolioSheet_();
  if (pf.getMaxColumns() < PORTFOLIO_PROJECT_COL) {
    pf.insertColumnsAfter(pf.getMaxColumns(), PORTFOLIO_PROJECT_COL - pf.getMaxColumns());
  }
  if (String(pf.getRange(1, PORTFOLIO_PROJECT_COL).getValue()).trim() !== 'Project') {
    pf.getRange(1, PORTFOLIO_PROJECT_COL).setValue('Project')
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    did.push('Portfolio header set');
  }

  projectsSheet_();
  projectNotesSheet_();

  /* A dropdown on the Master column so anyone typing straight into the sheet
     picks an existing campaign instead of inventing a near-duplicate. Rebuilt
     each run so a new campaign shows up without a separate step. */
  const names = projectRows_().map(function (p) { return p.name; });
  if (master && names.length) {
    try {
      master.getRange(2, COL.PROJECT, Math.max(master.getMaxRows() - 1, 1))
        .setDataValidation(SpreadsheetApp.newDataValidation()
          .requireValueInList(names, true).setAllowInvalid(true).build());
      did.push('Master dropdown: ' + names.length + ' campaigns');
    } catch (e) { did.push('dropdown skipped: ' + String(e).slice(0, 60)); }
  }

  log_('project-schema', '', '', did.join('; ') || 'already current', true);
  return {
    changed: did,
    masterColumns: master ? master.getMaxColumns() : 0,
    projects: names.length,
  };
}
