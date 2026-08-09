'use strict';
import { pushEnable, pushDisable, pushState, pushResync, pushSupport } from './push.js';
import { logList, logMarkSeen, logClear, logAdd } from './notiflog.js';

/* ═══════════ CONSTANTS / STATE ═══════════ */
const PRIORITIES = ['Urgent','High','Medium','Low'];
const STATUSES = ['New','In Progress','In Review','Revisions','Done','On Hold'];
const DAY = 86400000;

const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch(e){} },
  del(k){ try { localStorage.removeItem(k); } catch(e){} },
};

/* Your studio's Web app URL — baked in so team members never have to paste it.
   "Connect to a different sheet" on the login screen still overrides it. */
/* v5: the baked URL is stamped by the release script once the new PROD
   deployment exists (scripts/bake-url.mjs). Empty = login screen asks. */
const DEFAULT_URL = (typeof window !== 'undefined' && window.CF_DEFAULT_API) || '';

/* Bump this on every release. OTA works by comparing it with APP_LATEST_VERSION
   in the sheet's Config tab and pulling the new build from APP_UPDATE_URL. */
/* v5: the version lives in the CF-BOOT sentinel in index.html (server ping and
   the exe OTA regex it out of there). Single channel — beta is gone. */
const APP_VERSION = (typeof window !== 'undefined' && window.APP_VERSION) || '5.0.0';
const CHANNEL = 'stable';

/* Keep sheet links clean: people paste /exec?action=ping and similar tails —
   strip anything after /exec so the saved link is always the plain API base. */
function cleanUrl_(u){
  u = String(u || '').trim();
  if(/^https:\/\/script\.google(usercontent)?\.com\//.test(u) && u.indexOf('/exec') !== -1){
    u = u.replace(/\/exec[?#].*$/, '/exec');
  }
  return u;
}

const state = {
  /* served from the Apps Script mobile endpoint? it injects its own URL */
  url: cleanUrl_(store.get('cf_url') || store.get('td_url') || (typeof window !== 'undefined' && window.CF_INJECTED_API) || DEFAULT_URL),
  email: store.get('cf_email') || store.get('td_email') || '',
  code: store.get('cf_code') || store.get('td_code') || '',
  me: null, org: '', teams: [], roster: [], tasks: [], formUrl: '', sheetUrl: '',
  lastSync: null, googleClientId: '', googleApiKey: '', browserLogin: false, uploadMode: '', storageAccount: '', latestVersion: '',
  vapidKey: '', pushOn: false, pushWhy: '',
};
let tab = 'overview';
let bootTab_ = '';   // a tab restored from the URL hash, consumed by enterApp
/* Gallery + assigners state lives HERE, not beside their view functions.
   A cached boot renders the restored tab while the module is still
   evaluating, so a `let` further down the file is still in its temporal dead
   zone and the whole app dies with a ReferenceError. Function declarations
   hoist; `let` does not. */
let assignerPick = '';
let gal = { items: [], next: null, total: 0, loading: false, scope: 'team', team: '', loaded: false };
let projects = [];
let projLoaded = false, projLoading = false;
let projPick = '', projSub = 'overview';
let pgal = { items: [], next: null, total: 0, loading: false, loaded: false };
let projNotes = { items: [], loaded: false, loading: false };
let weekOffset = 0;
let myTab = 'today';
let mcalOffset = 0;
let filters = { team:'', member:'', priority:'', status:'', q:'' };
let reportSubject = null;

/* ═══════════ THEME ═══════════ */
function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  store.set('cf_theme', t);
  const b = document.getElementById('theme-btn');
  if(b) b.textContent = t==='dark' ? '☾' : '☀';
  const m = document.querySelector('meta[name="theme-color"]');
  if(m) m.content = t==='dark' ? '#1d1d1d' : '#fbfaf7';
}
applyTheme(store.get('cf_theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* ═══════════ HELPERS ═══════════ */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function dark(){ return document.documentElement.getAttribute('data-theme')==='dark'; }
function teamColor(team){
  const light = ['#1b1b1b','#eb5b2d','#8a867c','#5c8a72'];
  const darkP = ['#f2f0eb','#f06a38','#8f8d86','#7fae95'];
  const i = state.teams.indexOf(team);
  return i===-1 ? '#8a867c' : (dark()? darkP : light)[i % 4];
}
function avTextColor(team){ const i = state.teams.indexOf(team); return (i%4===0) ? (dark()? '#141414':'#ffffff') : '#ffffff'; }
function isClosed(t){ return t.status==='Done' || t.status==='Rejected'; }
function isOverdue(t){ return !isClosed(t) && t.status!=='On Hold' && t.status!=='In Review' && t.due && t.due < new Date(); }
function fmtD(x){ return x? x.toLocaleDateString('en-IN',{weekday:'short', day:'numeric', month:'short'}) : '—'; }
function fmtT(x){ return x? x.toLocaleTimeString('en-IN',{hour:'numeric', minute:'2-digit', hour12:true}).toUpperCase() : ''; }
function fmtDT(x){ return x? fmtD(x)+' · '+fmtT(x) : 'no deadline'; }
function dueLabel(t){ return t.due? fmtD(t.due)+', '+fmtT(t.due) : 'no deadline'; }
function initials(n){ return n? n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() : '—'; }
function member(name){ return state.roster.find(x=>x.name===name) || null; }
function memColor(name){ const m = member(name); return m? teamColor(m.team) : '#8a867c'; }
function av(name,size){
  const m = member(name);
  const fg = m? avTextColor(m.team) : '#fff';
  return `<span class="avatar" style="width:${size||30}px;height:${size||30}px;font-size:${(size||30)*0.36}px;background:${memColor(name)};color:${fg}">${initials(name)}</span>`;
}
function isAdmin(){ return state.me && state.me.role==='Super Admin'; }
function isHead(){ return state.me && state.me.role==='Team Head'; }
function canManage(t){ return isAdmin() || (isHead() && state.me.team===t.team); }
function isAssigner(){ return state.me && state.me.role==='Assigner'; }
function isMyRequest(t){ return isAssigner() && state.me && t.requester===state.me.name; }
/* may add markers / send changes / approve: heads always; assigners once the
   task reaches them (In Review · Assigner stage). */
function canDecide(t){ return canManage(t) || (isMyRequest(t) && t.status==='In Review' && t.stage==='Assigner'); }
function roleLabel(m){
  if(m.role==='Super Admin') return 'SUPER ADMIN';
  /* Assigners span both teams, so they get no craft label. */
  if(m.role==='Assigner') return 'ASSIGNER';
  const craft = m.team==='Video' ? 'EDITOR' : 'DESIGNER';
  return m.role==='Team Head' ? 'HEAD '+craft : (m.team==='Video'?'VIDEO EDITOR':'GRAPHIC DESIGNER');
}
function toast(html, err){ const el=document.createElement('div'); el.className='toast'+(err?' err':''); el.innerHTML=html; $('#toasts').appendChild(el); setTimeout(()=>el.remove(), 5200); }
function pchip(p){ return `<span class="chip p-${p}">${p}</span>`; }
function schip(t){
  if(isOverdue(t)) return `<span class="chip od-chip">🚨 Overdue</span>`;
  if(t.status==='Done') return `<span class="chip s-done">${hasFlagC(t,'auto-done')? '✓ Auto-approved' : '✓ Done'}</span>`;
  if(t.status==='Rejected') return `<span class="chip s-rejected">✗ Rejected</span>`;
  if(t.status==='In Review') return `<span class="chip s-review">${t.stage==='Assigner'? 'With requester' : 'In Review · QC'}</span>`;
  return `<span class="chip s-chip">${t.status}</span>`;
}
function tdot(team){ return `<span class="team-dot" style="background:${teamColor(team)}"></span>`; }

/* ═══════════ API ═══════════ */
function setSync(mode, text){
  const el = $('#sync'); if(!el) return;
  el.className = mode || '';
  el.textContent = text || (state.lastSync ? 'SYNCED '+state.lastSync.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}) : '—');
}
/* v4.9: inside the desktop app, every sheet call rides through the exe's own
   network engine (POST /api) — the same one that handles browser sign-in and
   updates. Antivirus web-shields and picky office networks that strangle
   in-page fetches to script.google.com never touch that path, and it's faster
   (kept-alive connections). Older exes without /api answer with a webpage,
   which fails JSON parsing once — then we fall back to direct calls for the
   rest of the session. */
let __proxyOk = null; /* null = untested · true = exe proxy works · false = go direct */
async function postApi_(url, bodyObj, timeoutMs){
  const payload = JSON.stringify(bodyObj);
  const ctrl = new AbortController();
  const to = setTimeout(()=>ctrl.abort(), timeoutMs || 45000);
  let proxyErr = null;
  try {
    if(url && isDesktopApp() && __proxyOk !== false){
      let txt = null;
      try {
        const res = await fetch('/api?u='+encodeURIComponent(url), { method:'POST', body: payload, signal: ctrl.signal });
        txt = await res.text();
      } catch(pe){
        if(pe && pe.name === 'AbortError') throw pe;
        txt = null; /* exe hiccup — try direct this once; don't write the engine off */
      }
      if(txt !== null){
        let j = null; try { j = JSON.parse(txt); } catch(e2){}
        if(j){
          __proxyOk = true;
          if(j.ok === false && j.error === 'PROXY'){
            proxyErr = new Error(j.message || 'The desktop app could not reach the sheet API.');
            proxyErr.apiError = 'PROXY';
          } else {
            return j;
          }
        } else if(txt.indexOf('APP_VERSION') !== -1 && txt.indexOf('CreativeFlow') !== -1){
          /* our own app page came back = an exe from before v4.9 (no /api route) */
          __proxyOk = false;
        } else {
          /* the SHEET answered with a webpage — dead/outdated link or wrong access.
             Say so honestly instead of falling into a doomed retry that reads as a timeout. */
          const e3 = new Error('The saved dashboard link answered with a webpage instead of data — it is probably outdated or wrong. Ask your admin for the current /exec link, or use “Connect to a different sheet” below.');
          e3.apiError = 'NOT_JSON';
          throw e3;
        }
      }
    }
    try {
      const res = await fetch(url, { method:'POST', body: payload, signal: ctrl.signal });
      const j = await res.json();
      if(proxyErr) __proxyOk = false; /* direct works while the exe's path didn't — prefer direct here */
      return j;
    } catch(de){
      throw proxyErr || de;
    }
  } finally { clearTimeout(to); }
}
/* v5: SELF-HEALING URL.
   A saved cf_url outranks the built-in one, which is right when an admin
   deliberately points a client elsewhere — and catastrophic when the saved one
   is a DEAD deployment. Both exe generations serve on 127.0.0.1:4879, so they
   share localStorage: every PC that ran the old exe inherits its dead URL and
   times out forever with no clue why. When a transport-level failure happens
   and we're not already on the built-in URL, retry once against the built-in
   one; if that answers, adopt it permanently and say so. */
const TRANSPORT_FAIL = ['TIMEOUT', 'BLOCKED', 'NOT_JSON', 'PROXY'];
let __healed = false;

async function api(action, payload, timeoutMs){
  const body = Object.assign({}, payload || {}, { action, email: state.email, code: state.code });
  try {
    const j = await postApi_(state.url, body, timeoutMs);
    if(!j || !j.ok){ const e = new Error((j && (j.message || j.error)) || 'Request failed'); e.apiError = j && j.error; throw e; }
    return j;
  } catch(e){
    const f = friendlyError_(e);
    const baked = cleanUrl_(DEFAULT_URL);
    if(!__healed && baked && cleanUrl_(state.url) !== baked && TRANSPORT_FAIL.indexOf(f.apiError) > -1){
      try {
        const j2 = await postApi_(baked, body, timeoutMs);
        if(j2 && j2.ok){
          __healed = true;
          const dead = state.url;
          state.url = baked;
          store.set('cf_url', baked); store.set('td_url', baked);
          try { toast('The saved dashboard link was out of date — reconnected to the current one automatically.'); } catch(_){}
          try { console.warn('CreativeFlow: switched from a dead link (' + dead + ') to ' + baked); } catch(_){}
          return j2;
        }
      } catch(_){ /* the built-in URL failed too — report the original error */ }
    }
    throw f;
  }
}
/* Translate raw fetch failures into something a human can act on. */
function friendlyError_(e){
  if(e && e.apiError) return e;
  const name = (e && e.name) || '';
  const msg = String((e && e.message) || e);
  let out;
  if(name==='AbortError' || /abort/i.test(msg)){
    out = new Error('The sheet API didn’t answer (timed out). Usually this PC or network is blocking script.google.com (VPN / firewall / antivirus web-shield), or the saved link is wrong. Use “Test connection” below.');
    out.apiError = 'TIMEOUT';
  } else if(name==='TypeError' || /failed to fetch|networkerror/i.test(msg)){
    out = new Error('The link redirected somewhere the app can’t follow. Most often the deployment’s “Who has access” is not “Anyone”, or this isn’t the /exec Web app URL. Use “Test connection” below.');
    out.apiError = 'BLOCKED';
  } else if(/json|unexpected token/i.test(msg)){
    out = new Error('The link answered with a webpage instead of data — it’s probably not the /exec Web app URL, or Api.gs wasn’t deployed as a New version.');
    out.apiError = 'NOT_JSON';
  } else {
    out = new Error(msg);
  }
  return out;
}
/* One-click diagnosis from the login screen. */
async function testConnection(){
  const err = $('#login-err');
  err.className = 'login-err'; err.style.display='block'; err.textContent = 'Testing the link…';
  const url = state.url || $('#in-url').value.trim();
  if(!url){ err.textContent = 'No link saved yet — paste the Web app URL first.'; return; }
  try {
    const j = await postApi_(url, { action:'ping' }, 15000);
    if(j && j.ok){
      err.className = 'login-err ok';
      err.textContent = '✓ Connected — the sheet API ('+(j.org||'your studio')+') is reachable'+(__proxyOk===true?' through the app’s own engine':'')+'. Sign in below; if it timed out before, it was momentary.';
    } else {
      err.textContent = 'The link answered, but not with the expected data. Re-check that it’s the /exec Web app URL and that Api.gs was deployed as a New version.';
    }
  } catch(e){
    const f = friendlyError_(e);
    err.textContent = (f.apiError==='TIMEOUT'
      ? 'No answer from the link at all — this PC/network can’t reach it (VPN, firewall, antivirus web-shield, or a wrong link).'
      : f.apiError==='BLOCKED'
      ? 'The link is reachable but the app was blocked from reading it — almost always the deployment’s “Who has access” is set to “Anyone with Google account” instead of “Anyone”. Fix: Apps Script ▸ Deploy ▸ Manage deployments ▸ ✏️ ▸ Who has access: Anyone ▸ Deploy.'
      : f.message);
  }
}
function parseTask(x){
  return Object.assign({}, x, {
    due: x.dueMs ? new Date(x.dueMs) : null,
    created: x.created ? new Date(x.created) : null,
    completed: x.completed ? new Date(x.completed) : null,
    startedAt: x.startedAt ? new Date(x.startedAt) : null,
  });
}
function upsert(taskJson){
  const t = parseTask(taskJson);
  const i = state.tasks.findIndex(x=>x.id===t.id);
  if(i===-1) state.tasks.push(t); else state.tasks[i] = t;
}
/* ── v4.9.1: page-sized task sync ─────────────────────────────────────────
   The dashboard used to arrive as ONE big answer — and some PCs/networks
   swallow small responses fine but stall on big ones (that's what kept one
   studio PC out for weeks). Now tasks come in ping-sized pages. Old servers
   without tasksPage still work: we fall back to the classic single call. */
let __pageSync = 0;        /* bump to cancel an in-flight background load */
let __pageLoading = false;

async function fetchAllTasksPaged_(){
  try {
    let out = [], next = 0, guard = 0;
    do {
      const pg = await api('tasksPage', { offset: next, limit: 25 });
      out = out.concat((pg.tasks || []).map(parseTask));
      next = pg.next;
    } while(next != null && ++guard < 400);
    return out;
  } catch(e){
    if(e && e.apiError === 'UNKNOWN_ACTION'){ /* older API — one big answer */
      const j = await api('tasks');
      return (j.tasks || []).map(parseTask);
    }
    throw e;
  }
}

/* Login-time loading: show the dashboard after the FIRST page, keep pulling
   the rest in the background so even huge boards open in a few seconds. */
async function loadTasksFirstFast_(){
  const runId = ++__pageSync;
  let first;
  try {
    first = await api('tasksPage', { offset: 0, limit: 25 });
  } catch(e){
    if(e && e.apiError === 'UNKNOWN_ACTION'){ /* older API */
      const j = await api('tasks');
      state.tasks = (j.tasks || []).map(parseTask);
      return;
    }
    throw e;
  }
  if(runId !== __pageSync) return;
  state.tasks = (first.tasks || []).map(parseTask);
  let next = first.next;
  const total = first.total || state.tasks.length;
  if(next == null) return;
  __pageLoading = true;
  (async () => {
    try {
      let guard = 0;
      while(next != null && ++guard < 400){
        const pg = await api('tasksPage', { offset: next, limit: 25 });
        if(runId !== __pageSync) return;
        (pg.tasks || []).forEach(x => state.tasks.push(parseTask(x)));
        next = pg.next;
        setSync('busy', 'LOADING '+state.tasks.length+'/'+total+'…');
        renderAll();
      }
      state.lastSync = new Date(); setSync(''); renderAll(); saveCache_();
    } catch(e){
      setSync('off', 'PARTIAL SYNC — refresh to retry');
    } finally {
      if(runId === __pageSync) __pageLoading = false;
    }
  })();
}

async function refreshTasks(silent){
  try {
    setSync('busy','SYNCING…');
    __pageSync++; /* cancel any background page loop; this refresh owns the list */
    const list = await fetchAllTasksPaged_();
    state.tasks = list;
    state.lastSync = new Date();
    setSync('');
    renderAll();
    saveCache_();
  } catch(err){
    setSync('off','OFFLINE');
    if(!silent) toast('Could not reach the sheet — '+esc(err.message), true);
  }
}

/* ═══════════ GOOGLE LOGIN ═══════════ */
function canUseGoogle(){
  if(!/^https?:$/.test(location.protocol)) return false;
  /* Google sign-in origins can't be registered for Apps-Script-served pages */
  if(/googleusercontent\.com$|script\.google\.com$/.test(location.hostname)) return false;
  return true;
}
function absorbPing_(j){
  if(!j || !j.ok) return false;
  state.org = j.org || state.org; state.googleClientId = j.googleClientId || '';
  state.googleApiKey = j.googleApiKey || ''; state.uploadMode = j.uploadMode || '';
  state.storageAccount = j.storageAccount || ''; state.latestVersion = j.appVersion || '';
  state.vapidKey = j.vapidKey || '';
  return true;
}

async function fetchPing(){
  if(!state.url) return;
  let ok = false;
  try{ ok = absorbPing_(await postApi_(state.url, { action:'ping' }, 20000)); }catch(e){}
  /* Heal a stale/dead saved link BEFORE anyone types a code, so the login
     screen shows the address it will actually use. (See api() for why.) */
  const baked = cleanUrl_(DEFAULT_URL);
  if(!ok && !__healed && baked && cleanUrl_(state.url) !== baked){
    try{
      if(absorbPing_(await postApi_(baked, { action:'ping' }, 20000))){
        __healed = true;
        state.url = baked;
        store.set('cf_url', baked); store.set('td_url', baked);
        const su = document.getElementById('saved-url');
        if(su && document.getElementById('login') && document.getElementById('login').style.display !== 'none') showLogin();
      }
    }catch(e){}
  }
  loginScreenOta_();
}

/* v4.9: updates used to install only AFTER sign-in — so a PC stuck at the login
   screen could never receive the fix for whatever was keeping it stuck. Now, as
   soon as the login screen learns a newer version exists, it updates itself. */
let __loginOta = false;
function loginScreenOta_(){
  if(state.me || __loginOta) return;
  if(!isDesktopApp() || !autoUpdateOn() || !updateAvailable()) return;
  __loginOta = true;
  installLatest().catch(()=>{});
}

/* ═══════════ OTA SELF-UPDATE (with on/off switch) ═══════════ */
let updateNotified = false;
function autoUpdateOn(){ return store.get('cf_autoupdate') !== 'off'; }
function toggleAutoUpdate(){
  store.set('cf_autoupdate', autoUpdateOn() ? 'off' : 'on');
  toast(autoUpdateOn() ? 'Auto-update is ON — new versions install themselves at sign-in.' : 'Auto-update is OFF — you\'ll see an "Update now" link instead.');
  renderTop();
}
function updateAvailable(){ return !!(state.latestVersion && verGt(state.latestVersion, APP_VERSION)); }
/* v5: the exe serves on 127.0.0.1:4879 specifically — a bare localhost check
   would wrongly engage the /api proxy under dev/preview servers too. */
function isDesktopApp(){ return (location.hostname==='localhost' || location.hostname==='127.0.0.1') && location.port==='4879'; }
function verGt(a,b){
  const x = String(a||'').split('.').map(Number), y = String(b||'').split('.').map(Number);
  for(let i=0; i<Math.max(x.length,y.length); i++){ const d=(x[i]||0)-(y[i]||0); if(d) return d>0; }
  return false;
}
async function installLatest(){
  if(!updateAvailable()) return;
  if(!isDesktopApp()){
    toast(`A new CreativeFlow version (v${esc(state.latestVersion)}) is available — ask your admin for the updated file.`);
    return;
  }
  try{
    toast(`⬇ Updating CreativeFlow to v${esc(state.latestVersion)}…`);
    const j = await api('appHtml', { channel: CHANNEL });
    const vm = String(j.html||'').match(/APP_VERSION\s*=\s*'([^']+)'/);
    if(!vm || !verGt(vm[1], APP_VERSION)){ toast('The update file on Drive isn\'t newer than this build — check APP_UPDATE_URL / the Drive file version.', true); return; }
    const r = await fetch('/update', { method:'POST', body: j.html });
    if(!r.ok){ toast('The desktop app rejected the update file.', true); return; }
    toast(`✓ Updated to v${esc(vm[1])} — restarting…`);
    setTimeout(()=>location.reload(), 1400);
  }catch(e){ toast('Update failed: '+esc(e.message), true); }
}
async function maybeSelfUpdate(){
  if(!updateAvailable()) return;
  renderTop(); // surface the "vX available" line
  if(autoUpdateOn()){ await installLatest(); return; }
  if(!updateNotified){
    updateNotified = true;
    toast(`v${esc(state.latestVersion)} is available — auto-update is off. Use <b>Update now</b> in the sidebar.`);
  }
}
/* v5: setupGoogleButton removed — Google login is retired (owner order, 4.9.2). Do not re-add. */
/* v5: startBrowserLogin removed — Google login is retired (owner order, 4.9.2). Do not re-add. */
/* v5: onGoogleCred removed — Google login is retired (owner order, 4.9.2). Do not re-add. */

/* ═══════════ LOGIN ═══════════ */
function setLoginBusy(b, label){
  const btn = $('#login-btn');
  btn.disabled = b;
  btn.textContent = b ? (label||'CONNECTING…') : 'OPEN MY DASHBOARD';
}
function showLogin(msg){
  $('#app').classList.remove('ready');
  $('#login').style.display = 'flex';
  $('#url-field').style.display = state.url ? 'none' : 'block';
  $('#changelink').style.display = state.url ? 'block' : 'none';
  $('#in-url').value = state.url;
  $('#in-email').value = state.email;
  $('#in-code').value = '';
  const su = $('#saved-url');
  if(state.url){
    const short = state.url.length > 64 ? state.url.slice(0, 44) + '……' + state.url.slice(-16) : state.url;
    su.innerHTML = 'Connected to: <b>' + esc(short) + '</b>';
    su.style.display = 'block';
  } else su.style.display = 'none';
  const e = $('#login-err');
  e.className = 'login-err';
  if(msg){ e.textContent = msg; e.style.display='block'; } else e.style.display='none';
  if(state.url) fetchPing();
}
/* ═══════════ DEVICE CACHE — instant open ═══════════
   A signed-in device paints its last known board immediately and refreshes in
   the background, so opening the app feels instant instead of waiting on a
   round trip to Google. Cleared on sign-out. */
