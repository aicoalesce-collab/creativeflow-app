/**
 * ============================================================================
 *  mock-api.mjs — in-memory mock of the CreativeFlow v5 Apps Script API.
 *  Fixture-driven, Windows-pathed, resettable. Mirrors the v5 contract
 *  (server/*.js) including the permission rules and state machine — the
 *  Playwright battery runs the real client against THIS.
 *
 *  Run: node tests/mock/mock-api.mjs         (default port 8787)
 *
 *  Env knobs:
 *   MOCK_PORT=8787
 *   MOCK_SLOW_BIG=1        delay the BIG answers (full bootstrap / legacy tasks) 60s
 *   MOCK_STALL_OVER=8192   any response bigger than N bytes: send first N bytes, never finish
 *   MOCK_PAGE_MAX=10       server page clamp override (default 50)
 *   MOCK_NO_PAGER=1        tasksPage → UNKNOWN_ACTION (old-server emulation)
 *   MOCK_TIMEOUT_ONCE=tasksPage   first call to that action hangs; later calls succeed
 *   MOCK_ERROR_HTML=bootstrap     that action answers with an HTML error page (NOT_JSON)
 *   MOCK_MAIL_QUOTA=0      emulate exhausted MailApp quota (outbox logs quota events)
 *   MOCK_MUTE=1            EMAIL_MUTE=YES semantics (outbox records muted entries)
 *   MOCK_APPVER=5.1.0      ping advertises this appVersion (OTA tests)
 *   MOCK_APPHTML=path      file served by the appHtml action / ?page=app
 *
 *  Control endpoints (test-only): POST /__reset · GET /__state · GET /__outbox
 * ============================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const PORT = Number(process.env.MOCK_PORT || 8787);
const API_VERSION = 5.0;
const PAGE_MAX = Number(process.env.MOCK_PAGE_MAX || 50);
const STALL_OVER = Number(process.env.MOCK_STALL_OVER || 0);
const SLOW_BIG = process.env.MOCK_SLOW_BIG === '1';
const NO_PAGER = process.env.MOCK_NO_PAGER === '1';
const TIMEOUT_ONCE = String(process.env.MOCK_TIMEOUT_ONCE || '');
const ERROR_HTML = String(process.env.MOCK_ERROR_HTML || '');
const MUTE = process.env.MOCK_MUTE === '1';
const MAIL_QUOTA = process.env.MOCK_MAIL_QUOTA !== undefined ? Number(process.env.MOCK_MAIL_QUOTA) : 100;
const APPVER = String(process.env.MOCK_APPVER || '');
const APPHTML = String(process.env.MOCK_APPHTML || '');

const STATUSES = ['New', 'In Progress', 'In Review', 'Revisions', 'Done', 'On Hold'];
const STATUSES_ALL = [...STATUSES, 'Rejected'];
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const TEAMS = [{ team: 'Graphic', prefix: 'GD' }, { team: 'Video', prefix: 'VD' }];
const CFG = { MAX_ROUNDS: 3, REVIEW_WINDOW_DAYS: 7, SLOT_EVE: '17:00', SLOT_NOON: '12:00', CREATE_CUTOFF: '17:00', WEEKLY_OFF: ['Sunday'], ORG: 'Coalesce Eventz (mock)' };

let state, outbox, mailQuotaLeft, timedOutOnce;

function day(offset, hm = '18:00') {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const [h, m] = hm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

function load() {
  const roster = JSON.parse(fs.readFileSync(path.join(FIX, 'roster.json'), 'utf8'));
  const rawTasks = JSON.parse(fs.readFileSync(path.join(FIX, 'tasks.json'), 'utf8'));
  const rawReviews = JSON.parse(fs.readFileSync(path.join(FIX, 'reviews.json'), 'utf8'));
  const rawShares = JSON.parse(fs.readFileSync(path.join(FIX, 'shares.json'), 'utf8'));
  const tasks = rawTasks.map(t => {
    const due = day(t.dueOffsetDays, t.dueTime || '18:00');
    return {
      id: t.id, requester: t.requester, team: t.team, assignee: t.assignee,
      title: t.title,
      desc: t.desc === '@MONSTER' ? 'X'.repeat(200 * 1024) : (t.desc || ''),
      brief: t.brief || '', deliverable: t.deliverable || '',
      priority: t.priority, status: t.status, notes: t.notes || '',
      revisions: t.revisions || 0,
      created: day(t.createdOffsetDays, '10:00').toISOString(),
      completed: t.completedOffsetDays == null ? null : day(t.completedOffsetDays, '16:00').toISOString(),
      dueMs: due.getTime(),
      dueDate: due.toISOString().slice(0, 10),
      dueTime: t.dueTime || '18:00',
      startedAt: t.startedOffsetDays == null ? null : day(t.startedOffsetDays, '11:00').toISOString(),
      stage: t.stage || '', qcRounds: t.qcRounds || 0, reviewDays: t.reviewDays || 0,
      flags: t.flags || '', renewedFrom: t.renewedFrom || '', briefPending: !!t.briefPending,
    };
  });
  const reviews = rawReviews.map(r => ({ ...r, created: day(r.createdOffsetDays, '12:00').toISOString() }));
  const shares = rawShares.map(s => ({ token: s.token, taskId: s.taskId, mode: s.mode, createdBy: s.createdBy, created: day(s.createdOffsetDays, '12:00').toISOString(), revoked: !!s.revoked }));
  const versions = {};
  tasks.filter(t => t.deliverable).forEach(t => {
    versions[t.id] = [];
    const n = t.id === 'VD-0002' || t.id === 'GD-0005' ? 2 : 1;
    for (let v = 1; v <= n; v++) {
      versions[t.id].push({ v, link: t.deliverable, by: t.assignee || t.requester, at: t.created, fileId: (t.deliverable.match(/\/d\/([-\w]{20,})/) || [])[1] || '', expires: '' });
    }
  });
  state = { roster, tasks, reviews, shares, versions, nextReview: 7 };
  outbox = [];
  mailQuotaLeft = MAIL_QUOTA;
  timedOutOnce = false;
}
load();

/* ── helpers mirroring the server ──────────────────────────────────────── */

