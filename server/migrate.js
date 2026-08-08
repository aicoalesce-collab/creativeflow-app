/**
 * ============================================================================
 *  migrate.js — one-command data migration from the OLD CreativeFlow sheet.
 *
 *  Paginated (≤500 rows per call) so the 6-minute execution ceiling can never
 *  kill it; tools/migrate.ps1 loops migrateStep until {done:true}.
 *  The old sheet is opened READ-ONLY (getValues only) — it is never written.
 *
 *  Ops (all Super Admin, via the admin action):
 *   migratePreflight {src}                → counts + anomaly report, no writes
 *   migrateStep {src, confirm:'MIGRATE'}  → next chunk (cursor in Config)
 *   migrateReport {src}                   → old-vs-new validation report
 *   wipeImport {confirm:'WIPE'}           → clear imported data for a re-run
 *   checkOldActivity {src, since}         → split-brain sweep after cutover
 *   newSinceCutover                       → what was created on v5 post-migration
 *
 *  ARRAYFORMULA protection: Master rows are written as THREE ranges —
 *  A:M (1–13), O (15), R:AD (18–30) — columns N/P/Q are never touched, so the
 *  header-row array formulas keep spilling.
 * ============================================================================
 */

const MIGRATE_TABS = ['roster', 'config', 'master', 'archive', 'reviews', 'shares', 'cycles', 'versions', 'alertsLog'];
const MIGRATE_CHUNK = 500;

function oldSheetId_(src) {
  const s = String(src || '').trim();
  const m = s.match(/\/d\/([-\w]{25,})/);
  return m ? m[1] : s;
}

function openOld_(src) {
  const id = oldSheetId_(src);
  if (!id) throw new Error('No old spreadsheet id/url given.');
  return SpreadsheetApp.openById(id);
}

/** Config keys carried over from the old sheet. Everything else stays fresh. */
const MIGRATE_CFG_KEYS = ['ORG_NAME', 'TIMEZONE', 'DUE_SOON_HOURS', 'DEFAULT_DUE_TIME', 'OVERDUE_REPEAT_HOURS',
  'CC_HEAD_FROM_ALERT_N', 'AUTO_URGENT_ON_OVERDUE', 'EMAIL_ON_ASSIGNMENT', 'NOTIFY_REQUESTER_ON_DONE',
  'DAILY_DIGEST', 'DIGEST_HOUR', 'ARCHIVE_AFTER_DAYS', 'MAX_ROUNDS', 'REVIEW_WINDOW_DAYS', 'SLOT_EVE',
  'SLOT_NOON', 'CREATE_CUTOFF', 'WEEKLY_OFF', 'EXTRA_WORK_DATES', 'HOLIDAY_DATES', 'DRIVE_EXPIRY_DAYS',
  'UPLOAD_MODE', 'STORAGE_ACCOUNT', 'GOOGLE_CLIENT_ID', 'GOOGLE_API_KEY'];
// NOT carried: FORM_URL/FORM_EDIT_URL (new form), SCHEMA_V (5.0), DIGEST_SENT,
// SWEEP40_AT, APP_UPDATE_URL, APP_LATEST_VERSION, GOOGLE_DESKTOP_* (retired).