const CACHE_KEY = 'cf_board_v1';
const CACHE_MAX = 900000; /* ~0.9 MB — well under the localStorage budget */

function saveCache_(){
  try {
    if(!state.me || __pageLoading) return;   /* never cache a half-loaded board */
    const payload = JSON.stringify({
      v: 1, at: Date.now(), email: state.email,
      me: state.me, org: state.org, teams: state.teams, roster: state.roster,
      formUrl: state.formUrl, sheetUrl: state.sheetUrl,
      tasks: state.tasks.map(t => Object.assign({}, t, { due: undefined, created: undefined, completed: undefined, startedAt: undefined })),
    });
    if(payload.length > CACHE_MAX) return;
    store.set(CACHE_KEY, payload);
  } catch(e){}
}

function loadCache_(){
  try {
    const raw = store.get(CACHE_KEY);
    if(!raw) return null;
    const j = JSON.parse(raw);
    /* only trust a cache written by the account that is signing in now */
    if(!j || j.v !== 1 || !j.me || j.email !== state.email) return null;
    return j;
  } catch(e){ return null; }
}

function clearCache_(){ try { store.del(CACHE_KEY); } catch(e){} }

/* Brand splash for a first-ever sign-in on a device (nothing cached yet) —
   shown instead of the login form, which would be misleading. */
function showSplash_(){
  if(document.getElementById('cf-splash')) return;
  const el = document.createElement('div');
  el.id = 'cf-splash';
  el.style.cssText = 'position:fixed;inset:0;z-index:250;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px';
  el.innerHTML = '<div class="dotf" style="font-size:30px">CREATIVE<span style="color:var(--accent)">FLOW</span></div>' +
    '<div style="color:var(--muted);font-size:12px">Loading your board…</div>';
  document.body.appendChild(el);
}
function hideSplash_(){ const el = document.getElementById('cf-splash'); if(el) el.remove(); }

async function bootstrapAndEnter(remember, silent){
  const j = await api('bootstrap', { lite: 1 }); /* small answer: identity + roster only */
  state.me = j.me; state.org = j.org || 'Your Studio'; state.teams = j.teams || [];
  state.roster = j.roster || []; state.formUrl = j.formUrl || ''; state.sheetUrl = j.sheetUrl || '';
  if(j.tasks){ /* older API ignored lite and sent everything — use it as-is */
    state.tasks = (j.tasks||[]).map(parseTask);
  } else {
    await loadTasksFirstFast_(); /* first page now, rest in the background */
  }
  state.lastSync = new Date();
  if(isAssigner() && (tab==='overview')) tab = 'review';
  if(remember){ store.set('cf_url', state.url); store.set('cf_email', state.email); store.set('cf_code', state.code); }
  hideSplash_();
  /* `silent` = the cached board is already on screen; re-render in place rather
     than resetting the tab and filters the user may already have changed. */
  if(silent){ setSync(''); renderAll(); saveCache_(); }
  else enterApp();
  if(window.__cfOpenTask){
    const _ot = window.__cfOpenTask; window.__cfOpenTask = '';
    let _tries = 0;
    const _try = ()=>{
      if(state.tasks.find(x=>x.id===_ot)) return openReview(_ot);
      if(__pageLoading && ++_tries < 25) return setTimeout(_try, 700); /* it may be on a later page */
      toast('Task <b>'+esc(_ot)+'</b> is not visible on this account.', true);
    };
    setTimeout(_try, 350);
  }
  fetchPing().then(maybeSelfUpdate).catch(()=>{});
}
async function doLogin(){
  const url = cleanUrl_($('#url-field').style.display==='none' ? state.url : $('#in-url').value.trim());
  const email = $('#in-email').value.trim();
  const code = $('#in-code').value.trim();
  const err = $('#login-err');
  err.style.display = 'none';
  const okUrl = (/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url) && url.indexOf('/exec') !== -1)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
  if(!okUrl){
    err.textContent = 'That link doesn’t look like a Web app URL — it should start with https://script.google.com/ and end in /exec.';
    err.style.display='block'; return;
  }
  if(!email || !code){ err.textContent='Enter your email and access code (or use the Google button).'; err.style.display='block'; return; }
  setLoginBusy(true);
  state.url = url; state.email = email; state.code = code;
  try {
    try {
      await bootstrapAndEnter($('#in-remember').checked);
    } catch(e1){
      if(e1.apiError!=='TIMEOUT') throw e1;
      setLoginBusy(true, 'STILL TRYING… (SLOW CONNECTION)');
      await bootstrapAndEnter($('#in-remember').checked); // one retry for cold starts
    }
  } catch(e){
    showLogin(e.apiError==='AUTH' ? 'That email + access code combination didn’t match the Roster. Codes are in your "[Task] 🔑" email.' :
      'Could not connect: '+e.message+' — check the link, your internet, and that the deployment access is "Anyone".');
  } finally { setLoginBusy(false); }
}
function enterApp(){
  $('#login').style.display = 'none';
  $('#app').classList.add('ready');
  /* Honour a tab restored from the URL hash. renderAll writes the current tab
     into the hash precisely so a refresh — or a PWA cold start — comes back
     where you were, but this line used to overwrite it unconditionally, so it
     never actually worked for any tab. Consumed once: a later sign-in starts
     at the Dashboard as before. */
  tab = bootTab_ || 'overview'; bootTab_ = '';
  myTab='today'; mcalOffset=0;
  filters = { team:'', member:'', priority:'', status:'', q:'' }; reportSubject = null;
  weekOffset = ([0,6].indexOf(new Date().getDay())!==-1) ? 1 : 0;
  renderAll();
  saveCache_();
  refreshPushState_();
  refreshNotifLog_();
  openTaskFromRoute_();     // arrived here by tapping a notification?
}

/* ═══════════ PUSH NOTIFICATIONS ═══════════ */

/** Reads the real state of this device and re-paints the account panel. Also
 *  re-registers a subscription the browser rotated behind our back — that
 *  failure is otherwise completely silent. */
async function refreshPushState_(){
  try{
    const st = await pushState();
    state.pushOn = st.on;
    state.pushWhy = st.supported ? '' : st.why;
    if(st.on) pushResync(api, state.vapidKey);
    renderTop();
  }catch(e){}
}

async function togglePush(btn){
  const label = state.pushOn;
  if(btn){ btn.disabled = true; btn.innerHTML = label ? 'Turning off…' : 'Turning on…'; }
  try{
    if(label){
      await pushDisable(api);
      state.pushOn = false;
      toast('Notifications are off on this device.');
    }else{
      await pushEnable(api, state.vapidKey);
      state.pushOn = true;
      state.pushWhy = '';
      toast('Notifications are on. You\'ll be told the moment something needs you.');
    }
  }catch(err){
    state.pushWhy = err && err.message ? err.message : String(err);
    toast(esc(state.pushWhy), true);
  }
  if(btn) btn.disabled = false;
  renderTop();
}

/* The service worker talks back: a tapped notification asks us to open its
   task, and a rotated subscription asks us to re-register it. */
if(typeof navigator !== 'undefined' && navigator.serviceWorker){
  navigator.serviceWorker.addEventListener('message', ev => {
    const d = ev.data || {};
    if(d.type === 'CF_OPEN' && d.taskId){
      if(state.me) openTaskModal(d.taskId);
      else store.set('cf_open_task', d.taskId);   // opened from a cold start
    }
    if(d.type === 'CF_PUSH_RESUBSCRIBE') pushResync(api, state.vapidKey);
    if(d.type === 'CF_NOTIF' && d.entry){ logAdd(d.entry).then(refreshNotifLog_); }
  });
}

/** #/t/<id> — where a tapped notification lands when the app was closed. */
function openTaskFromRoute_(){
  const m = (location.hash || '').match(/^#\/t\/([A-Za-z]{2}-\d{3,})$/);
  const pending = store.get('cf_open_task');
  const id = (m && m[1]) || pending || '';
  if(!id) return;
  store.del('cf_open_task');
  if(state.tasks.some(t => t.id === id)) openTaskModal(id);
}

function logout(){
  store.del('cf_code'); store.del('td_code'); state.code=''; state.me=null;
  clearCache_();            /* the board must not survive a sign-out */
  state.tasks = [];
  /* The subscription is per-device, not per-person: leaving it behind would
     send the next person to sign in the previous one's notifications. */
  pushDisable(api).catch(()=>{});
  state.pushOn = false;
  showLogin();
}

/* ═══════════ NAV / SHELL ═══════════ */
const TAB_DEFS_FULL = [
  {id:'overview', ic:'▦', label:'Dashboard'},
  {id:'tasks', ic:'☰', label:'Tasks'},
  {id:'review', ic:'◉', label:'Review'},
  {id:'projects', ic:'◳', label:'Projects'},
  {id:'gallery', ic:'▨', label:'Gallery'},
  {id:'calendar', ic:'▤', label:'Calendar'},
  {id:'reports', ic:'◔', label:'Reports'},
];
const TAB_DEFS_ASSIGNER = [
  {id:'review', ic:'◉', label:'Review'},
  {id:'tasks', ic:'☰', label:'My tasks'},
  {id:'projects', ic:'◳', label:'Projects'},
  {id:'gallery', ic:'▨', label:'Gallery'},
  {id:'calendar', ic:'▤', label:'Assign'},
  {id:'reports', ic:'◔', label:'Reports'},
];
/* Assigners tab is for the people who receive the requests, not the people who
   make them — a head or admin picking one assigner at a time. */
function TAB_DEFS_(){
  if(isAssigner()) return TAB_DEFS_ASSIGNER;
  if(!(isHead() || isAdmin())) return TAB_DEFS_FULL;
  const t = TAB_DEFS_FULL.slice();
  t.splice(3, 0, {id:'assigners', ic:'◈', label:'Assigners'});
  return t;
}
function renderNav(){
  const odCount = state.tasks.filter(isOverdue).length;
  const rvCount = reviewBadge();
  const bb = document.getElementById('bulk-btn');
  if(bb) bb.style.display = (isAssigner()||isHead()||isAdmin()) ? 'block' : 'none';
  $('#nav').innerHTML = TAB_DEFS_().map(x=>`
    <button class="nav-btn ${tab===x.id?'active':''}" data-tab="${x.id}">
      <span class="ic">${x.ic}</span>${x.label}
      ${x.id==='overview'&&odCount? `<span class="nav-badge">${odCount}</span>` : x.id==='review'&&rvCount? `<span class="nav-badge">${rvCount}</span>`:''}
    </button>`).join('');
  $('#nav').querySelectorAll('.nav-btn').forEach(b=> b.onclick = ()=>{ tab=b.dataset.tab; renderAll(); });

  /* phone bottom bar mirrors the nav, with New Task in the middle */
  const tb = $('#tabbar');
  if(tb){
    const items = TAB_DEFS_().map(x=>`<button class="tb ${tab===x.id?'active':''}" data-tab="${x.id}"><span class="ic">${x.ic}</span>${x.label}${x.id==='overview'&&odCount? `<span class="nb">${odCount}</span>` : x.id==='review'&&rvCount? `<span class="nb">${rvCount}</span>`:''}</button>`);
    items.splice(2, 0, `<button class="tb tb-new" aria-label="Add" onclick="openAddPill()"><span class="plus">＋</span></button>`);
    /* minmax(0,1fr), not 1fr: a plain 1fr track refuses to shrink below its
       content, so at seven tabs the bar ran off the side of the phone. */
    tb.style.gridTemplateColumns = 'repeat(' + items.length + ',minmax(0,1fr))';
    tb.classList.toggle('tight', items.length > 6);
    tb.innerHTML = items.join('');
    tb.querySelectorAll('.tb[data-tab]').forEach(b=> b.onclick = ()=>{ tab=b.dataset.tab; renderAll(); });
  }
}
function renderTop(){
  const t = TAB_DEFS_().find(x=>x.id===tab) || TAB_DEFS_()[0];
  const scopeName = isAdmin()? 'All teams' : isHead()? state.me.team+' team' : 'My workspace';
  $('#view-title').textContent = t.label;
  $('#view-sub').textContent = scopeName+' · '+new Date().toLocaleDateString('en-IN',{weekday:'long', day:'numeric', month:'long', year:'numeric'});
  $('#userchip').innerHTML = av(state.me.name,32)+`<span><div class="un">${esc(state.me.name)}</div><span class="role-pill">${esc(roleLabel(state.me))}</span></span>`;
  $('#org-sub').textContent = state.org;
  /* The badge counts UNREAD arrivals, not standing attention items. Once the
     bell has been opened it goes quiet even though the overdue list is still
     there — otherwise the number never clears and stops meaning anything. */
  const unread = notifUnread_;
  $('#bell-count').textContent = unread || '';
  $('#bell-count').style.display = unread ? 'block':'none';
  const acctHtml = `Signed in as <b>${esc(state.me.name)}</b><br><span style="color:var(--muted)">${esc(state.me.email)}</span>
    <div class="links">
      ${state.formUrl? `<a href="${esc(state.formUrl)}" target="_blank" rel="noopener">📝 Task request form</a>`:''}
      ${(isAdmin()||isHead()) && state.sheetUrl? `<a href="${esc(state.sheetUrl)}" target="_blank" rel="noopener">📄 Master sheet</a>`:''}
    </div>
    <div class="out"><button onclick="refreshTasks()">↻ Refresh</button><button onclick="logout()">Sign out</button></div>
    <div class="out" style="margin-top:7px"><button id="push-btn" onclick="togglePush(this)" title="Get a notification on this device the moment something needs you">${state.pushOn ? '🔔 Notifications: <b>ON</b>' : '🔕 Notifications: <b>OFF</b>'}</button></div>
    ${state.pushWhy ? `<div style="margin-top:6px;font-size:10.5px;color:var(--muted);line-height:1.6">${esc(state.pushWhy)}</div>` : ''}
    <div class="out" style="margin-top:7px"><button onclick="toggleAutoUpdate()" title="Install new versions automatically at sign-in">⟳ Auto-update: <b>${autoUpdateOn()?'ON':'OFF'}</b></button></div>
    <div style="margin-top:8px;font-size:10px;color:var(--muted);letter-spacing:.08em">CREATIVEFLOW v${APP_VERSION}${updateAvailable() ? ' · <a href="#" style="color:var(--accent);font-weight:700" onclick="installLatest();return false;">v'+esc(state.latestVersion)+' available — Update now</a>' : ''}</div>`;
  $('#acct').innerHTML = acctHtml;
  const sheet = $('#acct-sheet');
  if(sheet) sheet.innerHTML = acctHtml;
  $('#userchip').onclick = e => { e.stopPropagation(); $('#acct-sheet').classList.toggle('open'); };
  applyTheme(document.documentElement.getAttribute('data-theme'));
  setSync($('#sync').className, undefined);
}

/* ═══════════ NOTIFICATIONS ═══════════ */
function notifs(){
  const list = [];
  const now = new Date();
  state.tasks.filter(isOverdue).forEach(t=> list.push({red:1, ic:'⚠', t, msg:`<b>${t.id}</b> is overdue — “${esc(t.title)}” was due ${fmtDT(t.due)}.`, when:'escalation active'}));
  if(isHead()||isAdmin()){
    state.tasks.filter(t=>!t.assignee && !isClosed(t)).forEach(t=> list.push({ic:'🙋', t, msg:`<b>${t.id}</b> “${esc(t.title)}” needs an assignee — requested by ${esc(t.requester)}.`, when:'awaiting assignment'}));
    state.tasks.filter(t=>t.status==='In Review').forEach(t=> list.push({ic:'👁', t, msg:`<b>${t.id}</b> “${esc(t.title)}” is waiting for review.`, when:'in review'}));
  }
  state.tasks.filter(t=>!isOverdue(t) && !isClosed(t) && t.due && t.due-now < DAY && t.due > now).forEach(t=> list.push({ic:'◷', t, msg:`Deadline approaching for <b>${esc(t.title)}</b> — due ${fmtT(t.due)}.`, when:'due soon'}));
  return list;
}
function notifItemsHtml(ns, limit){
  const items = limit? ns.slice(0,limit) : ns;
  if(!items.length) return `<div class="empty">All clear — nothing needs your attention. 🎉</div>`;
  return items.map((n,i)=>`<div class="notif-item ${n.red?'hot':''}" data-ni="${i}">
    <span class="ni">${n.ic}</span>
    <span style="flex:1">${n.msg}<div class="nt">${n.when} · also sent by email</div></span>
    <span class="dot"></span></div>`).join('');
}
function bindNotifClicks(root, ns){
  root.querySelectorAll('.notif-item[data-ni]').forEach(el=> el.onclick = ()=>{
    const n = ns[+el.dataset.ni];
    $('#notif-panel').classList.remove('open');
    if(n && n.t) openTaskModal(n.t.id);
  });
}
/* ── the received-notification log ─────────────────────────────────────────
   What ACTUALLY arrived on this device, written by the service worker even
   while the app was closed. Sits above the derived "needs attention" list,
   which stays because it is stateful — an overdue task is still overdue
   whether or not you read the notification about it. */
let notifLog_ = [];
let notifUnread_ = 0;

/* test seam: lets the suite put an arrival in the log without a push service.
   Thin on purpose — it writes through the same store the worker uses. */
function logAddForTest(entry){ return logAdd(entry); }

async function refreshNotifLog_(){
  try{
    notifLog_ = await logList();
    notifUnread_ = notifLog_.filter(n => !n.seen).length;
    renderTop();
  }catch(e){}
}

const NOTIF_ICON = { assigned:'🆕', changes:'🔁', done:'✅', review:'👁', overdue:'🚨',
                     comment:'💬', rejected:'✗', 'due-soon':'◷', brief:'✍️', update:'⟳', test:'🔔' };

function notifWhen_(iso){
  const d = iso ? new Date(iso) : null;
  if(!d || isNaN(d)) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + ' min ago';
  if(mins < 1440) return Math.round(mins/60) + 'h ago';
  return fmtD(d);
}

function logItemsHtml_(){
  if(!notifLog_.length) return '';
  return `<div class="nh" style="display:flex;align-items:center;gap:8px">Received
      <span style="color:var(--muted);font-weight:400">· ${notifLog_.length}</span>
      <button style="margin-left:auto;font-size:10px;color:var(--muted);text-decoration:underline" onclick="clearNotifLog_()">Clear</button>
    </div>` +
    notifLog_.map((n,i)=>`<div class="notif-item ${n.seen?'':'hot'}" data-nl="${i}">
      <span class="ni">${NOTIF_ICON[n.kind] || '🔔'}</span>
      <span style="flex:1"><b>${esc(n.title)}</b><br>${esc(n.body)}<div class="nt">${notifWhen_(n.at)}${n.seen?'':' · new'}</div></span>
      ${n.seen?'':'<span class="dot"></span>'}</div>`).join('');
}

async function clearNotifLog_(){
  await logClear();
  notifLog_ = []; notifUnread_ = 0;
  renderNotifPanel(); renderTop();
}

function renderNotifPanel(){
  const ns = notifs();
  const p = $('#notif-panel');
  p.innerHTML = logItemsHtml_() +
    `<div class="nh">${notifLog_.length ? 'Needs attention' : 'Notifications'} · ${ns.length}</div>` +
    notifItemsHtml(ns);
  bindNotifClicks(p, ns);
  /* a logged notification opens its task too */
  p.querySelectorAll('.notif-item[data-nl]').forEach(el => el.onclick = () => {
    const n = notifLog_[+el.dataset.nl];
    $('#notif-panel').classList.remove('open');
    if(n && n.taskId && state.tasks.some(t => t.id === n.taskId)) openTaskModal(n.taskId);
  });
}

/** Opening the bell is what marks things read — that is the "if seen, close"
 *  behaviour: the badge clears, the entries stay readable until cleared. */
async function openNotifPanel_(){
  const p = $('#notif-panel');
  const opening = !p.classList.contains('open');
  p.classList.toggle('open');
  if(!opening) return;
  renderNotifPanel();
  if(notifUnread_){
    await logMarkSeen();
    notifLog_ = notifLog_.map(n => ({ ...n, seen: true }));
    notifUnread_ = 0;
    renderTop();
    /* repaint so the "new" flags drop away while the panel is still open */
    setTimeout(() => { if(p.classList.contains('open')) renderNotifPanel(); }, 1500);
  }
}

/* ═══════════ VIEWS ═══════════ */
function d0(days,h,m){ const n=new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()+days, h||0, m||0); }
function greetWord(){ const h = new Date().getHours(); return h<12?'GOOD MORNING,':h<17?'GOOD AFTERNOON,':'GOOD EVENING,'; }
function odStrip(tasks){
  const od = tasks.filter(isOverdue);
  if(!od.length) return '';
  return `<div class="od-strip"><span class="od-dot"></span><b>Overdue — act now</b>` +
    od.map(t=>`<span class="od-pill" onclick="openTaskModal('${t.id}')">${t.id} · ${esc(t.title)}${t.assignee?' — '+esc(t.assignee.split(' ')[0]):''}</span>`).join('') + `</div>`;
}
function rowHtml(t, showStatus){
  return `<div class="trow" onclick="openTaskModal('${t.id}')">
    ${av(t.assignee, 26)}
    <span class="tt">${esc(t.title)}<small>${t.id} · ${tdot(t.team)}${esc(t.team)}${t.assignee? ' · '+esc(t.assignee.split(' ')[0]):''}</small></span>
    ${showStatus? schip(t) : pchip(t.priority)}
    <span class="due ${isOverdue(t)?'late':(t.due && t.due-Date.now()<DAY?'':'ok')}">${isOverdue(t)?'⚠ ':''}${dueLabel(t)}</span></div>`;
}
const ICONS = {
  doc:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  clock:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  eye:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  check:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  cal:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
};