const nowIso = () => new Date().toISOString();
const auth = (email, code) => state.roster.find(m => m.active && m.email === String(email || '').trim().toLowerCase() && m.code.toUpperCase() === String(code || '').trim().toUpperCase()) || null;
const canManage = (u, team) => u.role === 'Super Admin' || (u.role === 'Team Head' && u.team === team);
const headsOf = team => {
  const h = state.roster.filter(m => m.active && m.role === 'Team Head' && m.team === team);
  return h.length ? h : state.roster.filter(m => m.active && m.role === 'Super Admin');
};
const emailByName = name => (state.roster.find(m => m.name === name) || {}).email || '';

function mail(to, subject, kind, actor) {
  const clean = String(to || '').split(',').map(s => s.trim()).filter(s => s && s.includes('@') && !s.includes('@example.com')).join(',');
  const entry = { to: String(to || ''), clean, subject, kind, actor: actor || '', at: nowIso() };
  if (!clean) { entry.dropped = 'no-real-recipient'; outbox.push(entry); return; }
  if (MUTE) { entry.muted = true; outbox.push(entry); return; }
  if (actor && /@example\.com$/i.test(actor)) { entry.mutedActor = true; outbox.push(entry); return; }
  if (mailQuotaLeft < 1) { entry.quota = true; outbox.push(entry); return; }
  mailQuotaLeft--;
  outbox.push(entry);
}

function scopedFull(u) {
  if (u.role === 'Super Admin') return state.tasks;
  if (u.role === 'Team Head') return state.tasks.filter(t => t.team === u.team);
  if (u.role === 'Assigner') return state.tasks.filter(t => t.requester === u.name);
  return state.tasks.filter(t => t.assignee === u.name);
}

/* v5 R4 fix mirror: list answers carry desc/notes PREVIEWS; taskDetail has full text. */
const DESC_PREVIEW = 500, NOTES_PREVIEW = 1000;
function preview(t) {
  const out = { ...t };
  if (t.desc.length > DESC_PREVIEW) { out.desc = t.desc.slice(0, DESC_PREVIEW); out.descMore = true; }
  if (t.notes.length > NOTES_PREVIEW) { out.notes = t.notes.slice(0, NOTES_PREVIEW); out.notesMore = true; }
  return out;
}
const scoped = u => scopedFull(u).map(preview);

const byId = id => state.tasks.find(t => t.id === String(id || '').trim());

