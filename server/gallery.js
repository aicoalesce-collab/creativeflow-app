/**
 * ============================================================================
 *  gallery.js — the studio's portfolio of finished work.
 *
 *  WHY THIS IS ITS OWN STORE, not a query over Master
 *
 *  Two things destroy a gallery built by filtering live tasks:
 *
 *   1. archiveDone() moves finished tasks out of Master on a schedule, so the
 *      gallery would quietly lose its oldest — and best — work.
 *   2. retention.js trashes the uploaded file after DRIVE_EXPIRY_DAYS (45) and
 *      purges it at 60. That is deliberate and the owner asked for it: video
 *      masters are enormous and the storage has to come back. But it means a
 *      gallery pointed at the original files goes blank a month and a half
 *      after each job.
 *
 *  So when a task is approved, we capture a SMALL still of the deliverable into
 *  a Portfolio folder and record a row here. A few hundred KB per job survives
 *  forever; the multi-gigabyte master still gets reclaimed on schedule. The
 *  studio keeps the showreel and keeps the disk space.
 *
 *  The row also carries the scoping fields (team, assignee, requester) so the
 *  gallery can be filtered per role without reading Master at all.
 * ============================================================================
 */

const PORTFOLIO_HEADERS = ['Task ID', 'Title', 'Team', 'Assignee', 'Requester', 'Completed', 'Thumb ID', 'Link', 'Kind', 'Added', 'Project'];
const PORTFOLIO_PROJECT_COL = 11;   // the campaign, so a gallery can be filtered to one
const PORTFOLIO_FOLDER = 'CreativeFlow Portfolio';
const GALLERY_PAGE = 24;      // one screenful of masonry; keeps answers small

function portfolioSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.PORTFOLIO);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.PORTFOLIO);
    sh.getRange(1, 1, 1, PORTFOLIO_HEADERS.length).setValues([PORTFOLIO_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(2, 280);
  }
  return sh;
}

/** The folder the small stills live in. Separate from the working uploads so
 *  retention never walks into it. */
function portfolioFolder_() {
  const key = 'portfolio_dir';
  try {
    const hit = CacheService.getScriptCache().get(key);
    if (hit) return hit;
  } catch (e) {}
  let dir = null;
  const it = DriveApp.getFoldersByName(PORTFOLIO_FOLDER);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) { dir = f; break; } }
  if (!dir) dir = DriveApp.createFolder(PORTFOLIO_FOLDER);
  const id = dir.getId();
  try { CacheService.getScriptCache().put(key, id, 21600); } catch (e) {}
  return id;
}

/** What kind of thing is this deliverable? Mirrors the client's detectMedia(). */
function galleryKind_(url) {
  const u = String(url || '').trim();
  if (!u) return { kind: 'none' };
  const yt = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{6,})/);
  if (yt) return { kind: 'yt', id: yt[1] };
  if (/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(u)) return { kind: 'img', src: u };
  const dv = u.match(/\/d\/([-\w]{20,})/) || u.match(/[?&]id=([-\w]{20,})/);
  if (dv) return { kind: 'drive', id: dv[1] };
  return { kind: 'link' };
}

/**
 * Grabs a still of a Drive deliverable and stores it in the Portfolio folder.
 *
 * Returns the new file's id, or '' if no still could be made — which is normal
 * and not an error: a PDF, a zip or an .aep has nothing to show, and the
 * gallery falls back to a typed card for those.
 */
function capturePortfolioThumb_(fileId) {
  try {
    /* The Drive thumbnail endpoint gives a far better image than
       File.getThumbnail(), which is tiny. Fall back to it if the fetch fails. */
    let blob = null;
    try {
      const res = UrlFetchApp.fetch('https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w1200', {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true, followRedirects: true,
      });
      if (res.getResponseCode() === 200) {
        const b = res.getBlob();
        if (b && b.getBytes().length > 1024) blob = b;   // an error page is not a picture
      }
    } catch (e) {}
    if (!blob) {
      try { blob = DriveApp.getFileById(fileId).getThumbnail(); } catch (e) {}
    }
    if (!blob) return '';

    const file = DriveApp.getFolderById(portfolioFolder_())
      .createFile(blob.setName('pf-' + fileId + '.jpg'));
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    return file.getId();
  } catch (e) {
    log_('portfolio', '', '', 'thumb failed for ' + fileId + ': ' + String(e).slice(0, 90), false);
    return '';
  }
}

/**
 * Called the moment a task is approved. Idempotent — re-approving after a
 * reopen updates the row rather than adding a second one.
 */