function viewOverview(){
  const mine = state.tasks;
  const now = new Date();
  const open = mine.filter(t=>!isClosed(t));
  const od = mine.filter(isOverdue);
  const odHigh = od.filter(t=>t.priority==='Urgent'||t.priority==='High');
  const dueToday = open.filter(t=>t.due && t.due>=d0(0) && t.due<d0(1));
  const inReview = mine.filter(t=>t.status==='In Review');
  const doneWeek = mine.filter(t=>t.completed && (now-t.completed) < 7*DAY);
  const due7 = open.filter(t=>t.due && t.due>=d0(0) && t.due<d0(7));

  let html = `<div class="greet">
    <div class="hi">${greetWord()}</div>
    <div class="name dotf">${esc(state.me.name.split(' ')[0])} <span class="role-pill" style="font-size:10px;padding:4px 13px">${esc(roleLabel(state.me))}</span></div>
    <div class="line">Here's what's happening with your ${isAdmin()?'teams':isHead()?state.me.team.toLowerCase()+' team':'tasks'} today.</div>
  </div><div class="dotsep"></div>`;

  html += odStrip(mine);

  html += `<div class="kpis">
    <div class="kpi"><div class="ico">${ICONS.doc}</div><div class="lbl">${isAdmin()||isHead()?'Open tasks':'My tasks'}</div><div class="n">${open.length}</div><div class="cap ${dueToday.length?'hot':''}">${dueToday.length} due today</div></div>
    <div class="kpi ${od.length?'alert':''}"><div class="ico">${ICONS.clock}</div><div class="lbl">Overdue</div><div class="n">${od.length}</div><div class="cap ${odHigh.length?'hot':''}">${odHigh.length? odHigh.length+' high priority':'—'}</div></div>
    <div class="kpi"><div class="ico">${ICONS.eye}</div><div class="lbl">In review</div><div class="n">${inReview.length}</div><div class="cap">${(isHead()||isAdmin())&&inReview.length? inReview.length+' waiting for you':'—'}</div></div>
    <div class="kpi"><div class="ico">${ICONS.check}</div><div class="lbl">Completed</div><div class="n">${doneWeek.length}</div><div class="cap">this week</div></div>
    <div class="kpi"><div class="ico">${ICONS.cal}</div><div class="lbl">Due 7 days</div><div class="n">${due7.length}</div><div class="cap">coming up</div></div>
  </div>`;

  html += `<div class="ov-grid"><div>`;

  /* MY TASKS with tabs */
  const tabsDef = [
    {k:'all', label:'All', f: t=>!isClosed(t)},
    {k:'today', label:'Today', f: t=>!isClosed(t) && t.due && t.due>=d0(0) && t.due<d0(1)},
    {k:'upcoming', label:'Upcoming', f: t=>!isClosed(t) && t.due && t.due>=d0(1)},
    {k:'overdue', label:'Overdue', f: isOverdue},
  ];
  const active = tabsDef.find(x=>x.k===myTab) || tabsDef[1];
  const listed = mine.filter(active.f).sort((a,b)=>(isOverdue(b)-isOverdue(a)) || ((a.due||Infinity)-(b.due||Infinity))).slice(0,8);
  html += `<div class="panel"><h3>${isAdmin()?'All tasks':isHead()?state.me.team+' tasks':'My tasks'} <span class="right" style="cursor:pointer" onclick="tab='tasks';renderAll()">VIEW ALL →</span></h3>
    <div class="ttabs">${tabsDef.map(x=>`<button class="ttab ${myTab===x.k?'on':''}" onclick="myTab='${x.k}';renderContent()">${x.label} ${x.k!=='all'? '· '+mine.filter(x.f).length : ''}</button>`).join('')}</div>` +
    (listed.length? listed.map(t=>rowHtml(t,true)).join('') : `<div class="empty">Nothing here. 🎉</div>`) +
    `<div style="margin-top:10px"><button class="ghostbtn" onclick="openNewTaskModal()">＋ New Task</button></div></div>`;

  /* Team workload (heads + admin) */
  if(isHead()||isAdmin()){
    const pool = state.roster.filter(m=>m.role!=='Super Admin' && (isAdmin() || m.team===state.me.team));
    if(pool.length){
      const loads = pool.map(m=>mine.filter(t=>t.assignee===m.name && !isClosed(t)).length);
      const maxL = Math.max(1,...loads);
      html += `<div class="panel"><h3>Team workload</h3>` + pool.map((m,i)=>{
        const n = loads[i];
        const o = mine.filter(t=>t.assignee===m.name).filter(isOverdue).length;
        return `<div class="bar-row"><span class="who">${av(m.name,24)}<span>${esc(m.name.split(' ')[0])}<br><span style="font-size:9.5px;color:var(--muted);letter-spacing:.06em">${esc(roleLabel(m))}</span></span></span>
          <div class="bar-track"><div class="bar-fill" style="background:${teamColor(m.team)};width:${Math.max(3,100*n/maxL)}%"></div></div>
          <span>${n} open${o?` <b style="color:var(--accent)">⚠${o}</b>`:''}</span></div>`;
      }).join('') + `</div>`;
    }
    const unassigned = mine.filter(t=>!t.assignee && !isClosed(t));
    html += `<div class="panel"><h3>Needs an assignee <span class="count">${unassigned.length}</span></h3>` +
      (unassigned.length? unassigned.map(t=>`
        <div class="trow"><span class="tid">${t.id}</span><span class="tt">${esc(t.title)}<small>${tdot(t.team)}${esc(t.team)} · from ${esc(t.requester)}</small></span>
        <select class="mini-sel" onchange="assignTask('${t.id}', this.value)" onclick="event.stopPropagation()">
          <option value="">Assign to…</option>${state.roster.filter(m=>m.team===t.team&&m.role!=='Super Admin').map(m=>`<option>${esc(m.name)}</option>`).join('')}
        </select></div>`).join('') : `<div class="empty">Everything is assigned. 🎉</div>`) + `</div>`;
  }

  html += `</div><div>`; /* right rail */
  const ns = notifs();
  html += `<div class="panel"><h3>Notifications <span class="right" style="cursor:pointer" onclick="document.getElementById('bell').click()">VIEW ALL</span></h3><div id="ov-notifs">${notifItemsHtml(ns, 5)}</div></div>`;
  html += `<div class="panel">${miniCalHtml()}</div>`;
  html += `</div></div>`;
  return html;
}

/* mini month calendar */
function miniCalHtml(){
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth()+mcalOffset);
  const Y = base.getFullYear(), M = base.getMonth();
  const today = new Date();
  const first = new Date(Y, M, 1);
  const startDow = (first.getDay()+6)%7;
  const daysIn = new Date(Y, M+1, 0).getDate();
  const dueSet = {};
  state.tasks.forEach(t=>{ if(t.due && !isClosed(t) && t.due.getFullYear()===Y && t.due.getMonth()===M) dueSet[t.due.getDate()]=1; });
  let cells = '';
  let row = '<tr>';
  for(let i=0;i<startDow;i++) row += '<td></td>';
  for(let d=1; d<=daysIn; d++){
    const isToday = d===today.getDate() && M===today.getMonth() && Y===today.getFullYear();
    row += `<td><span class="dcell ${isToday?'today':''} ${dueSet[d]?'has':''}" onclick="jumpToDate(${Y},${M},${d})">${d}</span></td>`;
    if((startDow+d)%7===0){ cells += row+'</tr>'; row='<tr>'; }
  }
  if(row!=='<tr>') cells += row+'</tr>';
  return `<div class="mcal-head"><b>${base.toLocaleDateString('en-IN',{month:'long', year:'numeric'})}</b>
      <span style="margin-left:auto"></span>
      <button onclick="mcalOffset--;renderContent()">‹</button><button onclick="mcalOffset++;renderContent()">›</button></div>
    <table class="mcal"><tr><th>MO</th><th>TU</th><th>WE</th><th>TH</th><th>FR</th><th>SA</th><th>SU</th></tr>${cells}</table>
    <div style="font-size:10px;color:var(--muted);margin-top:6px">● = tasks due · click a day to open that week</div>`;
}
function jumpToDate(Y,M,D){
  const target = mondayOf0_(new Date(Y,M,D));
  const cur = mondayOf0_(new Date());
  weekOffset = Math.round((target-cur)/(7*DAY));
  tab='calendar'; renderAll();
}
function mondayOf0_(d){ const b=new Date(d.getFullYear(),d.getMonth(),d.getDate()); b.setDate(b.getDate()-((b.getDay()+6)%7)); return b; }

function viewTasks(){
  const mine = state.tasks;
  let list = mine.filter(t=>
    (!filters.team || t.team===filters.team) &&
    (!filters.member || t.assignee===filters.member) &&
    (!filters.priority || t.priority===filters.priority) &&
    (!filters.status || (filters.status==='Overdue'? isOverdue(t) : t.status===filters.status)) &&
    (!filters.q || (t.title+' '+t.id+' '+t.assignee).toLowerCase().includes(filters.q.toLowerCase()))
  ).sort((a,b)=> (isOverdue(b)-isOverdue(a)) || ((a.status==='Done')-(b.status==='Done')) || ((a.due||Infinity)-(b.due||Infinity)));

  const memberOpts = [...new Set(mine.map(t=>t.assignee).filter(Boolean))];
  let html = odStrip(mine);
  html += `<div class="panel"><div class="filters">
    <input type="search" placeholder="Search tasks…" value="${esc(filters.q)}" oninput="filters.q=this.value; renderContent()">
    ${isAdmin()? `<select class="mini-sel" onchange="filters.team=this.value; renderContent()"><option value="">All teams</option>${state.teams.map(x=>`<option ${filters.team===x?'selected':''}>${esc(x)}</option>`).join('')}</select>`:''}
    ${(isAdmin()||isHead())? `<select class="mini-sel" onchange="filters.member=this.value; renderContent()"><option value="">All members</option>${memberOpts.map(x=>`<option ${filters.member===x?'selected':''}>${esc(x)}</option>`).join('')}</select>`:''}
    <select class="mini-sel" onchange="filters.priority=this.value; renderContent()"><option value="">All priorities</option>${PRIORITIES.map(x=>`<option ${filters.priority===x?'selected':''}>${x}</option>`).join('')}</select>
    <select class="mini-sel" onchange="filters.status=this.value; renderContent()"><option value="">All statuses</option><option ${filters.status==='Overdue'?'selected':''}>Overdue</option>${STATUSES.map(x=>`<option ${filters.status===x?'selected':''}>${x}</option>`).join('')}</select>
    <span class="count" style="margin-left:auto;color:var(--muted);font-size:12px">${list.length} task${list.length===1?'':'s'}</span>
  </div>
  <div class="tbl-wrap" style="overflow-x:auto"><table class="tasks"><thead><tr>
    <th>ID</th><th>Task</th><th>Team</th><th>Assigned to</th><th>Priority</th><th>Status</th><th>Due</th><th>Rev</th>
  </tr></thead><tbody>` +
  (list.length? list.map(t=>`<tr class="rowlink ${isOverdue(t)?'overdue-row':''}" onclick="openTaskModal('${t.id}')">
    <td style="font-variant-numeric:tabular-nums;color:var(--muted);font-size:11px">${t.id}</td>
    <td style="font-weight:600;min-width:200px">${esc(t.title)}</td>
    <td style="white-space:nowrap">${tdot(t.team)}${esc(t.team)}</td>
    <td style="white-space:nowrap">${t.assignee? av(t.assignee,22)+' '+esc(t.assignee) : '<i style="color:var(--muted)">unassigned</i>'}</td>
    <td>${pchip(t.priority)}</td><td>${schip(t)}</td>
    <td class="due ${isOverdue(t)?'late':''}" style="white-space:nowrap;color:${isOverdue(t)?'var(--accent)':'var(--muted)'};font-weight:${isOverdue(t)?'700':'500'};font-size:11.5px">${dueLabel(t)}</td>
    <td style="text-align:center;color:var(--muted)">${t.revisions||''}</td>
  </tr>`).join('') : `<tr><td colspan="8" class="empty">No tasks match. Try clearing filters, or add one with ＋ New Task.</td></tr>`) +
  `</tbody></table></div>
  <div class="mob-list">` + (list.length? list.map(t=>rowHtml(t,true)).join('') : `<div class="empty">No tasks match. Try clearing filters, or add one with ＋.</div>`) + `</div></div>`;
  return html;
}

/* ── calendar ── */
function mondayOf(offset){
  const n = new Date();
  const base = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  const dow = (base.getDay()+6)%7;
  base.setDate(base.getDate()-dow+offset*7);
  return base;
}
const CAL_START=9, CAL_END=21;
function viewCalendar(){
  const now = new Date();
  const mon = mondayOf(weekOffset);
  const days = Array.from({length:7},(_,i)=> new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+i));
  const mine = state.tasks;
  const od = mine.filter(isOverdue);
  const rangeLbl = days[0].toLocaleDateString('en-IN',{day:'numeric',month:'short'})+' – '+days[6].toLocaleDateString('en-IN',{day:'numeric',month:'short', year:'numeric'});

  let html = `<div class="cal-head"><h2 class="dotf">${rangeLbl}</h2>
    <div class="cal-nav"><button onclick="weekOffset--; renderContent()">‹</button><button onclick="weekOffset=0; renderContent()">Today</button><button onclick="weekOffset++; renderContent()">›</button></div>
    <div class="legend">${state.teams.map(tm=>`<span><span class="lg-dot" style="background:${teamColor(tm)}"></span>${esc(tm)}</span>`).join('')}<span><span class="lg-dot" style="background:var(--accent)"></span>Overdue</span></div></div>`;

  if(od.length){
    html += `<div class="od-lane"><div class="lbl">⚠ Overdue — drag onto the grid to reschedule, or finish first</div><div class="od-lane-items">` +
      od.map(t=>`<div class="cal-task late" style="position:static;width:200px;border-left-color:${teamColor(t.team)}" data-task="${t.id}"><div class="ct-t">${t.id} · ${esc(t.title)}</div><div class="ct-m">was due ${dueLabel(t)}</div></div>`).join('') + `</div></div>`;
  }

  html += `<div class="cal-wrap"><div class="cal-grid" id="cal-grid">`;
  html += `<div class="cal-gutter"></div>` + days.map(dt=>{
    const isToday = dt.toDateString()===now.toDateString();
    return `<div class="cal-day-head ${isToday?'today':''}">${dt.toLocaleDateString('en-IN',{weekday:'short'})}<b>${dt.getDate()}</b></div>`;
  }).join('');
  html += `<div>` + Array.from({length:CAL_END-CAL_START},(_,i)=>`<div class="time-cell">${((CAL_START+i+11)%12+1)} ${CAL_START+i<12?'AM':'PM'}</div>`).join('') + `</div>`;

  days.forEach(dt=>{
    const isToday = dt.toDateString()===now.toDateString();
    const dayTasks = mine.filter(t=> t.due && t.due.toDateString()===dt.toDateString() && !isOverdue(t));
    let cells = '';
    dayTasks.forEach(t=>{
      const h = t.due.getHours()+t.due.getMinutes()/60;
      const top = Math.max(0, Math.min(CAL_END-CAL_START-1, h-CAL_START)) * 46;
      cells += `<div class="cal-task ${t.status==='Done'?'done':''}" style="top:${top+2}px;height:44px;border-left-color:${teamColor(t.team)}" data-task="${t.id}" title="${esc(t.title)}">
        <div class="ct-t">${esc(t.title)}</div>
        <div class="ct-m">${fmtT(t.due)}${(isHead()||isAdmin())&&t.assignee? ' · '+initials(t.assignee):''}</div></div>`;
    });
    if(isToday){
      const nh = now.getHours()+now.getMinutes()/60;
      if(nh>=CAL_START && nh<=CAL_END) cells += `<div class="now-line" style="top:${(nh-CAL_START)*46}px"></div>`;
    }
    html += `<div class="day-col ${isToday?'today':''}" data-date="${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}" style="height:${(CAL_END-CAL_START)*46}px">${cells}</div>`;
  });
  html += `</div></div><div class="cal-hint">Drag any block to another day or time slot — the due date updates in the master sheet and alerts go out by email.</div>`;
  return html;
}

let drag = null;
function bindCalendarDrag(){
  document.querySelectorAll('.cal-task[data-task]').forEach(el=>{
    const t = state.tasks.find(x=>x.id===el.dataset.task);
    const mayDrag = t && (canManage(t) || t.assignee===state.me.name || isMyRequest(t)) && !isClosed(t);
    el.style.cursor = mayDrag ? 'grab' : 'pointer';
    el.addEventListener('pointerdown', e=>{
      if(e.button!==0) return;
      drag = { id: el.dataset.task, sx:e.clientX, sy:e.clientY, started:false, el, mayDrag };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e=>{
      if(!drag || drag.el!==el || !drag.mayDrag) return;
      if(!drag.started){
        if(Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) < 6) return;
        drag.started = true;
        drag.ghost = el.cloneNode(true);
        drag.ghost.classList.add('drag-ghost');
        drag.ghost.style.position='fixed';
        document.body.appendChild(drag.ghost);
        el.style.opacity='.35';
      }
      drag.ghost.style.left = (e.clientX-90)+'px';
      drag.ghost.style.top = (e.clientY-20)+'px';
      document.querySelectorAll('.day-col').forEach(c=>c.classList.remove('droptarget'));
      const col = dayColAt(e.clientX,e.clientY);
      if(col) col.classList.add('droptarget');
    });
    el.addEventListener('pointerup', async e=>{
      if(!drag || drag.el!==el) return;
      const wasDrag = drag.started;
      if(drag.ghost) drag.ghost.remove();
      el.style.opacity='';
      document.querySelectorAll('.day-col').forEach(c=>c.classList.remove('droptarget'));
      const id = drag.id; drag = null;
      if(!wasDrag){ openTaskModal(id); return; }
      const col = dayColAt(e.clientX,e.clientY);
      if(!col) return;
      const rect = col.getBoundingClientRect();
      let hours = CAL_START + (e.clientY-rect.top)/46;
      hours = Math.max(CAL_START, Math.min(CAL_END-0.5, Math.round(hours*2)/2));
      const [Y,M,D] = col.dataset.date.split('-').map(Number);
      const dueDate = `${Y}-${String(M+1).padStart(2,'0')}-${String(D).padStart(2,'0')}`;
      const dueTime = `${String(Math.floor(hours)).padStart(2,'0')}:${String(Math.round((hours%1)*60)).padStart(2,'0')}`;
      try{
        setSync('busy','SAVING…');
        const j = await api('updateTask', { id, patch:{ dueDate, dueTime } });
        upsert(j.task); state.lastSync=new Date(); setSync('');
        renderAll();
        toast(`<b>${id}</b> rescheduled to ${esc(fmtDT(parseTask(j.task).due))}${j.info? ' · '+esc(j.info):''}`);
      }catch(err){
        setSync('off','OFFLINE'); renderAll();
        toast(`Could not reschedule <b>${id}</b> — ${esc(err.message)}`, true);
      }
    });
  });
}
function dayColAt(x,y){
  return document.elementsFromPoint(x,y).find(el=>el.classList && el.classList.contains('day-col')) || null;
}

/* ── reports ── */
function viewReportsCharts(){
  const now = new Date();
  const scoped = isAdmin()? state.roster.filter(m=>m.role!=='Super Admin')
    : isHead()? state.roster.filter(m=>m.team===state.me.team && m.role!=='Super Admin')
    : [state.me];
  if(!scoped.length) return `<div class="panel"><div class="empty">Add members to the Roster to see reports.</div></div>`;
  if(!reportSubject || !scoped.find(m=>m.name===reportSubject)) reportSubject = scoped[0].name;
  const subj = scoped.find(m=>m.name===reportSubject);
  const tt = state.tasks.filter(t=>t.assignee===subj.name);
  const done30 = tt.filter(t=>t.completed && (now-t.completed)<30*DAY);
  const onTime = done30.filter(t=>t.due && t.completed<=t.due);
  const open = tt.filter(t=>!isClosed(t));
  const withCreated = done30.filter(t=>t.created);
  const turn = withCreated.length? (withCreated.reduce((s,t)=>s+(t.completed-t.created),0)/withCreated.length/DAY).toFixed(1) : '—';
  const revs = done30.reduce((s,t)=>s+(t.revisions||0),0);

  const weeks = Array.from({length:6},(_,i)=>{
    const from = new Date(now-((6-i)*7)*DAY), to = new Date(now-((5-i)*7)*DAY);
    return { lbl:'W'+(i+1), n: tt.filter(t=>t.completed && t.completed>=from && t.completed<to).length };
  });
  const maxW = Math.max(1,...weeks.map(w=>w.n));
  const inkC = dark()? '#f2f0eb' : '#1b1b1b';
  const mutC = dark()? '#8f8d86' : '#8a867c';
  const bars = weeks.map((w,i)=>{
    const h = Math.round(90*w.n/maxW);
    return `<g><rect x="${20+i*56}" y="${110-h}" width="34" height="${h}" rx="6" fill="${teamColor(subj.team)}" opacity=".9"/><text x="${37+i*56}" y="126" text-anchor="middle" font-size="10" fill="${mutC}">${w.lbl}</text><text x="${37+i*56}" y="${104-h}" text-anchor="middle" font-size="11" font-weight="700" fill="${inkC}">${w.n||''}</text></g>`;
  }).join('');
  const pct = done30.length? onTime.length/done30.length : 0;
  const ang = pct*2*Math.PI;
  const lx = 70+55*Math.sin(ang), ly = 70-55*Math.cos(ang);
  const okC = dark()? '#8f8d86' : '#6f6b62';
  const donut = done30.length? `<path d="M70 15 A55 55 0 ${ang>Math.PI?1:0} 1 ${lx} ${ly}" fill="none" stroke="${okC}" stroke-width="16" stroke-linecap="round"/>` : '';
  const accC = dark()? '#f06a38' : '#eb5b2d';

  let html = `<div class="rep-head">
    <select onchange="reportSubject=this.value; renderContent()">${scoped.map(m=>`<option ${m.name===reportSubject?'selected':''}>${esc(m.name)}</option>`).join('')}</select>
    <span class="role-pill">${esc(roleLabel(subj))}</span>
    <button class="ghostbtn" style="margin-left:auto" onclick="window.print()">🖨 Print / save as PDF</button>
  </div>
  <div class="panel" style="display:flex;gap:14px;align-items:center">${av(subj.name,46)}
    <div><div class="dotf" style="font-size:20px;letter-spacing:.06em;text-transform:uppercase">${esc(subj.name)}</div>
    <div style="color:var(--muted);font-size:11.5px">Performance report · last 30 days · generated ${fmtD(now)} · live from the master sheet</div></div></div>
  <div class="stat-tiles">
    <div class="kpi"><div class="lbl">Completed (30d)</div><div class="n">${done30.length}</div></div>
    <div class="kpi"><div class="lbl">On time</div><div class="n">${done30.length? Math.round(pct*100)+'%':'—'}</div></div>
    <div class="kpi"><div class="lbl">Avg turnaround</div><div class="n">${turn}</div><div class="cap">days</div></div>
    <div class="kpi"><div class="lbl">Revision rounds</div><div class="n">${revs}</div></div>
    <div class="kpi ${open.filter(isOverdue).length?'alert':''}"><div class="lbl">Open now</div><div class="n">${open.length}</div><div class="cap ${open.filter(isOverdue).length?'hot':''}">${open.filter(isOverdue).length? open.filter(isOverdue).length+' overdue':'—'}</div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h3>Tasks completed per week</h3><svg viewBox="0 0 356 132" width="100%" height="150">${bars}</svg></div>
    <div class="panel"><h3>On-time vs late (30d)</h3><div style="display:flex;gap:18px;align-items:center">
      <svg viewBox="0 0 140 140" width="120" height="120"><circle cx="70" cy="70" r="55" fill="none" stroke="${done30.length?accC:'var(--soft)'}" stroke-width="16"/>${donut}<text x="70" y="78" text-anchor="middle" font-size="24" font-weight="700" fill="${inkC}" font-family="Doto">${done30.length?Math.round(pct*100)+'%':'—'}</text></svg>
      <div style="font-size:12.5px;line-height:2"><span class="lg-dot" style="background:${okC}"></span>On time — ${onTime.length}<br><span class="lg-dot" style="background:${accC}"></span>Late — ${done30.length-onTime.length}</div>
    </div></div>
  </div>`;

  /* was: completed-only, hard-wired to 30 days and blind to the period picker.
     Now the same panel the team report uses — open work included, period-aware,
     and printable. */
  html += personLogHtml_(subj.name);
  return html;
}

/* ═══════════ MODALS ═══════════ */
/* v5 (R4 fix): list answers carry only a desc/notes PREVIEW — fetch the full
   text lazily the moment the task is opened, then re-render in place. */
function hydrateTask_(t){
  if(!(t.descMore || t.notesMore) || t.__hydrating) return;
  t.__hydrating = true;
  api('taskDetail', { id: t.id }).then(j => {
    if(!j.task) return;
    j.task.descMore = false; j.task.notesMore = false;
    upsert(j.task);
    const h2 = document.querySelector('#overlay .modal h2');
    if(h2 && h2.textContent.indexOf(t.id) === 0) openTaskModal(t.id);
  }).catch(()=>{}).finally(()=>{ t.__hydrating = false; });
}