function nextId(team) {
  const prefix = (TEAMS.find(t => t.team === team) || { prefix: 'T' }).prefix;
  let max = 0;
  state.tasks.forEach(t => { const m = t.id.match(new RegExp('^' + prefix + '-(\\d+)$')); if (m) max = Math.max(max, Number(m[1])); });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function isWorkDay(d) { return !CFG.WEEKLY_OFF.includes(d.toLocaleDateString('en-US', { weekday: 'long' })); }
function nextWorkDay(d) { const x = new Date(d); do { x.setDate(x.getDate() + 1); } while (!isWorkDay(x)); return x; }
function slotDue(now) {
  const hm = now.toTimeString().slice(0, 5);
  if (isWorkDay(now) && hm < CFG.SLOT_EVE) { const d = new Date(now); const [h, m] = CFG.SLOT_EVE.split(':'); d.setHours(+h, +m, 0, 0); return d; }
  const d = nextWorkDay(now); const [h, m] = CFG.SLOT_NOON.split(':'); d.setHours(+h, +m, 0, 0); return d;
}

const latestVersionOf = id => { const v = state.versions[id]; return v && v.length ? v[v.length - 1].v : 1; };

function addVersion(id, link, by, fileId, hadBefore) {
  const vs = state.versions[id] = state.versions[id] || [];
  const base = vs.length ? vs[vs.length - 1].v : (hadBefore ? 1 : 0);
  const v = base + 1;
  vs.push({ v, link, by, at: nowIso(), fileId: fileId || '', expires: '' });
  return v;
}

/* ── action handlers (contract mirror of server/*.js) ──────────────────── */

function ping() {
  return {
    ok: true, v: API_VERSION, org: CFG.ORG,
    appVersion: APPVER || appVersionFromFile() || '5.0.0',
    googleClientId: 'mock-client-id.apps.googleusercontent.com',
    googleApiKey: 'mock-api-key',
    uploadMode: 'central', storageAccount: 'studio@example.com',
    emailMute: MUTE, serverTime: nowIso(),
  };
}

function appVersionFromFile() {
  try {
    const p = APPHTML || path.join(FIX, '..', '..', 'web', 'dist-single', 'index.html');
    const m = fs.readFileSync(p, 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function appHtml() {
  try {
    const p = APPHTML || path.join(FIX, '..', '..', 'web', 'dist-single', 'index.html');
    const html = fs.readFileSync(p, 'utf8');
    return { ok: true, version: (html.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '', html };
  } catch (e) { return { ok: false, error: 'NO_APP', message: 'No app html available: ' + e.message }; }
}

function bootstrap(u, req) {
  const out = {
    ok: true,
    me: { name: u.name, team: u.team, role: u.role, email: u.email },
    org: CFG.ORG, formUrl: 'https://forms.example.com/mock', sheetUrl: 'https://sheets.example.com/mock',
    teams: TEAMS.map(t => t.team),
    roster: state.roster.filter(m => m.active).map(m => ({ name: m.name, team: m.team, role: m.role })),
    serverTime: nowIso(),
  };
  if (req && req.lite) { out.total = scoped(u).length; return out; }
  out.tasks = scoped(u);
  out.__big = true;
  return out;
}

function tasksPage(u, req) {
  if (NO_PAGER) return { ok: false, error: 'UNKNOWN_ACTION', message: 'tasksPage' };
  const rows = scoped(u);
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(req.limit) || 25)));
  const page = rows.slice(offset, offset + limit);
  return { ok: true, tasks: page, total: rows.length, next: offset + limit < rows.length ? offset + limit : null, serverTime: nowIso() };
}

function createCutoff(u, req) {
  if (u.role !== 'Assigner') return null;
  const today = new Date().toISOString().slice(0, 10);
  const hm = new Date().toTimeString().slice(0, 5);
  if (String(req.dueDate || '') === today && hm >= CFG.CREATE_CUTOFF) {
    return { ok: false, error: 'VALIDATION', message: 'Same-day tasks close at ' + CFG.CREATE_CUTOFF + ' — pick tomorrow or later, or call the team head for a genuine emergency.' };
  }
  return null;
}

function createTask(u, req, quiet) {
  const title = String(req.title || '').trim();
  if (!title) return { ok: false, error: 'VALIDATION', message: 'Task title is required.' };
  let team = String(req.team || '').trim();
  let assignee = String(req.assignee || '').trim();
  if (assignee) {
    const m = state.roster.find(x => x.active && x.name === assignee);
    if (!m) return { ok: false, error: 'VALIDATION', message: 'Assignee not found in the Roster.' };
    team = m.team;
  }
  if (!TEAMS.some(t => t.team === team)) return { ok: false, error: 'VALIDATION', message: 'Unknown team: ' + team };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.dueDate || ''))) return { ok: false, error: 'VALIDATION', message: 'A due date is required.' };

  const id = nextId(team);
  const dueTime = /^\d{1,2}:\d{2}$/.test(String(req.dueTime || '')) ? req.dueTime : '18:00';
  const due = new Date(req.dueDate + 'T' + dueTime.padStart(5, '0') + ':00');
  const t = {
    id, requester: u.name, team, assignee, title,
    desc: String(req.desc || ''), brief: String(req.brief || ''), deliverable: '',
    priority: PRIORITIES.includes(String(req.priority)) ? String(req.priority) : 'Medium',
    status: 'New', notes: '', revisions: 0,
    created: nowIso(), completed: null,
    dueMs: due.getTime(), dueDate: String(req.dueDate), dueTime,
    startedAt: null, stage: '', qcRounds: 0, reviewDays: 0, flags: '', renewedFrom: '', briefPending: false,
  };
  state.tasks.push(t);
  let info;
  if (quiet) info = 'created (bulk)';
  else if (assignee) { mail(emailByName(assignee), `[Task] 🆕 New task for you — ${id}: ${title}`, 'assigned', u.email); info = 'assignment alert emailed to ' + assignee; }
  else { mail(headsOf(team).map(h => h.email).join(','), `[Task] 🙋 New ${team} task needs an assignee — ${id}`, 'needs-assignee', u.email); info = 'sent to the ' + team + ' head for assignment'; }
  return { ok: true, info, task: t };
}