function migratePreflight_(req) {
  const old = openOld_(req.src);
  const out = { ok: true, src: old.getUrl(), tabs: {}, anomalies: [] };
  const oldTz = old.getSpreadsheetTimeZone();
  if (oldTz !== tzStr_()) out.anomalies.push('Timezone differs: old sheet ' + oldTz + ' vs new ' + tzStr_());

  const names = { roster: 'Roster', master: 'Master Tasks', archive: 'Archive', reviews: 'Reviews', shares: 'Shares', cycles: 'Cycles', versions: 'Versions', alertsLog: 'Alerts Log', config: 'Config' };
  Object.keys(names).forEach(k => {
    const sh = old.getSheetByName(names[k]);
    out.tabs[k] = sh ? Math.max(sh.getLastRow() - 1, 0) : -1;
    if (!sh && k !== 'alertsLog') out.anomalies.push('Old tab missing: ' + names[k]);
  });

  const mSh = old.getSheetByName('Master Tasks');
  if (mSh && mSh.getLastRow() > 1) {
    const w = Math.min(mSh.getMaxColumns(), LAST_COL2);
    const rows = mSh.getRange(2, 1, mSh.getLastRow() - 1, w).getValues().filter(r => r[0]);
    const rosterNames = {};
    const rSh = old.getSheetByName('Roster');
    if (rSh && rSh.getLastRow() > 1) rSh.getRange(2, 1, rSh.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0]) rosterNames[String(r[0]).trim()] = 1; });
    const teamsOk = {};
    teams_().forEach(t => teamsOk[t.team] = 1);
    const ids = {};
    let maxByPrefix = {};
    rows.forEach(r => {
      const id = String(r[COL.ID - 1]).trim();
      if (ids[id]) out.anomalies.push('Duplicate Task ID: ' + id);
      ids[id] = 1;
      const im = id.match(/^([A-Z]+)-(\d+)$/);
      if (im) maxByPrefix[im[1]] = Math.max(maxByPrefix[im[1]] || 0, Number(im[2]));
      const st = String(r[COL.STATUS - 1]).trim();
      if (st && STATUSES_ALL.indexOf(st) === -1) out.anomalies.push(id + ': unknown status "' + st + '"');
      const tm = String(r[COL.TEAM - 1]).trim();
      if (tm && !teamsOk[tm]) out.anomalies.push(id + ': unknown team "' + tm + '"');
      [COL.REQUESTER, COL.ASSIGNEE].forEach(c => {
        const nm = String(r[c - 1]).trim();
        if (nm && !rosterNames[nm]) out.anomalies.push(id + ': name not in old Roster: "' + nm + '" (col ' + c + ') — imported as-is');
      });
      if (r.length < LAST_COL2) { /* legacy 22-wide row — padded on import */ }
    });
    out.maxIdByPrefix = maxByPrefix;
    if (out.anomalies.length > 60) out.anomalies = out.anomalies.slice(0, 60).concat(['…and more (' + out.anomalies.length + ' total)']);
  }

  const rosterSh = old.getSheetByName('Roster');
  if (rosterSh && rosterSh.getLastRow() > 1) {
    const rr = rosterSh.getRange(2, 1, rosterSh.getLastRow() - 1, 7).getValues().filter(r => r[0]);
    const noCode = rr.filter(r => String(r[5]).trim().toLowerCase() === 'yes' && !String(r[6]).trim()).map(r => String(r[0]));
    if (noCode.length) out.anomalies.push('Active roster rows without access codes: ' + noCode.join(', '));
  }
  out.emailMute = String(cfg_('EMAIL_MUTE', 'NO')).toUpperCase().indexOf('Y') === 0;
  if (!out.emailMute) out.anomalies.unshift('EMAIL_MUTE is OFF — set it to YES before migrating.');
  return out;
}

function migrateCursor_() {
  try { return JSON.parse(String(cfg_('MIGRATE_CURSOR', '') || '')); } catch (e) { return null; }
}