function openTaskModal(id){
  const t = state.tasks.find(x=>x.id===id); if(!t) return;
  hydrateTask_(t);
  const manage = canManage(t);
  const mineTask = t.assignee===state.me.name;
  const myReq = isMyRequest(t);
  const memberStatuses = STATUSES.filter(s=>s!=='Done');
  const od = isOverdue(t);
  const dd = t.dueDate || '', dt = t.dueTime || '18:00';
  $('#overlay').innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2>${t.id} ${pchip(t.priority)} ${schip(t)}</h2>
    <div class="msub">${esc(t.title)} · ${tdot(t.team)}${esc(t.team)} · requested by ${esc(t.requester)}${t.created? ' · created '+fmtD(t.created):''}${t.revisions? ' · '+t.revisions+' revision round'+(t.revisions>1?'s':''):''}${t.qcRounds? ' · '+t.qcRounds+' QC round'+(t.qcRounds>1?'s':''):''}${t.startedAt? ' · started '+fmtD(t.startedAt):''}${hasFlagC(t,'over-limit')? ' · <b style="color:var(--accent)">⚠ over the revision limit</b>':''}${t.renewedFrom? ' · renewal of '+esc(t.renewedFrom):''}</div>
    ${od? `<div class="od-strip" style="margin-bottom:14px"><span class="od-dot"></span><b>Overdue since ${fmtDT(t.due)}</b> — email alerts repeat until it's done.</div>`:''}
    ${t.briefPending? `<div class="od-strip" style="margin-bottom:14px"><span class="od-dot"></span><b>Brief was updated mid-work</b>${mineTask? ` <button class="btn btn-p" style="margin-left:10px;padding:6px 12px" onclick="acceptBriefClick('${t.id}', this)">Accept updated brief</button>` : ' — waiting for '+esc(t.assignee||'the assignee')+' to accept'}</div>`:''}
    ${t.desc? `<div class="msub" style="background:var(--soft);border-radius:10px;padding:10px 12px">${esc(t.desc)}</div>`:''}
    <div class="fgrid">
      <div class="field"><label>Assigned to</label>
        ${manage? `<select id="m-assignee"><option value="">— unassigned —</option>${t.assignee && !state.roster.some(m=>m.team===t.team&&m.role!=='Super Admin'&&m.name===t.assignee)? `<option selected>${esc(t.assignee)}</option>`:''}${state.roster.filter(m=>m.team===t.team&&m.role!=='Super Admin').map(m=>`<option ${t.assignee===m.name?'selected':''}>${esc(m.name)}</option>`).join('')}</select>`
        : `<input value="${esc(t.assignee||'unassigned')}" disabled>`}</div>
      <div class="field"><label>Priority</label>
        ${(manage||myReq)? `<select id="m-priority">${PRIORITIES.map(p=>`<option ${t.priority===p?'selected':''}>${p}</option>`).join('')}</select>` : `<input value="${esc(t.priority)}" disabled>`}</div>
      <div class="field"><label>Due date</label>${(manage||mineTask||(myReq&&!isClosed(t)))? `<input type="date" id="m-due" value="${dd}">` : `<input value="${fmtD(t.due)}" disabled>`}</div>
      <div class="field"><label>Due time <span style="font-weight:400;text-transform:none;letter-spacing:0">· automatic</span></label><input value="${fmtT(t.due) || 'set by the system'}" disabled></div>
      <div class="field"><label>Started ${manage? '<span style="font-weight:400;text-transform:none;letter-spacing:0">· heads can backdate (logged)</span>':''}</label>${manage? `<input type="datetime-local" id="m-started" value="${t.startedAt? toLocalDT(t.startedAt):''}">` : `<input value="${t.startedAt? fmtD(t.startedAt)+' · '+fmtT(t.startedAt) : '— press ▶ Start work'}" disabled>`}</div>
      <div class="field"><label>Status</label>
        ${(manage||mineTask) && !isAssigner()? `<select id="m-status">${((manage?STATUSES:memberStatuses).indexOf(t.status)===-1?[t.status]:[]).concat(manage?STATUSES:memberStatuses).map(s=>`<option ${t.status===s?'selected':''}>${s}</option>`).join('')}</select>${!manage? `<div style="font-size:10px;color:var(--muted);margin-top:3px">Your head marks it Done after review.</div>`:''}` : `<input value="${esc(t.status)}" disabled>`}</div>
      <div class="field"><label>Brief / asset link</label>${(manage||myReq)? `<input id="m-brief" value="${esc(t.brief)}" placeholder="drive.google.com/…">` : (t.brief? `<div style="padding:8px 0"><a href="${esc(t.brief.indexOf('http')===0?t.brief:'https://'+t.brief)}" target="_blank" rel="noopener">Open brief ↗</a></div>` : `<input value="—" disabled>`)}</div>
      <div class="field f-full"><label>Deliverable link</label><div style="display:flex;gap:8px"><input id="m-deliverable" value="${esc(t.deliverable)}" ${(manage||mineTask)?'':'disabled'} placeholder="Paste the final file link here" style="flex:1">${(manage||mineTask)&&canDriveUpload()? `<button class="btn btn-g" style="flex:none" onclick="pickUpload('${t.id}')" title="Upload the file to your own Google Drive — the link fills in by itself">⬆ Upload</button>`:''}</div></div>
      <div class="field f-full"><label>Notes</label><textarea id="m-notes" rows="2" ${(manage||mineTask)?'':'disabled'}>${esc(t.notes)}</textarea></div>
    </div>
    <div class="modal-actions">
      ${(manage || (myReq && t.status==='New' && !t.startedAt))? `<button class="btn btn-danger" style="margin-right:auto" onclick="deleteTaskClick('${t.id}', this)">🗑 Delete</button>`:''}
      ${(mineTask||manage||(state.me && state.me.team===t.team && !t.assignee && !isAssigner())) && (t.status==='New' || t.status==='On Hold' || (t.status==='In Progress' && !t.startedAt))? `<button class="btn btn-p" onclick="startTaskClick('${t.id}', this)">${!t.assignee && !mineTask? '▶ Start & take this task' : (t.status==='On Hold'? '▶ Resume work' : '▶ Start work')}</button>`:''}
      ${(mineTask||manage) && t.status==='Revisions'? `<button class="btn btn-p" onclick="acceptChangesClick('${t.id}', this)">▶ Accept & start fixes</button>`:''}
      ${(mineTask||manage) && t.status==='In Progress'? `<button class="btn btn-g" onclick="holdTaskClick('${t.id}', this)">⏸ Hold</button>`:''}
      ${manage && t.status==='In Review' && t.stage!=='Assigner'? `<button class="btn btn-ok" onclick="qcPassClick('${t.id}', this)">✓ Pass QC → requester</button>`:''}
      ${(mineTask||manage) && hasFlagC(t,'auto-done')? `<button class="btn btn-warn" onclick="renewTaskClick('${t.id}', this)">↻ Renew as new task</button>`:''}
      <button class="btn btn-g" onclick="openReview('${t.id}')">🎬 Review</button>
      ${(manage || isMyRequest(t)) && !isClosed(t)? `<button class="btn btn-warn" onclick="rejectTaskClick('${t.id}', this)">✗ Reject</button>`:''}
      ${canDecide(t) && t.status==='In Review'? `<button class="btn btn-ok" onclick="quickStatus('${t.id}','Done',this)">✓ Approve → Done</button><button class="btn btn-warn" onclick="quickStatus('${t.id}','Revisions',this)">↺ Request revisions</button>`:''}
      <button class="btn btn-g" onclick="closeModal()">Close</button>
      ${(manage||mineTask||myReq)? `<button class="btn btn-p" id="save-btn" onclick="saveTask('${t.id}',this)">Save changes</button>`:''}
    </div></div>`;
  $('#overlay').classList.add('open');
}

async function saveTask(id, btn){
  const t = state.tasks.find(x=>x.id===id);
  const manage = canManage(t);
  const g = i => document.getElementById(i);
  const patch = {};
  if(manage){
    if(g('m-assignee') && g('m-assignee').value !== t.assignee) patch.assignee = g('m-assignee').value;
    if(g('m-started') && g('m-started').value && g('m-started').value !== (t.startedAt? toLocalDT(t.startedAt):'')) patch.startedAt = g('m-started').value;
  }
  if(manage || isMyRequest(t)){
    if(g('m-priority') && g('m-priority').value !== t.priority) patch.priority = g('m-priority').value;
    if(g('m-brief') && g('m-brief').value !== t.brief) patch.brief = g('m-brief').value;
  }
  if(g('m-due') && g('m-due').value && g('m-due').value !== t.dueDate){
    patch.dueDate = g('m-due').value; patch.dueTime = t.dueTime || '18:00';
  }
  if(g('m-status') && !isAssigner() && g('m-status').value !== t.status) patch.status = g('m-status').value;
  if(g('m-deliverable') && g('m-deliverable').value !== t.deliverable) patch.deliverable = g('m-deliverable').value;
  if(g('m-notes') && g('m-notes').value !== t.notes) patch.notes = g('m-notes').value;
  if(patch.status==='In Review' && !t.startedAt && !patch.startedAt){
    toast('Press <b>▶ Start work</b> first — it stamps the start time'+(manage? ', or type the real start time in the <b>Started</b> field and save.' : ', then submit for review.'), true);
    return;
  }
  if(!Object.keys(patch).length){ closeModal(); return; }
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try{
    setSync('busy','SAVING…');
    const j = await api('updateTask', { id, patch });
    upsert(j.task); state.lastSync=new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${id}</b> saved to the master sheet${j.info? ' · '+esc(j.info):''}`);
  }catch(err){
    if(btn){ btn.disabled=false; btn.textContent='Save changes'; }
    setSync('off','OFFLINE');
    toast(`Could not save <b>${id}</b> — ${esc(err.message)}`, true);
  }
}

async function quickStatus(id, status, btn){
  if(btn){ btn.disabled = true; }
  try{
    setSync('busy','SAVING…');
    const j = await api('updateTask', { id, patch:{ status } });
    upsert(j.task); state.lastSync=new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${id}</b> → ${status}${j.info? ' · '+esc(j.info):''}`);
  }catch(err){
    if(btn) btn.disabled = false;
    setSync('off','OFFLINE');
    toast(`Could not update <b>${id}</b> — ${esc(err.message)}`, true);
  }
}

async function deleteTaskClick(id, btn){
  if(!btn.dataset.armed){
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = '⚠ Click again to delete';
    setTimeout(()=>{ if(btn && btn.dataset){ btn.dataset.armed=''; btn.classList.remove('armed'); btn.textContent='🗑 Delete'; } }, 4000);
    return;
  }
  btn.disabled = true;
  try{
    setSync('busy','DELETING…');
    await api('deleteTask', { id });
    state.tasks = state.tasks.filter(x=>x.id!==id);
    state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${id}</b> deleted — a copy was kept in the sheet's Archive tab`);
  }catch(err){
    btn.disabled = false;
    setSync('off','OFFLINE');
    toast(`Could not delete <b>${id}</b> — ${esc(err.message)}`, true);
  }
}

async function assignTask(id, name){
  if(!name) return;
  try{
    setSync('busy','SAVING…');
    const j = await api('updateTask', { id, patch:{ assignee: name } });
    upsert(j.task); state.lastSync=new Date(); setSync('');
    renderAll();
    toast(`<b>${id}</b> assigned to ${esc(name)}${j.info? ' · '+esc(j.info):''}`);
  }catch(err){
    setSync('off','OFFLINE'); renderAll();
    toast(`Could not assign <b>${id}</b> — ${esc(err.message)}`, true);
  }
}