function portfolioCapture_(master, row) {
  try {
    const cur = fullRow_(master, row);
    const id = String(cur[COL.ID - 1]).trim();
    const link = String(cur[COL.DELIVERABLE - 1] || '').trim();
    if (!id || !link) return;                      // nothing finished to show

    const sh = portfolioSheet_();
    const existing = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    let at = 0;
    for (let i = 0; i < existing.length; i++) if (String(existing[i][0]).trim() === id) { at = i + 2; break; }

    const m = galleryKind_(link);

    /* ONE row per task, always showing the LATEST approved version.
       A task that comes back for revisions and is approved again arrives here
       with a new deliverable, so the old still must be replaced — reusing it
       would leave the gallery showing v1's picture next to v3's link, which is
       the one thing a portfolio must never do. The still is only reused when
       the deliverable is byte-for-byte the same link. */
    let thumbId = '', prevThumb = '', prevLink = '';
    if (at) {
      const prevRow = sh.getRange(at, 1, 1, PORTFOLIO_HEADERS.length).getValues()[0];
      prevThumb = String(prevRow[6] || '').trim();
      prevLink = String(prevRow[7] || '').trim();
    }
    const sameFile = at && prevLink === link;

    if (m.kind === 'drive') {
      thumbId = (sameFile && prevThumb) ? prevThumb : capturePortfolioThumb_(m.id);
    }
    /* Bin the superseded still. Leaving it behind slowly fills the Drive this
       whole retention scheme exists to keep free. */
    if (prevThumb && prevThumb !== thumbId) {
      try { DriveApp.getFileById(prevThumb).setTrashed(true); } catch (e) {}
    }

    const vals = [id, String(cur[COL.TITLE - 1] || ''), String(cur[COL.TEAM - 1] || ''),
      String(cur[COL.ASSIGNEE - 1] || ''), String(cur[COL.REQUESTER - 1] || ''),
      (cur[COL.COMPLETED - 1] instanceof Date) ? cur[COL.COMPLETED - 1] : new Date(),
      thumbId, link, m.kind, new Date(), String(cur[COL.PROJECT - 1] || '').trim()];

    if (at) sh.getRange(at, 1, 1, PORTFOLIO_HEADERS.length).setValues([vals]);
    else sh.appendRow(vals);
    log_('portfolio', id, '', m.kind + (thumbId ? ' + still' : ''), true);
  } catch (e) {
    /* A gallery entry is never worth failing an approval over. */
    try { log_('portfolio', '', '', String(e).slice(0, 140), false); } catch (e2) {}
  }
}

/* ── the API ───────────────────────────────────────────────────────────── */

function portfolioRows_() {
  const sh = portfolioSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, PORTFOLIO_HEADERS.length).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return {
        id: String(r[0]), title: String(r[1]), team: String(r[2]),
        assignee: String(r[3]), requester: String(r[4]),
        completed: (r[5] instanceof Date) ? r[5] : null,
        thumbId: String(r[6] || ''), link: String(r[7] || ''), kind: String(r[8] || ''),
        project: String(r[10] || '').trim(),
      };
    });
}

/**
 * { action:'gallery', page, scope:'team'|'mine', team } → { ok, items, next, total }
 *
 * Scoping is enforced HERE, not in the client, because a gallery row carries a
 * link to finished work:
 *   Super Admin — everything, optionally narrowed to one team
 *   Team Head   — their own team; scope:'mine' narrows to what they made
 *   Assigner    — only what they requested
 *   Member      — only what they made, whatever they ask for
 */
function apiGallery_(user, req) {
  const page = Math.max(0, Math.floor(Number(req.page) || 0));
  const scope = String(req.scope || 'team');
  const wantTeam = String(req.team || '').trim();
  const wantProject = String(req.project || '').trim();

  let rows = portfolioRows_();
  if (wantProject) rows = rows.filter(function (r) { return String(r.project).toLowerCase() === wantProject.toLowerCase(); });
  if (user.role === 'Super Admin') {
    if (wantTeam) rows = rows.filter(function (r) { return r.team === wantTeam; });
    if (scope === 'mine') rows = rows.filter(function (r) { return r.assignee === user.name; });
  } else if (user.role === 'Team Head') {
    rows = rows.filter(function (r) { return r.team === user.team; });
    if (scope === 'mine') rows = rows.filter(function (r) { return r.assignee === user.name; });
  } else if (user.role === 'Assigner') {
    rows = rows.filter(function (r) { return r.requester === user.name; });
  } else {
    rows = rows.filter(function (r) { return r.assignee === user.name; });
  }

  rows.sort(function (a, b) {
    return (b.completed ? b.completed.getTime() : 0) - (a.completed ? a.completed.getTime() : 0);
  });

  const total = rows.length;
  const slice = rows.slice(page * GALLERY_PAGE, page * GALLERY_PAGE + GALLERY_PAGE);
  return {
    ok: true,
    total: total,
    next: (page + 1) * GALLERY_PAGE < total ? page + 1 : null,
    items: slice.map(function (r) {
      return {
        id: r.id, title: r.title, team: r.team, assignee: r.assignee, requester: r.requester,
        completed: r.completed ? r.completed.toISOString() : '',
        /* The still we own, which outlives the original file. The client falls
           back to the live link's own thumbnail when there is no still. */
        thumb: r.thumbId ? 'https://drive.google.com/thumbnail?id=' + r.thumbId + '&sz=w800' : '',
        link: r.link, kind: r.kind, project: r.project,
      };
    }),
  };
}