function migrateStep_(req) {
  if (String(req.confirm) !== 'MIGRATE') return { ok: false, error: 'VALIDATION', message: 'Pass confirm:"MIGRATE" to run the migration.' };
  if (String(cfg_('EMAIL_MUTE', 'NO')).toUpperCase().indexOf('Y') !== 0) {
    return { ok: false, error: 'VALIDATION', message: 'EMAIL_MUTE must be YES during migration (set it in Config, or admin setConfig).' };
  }
  const old = openOld_(req.src);
  let cur = migrateCursor_();
  if (!cur) {
    // starting a NEW run
    if (String(cfg_('MIGRATED_AT', '')) && !req.force) {
      return { ok: false, error: 'VALIDATION', message: 'MIGRATED_AT is already set — this sheet was migrated. Pass force:1 to re-run (wipes imported data first via wipeImport).' };
    }
    cur = { tab: 0, offset: 0 };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabKey = MIGRATE_TABS[cur.tab];
  const res = importChunk_(ss, old, tabKey, cur.offset);

  if (res.next !== null) {
    cur.offset = res.next;
  } else {
    cur = { tab: cur.tab + 1, offset: 0 };
  }

  if (cur.tab >= MIGRATE_TABS.length) {
    // postlude
    buildTeamTabs_(ss);
    rebuildMemberTabs();
    buildDashboard_(ss);
    syncFormAssignees();
    cfgSet_('MIGRATED_AT', new Date().toISOString());
    cfgSet_('MIGRATE_CURSOR', '');
    log_('migrate', 'all', 'admin', 'migration complete from ' + oldSheetId_(req.src), true);
    return { ok: true, done: true, tab: tabKey, copied: res.copied, message: 'Migration complete. Run migrateReport to validate.' };
  }

  cfgSet_('MIGRATE_CURSOR', JSON.stringify(cur));
  return { ok: true, done: false, tab: tabKey, copied: res.copied, nextTab: MIGRATE_TABS[cur.tab], nextOffset: cur.offset };
}

/** Imports up to MIGRATE_CHUNK rows of one tab. offset 0 wipes that tab's data
 *  rows first (wipe-and-reload idempotency — safe to re-run pre-cutover). */
function importChunk_(ss, old, tabKey, offset) {
  switch (tabKey) {
    case 'config': {
      if (offset === 0) {
        const oldCfg = {};
        const oc = old.getSheetByName('Config');
        if (oc && oc.getLastRow() > 1) {
          oc.getRange(2, 1, oc.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) oldCfg[String(r[0]).trim()] = r[1]; });
        }
        let n = 0;
        MIGRATE_CFG_KEYS.forEach(k => { if (oldCfg[k] !== undefined && oldCfg[k] !== '') { cfgSet_(k, oldCfg[k]); n++; } });
        // team → prefix map E2:F11
        if (oc) {
          const tp = oc.getRange(2, 5, 10, 2).getValues();
          cfgSheet_().getRange(2, 5, 10, 2).setValues(tp);
        }
        // keep the mute ON regardless of what the old sheet said
        cfgSet_('EMAIL_MUTE', 'YES');
        return { copied: n, next: null };
      }
      return { copied: 0, next: null };
    }
    case 'roster': {
      const sh = old.getSheetByName('Roster');
      const dst = ss.getSheetByName(SHEETS.ROSTER);
      if (!sh || sh.getLastRow() < 2) return { copied: 0, next: null };
      if (offset === 0 && dst.getLastRow() > 1) dst.getRange(2, 1, dst.getLastRow() - 1, 7).clearContent();
      const total = sh.getLastRow() - 1;
      const n = Math.min(MIGRATE_CHUNK, total - offset);
      if (n <= 0) return { copied: 0, next: null };
      const vals = sh.getRange(2 + offset, 1, n, 7).getValues();
      dst.getRange(2 + offset, 1, n, 7).setValues(vals);
      const next = offset + n < total ? offset + n : null;
      if (next === null) ensureTestBot_(dst);
      return { copied: n, next: next };
    }
    case 'master': {
      const sh = old.getSheetByName('Master Tasks');
      const dst = ss.getSheetByName(SHEETS.MASTER);
      if (!sh || sh.getLastRow() < 2) return { copied: 0, next: null };
      if (offset === 0 && dst.getLastRow() > 1) {
        // wipe data rows without touching the header formulas (N/P/Q live in row 1)
        dst.getRange(2, 1, dst.getLastRow() - 1, LAST_COL2).clearContent();
      }
      const total = sh.getLastRow() - 1;
      const n = Math.min(MIGRATE_CHUNK, total - offset);
      if (n <= 0) return { copied: 0, next: null };
      const w = Math.min(sh.getMaxColumns(), LAST_COL2);
      const src = sh.getRange(2 + offset, 1, n, w).getValues()
        .map(r => { while (r.length < LAST_COL2) r.push(''); return r; });
      // three-range write dodges the ARRAYFORMULA columns N(14)/P(16)/Q(17)
      const aToM = src.map(r => r.slice(0, 13));
      const oCol = src.map(r => [r[14]]);
      const rToAD = src.map(r => r.slice(17, 30));
      dst.getRange(2 + offset, 1, n, 13).setValues(aToM);
      dst.getRange(2 + offset, 15, n, 1).setValues(oCol);
      dst.getRange(2 + offset, 18, n, 13).setValues(rToAD);
      return { copied: n, next: offset + n < total ? offset + n : null };
    }
    case 'archive':  return plainCopy_(old, ss, 'Archive', SHEETS.ARCHIVE, VISIBLE_COLS, offset);
    case 'reviews':  return plainCopy_(old, ss, 'Reviews', SHEETS.REVIEWS, REVIEW_HEADERS.length, offset);
    case 'shares':   return plainCopy_(old, ss, 'Shares', SHEETS.SHARES, SHARE_HEADERS.length, offset);
    case 'cycles':   return plainCopy_(old, ss, 'Cycles', SHEETS.CYCLES, 5, offset);
    case 'versions': return plainCopy_(old, ss, 'Versions', SHEETS.VERSIONS, 7, offset);
    case 'alertsLog': return plainCopy_(old, ss, 'Alerts Log', SHEETS.LOG, 6, offset);
    default: return { copied: 0, next: null };
  }
}