function openNewTaskModal(preProject){
  closeAddPill();
  const dflt = new Date(Date.now()+2*DAY);
  /* The campaign list is normally already loaded; fetch it quietly if the
     dialog is the first thing opened after a cold start. */
  if(!projLoaded && !projLoading) loadProjects(false);
  const pre = typeof preProject === 'string' ? preProject : '';
  const canProject = isHead() || isAdmin() || isAssigner();
  $('#overlay').innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2>＋ NEW TASK</h2><div class="msub">Anyone can add a task — it goes straight into the master sheet. Leave "Assign to" empty and the team head will allocate it.</div>
    <div class="fgrid">
      <div class="field"><label>Team</label><select id="n-team">${state.teams.map(x=>`<option>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label>Priority</label><select id="n-priority"><option>Medium</option><option>Urgent</option><option>High</option><option>Low</option></select></div>
      <div class="field f-full"><label>Task title</label><input id="n-title" placeholder="e.g. Instagram carousel — monsoon offer"></div>
      <div class="field f-full"><label>Description / brief</label><textarea id="n-desc" rows="2" placeholder="What exactly is needed?"></textarea></div>
      <div class="field"><label>Due date</label><input type="date" id="n-due" value="${dflt.getFullYear()}-${String(dflt.getMonth()+1).padStart(2,'0')}-${String(dflt.getDate()).padStart(2,'0')}"></div>

      <div class="field"><label>Assign to (optional)</label><select id="n-assignee"><option value="">Let the team head decide</option>${state.roster.filter(m=>m.role!=='Super Admin').map(m=>`<option value="${esc(m.name)}" data-team="${esc(m.team)}">${esc(m.name)} — ${esc(m.team)}</option>`).join('')}</select></div>
      <div class="field"><label>Brief / asset link</label><input id="n-brief" placeholder="drive.google.com/…"></div>
      <div class="field f-full"><label>Campaign <span style="font-weight:400;text-transform:none;letter-spacing:0">· optional</span></label>
        <div style="display:flex;gap:8px">
          <select id="n-project" style="flex:1"><option value="">— none —</option>${(projects||[]).map(p=>`<option ${pre===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}${pre && !(projects||[]).some(p=>p.name===pre) ? `<option selected>${esc(pre)}</option>` : ''}</select>
          ${canProject ? `<button class="btn btn-g" style="flex:none" onclick="toggleInlineProject()" title="Start a new campaign without leaving this box">＋ New</button>` : ''}
        </div>
        <div id="np-inline" style="display:none;margin-top:8px;gap:8px">
          <div style="display:flex;gap:8px">
            <input id="np-inline-name" placeholder="New campaign name" maxlength="80" style="flex:1">
            <button class="btn btn-p" style="flex:none" onclick="createProject(true)">Create</button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-g" onclick="closeModal()">Cancel</button>
      <button class="btn" id="create-again-btn" onclick="createTask(this,'again')" title="Save this one and keep the box open for the next">Save &amp; add another</button>
      ${canStartOwn_() ? `<button class="btn" id="create-start-btn" onclick="createTask(this,'start')" title="Save it and start the clock now">Save &amp; start work</button>` : ''}
      <button class="btn btn-p" id="create-btn" onclick="createTask(this)">Save</button>
    </div></div>`;
  $('#overlay').classList.add('open');
}
function toggleInlineProject(){
  const box = document.getElementById('np-inline'); if(!box) return;
  const on = box.style.display === 'none';
  box.style.display = on ? 'block' : 'none';
  if(on){ const i = document.getElementById('np-inline-name'); if(i) i.focus(); }
}

async function createTask(btn, mode){
  const g = i => document.getElementById(i);
  const title = g('n-title').value.trim();
  if(!title){ toast('Give the task a title first.', true); return; }
  if(!g('n-due').value){ toast('Pick a due date.', true); return; }
  const sel = g('n-assignee');
  const assignee = sel.value;
  const team = assignee ? sel.options[sel.selectedIndex].dataset.team : g('n-team').value;
  const label0 = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try{
    setSync('busy','SAVING…');
    const j = await api('createTask', {
      team, assignee, title, desc: g('n-desc').value, brief: g('n-brief').value,
      project: (g('n-project')||{}).value || '',
      priority: g('n-priority').value, dueDate: g('n-due').value, dueTime: '18:00',
    });
    upsert(j.task); state.lastSync=new Date(); setSync('');
    let extra = '';
    /* "Save & start work": stamp the start time immediately so the person
       doesn't have to reopen the task just to press Start. */
    if(mode === 'start'){
      try {
        const s2 = await api('startTask', { id: j.task.id });
        upsert(s2.task);
        extra = ' · started';
      } catch(e){ toast('Created, but could not start it — ' + esc(e.message), true); }
    }
    toast(`<b>${j.task.id}</b> created${extra}${j.info? ' · '+esc(j.info):''}`);
    if(mode === 'again'){
      /* keep team, priority and due date — the fields people repeat — and
         clear the ones that describe this particular task */
      ['n-title','n-desc','n-brief'].forEach(id=>{ const el=g(id); if(el) el.value=''; });
      renderAll();
      const t0 = g('n-title'); if(t0) t0.focus();
      if(btn){ btn.disabled=false; btn.textContent=label0; }
      return;
    }
    closeModal(); renderAll();
  }catch(err){
    if(btn){ btn.disabled=false; btn.textContent=label0 || 'Save'; }
    setSync('off','OFFLINE');
    toast('Could not create the task — '+esc(err.message), true);
  }
}
function closeModal(){ $('#overlay').classList.remove('open'); $('#overlay').innerHTML=''; }



/* ═══════════ DRIVE AUTO-UPLOAD (v3.2) ═══════════ */
const UPL_CHUNK = 8 * 1024 * 1024;   // 8 MB — a multiple of 256 KiB, as Drive requires
let upl = { busy:false, name:'', pct:0, taskId:null, cancel:false };
let gToken = { token:'', exp:0 };
let gTokenClient = null;

/* Upload needs a Client ID (Config ▸ GOOGLE_CLIENT_ID) and the desktop app
   (Google only allows registered localhost origins). */
/* v5: uploads need nothing from this PC — CreativeFlow holds the Drive
   authorisation server-side, so this works in every browser, on phones, in the
   desktop app and on the ?page=app fallback alike. */
function canDriveUpload(){ return true; }
function uplCentral(){ return state.uploadMode === 'central' && !!state.storageAccount; }
let gAcctVerified = false;
/* v5: the browser-side Google sign-in used for uploads is GONE.
   driveWhoAmI_ / ensureStudioAccount_ / loadGsi / driveToken / gFetch /
   ensureFolder_ / driveFolder all existed so each PC could authenticate to
   Drive itself. CreativeFlow now holds that authorisation server-side and
   issues a one-time upload session instead (see startUpload + server/upload.js),
   which is why uploads work on phones, on the fallback link and in the desktop
   app without anyone signing into Google. Do not reintroduce them. */

function pickUpload(taskId){
  if(upl.busy){ toast('One upload at a time — <b>'+esc(upl.name)+'</b> is still at '+upl.pct+'%.', true); return; }
  const inp = document.getElementById('upl-file');
  inp.value = '';
  inp.onchange = ()=>{ if(inp.files && inp.files[0]) startUpload(taskId, inp.files[0]); };
  inp.click();
}

async function startUpload(taskId, file){
  if(upl.busy) return;
  if(!file.size){ toast('That file is empty.', true); return; }
  upl = { busy:true, name:file.name, pct:0, taskId, cancel:false };
  renderUplCard('Preparing the upload…');
  try{
    /* v5: NO Google sign-in on this PC. CreativeFlow itself is authorised, so
       it opens the Drive session for us and we push the bytes straight to
       Google with the one-time session URL it returns. */
    const ticket = await api('uploadTicket', {
      taskId, name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      origin: location.origin,   /* Drive needs this to CORS-enable the session */
    });
    const session = ticket.uploadUrl;
    if(!session) throw new Error('CreativeFlow could not open a Drive upload session.');

    /* push chunks — the session URL survives wifi drops, we just resume */
    let sent = 0, fileJson = null, retries = 0;
    while(sent < file.size){
      if(upl.cancel) throw new Error('cancelled');
      const end = Math.min(sent + UPL_CHUNK, file.size);
      let r;
      try{
        r = await fetch(session, {
          method:'PUT',
          headers:{ 'Content-Range': 'bytes '+sent+'-'+(end-1)+'/'+file.size },
          body: file.slice(sent, end),
        });
      }catch(netErr){
        if(++retries > 8) throw new Error('The connection kept dropping — try again when the network is steadier.');
        renderUplCard('Connection dropped — retrying ('+retries+')…');
        await new Promise(z=>setTimeout(z, Math.min(30000, 1000 * Math.pow(2, retries))));
        sent = await uplStatus(session, file.size, sent);
        continue;
      }
      retries = 0;
      if(r.status === 308){
        const range = r.headers.get('Range');
        sent = range ? (parseInt(range.split('-')[1], 10) + 1) : end;
      } else if(r.ok){
        fileJson = await r.json(); sent = file.size;
      } else {
        throw new Error('Drive rejected part of the upload (HTTP '+r.status+').');
      }
      upl.pct = Math.min(99, Math.round(sent / file.size * 100));
      renderUplCard();
    }
    if(!fileJson || !fileJson.id) throw new Error('Upload ended without a file id from Drive.');

    /* the server shares it and attaches it — it owns the Drive permissions */
    renderUplCard('Linking it to the task…');
    const j = await api('uploadFinish', { taskId, fileId: fileJson.id });
    if(j.warning) toast(esc(j.warning), true);
    upsert(j.task); state.lastSync = new Date(); renderAll();
    upl.busy = false; upl.pct = 100;
    renderUplCard();
    setTimeout(()=>{ if(!upl.busy){ const c = document.getElementById('upl-card'); if(c) c.innerHTML=''; } }, 6000);
    toast('<b>'+esc(file.name)+'</b> is in the studio Drive — the link saved itself to <b>'+esc(taskId)+'</b>.');
    const mdel = document.getElementById('m-deliverable'); if(mdel) mdel.value = j.link;
    if(rv.open && !rv.guest && rv.taskId === taskId){ rv.viewAs=''; rv.player=null; rv.ytFailed=false; rv.form=null; renderReview(); }
  }catch(err){
    upl.busy = false;
    const c = document.getElementById('upl-card'); if(c) c.innerHTML = '';
    if(String(err.message)==='cancelled') toast('Upload cancelled.');
    else toast('Upload failed — '+esc(err.message), true);
  }
}

async function uplStatus(session, total, fallback){
  try{
    const r = await fetch(session, { method:'PUT', headers:{ 'Content-Range': 'bytes */'+total } });
    if(r.status === 308){
      const range = r.headers.get('Range');
      return range ? (parseInt(range.split('-')[1], 10) + 1) : 0;
    }
  }catch(e){}
  return fallback;
}
function cancelUpload(){ if(upl.busy) upl.cancel = true; }

function renderUplCard(label){
  const c = document.getElementById('upl-card'); if(!c) return;
  if(!upl.busy && upl.pct === 100){
    c.innerHTML = `<div class="upl"><div class="upl-t">✓ <b>${esc(upl.name)}</b></div><div class="upl-bar"><i style="width:100%"></i></div><div class="upl-m">Uploaded — link saved to ${esc(upl.taskId)} · ${uplCentral()? 'studio Drive ('+esc(state.storageAccount)+')' : 'your Drive'} ▸ CreativeFlow/${new Date().toISOString().slice(0,7)}</div></div>`;
    return;
  }
  if(!upl.busy){ c.innerHTML = ''; return; }
  c.innerHTML = `<div class="upl">
    <div class="upl-t">⬆ <b>${esc(upl.name)}</b><button class="upl-x" onclick="cancelUpload()" title="Cancel upload">✕</button></div>
    <div class="upl-bar"><i style="width:${upl.pct}%"></i></div>
    <div class="upl-m">${label ? esc(label) : upl.pct + '% — keep this window open until it finishes'}</div></div>`;
}

window.addEventListener('beforeunload', e => {
  if(upl.busy){ e.preventDefault(); e.returnValue = 'A Drive upload is still running — closing now abandons it.'; }
});

/* ═══════════ REVIEW ROOM (v3.1) ═══════════ */
let rv = {
  open:false, guest:false, guestTok:'', guestName: store.get('cf_guest_name') || '',
  taskId:null, gTask:null, items:[], mode:'comment', org:'',
  media:{kind:'none'}, viewAs:'',
  player:null, ytFailed:false, dvvFailed:false,
  form:null, shareOpen:false, shares:[], pollT:null, versions:[], viewVersion:1,
};

function tcStr(s){ s=Math.max(0,Math.round(Number(s)||0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
function parseTc(str){
  const t = String(str||'').trim();
  const m = t.match(/^(\d+):([0-5]?\d)$/);
  if(m) return (+m[1])*60 + (+m[2]);
  if(/^\d+$/.test(t)) return Math.max(0, +t);
  return null;
}
function toLocalDT(d){ const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); }
function rvWhen(iso){
  const d = iso ? new Date(iso) : null;
  if(!d || isNaN(d)) return '';
  return d.toDateString()===new Date().toDateString() ? fmtT(d) : fmtD(d);
}
function rvTask(){ return rv.guest ? rv.gTask : state.tasks.find(x=>x.id===rv.taskId); }
function rvManage(){ const t = rvTask(); return !rv.guest && t && canDecide(t); }
/* Guests on a comment link can ADD pins and markers — they still cannot
   resolve, delete or send changes. That stays with the studio. */
function rvCanAnnotate(){ return rv.guest ? rv.mode === 'comment' : rvManage(); }
function rvMine(t){ return !rv.guest && state.me && (t.assignee===state.me.name || t.requester===state.me.name); }

/* What kind of thing is the deliverable link? */
function detectMedia(t){
  const url = String(t.deliverable||'').trim();
  if(!url) return { kind:'none' };
  const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{6,})/);
  if(yt) return { kind:'yt', id: yt[1] };
  if(/^data:image\//i.test(url)) return { kind:'img', src:url };
  if(/\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(url)) return { kind:'img', src:url };
  const dv = url.match(/\/d\/([-\w]{20,})/) || url.match(/[?&]id=([-\w]{20,})/);
  if(dv){
    const asImg = rv.viewAs ? rv.viewAs==='img' : (String(t.team||'')!=='Video');
    if(asImg) return { kind:'img', src:'https://drive.google.com/thumbnail?id='+dv[1]+'&sz=w2000', drive:true, id:dv[1] };
    /* native <video> = realtime scrubbing + auto-timestamps; needs GOOGLE_API_KEY */
    if(state.googleApiKey && !rv.dvvFailed) return { kind:'dvv', id:dv[1], drive:true };
    return { kind:'dv', id:dv[1], drive:true };
  }
  return { kind:'link', url };
}

async function openReview(taskId){
  const t = state.tasks.find(x=>x.id===taskId);
  if(!t) return;
  closeModal();
  rv.open=true; rv.guest=false; rv.taskId=taskId; rv.items=[]; rv.viewAs='';
  rv.form=null; rv.player=null; rv.ytFailed=false; rv.dvvFailed=false; rv.shareOpen=false; rv.shares=[];
  rv.versions=[]; rv.viewVersion=1;
  renderReview();
  try{
    const j = await api('listReview', { taskId });
    if(!rv.open || rv.taskId!==taskId) return;
    rv.items = j.items || [];
    rv.shares = j.shares || [];
    rv.versions = j.versions || [];
    rv.viewVersion = rv.versions.length ? rv.versions[rv.versions.length-1].v : 1;
    if(rv.versions.length > 1) renderReview();
    else { renderSide(); updatePins(); }
  }catch(err){ toast('Could not load review items — '+esc(err.message), true); }
}
function closeReview(){
  if(rv.guest) return;
  rv.open=false; rv.player=null; rv.form=null; rv.shareOpen=false;
  if(rv.pollT){ clearInterval(rv.pollT); rv.pollT=null; }
  const el = $('#review'); el.classList.remove('open'); el.innerHTML='';
  document.body.style.overflow='';
}

function renderReview(){
  const t = rvTask(); if(!t){ closeReview(); return; }
  const el = $('#review');
  const manage = rvManage();
  const vSel = rv.versions.length ? rv.versions.find(v=>v.v===rv.viewVersion) : null;
  rv.media = detectMedia(vSel && vSel.link ? Object.assign({}, t, { deliverable: vSel.link }) : t);
  el.classList.add('open');
  document.body.style.overflow='hidden';
  el.innerHTML = `
    <div class="rv-top">
      ${rv.guest ? `<div class="rv-org dotf">${esc((rv.org||'CREATIVE').toUpperCase())}<span> · REVIEW</span></div>`
                 : `<button class="btn btn-g" onclick="closeReview()">← Back</button>`}
      <div class="rv-title"><span class="rv-id dotf">${esc(t.id)}</span><span class="rv-name">${esc(t.title)}</span></div>
      <div class="rv-actions">
        ${rv.versions.length>1 ? `<select id="rv-ver" onchange="setViewVersion(this.value)" title="Deliverable versions">${rv.versions.map(v=>`<option value="${v.v}" ${v.v===rv.viewVersion?'selected':''}>v${v.v}${v.expires && new Date(v.expires) < new Date() ? ' ✝ expired' : ''}${v.v===rv.versions[rv.versions.length-1].v ? ' · latest' : ''}</option>`).join('')}</select>`:''}
        ${!rv.guest && rv.media.kind!=='none' && (manage || rvMine(t)) && canDriveUpload() ? `<button class="btn btn-g" onclick="pickUpload('${t.id}')" title="Upload a new file to your own Drive — replaces the deliverable link">⬆ New version</button>`:''}
        ${rv.media.id ? `<a class="btn btn-g" href="https://drive.google.com/file/d/${rv.media.id}/view" target="_blank" rel="noopener" title="Open in Google Drive — full-res download">⤓ Drive</a>`:''}
        ${rv.media.drive && !rv.guest ? `<button class="btn btn-g" onclick="toggleViewAs()">${rv.media.kind==='img' ? '▶ View as video' : '🖼 View as image'}</button>`:''}
        ${manage && t.status==='In Review' && t.stage!=='Assigner' ? `<button class="btn btn-ok" onclick="qcPassClick('${rv.taskId}', this, true)">✓ Pass QC</button>`:''}
        ${manage ? `<button class="btn btn-g" id="rv-share-btn" onclick="toggleShare()">🔗 Share</button>
                    <button class="btn btn-p" id="rv-send" onclick="sendChangesClick(this)"></button>` : ''}
      </div>
    </div>
    <div class="rv-body">
      <div class="rv-media" id="rv-media">${mediaHtml(rv.media, t)}</div>
      <aside class="rv-side">
        <div class="rv-tools" id="rv-tools"></div>
        <div class="rv-scroll" id="rv-scroll"></div>
        <div class="rv-compose" id="rv-compose"></div>
      </aside>
    </div>
    <div class="rv-share-wrap" id="rv-share-wrap" style="display:none"></div>`;
  renderTools(); renderSide(); updatePins(); renderCompose();
  if(rv.media.kind==='yt' && !rv.ytFailed) loadYT(rv.media.id);
}

function toggleViewAs(){
  rv.viewAs = (rv.media && rv.media.kind==='img') ? 'dv' : 'img';
  rv.player = null; rv.ytFailed = false; rv.form = null;
  renderReview();
}

function mediaHtml(m, t){
  if(m.kind==='none'){
    return `<div class="rv-nofile"><div style="font-size:34px;margin-bottom:10px">🎬</div>No deliverable on this task yet.<br>${(rvManage()||rvMine(t)) ? 'Paste the file link in the panel on the right — a YouTube / Drive video or an image.' : 'Once '+esc(t.assignee||'the assignee')+' adds the file link, the review happens right here.'}</div>`;
  }
  if(m.kind==='yt')  return `<div class="ytbox" id="ytbox"><div id="ytp"></div></div>`;
  if(m.kind==='dv')  return `<div class="dvbox"><iframe id="dv-frame" src="https://drive.google.com/file/d/${m.id}/preview" allow="autoplay" allowfullscreen></iframe></div>`;
  if(m.kind==='dvv') return `<div class="dvbox"><video id="dv-vid" controls playsinline preload="metadata" style="width:100%;height:100%;background:#000" src="https://www.googleapis.com/drive/v3/files/${m.id}?alt=media&key=${encodeURIComponent(state.googleApiKey)}" onerror="dvvFail()"></video></div>`;
  if(m.kind==='img') return `<div class="img-wrap" id="img-wrap" onclick="imgClick(event)"><img src="${esc(m.src)}" alt="deliverable" draggable="false" onerror="imgFail()"><div id="pin-layer"></div></div>`;
  return `<div class="rv-nofile"><div style="font-size:34px;margin-bottom:10px">🔗</div>This link isn't a previewable video or image.<br><a href="${esc(m.url)}" target="_blank" rel="noopener">Open the file ↗</a><br><br>You can still add ⏱ time markers manually from the panel.</div>`;
}
function imgFail(){
  const wrap = document.getElementById('img-wrap');
  if(!wrap) return;
  wrap.outerHTML = `<div class="rv-nofile"><div style="font-size:34px;margin-bottom:10px">🖼</div>Couldn't load the image preview${rv.media && rv.media.drive ? ' — make sure the Drive file is shared as “Anyone with the link”.' : '.'}${rv.media && rv.media.drive && !rv.guest ? '<br><button class="btn btn-g" style="margin-top:12px" onclick="toggleViewAs()">Try it as a video instead</button>' : ''}</div>`;
}

function dvvFail(){
  if(rv.dvvFailed) return;
  rv.dvvFailed = true;
  toast('Realtime player couldn\'t stream this file — showing the Drive preview instead (timestamps go manual).');
  renderReview();
}

/* ── YouTube: real player if the API loads, plain embed if not ── */
function loadYT(vid){
  let settled = false;
  const fail = ()=>{ if(settled || !rv.open) return; settled = true; rv.ytFailed = true; ytFallback(vid); };
  const ok = ()=>{
    if(settled || !rv.open) return; settled = true;
    try{
      rv.player = new YT.Player('ytp', { videoId: vid, playerVars:{ rel:0 } });
      renderTools();
    }catch(e){ settled = false; fail(); }
  };
  if(window.YT && window.YT.Player){ ok(); return; }
  const timer = setTimeout(fail, 6000);
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = ()=>{ clearTimeout(timer); if(prev){ try{ prev(); }catch(e){} } ok(); };
  if(!document.getElementById('yt-api')){
    const s = document.createElement('script');
    s.id = 'yt-api'; s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = ()=>{ clearTimeout(timer); fail(); };
    document.head.appendChild(s);
  }
}
function ytFallback(vid){
  const box = document.getElementById('ytbox');
  if(box) box.innerHTML = `<iframe id="yt-plain" src="https://www.youtube.com/embed/${vid}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  renderTools();
}

/* ── side panel ── */
function renderTools(){
  const box = document.getElementById('rv-tools'); if(!box) return;
  const t = rvTask(); if(!t){ box.innerHTML=''; return; }
  /* Guests on a COMMENT link annotate exactly like the studio does — pins on an
     image, timecode markers on a video. Only view-only links stop at reading.
     (This used to return early for every guest, so a comment guest could click
      the image but the note box never appeared: annotation was dead.) */
  const manage = rvCanAnnotate();
  const guestNote = rv.guest
    ? `<div class="hint" style="margin-bottom:8px">You're reviewing as a guest — mark your points straight on the file, or reply at the bottom.</div>` : '';
  if(rv.form){
    /* The name is asked for HERE as well as under the comments: a guest who
       pins before scrolling down would otherwise write the whole note, press
       save, and be told off about a field they cannot see. */
    const needName = rv.guest && !rv.guestName;
    box.innerHTML = `<div class="rv-form">
      <div class="rv-form-h">${rv.form.type==='marker' ? '⏱ CHANGE AT '+tcStr(rv.form.tc) : '📍 PIN AT THE MARKED SPOT'}</div>
      ${needName ? `<input id="rv-form-name" class="guest-name" placeholder="Your name" maxlength="40" style="margin-bottom:6px">` : ''}
      <textarea id="rv-form-text" rows="2" placeholder="What needs to change here?"></textarea>
      <div class="rv-form-a"><button class="btn btn-g" onclick="cancelForm()">Cancel</button><button class="btn btn-p" id="rv-form-save" onclick="saveForm(this)">Add change</button></div></div>`;
    const first = document.getElementById(needName ? 'rv-form-name' : 'rv-form-text');
    if(first) first.focus();
    const ta = document.getElementById('rv-form-text');
    if(ta) ta.addEventListener('keydown', e=>{ if((e.ctrlKey||e.metaKey) && e.key==='Enter') saveForm(document.getElementById('rv-form-save')); });
    return;
  }
  if(rv.media.kind==='none' && rv.guest){
    box.innerHTML = `<div class="hint">There's no file on this task yet — the team will attach it here.</div>`;
    return;
  }
  if(rv.media.kind==='none' && (manage || rvMine(t))){   /* attaching is studio-only */
    if(canDriveUpload()){
      box.innerHTML = `<button class="btn btn-p" style="width:100%" onclick="pickUpload('${t.id}')">⬆ Upload to ${uplCentral()? "studio" : "my"} Drive</button>
        <div class="hint" style="margin:7px 0;text-align:center">${uplCentral()? 'goes to the studio Drive ('+esc(state.storageAccount)+') & links itself' : 'goes to your own Google Drive & links itself'} — or paste a link:</div>
        <div class="rv-tc-row"><input id="rv-del-url" placeholder="YouTube / Drive / image link" style="flex:1;width:auto;text-align:left"><button class="btn btn-g" onclick="saveDeliverable(this)">Attach</button></div>`;
    } else {
      box.innerHTML = `<div class="hint" style="margin-bottom:7px">Attach the deliverable to start the review:</div>
        <div class="rv-tc-row"><input id="rv-del-url" placeholder="YouTube / Drive / image link" style="flex:1;width:auto;text-align:left"><button class="btn btn-p" onclick="saveDeliverable(this)">Attach</button></div>`;
    }
    return;
  }
  if(!manage){
    box.innerHTML = `<div class="hint">${rv.guest ? 'This link is view-only — you can read the changes but not add any.' : rvMine(t) ? 'Your head marks the changes on the file — fix them, upload a new version, and reply below.' : 'Change markers are added by the team head. The comments below are open to everyone on the task.'}</div>`;
    return;
  }
  const k = rv.media.kind;
  if(k==='img'){ box.innerHTML = guestNote + `<div class="hint">🖱 <b>Click anywhere on the image</b> to pin a change exactly where it belongs.</div>`; return; }
  if((k==='yt' && rv.player && !rv.ytFailed) || k==='dvv'){
    box.innerHTML = guestNote + `<button class="btn btn-p" style="width:100%" onclick="addMarkerAtCurrent()">⏱ Add change at current time</button>
      ${k==='dvv'? `<div class="hint" style="margin-top:7px">Pause where the change is needed, then press the button — the timestamp is picked up automatically.</div>`:''}`;
    return;
  }
  if(k==='yt' || k==='dv' || k==='link'){
    box.innerHTML = guestNote + `<div class="rv-tc-row"><input id="rv-tc" placeholder="m:ss" inputmode="numeric"><button class="btn btn-p" style="flex:1" onclick="addMarkerAtCurrent()">⏱ Add change at this time</button></div>
      <div class="hint" style="margin-top:7px">${k==='dv' ? 'Type the time shown in the Drive player (e.g. 1:23).' : k==='yt' ? 'Player still loading — you can type the time meanwhile.' : 'Type the time from your player (e.g. 1:23).'}</div>`;
    return;
  }
  box.innerHTML = guestNote + `<div class="hint">Attach a deliverable link to start marking changes.</div>`;
}

function renderSide(){
  const box = document.getElementById('rv-scroll'); if(!box) return;
  const onV = x => !rv.versions.length || (Number(x.version)||1) === rv.viewVersion;
  const marks = rv.items.filter(x=>x.type!=='comment' && onV(x));
  const pins  = rv.items.filter(x=>x.type==='pin' && onV(x));
  const cms   = rv.items.filter(x=>x.type==='comment');
  const manage = rvManage();          /* resolve / delete — studio only */
  const canAdd = rvCanAnnotate();     /* …but comment guests can still ADD */
  const openN = marks.filter(x=>x.status==='Open').length;
  let h = `<div class="rv-h">CHANGES <span>${marks.length ? openN+' open · '+(marks.length-openN)+' resolved' : 'none yet'}</span></div>`;
  if(!marks.length) h += `<div class="rv-empty">${canAdd ? (rv.media.kind==='img' ? 'Click anywhere on the image to pin the first change.' : 'Use the tool above to mark the first change.') : 'No change markers yet.'}</div>`;
  h += marks.map(i=>{
    const res = i.status==='Resolved';
    const chip = i.type==='marker' ? '⏱ '+tcStr(i.tc||0) : '📍 '+(pins.indexOf(i)+1);
    return `<div class="mk ${res?'res':''}" id="mk-${i.id}">
      <div class="mk-l"><button class="mk-tc" onclick="gotoItem('${i.id}')">${chip}</button></div>
      <div class="mk-b"><div class="mk-t">${esc(i.text)}</div>
        <div class="mk-m">${esc(i.author)}${i.guest?' · guest':''} · ${rvWhen(i.created)}${res?' · <b>resolved</b>':''}</div></div>
      <div class="mk-a">
        ${manage ? `<button class="mk-btn" title="${res?'Reopen':'Mark resolved'}" onclick="resolveMk('${i.id}', ${res?'false':'true'})">${res?'↩':'✓'}</button>`:''}
        ${(manage || guestOwns_(i)) ? `<button class="mk-btn" title="${guestOwns_(i)?'Remove what you added':'Delete'}" onclick="delReview('${i.id}', this)">✕</button>`:''}
      </div></div>`;
  }).join('');
  h += `<div class="rv-h" style="margin-top:14px">COMMENTS <span>${cms.length || ''}</span></div>`;
  if(!cms.length) h += `<div class="rv-empty">${rv.guest ? 'No comments yet.' : 'Open to everyone on this task — and to guests with a comment link.'}</div>`;
  h += cms.map(c=>`<div class="cm">
      <div class="cm-av" style="background:${c.guest || rv.guest ? 'var(--muted)' : memColor(c.author)}">${initials(c.author)}</div>
      <div class="cm-b"><div class="cm-m"><b>${esc(c.author)}</b>${c.guest ? ' <span class="cm-guest">guest</span>' : ''} · ${rvWhen(c.created)}</div>
        <div class="cm-t">${esc(c.text)}</div></div>
      ${((!rv.guest && (manage || (state.me && c.author===state.me.name))) || guestOwns_(c)) ? `<button class="mk-btn" title="${guestOwns_(c)?'Remove your comment':'Delete'}" onclick="delReview('${c.id}', this)">✕</button>` : ''}
    </div>`).join('');
  box.innerHTML = h;
  setSendLabel();
  if(rv.shareOpen) renderShare();
}

function updatePins(){
  const layer = document.getElementById('pin-layer'); if(!layer) return;
  const onV = x => !rv.versions.length || (Number(x.version)||1) === rv.viewVersion;
  const pins = rv.items.filter(x=>x.type==='pin' && onV(x));
  let h = pins.map((p,ix)=>`<div class="pin ${p.status==='Resolved'?'res':''}" data-id="${p.id}" style="left:${p.x}%;top:${p.y}%" title="${esc(p.text)}" onclick="event.stopPropagation();gotoItem('${p.id}')">${ix+1}</div>`).join('');
  if(rv.form && rv.form.type==='pin') h += `<div class="pin hot" style="left:${rv.form.x}%;top:${rv.form.y}%">＋</div>`;
  layer.innerHTML = h;
}

function renderCompose(){
  const box = document.getElementById('rv-compose'); if(!box) return;
  if(rv.guest && rv.mode!=='comment'){
    box.innerHTML = `<div class="rv-guest-hint">This is a view-only link — ask the team for a comment link if you need to reply here.</div>`;
    return;
  }
  box.innerHTML = `
    ${rv.guest ? `<input id="rv-guest-name" class="guest-name" placeholder="Your name" maxlength="40" value="${esc(rv.guestName)}">` : ''}
    <div class="rv-cm-row">
      <textarea id="rv-cm-text" rows="2" placeholder="${rv.guest ? 'Write your feedback…' : 'Comment for everyone on this task…'}"></textarea>
      <button class="btn btn-p" id="rv-post" onclick="postComment(this)">Post</button>
    </div>`;
  const ta = document.getElementById('rv-cm-text');
  if(ta) ta.addEventListener('keydown', e=>{ if((e.ctrlKey||e.metaKey) && e.key==='Enter') postComment(document.getElementById('rv-post')); });
}

/* ── adding markers / pins / comments ── */
function imgClick(ev){
  if(!rvCanAnnotate()) return;
  const wrap = document.getElementById('img-wrap'); if(!wrap) return;
  const r = wrap.getBoundingClientRect();
  const x = Math.round((ev.clientX - r.left) / r.width * 1000) / 10;
  const y = Math.round((ev.clientY - r.top) / r.height * 1000) / 10;
  if(x<0 || y<0 || x>100 || y>100) return;
  rv.form = { type:'pin', x, y };
  renderTools(); updatePins();
}
function addMarkerAtCurrent(){
  let tc = null;
  const dvv = document.getElementById('dv-vid');
  if(dvv && dvv.readyState > 0 && !isNaN(dvv.currentTime)){
    tc = Math.round(dvv.currentTime);
    try{ dvv.pause(); }catch(e){}
  }
  if(tc==null && rv.player && !rv.ytFailed){
    try{ tc = Math.round(rv.player.getCurrentTime() || 0); rv.player.pauseVideo(); }catch(e){ tc = null; }
  }
  if(tc==null){
    const inp = document.getElementById('rv-tc');
    tc = inp ? parseTc(inp.value) : null;
    if(tc==null){ toast('Type the time as <b>m:ss</b> first — e.g. 1:23.', true); return; }
  }
  rv.form = { type:'marker', tc };
  renderTools();
}
function cancelForm(){ rv.form = null; renderTools(); updatePins(); }
async function saveForm(btn){
  const ta = document.getElementById('rv-form-text');
  const text = ta ? ta.value.trim() : '';
  if(!text){ toast('Describe the change first.', true); return; }
  const f = rv.form; if(!f) return;
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try{
    const base = f.type==='marker'
      ? { type:'marker', tc: f.tc, text, version: rv.viewVersion }
      : { type:'pin', x: f.x, y: f.y, text, version: rv.viewVersion };
    let j;
    if(rv.guest){
      const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      const name = val('rv-form-name') || val('rv-guest-name') || rv.guestName;   /* the field inside the form wins */
      if(!name || name.length < 2){
        toast('Add your name first so the team knows who marked this.', true);
        const n = document.getElementById('rv-form-name') || document.getElementById('rv-guest-name');
        if(n) n.focus();
        if(btn){ btn.disabled=false; btn.textContent='Add change'; }
        return;
      }
      rv.guestName = name; store.set('cf_guest_name', name);
      j = await api('guestComment', Object.assign({ token: rv.guestTok, name }, base));
    } else {
      j = await api('addReview', Object.assign({ taskId: rv.taskId }, base));
    }
    rv.items.push(j.item); rv.form = null;
    renderTools(); renderSide(); updatePins();
  }catch(err){
    if(btn){ btn.disabled = false; btn.textContent = 'Add change'; }
    toast('Could not add the change — '+esc(err.message), true);
  }
}
async function postComment(btn){
  const ta = document.getElementById('rv-cm-text');
  const text = ta ? ta.value.trim() : '';
  if(!text){ toast('Write a comment first.', true); return; }
  if(btn) btn.disabled = true;
  try{
    let j;
    if(rv.guest){
      const nameEl = document.getElementById('rv-guest-name');
      const name = nameEl ? nameEl.value.trim() : '';
      if(name.length < 2){ toast('Enter your name first.', true); if(btn) btn.disabled=false; return; }
      rv.guestName = name; store.set('cf_guest_name', name);
      j = await api('guestComment', { token: rv.guestTok, name, text });
    } else {
      j = await api('addReview', { taskId: rv.taskId, type:'comment', text });
    }
    rv.items.push(j.item);
    if(ta) ta.value = '';
    renderSide();
    const sc = document.getElementById('rv-scroll'); if(sc) sc.scrollTop = sc.scrollHeight;
  }catch(err){ toast('Could not post — '+esc(err.message), true); }
  if(btn) btn.disabled = false;
}

/* ── navigating to a marker ── */
function gotoItem(id){
  const i = rv.items.find(x=>x.id===id); if(!i) return;
  if(i.type==='pin'){
    const p = document.querySelector(`#pin-layer .pin[data-id="${id}"]`);
    if(p){ p.classList.add('hot'); setTimeout(()=>p.classList.remove('hot'), 1600); p.scrollIntoView({block:'nearest', inline:'nearest'}); }
    return;
  }
  const tc = Math.max(0, Math.round(i.tc||0));
  const dvv = document.getElementById('dv-vid');
  if(dvv){ try{ dvv.currentTime = tc; dvv.play().catch(()=>{}); return; }catch(e){} }
  if(rv.media.kind==='yt'){
    if(rv.player && !rv.ytFailed){ try{ rv.player.seekTo(tc, true); rv.player.playVideo(); return; }catch(e){} }
    const f = document.getElementById('yt-plain');
    if(f){ f.src = 'https://www.youtube.com/embed/'+rv.media.id+'?start='+tc+'&autoplay=1'; return; }
  }
  toast('Scrub the player to <b>⏱ '+tcStr(tc)+'</b> — this preview can\'t jump on its own.');
}

/* ── resolve / delete ── */
async function resolveMk(id, resolved){
  try{
    const j = await api('resolveReview', { id, resolved });
    const ix = rv.items.findIndex(x=>x.id===id);
    if(ix > -1) rv.items[ix] = j.item;
    renderSide(); updatePins();
  }catch(err){ toast('Could not update the marker — '+esc(err.message), true); }
}
async function delReview(id, btn){
  if(btn && !btn.dataset.armed){
    btn.dataset.armed = '1'; btn.textContent = 'sure?';
    setTimeout(()=>{ if(btn && btn.dataset){ btn.dataset.armed=''; btn.textContent='✕'; } }, 3000);
    return;
  }
  try{
    if(rv.guest) await api('guestDelete', { token: rv.guestTok, id, name: rv.guestName });
    else await api('deleteReview', { id });
    rv.items = rv.items.filter(x=>x.id!==id);
    renderSide(); updatePins(); renderTools();
  }catch(err){ toast('Could not delete — '+esc(err.message), true); }
}

/* A guest may remove what they themselves just added — a mis-clicked pin or a
   note they want to redo — but nothing of the studio's, and nothing the team
   has already resolved. Matches the server rule in apiGuestDelete_. */
function guestOwns_(i){
  return rv.guest && rv.mode === 'comment' && i.guest && i.status !== 'Resolved' &&
    !!rv.guestName && String(i.author).trim().toLowerCase() === rv.guestName.trim().toLowerCase();
}

/* ── send all open changes → task goes to Revisions + email digest ── */
function setSendLabel(){
  const b = document.getElementById('rv-send'); if(!b) return;
  if(b.dataset.armed) return;
  const n = rv.items.filter(x=>x.type!=='comment' && x.status==='Open').length;
  b.textContent = n ? `Send ${n} change${n>1?'s':''} →` : 'No open changes';
  b.disabled = !n;
}
async function sendChangesClick(btn){
  const openN = rv.items.filter(x=>x.type!=='comment' && x.status==='Open').length;
  if(!openN){ toast('Add at least one change marker first.', true); return; }
  const t = rvTask();
  if(!btn.dataset.armed){
    btn.dataset.armed = '1'; btn.classList.add('armed');
    btn.textContent = 'Really send '+openN+' to '+((t && t.assignee) || 'the team')+'?';
    setTimeout(()=>{ if(btn && btn.dataset && btn.dataset.armed){ btn.dataset.armed=''; btn.classList.remove('armed'); setSendLabel(); } }, 4000);
    return;
  }
  btn.disabled = true; btn.dataset.armed = ''; btn.classList.remove('armed');
  try{
    const j = await api('sendChanges', { taskId: rv.taskId });
    upsert(j.task); state.lastSync = new Date(); renderAll();
    btn.disabled = false; setSendLabel();
    toast(`<b>${esc(rv.taskId)}</b> → Revisions · ${j.count} change${j.count>1?'s':''} emailed to ${esc((j.task && j.task.assignee) || 'the team')}`);
  }catch(err){
    btn.disabled = false; setSendLabel();
    toast('Could not send — '+esc(err.message), true);
  }
}

/* ── attach a deliverable from inside the room ── */
async function saveDeliverable(btn){
  const inp = document.getElementById('rv-del-url');
  const url = inp ? inp.value.trim() : '';
  if(!url){ toast('Paste the file link first.', true); return; }
  if(btn){ btn.disabled = true; btn.textContent = '…'; }
  try{
    const j = await api('updateTask', { id: rv.taskId, patch:{ deliverable: url } });
    upsert(j.task); state.lastSync = new Date(); renderAll();
    rv.viewAs=''; rv.player=null; rv.ytFailed=false;
    renderReview();
  }catch(err){
    if(btn){ btn.disabled = false; btn.textContent = 'Attach'; }
    toast('Could not attach — '+esc(err.message), true);
  }
}

/* ── guest share links ── */
function shareUrl(tok){
  /* Short by design: the hosted app already knows which sheet it belongs to,
     so the long &api= tail is unnecessary. A hash route keeps it shorter still
     and survives static hosting.  →  https://…/creativeflow-app/#/r/AbCd1234
     Old ?review=…&api=… links keep working (see the boot block). */
  const api = state.url || DEFAULT_URL;
  /* Use our own origin whenever this copy of the app can actually serve the
     review route. That excludes Apps-Script-served pages (they can't own a
     URL) and the desktop app (a 127.0.0.1 link is useless to a client) — both
     fall back to ?page=app, which works for guests anywhere. */
  const hosted = !isDesktopApp() && !/googleusercontent\.com$|script\.google\.com$/.test(location.hostname);
  if(hosted){
    const base = location.origin + location.pathname.replace(/index\.html$/, '');
    const sameSheet = cleanUrl_(api) === cleanUrl_(DEFAULT_URL);
    return base + '#/r/' + tok + (sameSheet ? '' : '?api=' + encodeURIComponent(api));
  }
  return api + (api.indexOf('?')>-1 ? '&' : '?') + 'page=app&review=' + tok;
}
function toggleShare(){
  rv.shareOpen = !rv.shareOpen;
  const w = document.getElementById('rv-share-wrap');
  if(w) w.style.display = rv.shareOpen ? 'block' : 'none';
  if(rv.shareOpen) renderShare();
}
function renderShare(){
  const w = document.getElementById('rv-share-wrap'); if(!w) return;
  w.innerHTML = `<div class="rv-share">
    <div class="rv-h">GUEST LINKS <span>no login needed</span></div>
    <div class="rv-share-new">
      <select id="rv-share-mode"><option value="view">View only</option><option value="comment">View + comment</option></select>
      <button class="btn btn-p" onclick="createShareClick(this)">Create link</button>
    </div>
    <input id="rv-share-url" readonly style="display:none" onclick="this.select()">
    <div id="rv-share-list">${rv.shares.map(s=>`
      <div class="rv-share-row"><span class="chip">${s.mode==='comment' ? '💬 comment' : '👁 view'}</span>
        <button class="btn btn-g" onclick="copyShare('${s.token}', this)">Copy link</button>
        <button class="btn btn-danger" onclick="revokeShareClick('${s.token}', this)">Revoke</button></div>`).join('')
      || `<div class="rv-empty" style="margin-top:10px">No links yet — create one and send it to anyone. They see this file, the markers and the comments, without logging in.</div>`}</div>
    <div class="rv-share-note">Anyone with a link sees this one task only. <b>Revoke</b> kills a link instantly.</div>
  </div>`;
}
async function createShareClick(btn){
  const mode = (document.getElementById('rv-share-mode')||{}).value || 'view';
  const label0 = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try{
    const j = await api('createShare', { taskId: rv.taskId, mode });
    rv.shares.unshift({ token: j.token, mode: j.mode, created: '' });
    renderShare();
    const el = document.getElementById('rv-share-url');
    if(el){ el.style.display='block'; el.value = shareUrl(j.token); el.select(); }
    toast('Guest link created — copy it from the panel.');
  }catch(err){
    if(btn){ btn.disabled = false; btn.textContent = 'Create link'; }
    toast('Could not create the link — '+esc(err.message), true);
  }
}
async function copyShare(tok, btn){
  const u = shareUrl(tok);
  let ok = false;
  try{ await navigator.clipboard.writeText(u); ok = true; }catch(e){}
  if(!ok){
    try{
      const ta = document.createElement('textarea'); ta.value = u;
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    }catch(e){}
  }
  const el = document.getElementById('rv-share-url');
  if(el){ el.style.display='block'; el.value = u; }
  if(ok){
    toast('Guest link copied — paste it anywhere.');
    if(btn){ btn.textContent = 'Copied ✓'; setTimeout(()=>{ if(btn) btn.textContent='Copy link'; }, 2000); }
  } else if(el){ el.select(); toast('Copy was blocked — the link is shown in the panel, select and copy it.'); }
}
async function revokeShareClick(tok, btn){
  if(btn && !btn.dataset.armed){
    btn.dataset.armed = '1'; btn.textContent = 'Really revoke?';
    setTimeout(()=>{ if(btn && btn.dataset){ btn.dataset.armed=''; btn.textContent='Revoke'; } }, 3000);
    return;
  }
  if(btn) btn.disabled = true;
  try{
    await api('revokeShare', { token: tok });
    rv.shares = rv.shares.filter(s=>s.token!==tok);
    renderShare();
    toast('Link revoked — it stops working immediately.');
  }catch(err){
    if(btn){ btn.disabled = false; btn.dataset.armed=''; btn.textContent='Revoke'; }
    toast('Could not revoke — '+esc(err.message), true);
  }
}

/* ── guest mode boot (opened via …&review=TOKEN) ── */
async function bootGuest(tok){
  rv.open = true; rv.guest = true; rv.guestTok = tok; rv.mode = 'view';
  const lg = document.getElementById('login'); if(lg) lg.style.display = 'none';
  const el = $('#review');
  el.classList.add('open');
  el.innerHTML = `<div class="rv-loading dotf">LOADING REVIEW…</div>`;
  document.body.style.overflow = 'hidden';
  try{
    try{ const pj = await api('ping', {}); state.googleApiKey = pj.googleApiKey || ''; }catch(e){}
    const j = await api('guestReview', { token: tok });
    rv.gTask = j.task; rv.items = j.items || []; rv.mode = j.mode || 'view'; rv.org = j.org || '';
    rv.versions = j.versions || [];
    rv.viewVersion = rv.versions.length ? rv.versions[rv.versions.length-1].v : 1;
    document.title = 'Review · ' + (j.task.title || j.task.id);
    renderReview();
    if(rv.pollT) clearInterval(rv.pollT);
    rv.pollT = setInterval(pollGuest, 60000);
  }catch(err){
    el.innerHTML = `<div class="rv-loading"><div class="dotf" style="font-size:22px;margin-bottom:10px;letter-spacing:.1em">LINK NOT AVAILABLE</div><div style="color:var(--muted);font-size:13px;max-width:420px;line-height:1.7">${esc(err.message)}</div></div>`;
  }
}
async function pollGuest(){
  if(!rv.guest || document.visibilityState!=='visible') return;
  try{
    const j = await api('guestReview', { token: rv.guestTok });
    rv.gTask = j.task; rv.items = j.items || []; rv.mode = j.mode || 'view';
    renderSide(); updatePins();
  }catch(e){}
}




/* ═══════════ PERIOD REPORTS + BULK ADD (v4.2) ═══════════ */
let reportPeriod = store.get('cf_report_period') || 'month';
function setReportPeriod(p){
  reportPeriod = p; store.set('cf_report_period', p);
  teamStats = null;                       /* the combined answer is period-scoped */
  if(reportScope === 'team' && canSeeTeamReport()){ setReportScope('team'); return; }
  renderAll();
}
function periodStart_(){
  const n = new Date();
  if(reportPeriod==='week'){ const d = new Date(n.getFullYear(), n.getMonth(), n.getDate()); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return d; }
  if(reportPeriod==='year') return new Date(n.getFullYear(), 0, 1);
  if(reportPeriod==='all') return new Date(2000, 0, 1);
  return new Date(n.getFullYear(), n.getMonth(), 1);
}
function reportStatsHtml(){
  const from = periodStart_();
  const scope = state.tasks;
  const given = scope.filter(t=>t.created && t.created >= from);
  const done  = scope.filter(t=>t.status==='Done' && t.completed && t.completed >= from);
  const realDone = done.filter(t=>!hasFlagC(t,'auto-done'));
  const autoDone = done.filter(t=>hasFlagC(t,'auto-done'));
  const rejected = scope.filter(t=>t.status==='Rejected' && ((t.completed && t.completed>=from) || (t.created && t.created>=from)));
  const renewals = scope.filter(t=>t.renewedFrom && t.created && t.created >= from);
  const overLim  = scope.filter(t=>hasFlagC(t,'over-limit') && ((t.completed&&t.completed>=from)||(t.created&&t.created>=from)));
  const avg = a => a.length ? (a.reduce((s,x)=>s+x,0)/a.length) : 0;
  const rounds = avg(done.map(t=>t.revisions||0));
  const turnDays = avg(done.filter(t=>t.created).map(t=>(t.completed - t.created)/DAY));
  const makeDays = avg(done.filter(t=>t.startedAt).map(t=>(t.completed - t.startedAt)/DAY));
  const tile = (n, lbl, hot) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="n" ${hot?'style="color:var(--accent)"':''}>${n}</div></div>`;
  const pbtn = p => `<button class="btn ${reportPeriod===p?'btn-p':'btn-g'}" style="padding:6px 12px;font-size:11px" onclick="setReportPeriod('${p}')">${p==='week'?'This week':p==='month'?'This month':p==='year'?'This year':'All time'}</button>`;
  return `<div class="panel">
    <h3>YOUR NUMBERS <span class="right" style="display:flex;gap:6px">${pbtn('week')}${pbtn('month')}${pbtn('year')}${pbtn('all')}</span></h3>
    <div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:10px">
      ${tile(given.length,'Tasks given')}
      ${tile(realDone.length,'Completed')}
      ${tile(rejected.length,'Rejected', rejected.length>0)}
      ${tile(autoDone.length,'Auto-approved', autoDone.length>0)}
      ${tile(renewals.length,'Renewals', renewals.length>0)}
      ${tile(overLim.length,'⚠ Over-limit', overLim.length>0)}
      ${tile(rounds? rounds.toFixed(1) : '—','Avg revision rounds')}
      ${tile(turnDays? turnDays.toFixed(1)+'d' : '—','Avg turnaround')}
      ${tile(makeDays? makeDays.toFixed(1)+'d' : '—','Avg making time')}
    </div>
    <div style="font-size:10.5px;color:var(--muted);margin-top:10px">${isAssigner()? 'Counting only the tasks you requested.' : isHead()? 'Counting your team\'s tasks.' : 'Counting all teams.'} Averages use tasks completed in the period.</div>
  </div>`;
}
/* "Save & start work" is only offered when the creator would be the person
   doing the work — otherwise it would be starting someone else's clock. A
   member creating a task takes it themselves; an assigner never does. */
function canStartOwn_(){
  if(!state.me || isAssigner()) return false;
  const sel = document.getElementById('n-assignee');
  const chosen = sel ? sel.value : '';
  return !chosen || chosen === state.me.name;
}

/* ═══════════ ALL-TEAMS REPORT (heads + admin) ═══════════
   A head's task scope stays their own team — this view asks the server for
   COUNTS across every team instead, so they get the whole picture without
   being able to read another team's briefs. */
let reportScope = 'mine';     /* 'mine' | 'team' */
let teamStats = null;         /* last teamStats answer */
let teamStatsLoading = false;

function canSeeTeamReport(){ return isAdmin() || isHead(); }

async function setReportScope(v){
  reportScope = v;
  if(v === 'team' && !teamStats && !teamStatsLoading){
    teamStatsLoading = true; renderContent();
    try { teamStats = await api('teamStats', { days: periodDays_() }); }
    catch(e){ toast('Could not load the combined report — ' + esc(e.message), true); reportScope = 'mine'; }
    finally { teamStatsLoading = false; }
  }
  renderContent();
}

function periodDays_(){
  return reportPeriod === 'week' ? 7 : reportPeriod === 'month' ? 30 : reportPeriod === 'year' ? 365 : 3650;
}

function statTile_(label, value, sub){
  return `<div class="kpi"><div class="k-l">${esc(label)}</div><div class="k-v">${value == null ? '—' : value}</div>` +
    (sub ? `<div class="k-s">${esc(sub)}</div>` : '') + `</div>`;
}

/* One section per team the viewer is entitled to: the team's COMBINED figures
   (the head's own work and their members' together) and, under it, the same
   numbers person by person. A head gets their own team; a Super Admin gets one
   section per team. The old studio-wide "All teams" mash-up is gone. */
function teamCombinedHtml(){
  if(teamStatsLoading || !teamStats) return `<div class="panel"><div class="empty">Loading the combined report…</div></div>`;
  const t = teamStats;
  if(!t.teams || !t.teams.length) return `<div class="panel"><div class="empty">No team is attached to your roster row, so there's nothing to combine.</div></div>`;

  const td = (v, extra) => `<td style="padding:8px 10px;border-bottom:1px solid var(--line);${extra||''}">${v}</td>`;
  return t.teams.map(x => {
    const people = t.people.filter(p => p.team === x.name).sort((a,b)=> b.open-a.open || b.done-a.done);
    const rows = people.map(p => `<tr>
        ${td(av(p.name,24) + ' ' + esc(p.name))}
        ${td(p.open)}
        ${td(p.overdue, p.overdue?'color:var(--accent);font-weight:700':'')}
        ${td(p.done)}
        ${td(p.onTimePct==null?'—':p.onTimePct+'%')}
        ${td(p.avgTurnaroundDays==null?'—':p.avgTurnaroundDays+'d')}
      </tr>`).join('');
    return `<div class="panel">
      <div class="p-h"><h3>${tdot(x.name)}${esc(x.name)} team · combined · last ${t.days} days</h3></div>
      <div class="kpis" style="margin:10px 0 6px">
        ${statTile_('Open', x.open)}
        ${statTile_('Overdue', x.overdue)}
        ${statTile_('In review', x.inReview)}
        ${statTile_('Completed', x.done, 'in this period')}
      </div>
      <div class="kpis" style="margin:0 0 16px">
        ${statTile_('On time', x.onTimePct==null?null:x.onTimePct+'%')}
        ${statTile_('Avg rounds', x.avgRounds)}
        ${statTile_('Avg turnaround', x.avgTurnaroundDays==null?null:x.avgTurnaroundDays+'d')}
        ${statTile_('Rejected', x.rejected)}
      </div>
      <div class="tbl-wrap" style="overflow-x:auto"><table class="tasks"><thead><tr>
        <th>Person</th><th>Open</th><th>Overdue</th><th>Done</th><th>On time</th><th>Avg turnaround</th>
      </tr></thead><tbody>${rows || `<tr>${td('Nobody on this team has activity in this period', 'opacity:.6')}<td colspan="5"></td></tr>`}</tbody></table></div>
      ${/* narrow screens hide .tbl-wrap entirely — without this the phone shows
            team totals and no people at all, which the old report did too */''}
      <div class="mob-list">${people.map(p=>`<div style="display:flex;align-items:center;gap:9px;padding:9px 4px;border-bottom:1px solid var(--line)">
          ${av(p.name,26)}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
            <div style="font-size:10.5px;color:var(--muted)">${p.done} done${p.onTimePct==null?'':' · '+p.onTimePct+'% on time'}${p.avgTurnaroundDays==null?'':' · '+p.avgTurnaroundDays+'d avg'}</div>
          </div>
          <div style="text-align:right;font-size:11px;white-space:nowrap"><b>${p.open}</b> open${p.overdue?`<br><b style="color:var(--accent)">${p.overdue} overdue</b>`:''}</div>
        </div>`).join('') || `<div class="empty">Nobody on this team has activity in this period.</div>`}</div>
      <div class="login-note" style="padding:0 4px 4px">Combined counts every task in the team — including work not assigned to anyone yet — so it can be higher than the rows added up.</div>
    </div>` + teamLogHtml_(x.name);
  }).join('');
}

/* The work behind the numbers. Built from the tasks the client already holds —
   no extra call, nothing new over the wire, and it can only ever show what this
   person is already allowed to see. Used by both report views. */
function logList_(match){
  const start = periodStart_().getTime();
  const ms = d => d ? d.getTime() : null;
  const all = (state.tasks || []).filter(match);
  const open = all.filter(t => !isClosed(t))
    .sort((a,b) => (ms(a.due) == null ? Infinity : ms(a.due)) - (ms(b.due) == null ? Infinity : ms(b.due)));
  const closed = all.filter(t => isClosed(t) && ms(t.completed) != null && ms(t.completed) >= start)
    .sort((a,b) => ms(b.completed) - ms(a.completed));
  return open.concat(closed);
}

function taskLogPanel_(heading, list, showWho){
  const td = (v, extra) => `<td style="padding:7px 10px;border-bottom:1px solid var(--line);${extra||''}">${v}</td>`;
  const rows = list.map(t => `<tr onclick="openTaskModal('${t.id}')" style="cursor:pointer">
      ${td(`<b>${esc(t.title)}</b><br><small style="color:var(--muted)">${esc(t.id)}</small>`)}
      ${showWho ? td(t.assignee ? esc(t.assignee) : '<span style="color:var(--muted)">unassigned</span>') : ''}
      ${td(schip(t))}
      ${td(dueLabel(t), isOverdue(t) ? 'color:var(--accent);font-weight:600' : '')}
      ${td(t.completed ? fmtD(t.completed) : '—')}
      ${td(t.revisions || 0)}
    </tr>`).join('');

  return `<div class="panel">
    <div class="p-h"><h3>${heading} <span style="color:var(--muted);font-weight:400">· ${list.length} task${list.length===1?'':'s'}</span></h3></div>
    ${list.length ? `<div class="tbl-wrap" style="overflow-x:auto"><table class="tasks"><thead><tr>
        <th>Task</th>${showWho ? '<th>Who</th>' : ''}<th>Status</th><th>Due</th><th>Finished</th><th>Rounds</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="mob-list">${list.map(t => rowHtml(t, true)).join('')}</div>`
    : `<div class="empty">Nothing open, and nothing finished in this period.</div>`}
    <div class="login-note" style="padding:0 4px 4px">Everything still open, plus everything finished in this period. Tap a row to open the task.</div>
  </div>`;
}

function teamLogHtml_(team){
  return taskLogPanel_(`${tdot(team)}${esc(team)} team · task log`, logList_(t => String(t.team || '') === team), true);
}
function personLogHtml_(name){
  return taskLogPanel_(`${esc(name)} · task log`, logList_(t => String(t.assignee || '') === name), false);
}

function printBtnHtml_(){
  return `<button class="ghostbtn" onclick="window.print()">🖨 Print / save as PDF</button>`;
}

function scopeSwitchHtml(){
  if(!canSeeTeamReport()) return '';
  return `<div class="filters" style="margin-bottom:12px;align-items:center">
    <button class="btn ${reportScope==='mine'?'btn-p':''}" onclick="setReportScope('mine')">${isAdmin()?'By person':'My team'}</button>
    <button class="btn ${reportScope==='team'?'btn-p':''}" onclick="setReportScope('team')">${isAdmin()?'Teams combined':'Team combined'}</button>
    ${reportScope==='team' ? `<span style="margin-left:auto">${printBtnHtml_()}</span>` : ''}
  </div>`;
}

function viewReports(){
  if(reportScope === 'team' && canSeeTeamReport()){
    return reportStatsHtml() + scopeSwitchHtml() + teamCombinedHtml();
  }
  return reportStatsHtml() + scopeSwitchHtml() + (isAssigner() ? '' : viewReportsCharts());
}

/* ── bulk add ── */
let bulkRows = [];
function bulkTemplateHref(){
  const csv = 'Team,Title,Description,Priority,Due date (YYYY-MM-DD),Due time (HH:MM),Brief link\n' +
    (state.teams[0]||'Graphic') + ',Instagram carousel — offer,3 slides + caption,High,2026-08-15,18:00,https://drive.google.com/…\n' +
    (state.teams[1]||'Video') + ',Reel 30s — venue teaser,vertical cut,Medium,2026-08-18,12:00,';
  return 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
}
function openBulkModal(){
  bulkRows = [];
  $('#overlay').innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2>🧺 BULK ADD TASKS</h2>
    <div class="msub">Paste rows straight from Excel / Google Sheets (tab-separated — just copy the cells).
      Columns: <b>Team · Title · Description · Priority · Due date (YYYY-MM-DD) · Due time · Brief link</b>
      · <a href="${bulkTemplateHref()}" download="CreativeFlow-bulk-template.csv">Download the template</a></div>
    <textarea id="bulk-in" rows="7" style="width:100%;font-size:12px" placeholder="Graphic\tDiwali poster\t3 sizes\tHigh\t2026-08-15\t18:00\thttps://…"></textarea>
    <div id="bulk-prev" style="max-height:220px;overflow:auto;margin-top:10px"></div>
    <div class="modal-actions">
      <button class="btn btn-g" onclick="closeModal()">Cancel</button>
      <button class="btn btn-g" onclick="previewBulk()">Preview</button>
      <button class="btn btn-p" id="bulk-go" style="display:none" onclick="submitBulk(this)">Create tasks</button>
    </div></div>`;
  $('#overlay').classList.add('open');
}
function previewBulk(){
  const txt = (document.getElementById('bulk-in')||{value:''}).value;
  const lines = txt.split(/\r?\n/).map(l=>l.trim()).filter(l=>l);
  bulkRows = [];
  const out = [];
  lines.forEach((line, ix) => {
    const cells = line.split(line.indexOf('\t')>-1 ? '\t' : ',').map(c=>c.trim());
    if(ix===0 && /title/i.test(line) && /team/i.test(line)) return; // header row
    const [team, title, desc, priority, dueDate, dueTime, brief] = cells;
    const teamOk = state.teams.find(x=>x.toLowerCase()===String(team||'').toLowerCase());
    let err = '';
    if(!teamOk) err = 'unknown team “'+esc(team||'')+'”';
    else if(!title) err = 'title missing';
    else if(!/^\d{4}-\d{2}-\d{2}$/.test(dueDate||'')) err = 'due date must be YYYY-MM-DD';
    const row = { team: teamOk || team, title: title||'', desc: desc||'', brief: brief||'',
      priority: PRIORITIES.indexOf(priority)>-1 ? priority : 'Medium',
      dueDate: dueDate||'', dueTime: /^\d{1,2}:\d{2}$/.test(dueTime||'') ? dueTime : '18:00' };
    if(!err) bulkRows.push(row);
    out.push(`<div style="display:flex;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--line);font-size:12px;${err?'color:var(--accent)':''}">
      <span style="min-width:18px">${err?'✗':'✓'}</span><b style="min-width:70px">${esc(row.team)}</b>
      <span style="flex:1">${esc(row.title)}</span><span>${esc(row.priority)}</span><span>${esc(row.dueDate)} ${esc(row.dueTime)}</span>
      ${err? `<span>· ${err}</span>`:''}</div>`);
  });
  document.getElementById('bulk-prev').innerHTML = out.join('') || '<div class="rv-empty">Nothing to preview yet.</div>';
  const go = document.getElementById('bulk-go');
  go.style.display = bulkRows.length ? 'inline-block' : 'none';
  go.textContent = 'Create ' + bulkRows.length + ' task' + (bulkRows.length>1?'s':'');
}
async function submitBulk(btn){
  if(!bulkRows.length) return;
  btn.disabled = true; btn.textContent = 'Creating…';
  try{
    setSync('busy','SAVING…');
    const j = await api('bulkCreate', { rows: bulkRows });
    (j.created||[]).forEach(t=>upsert(t));
    state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    const errs = (j.errors||[]);
    toast(`<b>${(j.created||[]).length}</b> task${(j.created||[]).length===1?'':'s'} created${errs.length? ' · <b>'+errs.length+'</b> row'+(errs.length>1?'s':'')+' skipped: '+esc(errs.map(e=>e.message).join(' | ')).slice(0,180) : ''}`, errs.length>0);
  }catch(err){
    btn.disabled = false; btn.textContent = 'Create tasks';
    setSync('off','OFFLINE');
    toast('Bulk add failed — '+esc(err.message), true);
  }
}

/* ═══════════ WORKFLOW ACTIONS (v4.0) ═══════════ */
function hasFlagC(t, f){ return String((t && t.flags) || '').split(',').indexOf(f) > -1; }
function setViewVersion(v){
  rv.viewVersion = Number(v) || 1;
  rv.player = null; rv.ytFailed = false; rv.form = null;
  renderReview();
}
async function simpleAction_(action, id, btn, okMsg){
  if(btn) btn.disabled = true;
  try{
    setSync('busy','SAVING…');
    const j = await api(action, { id });
    upsert(j.task); state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    toast(okMsg(j) + (j.info? ' · '+esc(j.info) : ''));
    return j;
  }catch(err){
    if(btn) btn.disabled = false;
    setSync('off','OFFLINE');
    toast('Could not do that — '+esc(err.message), true);
    return null;
  }
}
async function startTaskClick(id, btn){
  await simpleAction_('startTask', id, btn, j => `<b>${esc(id)}</b> started — the clock is running. Good luck!`);
}
async function acceptChangesClick(id, btn){
  await simpleAction_('acceptChanges', id, btn, j => `<b>${esc(id)}</b> — changes accepted, back to work. Deadline: ${esc(j.task && j.task.dueDate ? j.task.dueDate+' '+j.task.dueTime : 'as set')}.`);
}
async function qcPassClick(id, btn, inRoom){
  const j = await simpleAction_('qcPass', id, btn, () => `<b>${esc(id)}</b> passed QC — off to the requester.`);
  if(j && inRoom && rv.open && !rv.guest && rv.taskId === id) renderReview();
}
async function renewTaskClick(id, btn){
  if(btn && !btn.dataset.armed){
    btn.dataset.armed = '1'; btn.textContent = 'Really renew as a new task?';
    setTimeout(()=>{ if(btn && btn.dataset && btn.dataset.armed){ btn.dataset.armed=''; btn.textContent='↻ Renew as new task'; } }, 4000);
    return;
  }
  if(btn) btn.disabled = true;
  try{
    setSync('busy','SAVING…');
    const j = await api('renewTask', { id });
    upsert(j.task); state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${esc(id)}</b> renewed as <b>${esc(j.task.id)}</b> — counted in reports.`);
  }catch(err){
    if(btn){ btn.disabled = false; btn.dataset.armed=''; btn.textContent='↻ Renew as new task'; }
    setSync('off','OFFLINE');
    toast('Could not renew — '+esc(err.message), true);
  }
}
async function holdTaskClick(id, btn){
  if(btn) btn.disabled = true;
  try{
    setSync('busy','SAVING…');
    const j = await api('updateTask', { id, patch:{ status:'On Hold' } });
    upsert(j.task); state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${esc(id)}</b> paused — the clock and overdue alerts stop. Press <b>▶ Resume work</b> when you're back on it.`);
  }catch(err){
    if(btn) btn.disabled = false;
    setSync('off','OFFLINE');
    toast('Could not pause — '+esc(err.message), true);
  }
}
async function acceptBriefClick(id, btn){
  await simpleAction_('acceptBrief', id, btn, () => `<b>${esc(id)}</b> — updated brief accepted. Carry on.`);
}