function updateTask(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found (it may have been archived).' };
  const manage = canManage(u, t.team);
  const isMine = t.assignee === u.name;
  const isReqA = u.role === 'Assigner' && t.requester === u.name;
  if (!manage && !isMine && !isReqA) return { ok: false, error: 'FORBIDDEN', message: 'You can only update your own tasks.' };

  const p = req.patch || {};
  if (isReqA && !manage && !isMine) {
    const allowed = ['status', 'brief', 'priority', 'notes', 'dueDate', 'dueTime'];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) return { ok: false, error: 'FORBIDDEN', message: 'As the requester you can change the verdict, brief, priority and deadline — "' + k + '" belongs to the team.' };
    if (p.status !== undefined) {
      if (!['Done', 'Revisions'].includes(String(p.status))) return { ok: false, error: 'FORBIDDEN', message: 'Your call is ✓ Approve (Done) or ↺ send changes (Revisions) — other statuses are the team\'s.' };
      if (t.status !== 'In Review' || t.stage !== 'Assigner') return { ok: false, error: 'VALIDATION', message: 'This task hasn\'t reached you yet — the team is still on it.' };
    }
    if ((p.dueDate !== undefined || p.dueTime !== undefined) && ['Done', 'Rejected'].includes(t.status)) return { ok: false, error: 'VALIDATION', message: 'This task is closed — renew or create a new one instead.' };
  } else if (!manage && !isReqA) {
    const allowed = ['status', 'deliverable', 'notes', 'dueDate', 'dueTime'];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) return { ok: false, error: 'FORBIDDEN', message: 'Only your team head can change "' + k + '".' };
    if (p.status === 'Done' || p.status === 'Rejected') return { ok: false, error: 'FORBIDDEN', message: p.status === 'Done' ? 'Set it to In Review — your team head marks it Done.' : 'Only the team head or super admin can reject a task.' };
  }
  if (p.status !== undefined && !STATUSES_ALL.includes(String(p.status))) return { ok: false, error: 'VALIDATION', message: 'Unknown status.' };
  if (p.priority !== undefined && !PRIORITIES.includes(String(p.priority))) return { ok: false, error: 'VALIDATION', message: 'Unknown priority.' };

  if (p.status === 'In Review' && p.status !== t.status) {
    if (!t.startedAt && !(manage && p.startedAt)) return { ok: false, error: 'VALIDATION', message: 'Press ▶ Start work first — it stamps the start time. (Heads can also type the real start time in the task card and save.)' };
    if (t.briefPending && !manage) return { ok: false, error: 'VALIDATION', message: 'The brief was updated — press “Accept updated brief” on the task first.' };
  }

  const notes = [];
  const curStatus = t.status;

  if (manage && p.assignee !== undefined) {
    const a = String(p.assignee || '').trim();
    if (a) {
      const m = state.roster.find(x => x.active && x.name === a && x.team === t.team);
      if (!m) return { ok: false, error: 'VALIDATION', message: 'Assignee must be an active ' + t.team + ' member.' };
    }
    const old = t.assignee;
    t.assignee = a;
    if (a && a !== old) { mail(emailByName(a), `[Task] 🆕 New task for you — ${t.id}`, 'assigned', u.email); notes.push('assignment alert emailed to ' + a); }
  }
  if ((manage || isReqA) && p.priority !== undefined) t.priority = String(p.priority);
  if ((manage || isReqA) && p.brief !== undefined) {
    const nb = String(p.brief);
    const changed = nb !== t.brief;
    t.brief = nb;
    if (changed && t.startedAt && !['Done', 'Rejected'].includes(curStatus)) {
      t.briefPending = true;
      mail(emailByName(t.assignee), '[Task] ✍️ Brief updated — ' + t.id, 'brief-updated', u.email);
      notes.push('brief flagged for re-accept');
    }
  }
  if (p.startedAt !== undefined) {
    if (!manage) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head or super admin can set or backdate the start time.' };
    const sd = new Date(String(p.startedAt));
    if (isNaN(sd.getTime())) return { ok: false, error: 'VALIDATION', message: 'Start time not understood — use the date-time picker.' };
    if (sd.getTime() > Date.now() + 600000) return { ok: false, error: 'VALIDATION', message: 'The start time can\'t be in the future.' };
    t.startedAt = sd.toISOString();
    notes.push('start time set (logged)');
  }
  if (p.dueDate !== undefined || p.dueTime !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.dueDate || ''))) t.dueDate = String(p.dueDate);
    t.dueTime = /^\d{1,2}:\d{2}$/.test(String(p.dueTime || '')) ? String(p.dueTime) : '';
    t.dueMs = new Date(t.dueDate + 'T' + (t.dueTime || '23:59').padStart(5, '0') + ':00').getTime();
    if (manage) { mail(emailByName(t.assignee), '[Task] 📅 Deadline changed — ' + t.id, 'due-changed', u.email); notes.push('reschedule alert emailed'); }
    else { mail(headsOf(t.team).map(h => h.email).join(','), '[Task] 📅 ' + u.name + ' rescheduled ' + t.id, 'rescheduled-by-member', u.email); notes.push('team head notified of the move'); }
  }
  if (p.deliverable !== undefined) {
    const nd = String(p.deliverable);
    if (nd && nd !== t.deliverable) {
      const hadBefore = t.deliverable !== '';
      t.deliverable = nd;
      const v = addVersion(t.id, nd, u.name, String(req.fileId || ''), hadBefore);
      notes.push('saved as v' + v);
    } else t.deliverable = nd;
  }
  if (p.notes !== undefined) t.notes = String(p.notes);

  if (p.status !== undefined && String(p.status) !== curStatus) {
    const s = String(p.status);
    t.status = s;
    if (s === 'Done') {
      t.stage = ''; t.completed = nowIso();
      mail([emailByName(t.requester), ...headsOf(t.team).map(h => h.email)].join(','), '[Task] ✅ Completed — ' + t.id, 'done', u.email);
      notes.push('requester + head notified');
    } else {
      if (curStatus === 'Done') t.completed = null;
      if (curStatus === 'In Review' && s !== 'Revisions') t.stage = '';
      if (s === 'In Progress') { if (!t.startedAt) t.startedAt = nowIso(); }
      if (s === 'Revisions') {
        if (t.stage === 'QC') { t.qcRounds++; notes.push('sent back at QC (does not use the round limit)'); }
        else {
          t.revisions++;
          if (t.revisions > CFG.MAX_ROUNDS) { if (!t.flags.includes('over-limit')) t.flags = t.flags ? t.flags + ',over-limit' : 'over-limit'; notes.push('⚠ round ' + t.revisions + ' — over the ' + CFG.MAX_ROUNDS + '-round limit'); }
        }
        t.stage = '';
        const slot = slotDue(new Date());
        t.dueDate = slot.toISOString().slice(0, 10);
        t.dueTime = slot.toTimeString().slice(0, 5);
        t.dueMs = slot.getTime();
        notes.push('deadline auto-set');
        mail(emailByName(t.assignee), '[Task] 🔁 Revisions requested — ' + t.id, 'revision', u.email);
        notes.push('revision alert emailed');
      }
      if (s === 'In Review') {
        t.stage = manage ? 'Assigner' : 'QC';
        if (t.stage === 'QC') { mail(headsOf(t.team).map(h => h.email).join(','), '[Task] 🔎 QC check — ' + t.id, 'qc-request', u.email); notes.push('head asked to QC'); }
        else { mail(emailByName(t.requester), '[Task] 🎬 Your assignment is ready — ' + t.id, 'review-request', u.email); notes.push('requester pinged to review'); }
      }
    }
  }
  return { ok: true, info: notes.join(' · '), task: t };
}