function plainCopy_(old, ss, oldName, newName, width, offset) {
  const sh = old.getSheetByName(oldName);
  const dst = ss.getSheetByName(newName);
  if (!sh || !dst || sh.getLastRow() < 2) return { copied: 0, next: null };
  if (offset === 0 && dst.getLastRow() > 1) dst.getRange(2, 1, dst.getLastRow() - 1, dst.getMaxColumns()).clearContent();
  const total = sh.getLastRow() - 1;
  const n = Math.min(MIGRATE_CHUNK, total - offset);
  if (n <= 0) return { copied: 0, next: null };
  const w = Math.min(width, sh.getMaxColumns());
  const vals = sh.getRange(2 + offset, 1, n, w).getValues()
    .map(r => { while (r.length < width) r.push(''); return r; });
  if (dst.getMaxRows() < 1 + offset + n) dst.insertRowsAfter(dst.getMaxRows(), 1 + offset + n - dst.getMaxRows());
  dst.getRange(2 + offset, 1, n, width).setValues(vals);
  return { copied: n, next: offset + n < total ? offset + n : null };
}

function ensureTestBot_(rosterSh) {
  const last = rosterSh.getLastRow();
  if (last >= 2) {
    const emails = rosterSh.getRange(2, 2, last - 1, 1).getValues().map(r => String(r[0]).trim().toLowerCase());
    if (emails.indexOf('testbot@example.com') !== -1) return;
  }
  rosterSh.appendRow(['Test Bot', 'testbot@example.com', 'Graphic', 'Member', '', 'Yes', 'TB6363']);
}

/** Old-vs-new validation: row counts, status/team distributions, ID continuity. */
function migrateReport_(req) {
  const old = openOld_(req.src);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const names = { roster: ['Roster', SHEETS.ROSTER], master: ['Master Tasks', SHEETS.MASTER], archive: ['Archive', SHEETS.ARCHIVE], reviews: ['Reviews', SHEETS.REVIEWS], shares: ['Shares', SHEETS.SHARES], cycles: ['Cycles', SHEETS.CYCLES], versions: ['Versions', SHEETS.VERSIONS], alertsLog: ['Alerts Log', SHEETS.LOG] };
  const out = { ok: true, counts: {}, statusDist: {}, samples: [] };
  Object.keys(names).forEach(k => {
    const o = old.getSheetByName(names[k][0]);
    const n = ss.getSheetByName(names[k][1]);
    const oc = o ? Math.max(o.getLastRow() - 1, 0) : -1;
    let nc = n ? Math.max(n.getLastRow() - 1, 0) : -1;
    if (k === 'roster' && nc > 0) nc -= 1; // Test Bot is a v5 addition
    out.counts[k] = { old: oc, imported: nc, match: oc === nc };
  });
  const m = ss.getSheetByName(SHEETS.MASTER);
  if (m.getLastRow() > 1) {
    const rows = m.getRange(2, 1, m.getLastRow() - 1, LAST_COL2).getValues().filter(r => r[0]);
    rows.forEach(r => {
      const st = String(r[COL.STATUS - 1]).trim() || '(blank)';
      out.statusDist[st] = (out.statusDist[st] || 0) + 1;
    });
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const pick = rows[Math.floor(rows.length * (i + 0.5) / 5)];
      out.samples.push({ id: pick[COL.ID - 1], title: pick[COL.TITLE - 1], status: pick[COL.STATUS - 1], assignee: pick[COL.ASSIGNEE - 1], stage: pick[X.STAGE - 1], revisions: pick[COL.REVISIONS - 1] });
    }
    // ARRAYFORMULA sanity: N/P/Q must be spilling (header row holds formulas)
    out.overdueFormulaAlive = String(m.getRange(1, COL.OVERDUE).getFormula()).indexOf('ARRAYFORMULA') !== -1;
  }
  out.migratedAt = String(cfg_('MIGRATED_AT', ''));
  return out;
}

