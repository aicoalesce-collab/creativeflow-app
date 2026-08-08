/**
 * ============================================================================
 *  CREATIVEFLOW v5 — main.js · web-app entry points + router + dispatch
 *
 *  Transport contract (do not break — see CLAUDE.md):
 *   - Clients POST text/plain JSON to /exec (simple request, no CORS preflight).
 *   - GET serves only public actions + ?page=app.
 *   - EVERY response stays ping-sized; the login path is bootstrap{lite:1} +
 *     tasksPage (25/page). The legacy `tasks` big answer is a fallback only.
 *
 *  Dispatch wrapper: routes marked lock:true run inside ONE ScriptLock; emails
 *  queued by handlers are flushed AFTER the lock is released (v5 fix — the old
 *  code sent SMTP inside the lock and serialized every write for seconds).
 * ============================================================================
 */

const API_VERSION = 5.0;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.page === 'app') return serveApp_(p);
  const action = String(p.action || 'ping');
  const PUBLIC_GET = ['ping', 'appHtml', 'guestReview'];
  if (PUBLIC_GET.indexOf(action) === -1) {
    // v5: authed actions are POST-only — access codes never travel in URLs.
    return jsonOut_({ ok: false, error: 'UNKNOWN_ACTION', message: action + ' (authed actions are POST-only)' });
  }
  return jsonOut_(routeApi_(p));
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) {}
  return jsonOut_(routeApi_(req));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ── route table ───────────────────────────────────────────────────────── */

function routes_() {
  return {
    // public
    ping:          { pub: true,  fn: function (u, q) { return apiPing_(); } },
    appHtml:       { pub: true,  fn: function (u, q) { return apiAppHtml_(); } },
    guestReview:   { pub: true,  fn: function (u, q) { return apiGuestReview_(q); } },
    guestComment:  { pub: true,  lock: true, fn: function (u, q) { return apiGuestComment_(q); } },
    // authed reads (no lock — read-only, must stay fast)
    bootstrap:     { fn: apiBootstrap_ },
    tasks:         { fn: function (u, q) { return { ok: true, tasks: apiTasks_(u), serverTime: new Date().toISOString() }; } },
    tasksPage:     { fn: apiTasksPage_ },
    taskDetail:    { fn: apiTaskDetail_ },
    listReview:    { fn: apiListReview_ },
    // authed writes (locked)
    createTask:    { lock: true, fn: function (u, q) { const cut = createCutoff_(u, q); if (cut) return cut; return apiCreate_(u, q); } },
    updateTask:    { lock: true, fn: apiUpdate_ },
    deleteTask:    { lock: true, fn: apiDelete_ },
    rejectTask:    { lock: true, fn: apiRejectTask_ },
    startTask:     { lock: true, fn: apiStartTask_ },
    acceptChanges: { lock: true, fn: apiAcceptChanges_ },
    qcPass:        { lock: true, fn: apiQcPass_ },
    renewTask:     { lock: true, fn: apiRenewTask_ },
    acceptBrief:   { lock: true, fn: apiAcceptBrief_ },
    bulkCreate:    { lock: true, fn: apiBulkCreate_ },
    addReview:     { lock: true, fn: apiAddReview_ },
    resolveReview: { lock: true, fn: apiResolveReview_ },
    deleteReview:  { lock: true, fn: apiDeleteReview_ },
    sendChanges:   { lock: true, fn: apiSendChanges_ },
    createShare:   { lock: true, fn: apiCreateShare_ },
    revokeShare:   { lock: true, fn: apiRevokeShare_ },
    // admin ops (Super Admin only, checked inside)
    admin:         { lock: true, fn: apiAdmin_ },
  };
}