/* ═══════════ REVIEW TAB + REJECT (v3.3) ═══════════ */
function reviewBuckets(){
  if(!state.me) return { waiting:[], withReq:[], fixing:[], decided:[] };
  const rel = state.tasks.filter(t => isAdmin() || (isHead() && t.team===state.me.team) || t.assignee===state.me.name || t.requester===state.me.name);
  const rev = isHead()||isAdmin();
  return {
    waiting: rev ? rel.filter(t=>t.status==='In Review' && t.stage!=='Assigner' && canManage(t))
                 : isAssigner() ? rel.filter(t=>t.status==='In Review' && t.stage==='Assigner' && t.requester===state.me.name)
                 : rel.filter(t=>t.status==='Revisions' && t.assignee===state.me.name),
    withReq: rel.filter(t=>t.status==='In Review' && t.stage==='Assigner'),
    fixing:  rel.filter(t=>t.status==='Revisions'),
    decided: rel.filter(t=> (t.status==='Done' && t.completed && (Date.now()-t.completed.getTime()) < 7*DAY) || t.status==='Rejected'),
  };
}
function reviewBadge(){ return reviewBuckets().waiting.length; }
function rvqRow(t){
  return `<div class="rvq" onclick="openReview('${t.id}')">
    <span class="rvq-id dotf">${t.id}</span>
    <div class="rvq-b"><div class="rvq-t">${esc(t.title)}</div>
      <div class="rvq-m">${tdot(t.team)}${esc(t.team)} · ${esc(t.assignee||'unassigned')}${t.revisions? ' · '+t.revisions+' round'+(t.revisions>1?'s':''):''} · ${dueLabel(t)}</div></div>
    ${schip(t)}<span class="rvq-go">→</span></div>`;
}
function viewReview(){
  const b = reviewBuckets();
  const rev = isHead()||isAdmin();
  const sec = (title, arr, empty) => `<div class="panel"><h3>${title}${arr.length? ` <span class="right">${arr.length}</span>`:''}</h3>${arr.length? arr.map(rvqRow).join('') : `<div class="rv-empty">${empty}</div>`}</div>`;
  return `
    ${sec(rev? '🔎 WAITING ON YOUR QC' : isAssigner()? '🎬 WAITING ON YOUR VERDICT' : '↺ FIX & RESUBMIT', b.waiting, rev? 'Nothing waiting on your check — clear desk.' : isAssigner()? 'Nothing waiting on you — the teams are on it.' : 'No revision requests on your plate right now.')}
    ${sec('🎬 WITH THE REQUESTER', b.withReq, 'Nothing is waiting on a requester right now.')}
    ${rev? sec('↺ IN REVISIONS', b.fixing, 'No tasks are in a revision round.') : ''}
    ${sec('✓ DECIDED RECENTLY', b.decided, 'No approvals or rejects in the last 7 days.')}`;
}
async function rejectTaskClick(id, btn){
  const existing = document.getElementById('rej-box');
  if(!existing){
    const actions = btn.closest('.modal-actions');
    if(!actions) return;
    const div = document.createElement('div');
    div.id = 'rej-box';
    div.style.cssText = 'display:flex;gap:8px;margin:10px 0 2px;width:100%';
    div.innerHTML = `<input id="rej-reason" placeholder="Why is it rejected? (required — goes to the member & head)" style="flex:1">
      <button class="btn btn-danger" id="rej-go">Confirm reject</button>`;
    actions.parentNode.insertBefore(div, actions);
    const go = document.getElementById('rej-go');
    go.onclick = ()=>rejectTaskClick(id, go);
    const inp = document.getElementById('rej-reason');
    inp.focus();
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter') rejectTaskClick(id, go); });
    return;
  }
  const reason = (document.getElementById('rej-reason')||{value:''}).value.trim();
  if(!reason){ toast('Write the reject reason first — the member deserves to know why.', true); return; }
  btn.disabled = true;
  try{
    setSync('busy','SAVING…');
    const j = await api('rejectTask', { id, reason });
    upsert(j.task); state.lastSync = new Date(); setSync('');
    closeModal(); renderAll();
    toast(`<b>${esc(id)}</b> rejected — member and head have been notified.`);
  }catch(err){
    btn.disabled = false;
    setSync('off','OFFLINE');
    toast('Could not reject — '+esc(err.message), true);
  }
}