/** Clears every imported tab's data rows + the migration stamps (dry-run reset). */
function wipeImport_(req) {
  if (String(req.confirm) !== 'WIPE') return { ok: false, error: 'VALIDATION', message: 'Pass confirm:"WIPE" to clear imported data.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEETS.MASTER, SHEETS.ARCHIVE, SHEETS.REVIEWS, SHEETS.SHARES, SHEETS.CYCLES, SHEETS.VERSIONS, SHEETS.LOG].forEach(nm => {
    const sh = ss.getSheetByName(nm);
    if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
  });
  const r = ss.getSheetByName(SHEETS.ROSTER);
  if (r && r.getLastRow() > 1) r.getRange(2, 1, r.getLastRow() - 1, 7).clearContent();
  buildRoster_(ss); // reseed owner + Test Bot
  cfgSet_('MIGRATED_AT', '');
  cfgSet_('MIGRATE_CURSOR', '');
  log_('migrate', 'wipe', 'admin', 'imported data cleared', true);
  return { ok: true, result: 'imported data cleared; roster reseeded (owner + Test Bot)' };
}

/** Split-brain sweep: anything created/updated on the OLD sheet after cutover? */
function checkOldSheetActivity_(req) {
  const old = openOld_(req.src);
  const since = new Date(String(req.since || cfg_('MIGRATED_AT', '')));
  if (isNaN(since.getTime())) return { ok: false, error: 'VALIDATION', message: 'Pass since (ISO) or migrate first.' };
  const out = { ok: true, since: since.toISOString(), newTasks: [], logEntries: 0 };
  const m = old.getSheetByName('Master Tasks');
  if (m && m.getLastRow() > 1) {
    m.getRange(2, 1, m.getLastRow() - 1, LAST_COL).getValues().forEach(r => {
      if (r[COL.ID - 1] && r[COL.CREATED - 1] instanceof Date && r[COL.CREATED - 1] > since) {
        out.newTasks.push({ id: String(r[COL.ID - 1]), title: String(r[COL.TITLE - 1]), created: r[COL.CREATED - 1].toISOString() });
      }
    });
  }
  const lg = old.getSheetByName('Alerts Log');
  if (lg && lg.getLastRow() > 1) {
    lg.getRange(2, 1, lg.getLastRow() - 1, 1).getValues().forEach(r => {
      if (r[0] instanceof Date && r[0] > since) out.logEntries++;
    });
  }
  out.splitBrain = out.newTasks.length > 0;
  return out;
}

/** Everything created on v5 after migration — the manual-rollback report. */
function newSinceCutover_() {
  const since = new Date(String(cfg_('MIGRATED_AT', '')));
  if (isNaN(since.getTime())) return { ok: false, error: 'VALIDATION', message: 'No MIGRATED_AT set.' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = { ok: true, since: since.toISOString(), tasks: [], reviews: 0, versions: 0 };
  const m = ss.getSheetByName(SHEETS.MASTER);
  if (m.getLastRow() > 1) {
    m.getRange(2, 1, m.getLastRow() - 1, LAST_COL).getValues().forEach(r => {
      if (r[COL.ID - 1] && r[COL.CREATED - 1] instanceof Date && r[COL.CREATED - 1] > since) {
        out.tasks.push({ id: String(r[COL.ID - 1]), title: String(r[COL.TITLE - 1]), status: String(r[COL.STATUS - 1]), assignee: String(r[COL.ASSIGNEE - 1]) });
      }
    });
  }
  const rv = ss.getSheetByName(SHEETS.REVIEWS);
  if (rv.getLastRow() > 1) rv.getRange(2, 11, rv.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0] instanceof Date && r[0] > since) out.reviews++; });
  const vs = ss.getSheetByName(SHEETS.VERSIONS);
  if (vs.getLastRow() > 1) vs.getRange(2, 5, vs.getLastRow() - 1, 1).getValues().forEach(r => { if (r[0] instanceof Date && r[0] > since) out.versions++; });
  return out;
}