/**
 * Backfills the portfolio from tasks that were already Done before this
 * existed. Batched, resumable, and it skips anything already captured.
 *   { op:'portfolioBackfill', limit: 40 }
 */
function portfolioBackfill_(req) {
  const limit = Math.min(60, Math.max(1, Math.floor(Number(req && req.limit) || 25)));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const have = {};
  portfolioRows_().forEach(function (r) { have[r.id] = true; });

  /* Rows captured before campaigns existed carry no project, so a campaign
     gallery would be empty for work that plainly belongs to it. Fill those in
     from the task itself before adding anything new. */
  const filled = backfillPortfolioProjects_(ss);

  let added = 0, scanned = 0, stills = 0;
  const sheets = [ss.getSheetByName(SHEETS.MASTER), ss.getSheetByName(SHEETS.ARCHIVE)];
  for (let s = 0; s < sheets.length && added < limit; s++) {
    const sh = sheets[s];
    if (!sh || sh.getLastRow() < 2) continue;
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, LAST_COL2).getValues();
    for (let i = 0; i < rows.length && added < limit; i++) {
      const r = rows[i];
      const id = String(r[COL.ID - 1] || '').trim();
      if (!id || have[id]) continue;
      if (String(r[COL.STATUS - 1]).trim() !== 'Done') continue;
      const link = String(r[COL.DELIVERABLE - 1] || '').trim();
      if (!link) continue;
      scanned++;
      const m = galleryKind_(link);
      let thumbId = '';
      if (m.kind === 'drive') { thumbId = capturePortfolioThumb_(m.id); if (thumbId) stills++; }
      portfolioSheet_().appendRow([id, String(r[COL.TITLE - 1] || ''), String(r[COL.TEAM - 1] || ''),
        String(r[COL.ASSIGNEE - 1] || ''), String(r[COL.REQUESTER - 1] || ''),
        (r[COL.COMPLETED - 1] instanceof Date) ? r[COL.COMPLETED - 1] : new Date(),
        thumbId, link, m.kind, new Date(), String(r[COL.PROJECT - 1] || '').trim()]);
      have[id] = true;
      added++;
    }
  }
  return { added: added, stills: stills, scanned: scanned, projectsFilled: filled, more: added >= limit };
}

/**
 * Drops a task out of the gallery when it stops being finished.
 *
 * Reopening a Done task for another round means it is no longer work to show
 * off. Without this the piece would sit in the portfolio, with its old still,
 * while the team is actively redoing it.
 */
function portfolioRemove_(taskId) {
  try {
    const id = String(taskId || '').trim();
    if (!id) return;
    const sh = portfolioSheet_();
    if (sh.getLastRow() < 2) return;
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, PORTFOLIO_HEADERS.length).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim() !== id) continue;
      const thumb = String(rows[i][6] || '').trim();
      if (thumb) { try { DriveApp.getFileById(thumb).setTrashed(true); } catch (e) {} }
      sh.deleteRow(i + 2);
      log_('portfolio', id, '', 'removed — task reopened', true);
      return;
    }
  } catch (e) { /* never worth failing a status change over */ }
}


/**
 * Fills the Portfolio's campaign column for rows captured before campaigns
 * existed, by reading the task back out of Master or Archive.
 *
 * Without it a campaign gallery is empty for work that plainly belongs to it —
 * the piece is in the portfolio, it just never learned which campaign it was.
 */
function backfillPortfolioProjects_(ss) {
  const sh = portfolioSheet_();
  if (sh.getLastRow() < 2) return 0;

  const byId = {};
  [[SHEETS.MASTER, COL.PROJECT], [SHEETS.ARCHIVE, ARCHIVE_PROJECT_COL]].forEach(function (pair) {
    const src = ss.getSheetByName(pair[0]);
    if (!src || src.getLastRow() < 2 || src.getMaxColumns() < pair[1]) return;
    const w = pair[1];
    src.getRange(2, 1, src.getLastRow() - 1, w).getValues().forEach(function (r) {
      const id = String(r[COL.ID - 1] || '').trim();
      const p = String(r[w - 1] || '').trim();
      if (id && p && !byId[id]) byId[id] = p;
    });
  });

  const rng = sh.getRange(2, PORTFOLIO_PROJECT_COL, sh.getLastRow() - 1, 1);
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  const cur = rng.getValues();
  let n = 0;
  for (let i = 0; i < cur.length; i++) {
    if (String(cur[i][0]).trim()) continue;
    const p = byId[String(ids[i][0]).trim()];
    if (p) { cur[i][0] = p; n++; }
  }
  if (n) rng.setValues(cur);
  return n;
}