/* ═══════════ RENDER ROOT ═══════════ */
function renderContent(){
  if(isAssigner() && tab==='overview') tab = 'review';
  /* the boot hash restore runs before we know who is signed in, so a member
     cold-starting #assigners would otherwise render a tab they cannot have */
  if(tab==='assigners' && !(isHead() || isAdmin())) tab = 'overview';
  const v = { overview:viewOverview, tasks:viewTasks, review:viewReview, calendar:viewCalendar, reports:viewReports, gallery:viewGallery, assigners:viewAssigners, projects:viewProjects }[tab] || viewOverview;
  $('#content').innerHTML = v();
  if(tab==='calendar') bindCalendarDrag();
  if(tab==='overview'){ const box = document.getElementById('ov-notifs'); if(box) bindNotifClicks(box, notifs()); }
}
function renderAll(){
  if(!state.me) return;
  renderNav(); renderTop(); renderNotifPanel(); renderContent();
  /* v5: keep the current tab in the URL hash so PWA back-button + refresh land
     where you were. Written AFTER renderContent because that's where the
     assigner overview→review redirect happens. replaceState = no history spam. */
  try { if(location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab); } catch(e){}
}
window.addEventListener('hashchange', () => {
  const want = location.hash.slice(1);
  if(state.me && want && want !== tab && TAB_DEFS_().some(x => x.id === want)){ tab = want; renderAll(); }
});

/* ═══════════ WIRING ═══════════ */
$('#login-btn').onclick = doLogin;
$('#in-code').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
$('#in-url').addEventListener('change', ()=>{ const u=cleanUrl_($('#in-url').value.trim()); if(u){ state.url=u; $('#in-url').value=u; fetchPing(); } });
$('#change-url').onclick = e=>{ e.preventDefault(); state.url=''; store.del('cf_url'); store.del('td_url'); showLogin(); };
$('#test-conn').onclick = e=>{ e.preventDefault(); testConnection(); };
$('#newtask-btn').onclick = openNewTaskModal;
$('#bulk-btn').onclick = openBulkModal;
$('#refresh-btn').onclick = ()=>refreshTasks();
$('#theme-btn').onclick = ()=>{ applyTheme(dark()?'light':'dark'); renderAll(); };
$('#bell').onclick = e => { e.stopPropagation(); openNotifPanel_(); };
document.addEventListener('click', e => {
  if(!e.target.closest('#notif-panel') && !e.target.closest('#bell')) $('#notif-panel').classList.remove('open');
  if(!e.target.closest('#acct-sheet') && !e.target.closest('#userchip')) $('#acct-sheet').classList.remove('open');
});
$('#overlay').addEventListener('click', e => { if(e.target.id==='overlay') closeModal(); });
document.addEventListener('keydown', e => { if(e.key==='Escape'){ if(rv.open && !rv.guest){ if(rv.form){ cancelForm(); } else if(rv.shareOpen){ toggleShare(); } else { closeReview(); } return; } closeModal(); $('#notif-panel').classList.remove('open'); $('#acct-sheet').classList.remove('open'); } });

setInterval(()=>{ if(state.me && document.visibilityState==='visible') refreshTasks(true); }, 60000);
document.addEventListener('visibilitychange', ()=>{ if(state.me && document.visibilityState==='visible') refreshTasks(true); });

/* desktop-app heartbeat: keeps CreativeFlow.exe's local server alive while the window is open */
(function(){
  if(location.hostname==='localhost' || location.hostname==='127.0.0.1'){
    setInterval(()=>{ try{ fetch('/alive').catch(()=>{}); }catch(e){} }, 15000);
  }
})();

/* boot */
/* v5: restore the tab from the hash before first render */
/* Boot hash restore. Hard-coded rather than derived from TAB_DEFS_(): state.me
   is still null here, so TAB_DEFS_() would return the plain list and drop
   'assigners' — a head refreshing that tab, or cold-starting the installed app
   on it, would silently land on the Dashboard. renderContent re-checks the
   role, so an id someone is not entitled to is corrected a moment later. */
(function(){
  const h = location.hash.slice(1);
  if(h && ['overview','tasks','review','projects','gallery','assigners','calendar','reports'].indexOf(h) > -1) { tab = h; bootTab_ = h; }
})();
const __rvQS = new URLSearchParams(location.search);
/* short route: #/r/<token>[?api=…] — checked before the legacy ?review= form */
const __rvHash = (location.hash || '').match(/^#\/r\/([A-Za-z0-9]{8,40})(?:\?(.*))?$/);
if(__rvHash && __rvHash[2]){
  const hq = new URLSearchParams(__rvHash[2]);
  if(hq.get('api')) __rvQS.set('api', hq.get('api'));
}
const __rvTok = String(window.CF_GUEST_TOKEN || (__rvHash && __rvHash[1]) || __rvQS.get('review') || '').trim();
window.__cfOpenTask = String(window.CF_OPEN_TASK || __rvQS.get('task') || '').trim();
if(__rvTok){
  if(__rvQS.get('api')) state.url = cleanUrl_(__rvQS.get('api').trim());
  bootGuest(__rvTok);
} else if(state.url && state.email && state.code){
  /* v5: a signed-in device must never see the login form again.
     Hide it immediately, paint the last known board from the device cache so
     the app is usable in milliseconds, and refresh in the background. Only a
     genuine credential rejection sends anyone back to the login screen. */
  document.getElementById('login').style.display = 'none';
  const cached = loadCache_();
  if(cached){
    state.me = cached.me; state.org = cached.org || ''; state.teams = cached.teams || [];
    state.roster = cached.roster || []; state.formUrl = cached.formUrl || ''; state.sheetUrl = cached.sheetUrl || '';
    state.tasks = (cached.tasks || []).map(parseTask);
    enterApp();
    setSync('busy', 'SYNCING…');
  } else {
    showSplash_();
  }
  bootstrapAndEnter(false, !!cached).catch(e=>{
    if(cached){                       // we already have a usable board on screen
      setSync('off', 'OFFLINE — showing your last synced board');
      if(e.apiError === 'AUTH'){ hideSplash_(); showLogin('Your saved login didn’t match — sign in again.'); }
      return;
    }
    hideSplash_();
    $('#login-tag').textContent = 'Your studio’s task command center';
    showLogin(e.apiError==='AUTH' ? 'Your saved login didn’t match — sign in again.' : null);
  });
} else {
  showLogin();
}

/* ── v5 ESM shim: the markup uses inline onclick handlers that expect the old
   global <script> scope — expose every top-level function on window so the
   proven markup keeps working unchanged under Vite/ESM. state/store/rv are
   exposed too (Playwright suites and the console read them). ── */
/* Mutable module bindings the markup writes to (tab=…, weekOffset--, filters.q=…)
   MUST be live accessors, not value copies: a plain Object.assign snapshots the
   reference, so any later reassignment (e.g. the filter reset on login) leaves
   the inline handlers writing to an orphan — dropdowns and week arrows then
   silently do nothing. Getters/setters keep window and module in lockstep. */
[['tab', v => (tab = v), () => tab],
 ['weekOffset', v => (weekOffset = v), () => weekOffset],
 ['myTab', v => (myTab = v), () => myTab],
 ['mcalOffset', v => (mcalOffset = v), () => mcalOffset],
 ['filters', v => (filters = v), () => filters],
 ['reportSubject', v => (reportSubject = v), () => reportSubject],
 ['reportPeriod', v => (reportPeriod = v), () => reportPeriod],
 ['rv', v => (rv = v), () => rv],
 ['bulkRows', v => (bulkRows = v), () => bulkRows],
 ['reportScope', v => (reportScope = v), () => reportScope],
 ['assignerPick', v => (assignerPick = v), () => assignerPick],
 ['projPick', v => (projPick = v), () => projPick],
 ['projSub', v => (projSub = v), () => projSub],
 ['teamStats', v => (teamStats = v), () => teamStats],
].forEach(([name, set, get]) => {
  Object.defineProperty(window, name, { get, set, configurable: true });
});
Object.assign(window, { state, store, STATUSES, PRIORITIES, setReportScope, canStartOwn_, rvCanAnnotate, statTile_, teamCombinedHtml, scopeSwitchHtml, canSeeTeamReport, periodDays_, togglePush, refreshPushState_, openTaskFromRoute_, openNotifPanel_, clearNotifLog_, refreshNotifLog_, logAddForTest, viewGallery, viewAssigners, setAssigner, assignerList_, viewProjects, loadProjects, openProject, closeProject, setProjSub, setProjStatus, openNewProjectModal, createProject, addProjNote, delProjNote, openAddPill, closeAddPill, toggleInlineProject, setGalScope, setGalTeam, loadGallery, openGalleryItem, galImgFail });

/* ═══════════ ASSIGNERS ═══════════
   Who asked for what. Assigners sit outside the Graphic/Video teams — they are
   the people who commission the work — so their requests scatter across both
   teams and never appear grouped anywhere else in the app. */


function assignerList_(){
  const roles = {};
  (state.roster || []).forEach(m => { roles[m.name] = m.role; });
  const seen = {};
  /* Everyone with the Assigner role, so a newly added one shows up ready to
     use even before their first request... */
  (state.roster || []).filter(m => m.role === 'Assigner')
    .forEach(m => { seen[m.name] = { name: m.name, role: 'Assigner', active: m.active !== false }; });
  /* ...and everyone who has ACTUALLY commissioned work, whatever their role.
     In this studio the heads and members request from each other constantly, so
     filtering to the Assigner role alone left the tab completely empty. */
  (state.tasks || []).forEach(t => {
    const r = String(t.requester || '').trim();
    if(!r || seen[r]) return;
    seen[r] = { name: r, role: roles[r] || '', active: true };
  });
  return Object.keys(seen).map(k => seen[k])
    .sort((a,b) => assignerTasks_(b.name).length - assignerTasks_(a.name).length || a.name.localeCompare(b.name));
}

function assignerTasks_(name){
  return (state.tasks || []).filter(t => String(t.requester || '').trim() === name);
}

function assignerStats_(name){
  const ts = assignerTasks_(name);
  return {
    total: ts.length,
    open: ts.filter(t => !isClosed(t)).length,
    overdue: ts.filter(isOverdue).length,
    review: ts.filter(t => t.status === 'In Review').length,
    done: ts.filter(t => t.status === 'Done').length,
  };
}

function setAssigner(name){ assignerPick = name; renderContent(); }

function viewAssigners(){
  const people = assignerList_();
  if(!people.length){
    return `<div class="panel"><div class="empty">Nobody has requested work yet.<br>
      <span style="color:var(--muted)">Anyone who requests a task appears here. Add dedicated requesters in the Roster with the role <b>Assigner</b> — they don't need a team.</span></div></div>`;
  }
  if(!assignerPick || !people.some(p => p.name === assignerPick)) assignerPick = people[0].name;

  const chips = people.map(p => {
    const s = assignerStats_(p.name);
    const on = p.name === assignerPick;
    /* esc() around the JSON: the string is going INSIDE a double-quoted
       attribute, so raw JSON quotes would close it early and leave the handler
       as the fragment `setAssigner(`. Every chip would be dead on click. */
    return `<button class="btn ${on?'btn-p':''}" onclick="setAssigner(${esc(JSON.stringify(p.name))})">
        ${esc(p.name)}${p.role && p.role !== 'Assigner' ? ` <span style="opacity:.5;font-weight:400">${esc(p.role.toLowerCase())}</span>` : ''}${p.active===false?' <span style="opacity:.55">·inactive</span>':''}
        <span style="opacity:.7;font-weight:400;margin-left:6px">${s.open}</span>
        ${s.overdue?`<span style="margin-left:5px;font-weight:700${on?'':';color:var(--accent)'}">⚠${s.overdue}</span>`:''}
      </button>`;
  }).join('');

  const s = assignerStats_(assignerPick);
  const ts = assignerTasks_(assignerPick).slice().sort((a,b) => {
    const ac = isClosed(a) ? 1 : 0, bc = isClosed(b) ? 1 : 0;
    if(ac !== bc) return ac - bc;                            // live work first
    const ad = a.due ? a.due.getTime() : Infinity, bd = b.due ? b.due.getTime() : Infinity;
    return ad - bd;
  });

  const td = (v, extra) => `<td style="padding:7px 10px;border-bottom:1px solid var(--line);${extra||''}">${v}</td>`;
  const rows = ts.map(t => `<tr onclick="openTaskModal('${t.id}')" style="cursor:pointer">
      ${td(`<b>${esc(t.title)}</b><br><small style="color:var(--muted)">${esc(t.id)}</small>`)}
      ${td(tdot(t.team) + esc(t.team))}
      ${td(t.assignee ? esc(t.assignee) : '<span style="color:var(--muted)">unassigned</span>')}
      ${td(schip(t))}
      ${td(dueLabel(t), isOverdue(t) ? 'color:var(--accent);font-weight:600' : '')}
      ${td(t.completed ? fmtD(t.completed) : '—')}
    </tr>`).join('');

  return `<div class="filters" style="margin-bottom:12px;flex-wrap:wrap">${chips}</div>
  <div class="panel">
    <div class="p-h"><h3>${esc(assignerPick)} <span style="color:var(--muted);font-weight:400">· ${s.total} request${s.total===1?'':'s'}</span></h3></div>
    <div class="kpis" style="margin:10px 0 16px">
      ${statTile_('Open', s.open)}
      ${statTile_('Overdue', s.overdue)}
      ${statTile_('In review', s.review)}
      ${statTile_('Completed', s.done)}
    </div>
    ${(isHead() && !isAdmin()) ? `<div class="login-note" style="padding:0 4px 8px">You see the ${esc(state.me.team)} side of these requests. ${esc(assignerPick)} may have asked the other team for more.</div>` : ""}
    ${ts.length ? `<div class="tbl-wrap" style="overflow-x:auto"><table class="tasks"><thead><tr>
        <th>Task</th><th>Team</th><th>Assigned to</th><th>Status</th><th>Due</th><th>Finished</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="mob-list">${ts.map(t => rowHtml(t, true)).join('')}</div>`
    : `<div class="empty">No requests from ${esc(assignerPick)} yet.</div>`}
  </div>`;
}

/* ═══════════ GALLERY ═══════════
   Finished work, newest first. Reads the server's Portfolio store rather than
   live tasks: approved tasks get archived out of Master, and the uploaded files
   themselves are reclaimed after 45 days — the Portfolio keeps a small still of
   its own so the studio's showreel outlives both. */


async function loadGallery(more){
  if(gal.loading) return;
  if(more && gal.next == null) return;
  const page = more ? gal.next : 0;
  gal.loading = true;
  if(!more){ gal.items = []; gal.next = null; gal.total = 0; }
  renderContent();
  try{
    const j = await api('gallery', { page, scope: gal.scope, team: gal.team });
    gal.items = more ? gal.items.concat(j.items || []) : (j.items || []);
    gal.next = (j.next === undefined ? null : j.next);
    gal.total = j.total || 0;
  }catch(err){
    toast('Could not load the gallery — ' + esc(err.message), true);
  }
  gal.loaded = true;
  gal.loading = false;
  renderContent();
}

function setGalScope(v){ if(gal.scope===v) return; gal.scope = v; gal.loaded = false; loadGallery(false); }
function setGalTeam(v){ gal.team = v; gal.loaded = false; loadGallery(false); }

/** The best picture available, in order of how long it will survive. */
function galThumb_(it){
  if(it.thumb) return it.thumb;                                  // our own still: permanent
  const u = String(it.link || '');
  const yt = u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/))([\w-]{6,})/);
  if(yt) return 'https://img.youtube.com/vi/' + yt[1] + '/hqdefault.jpg';
  if(/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) return u;
  const dv = u.match(/\/d\/([-\w]{20,})/) || u.match(/[?&]id=([-\w]{20,})/);
  if(dv) return 'https://drive.google.com/thumbnail?id=' + dv[1] + '&sz=w800';
  return '';
}