function deleteTask(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found (it may already be deleted or archived).' };
  const isReqD = u.role === 'Assigner' && t.requester === u.name;
  if (!canManage(u, t.team) && !isReqD) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can delete tasks.' };
  if (isReqD && !canManage(u, t.team) && (t.status !== 'New' || t.startedAt)) {
    return { ok: false, error: 'VALIDATION', message: 'The team has already started this one — use ✗ Reject (with a reason) instead of deleting.' };
  }
  state.tasks = state.tasks.filter(x => x.id !== t.id);
  return { ok: true, deletedId: t.id };
}

function rejectTask(u, req) {
  const t = byId(req.id);
  const reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'VALIDATION', message: 'A reject needs a reason — one honest line.' };
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found.' };
  const isReqR = u.role === 'Assigner' && t.requester === u.name;
  if (!canManage(u, t.team) && !isReqR) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can reject a task.' };
  if (t.status === 'Done') return { ok: false, error: 'VALIDATION', message: 'This task is already Done — reopen it first if it truly must be rejected.' };
  t.stage = ''; t.status = 'Rejected';
  t.notes = ('✗ Rejected by ' + u.name + ' — ' + reason + (t.notes ? '\n' + t.notes : '')).slice(0, 4000);
  mail([emailByName(t.assignee), ...headsOf(t.team).map(h => h.email)].join(','), '[Task] ✗ Rejected — ' + t.id, 'rejected', u.email);
  return { ok: true, task: t };
}

function startTask(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found.' };
  const mine = t.assignee === u.name;
  const teammate = u.team === t.team && u.role !== 'Assigner';
  if (!mine && !canManage(u, t.team) && !(teammate && !t.assignee)) {
    return { ok: false, error: 'FORBIDDEN', message: t.assignee ? 'This task is assigned to ' + t.assignee + ' — only they (or the head) can start it.' : 'Only the ' + t.team + ' team can start this task.' };
  }
  if (['Done', 'Rejected', 'In Review'].includes(t.status)) return { ok: false, error: 'VALIDATION', message: 'This task is in ' + t.status + ' — nothing to start.' };
  let claimed = false;
  if (!t.assignee && u.role !== 'Assigner') { t.assignee = u.name; claimed = true; }
  if (!t.startedAt) t.startedAt = nowIso();
  if (t.status === 'New' || t.status === 'On Hold') t.status = 'In Progress';
  if (claimed) mail(headsOf(t.team).map(h => h.email).join(','), '[Task] 🙋 ' + u.name + ' picked up ' + t.id, 'claimed', u.email);
  const out = { ok: true, task: t };
  if (claimed) out.info = 'it was unassigned — it\'s yours now, head notified';
  return out;
}

