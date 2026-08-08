/**
 * shares.js — revocable guest links (view or comment). 26-char tokens.
 */

const SHARE_HEADERS = ['Token', 'Task ID', 'Mode', 'Created By', 'Created', 'Revoked'];

function sharesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.SHARES);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.SHARES);
    sh.getRange(1, 1, 1, SHARE_HEADERS.length).setValues([SHARE_HEADERS])
      .setFontWeight('bold').setBackground('#455a64').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function apiCreateShare_(user, req) {
  const taskId = String(req.taskId || '').trim();
  const t = taskRowIfAllowed_(user, taskId);
  if (t.err) return t.err;
  if (!t.own) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can create share links.' };
  const mode = (String(req.mode) === 'comment') ? 'comment' : 'view';
  /* 12 chars of a 54-char alphabet ≈ 10^20 combinations — unguessable, and
     short enough that the whole share link fits in a message. Older 26-char
     tokens keep working; only newly minted ones are short. */
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 12; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
  sharesSheet_().appendRow([token, taskId, mode, user.name, new Date(), '']);
  log_('share-create', taskId, user.email, mode, true);
  return { ok: true, token: token, mode: mode };
}

function apiRevokeShare_(user, req) {
  const sh = sharesSheet_();
  if (sh.getLastRow() < 2) return { ok: false, error: 'NOT_FOUND', message: 'Link not found.' };
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, SHARE_HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(req.token || '')) {
      const t = taskRowIfAllowed_(user, String(data[i][1]));
      if (t.err) return t.err;
      if (!t.own) return { ok: false, error: 'FORBIDDEN', message: 'Only the team head, super admin or the task\'s requester can revoke links.' };
      sh.getRange(i + 2, 6).setValue('Yes');
      return { ok: true, revoked: String(req.token) };
    }
  }
  return { ok: false, error: 'NOT_FOUND', message: 'Link not found.' };
}

function shareByToken_(token) {
  const sh = sharesSheet_();
  if (sh.getLastRow() < 2) return null;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, SHARE_HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === token && String(data[i][5]) !== 'Yes') {
      return { token: token, taskId: String(data[i][1]), mode: String(data[i][2]) };
    }
  }
  return null;
}