function galCard_(it, i, from){
  const src = galThumb_(it);
  const who = it.assignee || it.requester || '';
  return `<figure class="g-card" onclick="openGalleryItem(${i}, ${esc(JSON.stringify(from || 'gal'))})" title="${esc(it.title)}">
      ${src ? `<img src="${esc(src)}" alt="${esc(it.title)}" loading="lazy" onerror="galImgFail(this)">`
            : `<div class="g-noimg"><span class="g-ic">${it.kind === 'link' ? '🔗' : '📄'}</span><span>no preview</span></div>`}
      <figcaption class="g-meta">
        <div class="g-t">${esc(it.title)}</div>
        <div class="g-s">${tdot(it.team)}${esc(it.id)}${who ? ' · ' + esc(String(who).split(' ')[0]) : ''}${it.completed ? ' · ' + fmtD(new Date(it.completed)) : ''}</div>
      </figcaption></figure>`;
}

/* A Drive still can 404 when the file was pasted by hand and never link-shared,
   or was deleted before we captured a copy. Say so rather than leaving a
   broken-image icon. */
function galImgFail(img){
  if(!img || !img.parentNode) return;
  img.outerHTML = `<div class="g-noimg"><span class="g-ic">🖼</span><span>preview unavailable</span></div>`;
}

function openGalleryItem(i, from){
  const list = (from === 'pgal' ? pgal : gal).items || [];
  const it = list[i]; if(!it) return;
  if(state.tasks.some(t => t.id === it.id)){ openTaskModal(it.id); return; }
  if(it.link) window.open(it.link, '_blank', 'noopener');   // archived out of the board
}

function viewGallery(){
  if(!gal.loaded && !gal.loading) loadGallery(false);

  const canScope = isHead() || isAdmin();
  const bar = canScope ? `<div class="filters" style="margin-bottom:12px;align-items:center">
      <button class="btn ${gal.scope==='team'?'btn-p':''}" onclick="setGalScope('team')">${isAdmin()?'Everyone':'Whole team'}</button>
      <button class="btn ${gal.scope==='mine'?'btn-p':''}" onclick="setGalScope('mine')">Just mine</button>
      ${isAdmin() ? `<select class="mini-sel" style="margin-left:auto" onchange="setGalTeam(this.value)">
          <option value="">All teams</option>
          ${(state.teams||[]).map(x=>`<option ${gal.team===x?'selected':''}>${esc(x)}</option>`).join('')}
        </select>` : ''}
    </div>` : '';

  if(gal.loading && !gal.items.length) return bar + `<div class="panel"><div class="empty">Loading the gallery…</div></div>`;

  if(!gal.items.length){
    return bar + `<div class="panel"><div class="empty">Nothing here yet.<br>
      <span style="color:var(--muted)">Finished work appears automatically once a task is approved with a file attached.</span></div></div>`;
  }

  return bar +
    `<div class="g-count">${gal.total} finished ${gal.total===1?'piece':'pieces'}</div>` +
    `<div class="gallery">${gal.items.map(galCard_).join('')}</div>` +
    (gal.next != null
      ? `<div style="text-align:center;margin:18px 0"><button class="btn btn-g" onclick="loadGallery(true)"${gal.loading?' disabled':''}>${gal.loading?'Loading…':'Show more'}</button></div>`
      : `<div class="g-end">That's everything.</div>`);
}


/* ═══════════ PROJECTS / CAMPAIGNS ═══════════
   A campaign is a folder for work: the Diwali launch, a product film, an event.
   Pick one and you get its own small workspace — the numbers, its tasks, the
   finished pieces, and a running note feed — instead of hunting for the same
   campaign across five other screens. */

async function loadProjects(force){
  if(projLoading) return;
  if(projLoaded && !force) return;
  projLoading = true;
  try{
    const j = await api('projects', {});
    projects = j.projects || [];
    projLoaded = true;
  }catch(err){ toast('Could not load campaigns — ' + esc(err.message), true); }
  projLoading = false;
  renderContent();
}

function projByName_(name){
  return (projects || []).find(p => p.name.toLowerCase() === String(name || '').toLowerCase()) || null;
}
function projTasks_(name){
  const want = String(name || '').toLowerCase();
  return (state.tasks || []).filter(t => String(t.project || '').toLowerCase() === want);
}
function projColour_(name){
  const p = projByName_(name);
  return p ? p.colour : 'var(--muted)';
}

function openProject(name){
  projPick = name; projSub = 'overview';
  pgal = { items: [], next: null, total: 0, loading: false, loaded: false };
  projNotes = { items: [], loaded: false, loading: false };
  renderContent();
}
function closeProject(){ projPick = ''; renderContent(); }
function setProjSub(v){
  projSub = v;
  if(v === 'gallery' && !pgal.loaded) loadProjGallery();
  else if(v === 'notes' && !projNotes.loaded) loadProjNotes();
  else renderContent();
}

async function loadProjGallery(){
  if(pgal.loading) return;
  pgal.loading = true; renderContent();
  try{
    const j = await api('gallery', { page: 0, scope: 'team', project: projPick });
    pgal.items = j.items || []; pgal.total = j.total || 0; pgal.next = j.next;
  }catch(err){ toast('Could not load this campaign’s work — ' + esc(err.message), true); }
  pgal.loaded = true; pgal.loading = false; renderContent();
}

async function loadProjNotes(){
  if(projNotes.loading) return;
  projNotes.loading = true; renderContent();
  try{
    const j = await api('projectNotes', { project: projPick });
    projNotes.items = j.notes || [];
  }catch(err){ toast('Could not load notes — ' + esc(err.message), true); }
  projNotes.loaded = true; projNotes.loading = false; renderContent();
}

async function addProjNote(btn){
  const ta = document.getElementById('pn-text');
  const text = ta ? ta.value.trim() : '';
  if(!text){ toast('Write something first.', true); return; }
  if(btn) btn.disabled = true;
  try{
    const j = await api('projectNoteAdd', { project: projPick, text });
    projNotes.items.unshift(j.note);
    if(ta) ta.value = '';
    renderContent();
  }catch(err){ toast('Could not save the note — ' + esc(err.message), true); }
  if(btn) btn.disabled = false;
}

async function delProjNote(id, btn){
  if(btn && !btn.dataset.armed){
    btn.dataset.armed = '1'; btn.textContent = 'sure?';
    setTimeout(()=>{ if(btn && btn.dataset){ btn.dataset.armed=''; btn.textContent='✕'; } }, 3000);
    return;
  }
  try{
    await api('projectNoteDel', { id });
    projNotes.items = projNotes.items.filter(n => n.id !== id);
    renderContent();
  }catch(err){ toast('Could not remove it — ' + esc(err.message), true); }
}

async function setProjStatus(v){
  const name = projPick;
  try{
    await api('projectUpdate', { name, patch: { status: v } });
    const p = projByName_(name); if(p) p.status = v;
    toast('Campaign marked ' + esc(v) + '.');
    renderContent();
  }catch(err){ toast('Could not update — ' + esc(err.message), true); }
}

/** Create a campaign from the pill, the tab, or the new-task dialog. */
async function createProject(fromModal){
  const el = document.getElementById(fromModal ? 'np-inline-name' : 'np-name');
  const name = el ? el.value.trim() : '';
  if(name.length < 2){ toast('Give the campaign a name.', true); if(el) el.focus(); return; }
  try{
    const j = await api('projectCreate', { name, client: (document.getElementById('np-client')||{}).value || '' });
    projects.push(j.project);
    projLoaded = true;
    toast('Campaign “' + esc(name) + '” created.');
    if(fromModal){
      /* fold the inline form away and select the new campaign on the task */
      const sel = document.getElementById('n-project');
      if(sel){
        const o = document.createElement('option');
        o.value = name; o.textContent = name; sel.appendChild(o); sel.value = name;
      }
      const box = document.getElementById('np-inline'); if(box) box.style.display = 'none';
    } else {
      closeModal();
      openProject(name);
    }
  }catch(err){ toast(esc(err.message), true); }
}

function openNewProjectModal(){
  closeAddPill();
  $('#overlay').innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:440px">
    <h2>New campaign</h2>
    <div class="msub">Group a set of tasks — a launch, a film, an event — so they can be tracked together.</div>
    <div class="fgrid">
      <div class="field f-full"><label>Campaign name</label><input id="np-name" placeholder="Great White Launch" maxlength="80"></div>
      <div class="field f-full"><label>Client <span style="font-weight:400;text-transform:none;letter-spacing:0">· optional</span></label><input id="np-client" placeholder="Great White Electricals" maxlength="80"></div>
    </div>
    <div class="mact"><button class="btn btn-g" onclick="closeModal()">Cancel</button>
      <button class="btn btn-p" onclick="createProject(false)">Create campaign</button></div>
  </div>`;
  $('#overlay').classList.add('open');
  const i = document.getElementById('np-name'); if(i) i.focus();
}

/* ── the campaign list ── */

function projCardHtml_(p){
  const pct = p.counts.total ? Math.round((p.counts.done / p.counts.total) * 100) : 0;
  return `<button class="pj-card" onclick="openProject(${esc(JSON.stringify(p.name))})">
      <span class="pj-bar" style="background:${esc(p.colour)}"></span>
      <span class="pj-body">
        <span class="pj-top">
          <span class="pj-name">${esc(p.name)}</span>
          ${p.status !== 'Active' ? `<span class="chip">${esc(p.status)}</span>` : ''}
        </span>
        ${p.client ? `<span class="pj-client">${esc(p.client)}</span>` : ''}
        <span class="pj-stats">
          <b>${p.counts.open}</b> open
          ${p.counts.overdue ? `<span class="pj-od">⚠ ${p.counts.overdue} overdue</span>` : ''}
          <span class="pj-done">${p.counts.done}/${p.counts.total} done</span>
        </span>
        <span class="pj-track"><span class="pj-fill" style="width:${pct}%;background:${esc(p.colour)}"></span></span>
      </span>
    </button>`;
}

function viewProjectList_(){
  const canAdd = isHead() || isAdmin() || isAssigner();
  if(!projLoaded && !projLoading) loadProjects(false);
  if(projLoading && !projects.length) return `<div class="panel"><div class="empty">Loading campaigns…</div></div>`;

  const unfiled = (state.tasks || []).filter(t => !String(t.project || '').trim() && !isClosed(t)).length;

  if(!projects.length){
    return `<div class="panel"><div class="empty">No campaigns yet.<br>
      <span style="color:var(--muted)">A campaign groups tasks that belong together — a launch, a film, an event.</span>
      ${canAdd ? `<div style="margin-top:16px"><button class="btn btn-p" onclick="openNewProjectModal()">＋ New campaign</button></div>` : ''}</div></div>`;
  }

  return `<div class="pj-head">
      <span class="g-count">${projects.length} campaign${projects.length===1?'':'s'}</span>
      ${canAdd ? `<button class="btn btn-p" onclick="openNewProjectModal()">＋ New campaign</button>` : ''}
    </div>
    <div class="pj-grid">${projects.map(projCardHtml_).join('')}</div>
    ${unfiled ? `<div class="pj-unfiled">${unfiled} open task${unfiled===1?'':'s'} ${unfiled===1?'is':'are'} not in a campaign yet — open a task and pick one under <b>Campaign</b>.</div>` : ''}`;
}

/* ── one campaign ── */

function projOverviewHtml_(p, ts){
  const open = ts.filter(t => !isClosed(t));
  const soon = open.filter(t => t.due).sort((a,b) => a.due - b.due).slice(0, 5);
  const people = {};
  open.forEach(t => { const w = t.assignee || '—'; people[w] = (people[w] || 0) + 1; });
  const roster = Object.keys(people).sort((a,b) => people[b] - people[a]);
  const pct = p.counts.total ? Math.round((p.counts.done / p.counts.total) * 100) : 0;

  return `<div class="panel">
      <div class="kpis" style="margin-bottom:16px">
        ${statTile_('Open', p.counts.open)}
        ${statTile_('Overdue', p.counts.overdue)}
        ${statTile_('In review', p.counts.inReview)}
        ${statTile_('Done', p.counts.done, 'of ' + p.counts.total)}
      </div>
      <div class="pj-track" style="height:8px"><span class="pj-fill" style="width:${pct}%;background:${esc(p.colour)}"></span></div>
      <div class="hint" style="margin-top:8px">${pct}% of this campaign is finished.</div>
    </div>
    <div class="ov-grid">
      <div class="panel">
        <div class="p-h"><h3>Next deadlines</h3></div>
        ${soon.length ? soon.map(t => rowHtml(t, true)).join('') : '<div class="empty">Nothing scheduled.</div>'}
      </div>
      <div class="panel">
        <div class="p-h"><h3>Who's on it</h3></div>
        ${roster.length ? roster.map(nm => `<div class="trow" style="cursor:default">
            ${av(nm, 26)}<span class="tt">${esc(nm)}</span>
            <span class="due ok">${people[nm]} open</span></div>`).join('')
          : '<div class="empty">Nobody has open work here.</div>'}
      </div>
    </div>`;
}

function projTasksHtml_(ts){
  if(!ts.length) return `<div class="panel"><div class="empty">No tasks in this campaign yet.<br>
    <span style="color:var(--muted)">Use <b>＋ Add task</b> above and it will be filed here automatically.</span></div></div>`;
  const sorted = ts.slice().sort((a,b) => {
    const ac = isClosed(a) ? 1 : 0, bc = isClosed(b) ? 1 : 0;
    if(ac !== bc) return ac - bc;
    return (a.due ? a.due.getTime() : Infinity) - (b.due ? b.due.getTime() : Infinity);
  });
  const td = (v, extra) => `<td style="padding:7px 10px;border-bottom:1px solid var(--line);${extra||''}">${v}</td>`;
  return `<div class="panel">
    <div class="tbl-wrap" style="overflow-x:auto"><table class="tasks"><thead><tr>
      <th>Task</th><th>Team</th><th>Assigned to</th><th>Status</th><th>Due</th>
    </tr></thead><tbody>${sorted.map(t => `<tr onclick="openTaskModal('${t.id}')" style="cursor:pointer">
        ${td(`<b>${esc(t.title)}</b><br><small style="color:var(--muted)">${esc(t.id)}</small>`)}
        ${td(tdot(t.team) + esc(t.team))}
        ${td(t.assignee ? esc(t.assignee) : '<span style="color:var(--muted)">unassigned</span>')}
        ${td(schip(t))}
        ${td(dueLabel(t), isOverdue(t) ? 'color:var(--accent);font-weight:600' : '')}
      </tr>`).join('')}</tbody></table></div>
    <div class="mob-list">${sorted.map(t => rowHtml(t, true)).join('')}</div>
  </div>`;
}

function projGalleryHtml_(){
  if(pgal.loading && !pgal.items.length) return `<div class="panel"><div class="empty">Loading finished work…</div></div>`;
  if(!pgal.items.length) return `<div class="panel"><div class="empty">Nothing finished in this campaign yet.<br>
    <span style="color:var(--muted)">Approved work with a file attached appears here automatically.</span></div></div>`;
  return `<div class="g-count">${pgal.total} finished ${pgal.total===1?'piece':'pieces'}</div>
    <div class="gallery">${pgal.items.map((it,i) => galCard_(it, i, 'pgal')).join('')}</div>`;
}

function projNotesHtml_(){
  const me = state.me ? state.me.name : '';
  return `<div class="panel">
      <div class="p-h"><h3>Campaign notes</h3></div>
      <div class="pn-compose">
        <textarea id="pn-text" rows="3" placeholder="Brief, decisions, client feedback — anything the team should find here later…"></textarea>
        <button class="btn btn-p" onclick="addProjNote(this)">Add note</button>
      </div>
    </div>
    <div class="panel">
      ${projNotes.loading && !projNotes.items.length ? '<div class="empty">Loading…</div>'
        : !projNotes.items.length ? '<div class="empty">No notes yet — the first one sets the context for everyone else.</div>'
        : projNotes.items.map(nt => `<div class="pn">
            <div class="cm-av" style="background:${memColor(nt.author)}">${initials(nt.author)}</div>
            <div class="pn-b">
              <div class="cm-m"><b>${esc(nt.author)}</b> · ${rvWhen(nt.created)}</div>
              <div class="pn-t">${esc(nt.text)}</div>
            </div>
            ${(nt.author === me || isHead() || isAdmin()) ? `<button class="mk-btn" title="Remove" onclick="delProjNote('${nt.id}', this)">✕</button>` : ''}
          </div>`).join('')}
    </div>`;
}

function viewProjects(){
  if(!projPick) return viewProjectList_();

  const p = projByName_(projPick) || { name: projPick, colour: 'var(--muted)', client: '', status: 'Active',
    counts: { total: 0, open: 0, overdue: 0, inReview: 0, done: 0 } };
  const ts = projTasks_(projPick);
  const canEdit = isHead() || isAdmin() || isAssigner();

  const SUBS = [['overview','Overview'], ['tasks','Tasks'], ['gallery','Gallery'], ['notes','Notes']];
  const body = projSub === 'tasks' ? projTasksHtml_(ts)
    : projSub === 'gallery' ? projGalleryHtml_()
    : projSub === 'notes' ? projNotesHtml_()
    : projOverviewHtml_(p, ts);

  return `<div class="pj-hero" style="border-left:4px solid ${esc(p.colour)}">
      <button class="btn btn-g pj-back" onclick="closeProject()">← All campaigns</button>
      <div class="pj-hero-t">
        <div class="pj-hero-name">${esc(p.name)}</div>
        <div class="pj-hero-sub">${p.client ? esc(p.client) + ' · ' : ''}${p.counts.total} task${p.counts.total===1?'':'s'}${p.counts.overdue ? ' · <b style="color:var(--accent)">' + p.counts.overdue + ' overdue</b>' : ''}</div>
      </div>
      <div class="pj-hero-a">
        ${canEdit ? `<select class="mini-sel" onchange="setProjStatus(this.value)" title="Campaign status">
            ${['Active','On Hold','Done'].map(s => `<option ${p.status===s?'selected':''}>${s}</option>`).join('')}
          </select>` : ''}
        <button class="btn btn-p" onclick="openNewTaskModal(${esc(JSON.stringify(projPick))})">＋ Add task</button>
      </div>
    </div>
    <div class="filters pj-subs">${SUBS.map(([id,label]) =>
      `<button class="btn ${projSub===id?'btn-p':''}" onclick="setProjSub('${id}')">${label}</button>`).join('')}</div>
    ${body}`;
}

/* ── the mobile add pill ──────────────────────────────────────────────────
   One ＋ used to mean one thing. Now it can start a task or a campaign, so it
   opens into a short menu that shuffles out from under the button. */

function openAddPill(){
  if(document.getElementById('add-pill')) return closeAddPill();
  const canProject = isHead() || isAdmin() || isAssigner();
  const scrim = document.createElement('div');
  scrim.className = 'add-scrim';
  scrim.id = 'add-scrim';
  scrim.onclick = closeAddPill;
  const pill = document.createElement('div');
  pill.className = 'add-pill';
  pill.id = 'add-pill';
  pill.innerHTML = `<button onclick="openNewTaskModal()"><span class="ic">☰</span>Add task</button>
    ${canProject ? `<button onclick="openNewProjectModal()"><span class="ic">◈</span>Add campaign</button>` : ''}`;
  document.body.appendChild(scrim);
  document.body.appendChild(pill);
  requestAnimationFrame(() => { scrim.classList.add('on'); pill.classList.add('on'); });
  const btn = document.querySelector('#tabbar .tb-new'); if(btn) btn.classList.add('open');
}

function closeAddPill(){
  const s = document.getElementById('add-scrim'); if(s) s.remove();
  const p = document.getElementById('add-pill'); if(p) p.remove();
  const btn = document.querySelector('#tabbar .tb-new'); if(btn) btn.classList.remove('open');
}

Object.assign(window, { cleanUrl_, applyTheme, dark, teamColor, avTextColor, isClosed, isOverdue, fmtD, fmtT, fmtDT, dueLabel, initials, member, memColor, av, isAdmin, isHead, canManage, isAssigner, isMyRequest, canDecide, roleLabel, toast, pchip, schip, tdot, setSync, postApi_, api, friendlyError_, testConnection, parseTask, upsert, fetchAllTasksPaged_, loadTasksFirstFast_, refreshTasks, canUseGoogle, fetchPing, loginScreenOta_, autoUpdateOn, toggleAutoUpdate, updateAvailable, isDesktopApp, verGt, installLatest, maybeSelfUpdate, setLoginBusy, showLogin, bootstrapAndEnter, doLogin, enterApp, logout, TAB_DEFS_, renderNav, renderTop, notifs, notifItemsHtml, bindNotifClicks, renderNotifPanel, d0, greetWord, odStrip, rowHtml, viewOverview, miniCalHtml, jumpToDate, mondayOf0_, viewTasks, mondayOf, viewCalendar, bindCalendarDrag, dayColAt, viewReportsCharts, openTaskModal, saveTask, quickStatus, deleteTaskClick, assignTask, openNewTaskModal, createTask, closeModal, canDriveUpload, uplCentral, pickUpload, startUpload, uplStatus, cancelUpload, renderUplCard, tcStr, parseTc, toLocalDT, rvWhen, rvTask, rvManage, rvMine, detectMedia, openReview, closeReview, renderReview, toggleViewAs, mediaHtml, imgFail, dvvFail, loadYT, ytFallback, renderTools, renderSide, updatePins, renderCompose, imgClick, addMarkerAtCurrent, cancelForm, saveForm, postComment, gotoItem, resolveMk, delReview, setSendLabel, sendChangesClick, saveDeliverable, shareUrl, toggleShare, renderShare, createShareClick, copyShare, revokeShareClick, bootGuest, pollGuest, setReportPeriod, periodStart_, reportStatsHtml, viewReports, bulkTemplateHref, openBulkModal, previewBulk, submitBulk, hasFlagC, setViewVersion, simpleAction_, startTaskClick, acceptChangesClick, qcPassClick, renewTaskClick, holdTaskClick, acceptBriefClick, reviewBuckets, reviewBadge, rvqRow, viewReview, rejectTaskClick, renderContent, renderAll });