function routeApi_(req) {
  try {
    const action = String(req.action || 'ping');
    const route = routes_()[action];
    if (!route) return { ok: false, error: 'UNKNOWN_ACTION', message: action };
    let user = null;
    if (!route.pub) {
      user = apiAuth_(req.email, req.code);
      if (!user) return { ok: false, error: 'AUTH', message: 'Email or access code did not match the Roster.' };
      CURRENT_ACTOR = user.email;
    }
    return dispatch_(route, user, req);
  } catch (err) {
    return { ok: false, error: 'SERVER', message: String(err) };
  }
}

function dispatch_(route, user, req) {
  if (!route.lock) {
    const out = route.fn(user, req);
    flushMailQueue_();
    return out;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let out;
  try {
    out = route.fn(user, req);
  } finally {
    lock.releaseLock();
  }
  flushMailQueue_(); // emails go out AFTER the lock is released
  return out;
}

/* ── ping ──────────────────────────────────────────────────────────────── */

function apiPing_() {
  stampClientPing_(); // passive heartbeat for the daily selfCheck
  return {
    ok: true,
    v: API_VERSION,
    org: String(cfg_('ORG_NAME', 'Task System')),
    appVersion: latestAppVersion_(),
    googleClientId: String(cfg_('GOOGLE_CLIENT_ID', '')),
    googleApiKey: String(cfg_('GOOGLE_API_KEY', '')),
    uploadMode: String(cfg_('UPLOAD_MODE', 'central')),
    storageAccount: String(cfg_('STORAGE_ACCOUNT', '')),
    emailMute: String(cfg_('EMAIL_MUTE', 'NO')).toUpperCase().indexOf('Y') === 0,
    serverTime: new Date().toISOString(),
  };
}

/* ── app serving (?page=app fallback + exe OTA source) ─────────────────── */

function appVersionOf_(html) {
  const m = String(html || '').match(/APP_VERSION\s*=\s*'([^']+)'/);
  return m ? m[1] : '';
}

function latestAppVersion_() {
  try { return appVersionOf_(HtmlService.createHtmlOutputFromFile('app').getContent()); }
  catch (e) { return ''; }
}

/** Public: serves the app shell HTML (no data). Single channel — the old
 *  App/AppBeta split and the Drive APP_UPDATE_URL fallback are retired. */
function apiAppHtml_() {
  try {
    const html = HtmlService.createHtmlOutputFromFile('app').getContent();
    if (html && html.indexOf('CreativeFlow') !== -1) {
      const v = appVersionOf_(html);
      log_('ota-download', '', '', 'served v' + (v || '?'), true);
      return { ok: true, version: v, html: html };
    }
  } catch (e) { /* fall through */ }
  return { ok: false, error: 'NO_APP', message: 'No app.html in this Apps Script project — run the client build + deploy.' };
}

/** ?page=app — serves the same client. HtmlService strips URL params from the
 *  client's view, so the server injects them by rewriting the CF-BOOT sentinel
 *  lines (exact literals — the client build must keep them un-minified). */
function serveApp_(params) {
  const r = apiAppHtml_();
  if (!r.ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px 24px;max-width:460px;margin:auto;line-height:1.6">' +
      '<h2 style="font-family:monospace">CREATIVEFLOW</h2>' +
      '<p><b>The app is not installed on this deployment yet.</b></p><p>' + esc_(r.message) + '</p></div>'
    ).setTitle('CreativeFlow');
  }
  let html = r.html;
  const apiUrl = ScriptApp.getService().getUrl();
  html = html.replace("window.CF_INJECTED_API = '';", 'window.CF_INJECTED_API = ' + JSON.stringify(apiUrl) + ';');
  const gTok = params ? String(params.review || '').trim() : '';
  const openTask = params ? String(params.task || '').trim() : '';
  if (gTok) html = html.replace("window.CF_GUEST_TOKEN = '';", 'window.CF_GUEST_TOKEN = ' + JSON.stringify(gTok) + ';');
  if (openTask) html = html.replace("window.CF_OPEN_TASK = '';", 'window.CF_OPEN_TASK = ' + JSON.stringify(openTask) + ';');
  return HtmlService.createHtmlOutput(html)
    .setTitle('CreativeFlow')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