function acceptChanges(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task not found.' };
  if (t.assignee !== u.name && !canManage(u, t.team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee can accept the changes.' };
  if (t.status !== 'Revisions') return { ok: false, error: 'VALIDATION', message: 'This task is not in a revision round.' };
  t.status = 'In Progress';
  return { ok: true, task: t };
}

function qcPass(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task not found.' };
  if (!canManage(u, t.team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head or super admin can pass QC.' };
  if (t.status !== 'In Review') return { ok: false, error: 'VALIDATION', message: 'This task is not in review.' };
  if (t.stage === 'Assigner') return { ok: false, error: 'VALIDATION', message: 'Already with the requester.' };
  t.stage = 'Assigner';
  mail(emailByName(t.requester), '[Task] 🎬 Your assignment is ready — ' + t.id, 'review-request', u.email);
  return { ok: true, task: t, info: 'passed QC · requester emailed a review link' };
}

function renewTask(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task not found.' };
  if (t.assignee !== u.name && !canManage(u, t.team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee or head can renew this task.' };
  if (!t.flags.split(',').includes('auto-done')) return { ok: false, error: 'VALIDATION', message: 'Renewal is only for tasks that auto-closed because the review window ran out.' };
  const nd = nextWorkDay(new Date());
  const made = createTask(u, {
    team: t.team, assignee: t.assignee, title: t.title + ' — renewal',
    desc: t.desc, brief: t.brief, priority: t.priority,
    dueDate: nd.toISOString().slice(0, 10), dueTime: CFG.SLOT_EVE,
  });
  if (!made.ok) return made;
  made.task.renewedFrom = t.id;
  made.info = 'renewed as ' + made.task.id + ' — counted in reports';
  return made;
}

function acceptBrief(u, req) {
  const t = byId(req.id);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'Task not found.' };
  if (t.assignee !== u.name && !canManage(u, t.team)) return { ok: false, error: 'FORBIDDEN', message: 'Only the assignee accepts the updated brief.' };
  t.briefPending = false;
  return { ok: true, task: t };
}

function bulkCreate(u, req) {
  if (!['Assigner', 'Team Head', 'Super Admin'].includes(u.role)) return { ok: false, error: 'FORBIDDEN', message: 'Bulk add is for requesters and heads.' };
  const rows = (req.rows || []).slice(0, 50);
  if (!rows.length) return { ok: false, error: 'VALIDATION', message: 'No rows to create.' };
  const created = [], errors = [];
  rows.forEach((x, i) => {
    const cut = createCutoff(u, x || {});
    if (cut) { errors.push({ i, title: String((x || {}).title || ''), message: cut.message }); return; }
    const r = createTask(u, x || {}, true);
    if (r.ok) created.push(r.task);
    else errors.push({ i, title: String((x || {}).title || ''), message: r.message });
  });
  const byTeam = {};
  created.forEach(t => { (byTeam[t.team] = byTeam[t.team] || []).push(t); });
  Object.keys(byTeam).forEach(team => mail(headsOf(team).map(h => h.email).join(','), '[Task] 🧺 ' + byTeam[team].length + ' new ' + team + ' tasks from ' + u.name, 'bulk-digest', u.email));
  return { ok: true, created, errors };
}

/* ── review room ───────────────────────────────────────────────────────── */

function taskAccess(u, taskId) {
  const t = byId(taskId);
  if (!t) return { err: { ok: false, error: 'NOT_FOUND', message: 'Task ' + taskId + ' was not found.' } };
  const isReq = t.requester === u.name;
  const allowed = u.role === 'Super Admin' || (u.role === 'Team Head' && u.team === t.team) || t.assignee === u.name || isReq;
  if (!allowed) return { err: { ok: false, error: 'FORBIDDEN', message: 'This task is outside your scope.' } };
  const manage = canManage(u, t.team);
  const own = manage || (u.role === 'Assigner' && isReq);
  const decide = manage || (u.role === 'Assigner' && isReq && t.stage === 'Assigner' && t.status === 'In Review');
  return { t, manage, own, decide, isReq };
}

function listReview(u, req) {
  const a = taskAccess(u, String(req.taskId || '').trim());
  if (a.err) return a.err;
  const out = { ok: true, items: state.reviews.filter(r => r.taskId === a.t.id), canManage: a.manage, versions: state.versions[a.t.id] || [] };
  if (a.manage) out.shares = state.shares.filter(s => s.taskId === a.t.id && !s.revoked).map(s => ({ token: s.token, mode: s.mode, created: s.created }));
  return out;
}

function addReview(u, req) {
  const a = taskAccess(u, String(req.taskId || '').trim());
  if (a.err) return a.err;
  const type = String(req.type || 'comment');
  if (!['comment', 'marker', 'pin'].includes(type)) return { ok: false, error: 'VALIDATION', message: 'Bad type.' };
  if (type !== 'comment' && !a.decide) return { ok: false, error: 'FORBIDDEN', message: a.isReq && a.t.stage !== 'Assigner' ? 'The team is still on its internal check — you can comment now and mark changes once it reaches you.' : 'Only the team head, super admin or the task\'s requester (at review stage) can add change markers.' };
  const text = String(req.text || '').trim();
  if (!text) return { ok: false, error: 'VALIDATION', message: 'Write something first.' };
  const item = {
    id: 'RV-' + String(state.nextReview++).padStart(5, '0'), taskId: a.t.id, type,
    tc: type === 'marker' && req.tc != null ? Number(req.tc) : null,
    x: type === 'pin' && req.x != null ? Number(req.x) : null,
    y: type === 'pin' && req.y != null ? Number(req.y) : null,
    author: u.name, guest: false, text,
    status: type === 'comment' ? '' : 'Open', created: nowIso(),
    version: Number(req.version) || latestVersionOf(a.t.id),
  };
  state.reviews.push(item);
  if (type === 'comment') mail([emailByName(a.t.assignee), emailByName(a.t.requester), ...headsOf(a.t.team).map(h => h.email)].join(','), '[Task] 💬 New comment on ' + a.t.id, 'comment', u.email);
  return { ok: true, item };
}

function resolveReview(u, req) {
  const item = state.reviews.find(r => r.id === String(req.id || ''));
  if (!item) return { ok: false, error: 'NOT_FOUND', message: 'Marker not found.' };
  const a = taskAccess(u, item.taskId);
  if (a.err) return a.err;
  if (!a.decide && !a.manage) return { ok: false, error: 'FORBIDDEN', message: 'Only reviewers can resolve markers.' };
  item.status = req.resolved !== false ? 'Resolved' : 'Open';
  return { ok: true, item };
}

function deleteReview(u, req) {
  const idx = state.reviews.findIndex(r => r.id === String(req.id || ''));
  if (idx === -1) return { ok: false, error: 'NOT_FOUND', message: 'Entry not found.' };
  const item = state.reviews[idx];
  const a = taskAccess(u, item.taskId);
  if (a.err) return a.err;
  if (!a.manage && !a.decide && item.author !== u.name) return { ok: false, error: 'FORBIDDEN', message: 'You can only delete your own entries.' };
  state.reviews.splice(idx, 1);
  return { ok: true, deletedId: item.id };
}

function sendChanges(u, req) {
  const a = taskAccess(u, String(req.taskId || '').trim());
  if (a.err) return a.err;
  if (!a.decide) return { ok: false, error: 'FORBIDDEN', message: a.isReq && a.t.stage !== 'Assigner' ? 'This is still in the internal check — the head sends it to you first.' : 'Only reviewers can send changes.' };
  const open = state.reviews.filter(r => r.taskId === a.t.id && r.type !== 'comment' && r.status === 'Open');
  if (!open.length) return { ok: false, error: 'VALIDATION', message: 'No open markers to send — add change markers first.' };
  const upd = updateTask(u, { id: a.t.id, patch: { status: 'Revisions' } });
  if (!upd.ok) return upd;
  mail(emailByName(a.t.assignee), '[Task] 🔁 ' + open.length + ' changes requested — ' + a.t.id, 'send-changes', u.email);
  return { ok: true, count: open.length, task: upd.task };
}

function createShare(u, req) {
  const a = taskAccess(u, String(req.taskId || '').trim());
  if (a.err) return a.err;
  if (!a.own) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can create share links.' };
  const mode = String(req.mode) === 'comment' ? 'comment' : 'view';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)];
  state.shares.push({ token, taskId: a.t.id, mode, createdBy: u.name, created: nowIso(), revoked: false });
  return { ok: true, token, mode };
}

function revokeShare(u, req) {
  const s = state.shares.find(x => x.token === String(req.token || ''));
  if (!s) return { ok: false, error: 'NOT_FOUND', message: 'Link not found.' };
  const a = taskAccess(u, s.taskId);
  if (a.err) return a.err;
  if (!a.own) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can revoke links.' };
  s.revoked = true;
  return { ok: true, revoked: s.token };
}

function guestReview(req) {
  const s = state.shares.find(x => x.token === String(req.token || '').trim() && !x.revoked);
  if (!s) return { ok: false, error: 'AUTH', message: 'This review link is invalid or has been revoked.' };
  const t = byId(s.taskId);
  if (!t) return { ok: false, error: 'NOT_FOUND', message: 'This review is no longer available.' };
  return {
    ok: true, mode: s.mode,
    task: { id: t.id, title: t.title, team: t.team, deliverable: t.deliverable, brief: t.brief },
    items: state.reviews.filter(r => r.taskId === t.id),
    versions: state.versions[t.id] || [],
    org: CFG.ORG, googleApiKey: 'mock-api-key',
  };
}

function guestComment(req) {
  const s = state.shares.find(x => x.token === String(req.token || '').trim() && !x.revoked);
  if (!s) return { ok: false, error: 'AUTH', message: 'This review link is invalid or has been revoked.' };
  if (s.mode !== 'comment') return { ok: false, error: 'FORBIDDEN', message: 'This link is view-only.' };
  const name = String(req.name || '').trim().slice(0, 40);
  const text = String(req.text || '').trim().slice(0, 2000);
  if (name.length < 2) return { ok: false, error: 'VALIDATION', message: 'Enter your name first.' };
  if (!text) return { ok: false, error: 'VALIDATION', message: 'Write something first.' };
  const type = ['comment', 'marker', 'pin'].includes(String(req.type || 'comment')) ? String(req.type || 'comment') : 'comment';
  const t = byId(s.taskId);
  const item = { id: 'RV-' + String(state.nextReview++).padStart(5, '0'), taskId: s.taskId, type,
    tc: type === 'marker' && req.tc != null ? Number(req.tc) : null,
    x: type === 'pin' && req.x != null ? Number(req.x) : null,
    y: type === 'pin' && req.y != null ? Number(req.y) : null,
    author: name, guest: true, text, status: type === 'comment' ? '' : 'Open', created: nowIso(), version: latestVersionOf(s.taskId) };
  state.reviews.push(item);
  if (t) mail([emailByName(t.assignee), ...headsOf(t.team).map(h => h.email)].join(','), '[Task] 💬 Client comment on ' + s.taskId, 'guest-comment', '');
  return { ok: true, item };
}

function guestDelete(req) {
  const s = state.shares.find(x => x.token === String(req.token || '').trim() && !x.revoked);
  if (!s) return { ok: false, error: 'AUTH', message: 'This review link is invalid or has been revoked.' };
  if (s.mode !== 'comment') return { ok: false, error: 'FORBIDDEN', message: 'This link is view-only.' };
  const id = String(req.id || '').trim(), name = String(req.name || '').trim();
  if (!id || !name) return { ok: false, error: 'VALIDATION', message: 'Nothing to delete.' };
  const i = state.reviews.findIndex(x => x.id === id);
  if (i === -1) return { ok: false, error: 'NOT_FOUND', message: 'That entry is already gone.' };
  const it = state.reviews[i];
  if (it.taskId !== s.taskId) return { ok: false, error: 'FORBIDDEN', message: 'That entry is not on this review.' };
  if (!it.guest) return { ok: false, error: 'FORBIDDEN', message: 'Only your own guest notes can be removed.' };
  if (String(it.author).trim().toLowerCase() !== name.toLowerCase()) return { ok: false, error: 'FORBIDDEN', message: 'That note was added under a different name.' };
  if (it.status === 'Resolved') return { ok: false, error: 'FORBIDDEN', message: 'The team has already actioned this point, so it can no longer be removed.' };
  state.reviews.splice(i, 1);
  return { ok: true, deletedId: id };
}

/* ── router + HTTP plumbing ────────────────────────────────────────────── */

function route(req) {
  const action = String(req.action || 'ping');
  const PUB = { ping: () => ping(), appHtml: () => appHtml(), guestReview: () => guestReview(req), guestComment: () => guestComment(req), guestDelete: () => guestDelete(req) };
  if (PUB[action]) return PUB[action]();
  const u = auth(req.email, req.code);
  if (!u) return { ok: false, error: 'AUTH', message: 'Email or access code did not match the Roster.' };
  const AUTHED = {
    bootstrap: () => bootstrap(u, req),
    tasks: () => ({ ok: true, tasks: scoped(u), serverTime: nowIso(), __big: true }),
    tasksPage: () => tasksPage(u, req),
    teamStats: () => {
      if (!['Team Head', 'Super Admin'].includes(u.role)) return { ok: false, error: 'FORBIDDEN', message: 'Team-wide reports are for team heads and admins.' };
      const days = Math.min(3650, Math.max(1, Math.floor(Number(req.days) || 30)));
      const from = Date.now() - days * 86400000;
      const blank = (name, team) => ({ name, team: team || '', open: 0, overdue: 0, inReview: 0, done: 0, rejected: 0, onTime: 0, closedWithDue: 0, rounds: 0, roundsTasks: 0, turnaroundDays: 0, turnaroundTasks: 0 });
      // a head gets their own team only; a Super Admin gets every team
      const own = String(u.team || '').trim();
      const wanted = (u.role === 'Team Head' && own && TEAMS.some(t => t.team === own)) ? [own] : TEAMS.map(t => t.team);
      const byTeam = {}; wanted.forEach(t => byTeam[t] = blank(t, t));
      const people = state.roster.filter(m => m.active && m.role !== 'Super Admin' && m.role !== 'Assigner' && wanted.includes(String(m.team || '').trim()));
      const byPerson = {}; people.forEach(m => byPerson[m.name] = blank(m.name, m.team));
      const now = Date.now();
      state.tasks.forEach(t => {
        const closed = t.status === 'Done' || t.status === 'Rejected';
        const completed = t.completed ? Date.parse(t.completed) : null;
        const started = t.startedAt ? Date.parse(t.startedAt) : null;
        [byTeam[t.team], byPerson[t.assignee]].filter(Boolean).forEach(b => {
          if (!closed) {
            b.open++;
            if (t.status === 'In Review') b.inReview++;
            else if (t.status !== 'On Hold' && t.dueMs < now) b.overdue++;
          }
          if (completed && completed >= from) {
            if (t.status === 'Done') b.done++;
            b.rounds += t.revisions || 0; b.roundsTasks++;
            b.closedWithDue++; if (completed <= t.dueMs) b.onTime++;
            if (started) { b.turnaroundDays += (completed - started) / 86400000; b.turnaroundTasks++; }
          }
          if (t.status === 'Rejected' && completed && completed >= from) b.rejected++;
        });
      });
      const fin = b => ({ name: b.name, team: b.team, open: b.open, overdue: b.overdue, inReview: b.inReview, done: b.done, rejected: b.rejected,
        onTimePct: b.closedWithDue ? Math.round(b.onTime / b.closedWithDue * 100) : null,
        avgRounds: b.roundsTasks ? Math.round(b.rounds / b.roundsTasks * 10) / 10 : null,
        avgTurnaroundDays: b.turnaroundTasks ? Math.round(b.turnaroundDays / b.turnaroundTasks * 10) / 10 : null });
      return { ok: true, days, teams: wanted.map(t => fin(byTeam[t])), people: people.map(m => fin(byPerson[m.name])).filter(p => p.open || p.done || p.rejected), serverTime: nowIso() };
    },
    taskDetail: () => {
      const t = scopedFull(u).find(x => x.id === String(req.id || '').trim());
      return t ? { ok: true, task: t } : { ok: false, error: 'NOT_FOUND', message: 'Task ' + req.id + ' was not found in your scope.' };
    },
    createTask: () => createCutoff(u, req) || createTask(u, req),
    updateTask: () => updateTask(u, req),
    deleteTask: () => deleteTask(u, req),
    rejectTask: () => rejectTask(u, req),
    startTask: () => startTask(u, req),
    acceptChanges: () => acceptChanges(u, req),
    qcPass: () => qcPass(u, req),
    renewTask: () => renewTask(u, req),
    acceptBrief: () => acceptBrief(u, req),
    bulkCreate: () => bulkCreate(u, req),
    listReview: () => listReview(u, req),
    addReview: () => addReview(u, req),
    resolveReview: () => resolveReview(u, req),
    deleteReview: () => deleteReview(u, req),
    sendChanges: () => sendChanges(u, req),
    createShare: () => createShare(u, req),
    revokeShare: () => revokeShare(u, req),
    admin: () => u.role === 'Super Admin' ? { ok: true, result: 'mock admin: ' + String(req.op || '') } : { ok: false, error: 'FORBIDDEN', message: 'Admin ops are Super Admin only.' },
  };
  const fn = AUTHED[action];
  return fn ? fn() : { ok: false, error: 'UNKNOWN_ACTION', message: action };
}

const server = http.createServer((rq, rs) => {
  const url = new URL(rq.url, 'http://x');
  const send = (code, body, type = 'application/json') => {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    rs.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    if (STALL_OVER && buf.length > STALL_OVER) { rs.write(buf.subarray(0, STALL_OVER)); return; /* never end() — the stall */ }
    rs.end(buf);
  };

  // control endpoints
  if (url.pathname === '/__reset') { load(); return send(200, { ok: true, reset: true }); }
  if (url.pathname === '/__state') return send(200, { tasks: state.tasks.length, reviews: state.reviews.length, shares: state.shares.length, mailQuotaLeft });
  if (url.pathname === '/__outbox') return send(200, outbox);

  let body = '';
  rq.on('data', c => body += c);
  rq.on('end', () => {
    let req = {};
    if (rq.method === 'POST') { try { req = JSON.parse(body || '{}'); } catch {} }
    else { url.searchParams.forEach((v, k) => req[k] = v); }
    const action = String(req.action || (url.searchParams.get('page') === 'app' ? '__page_app' : 'ping'));

    if (action === '__page_app') {
      const r = appHtml();
      return send(200, r.ok ? r.html : '<h1>no app</h1>', 'text/html');
    }
    if (rq.method === 'GET' && !['ping', 'appHtml', 'guestReview'].includes(action)) {
      return send(200, { ok: false, error: 'UNKNOWN_ACTION', message: action + ' (authed actions are POST-only)' });
    }
    if (ERROR_HTML && action === ERROR_HTML) {
      return send(200, '<!DOCTYPE html><html><body>Google Apps Script: server error</body></html>', 'text/html');
    }
    if (TIMEOUT_ONCE && action === TIMEOUT_ONCE && !timedOutOnce) {
      timedOutOnce = true;
      return; // hang forever — client's 45s abort + single retry handles it
    }
    const out = route(req);
    const isBig = out && out.__big;
    if (out) delete out.__big;
    if (SLOW_BIG && isBig) return setTimeout(() => send(200, out), 60000);
    send(200, out);
  });
});

server.listen(PORT, () => console.log(`[mock-api] CreativeFlow v5 mock on http://127.0.0.1:${PORT}  (slowBig=${SLOW_BIG} stallOver=${STALL_OVER} noPager=${NO_PAGER} pageMax=${PAGE_MAX} mute=${MUTE})`));
