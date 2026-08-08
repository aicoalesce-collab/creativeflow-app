/**
 * auth.js — roster email + 6-char access code. Nothing else.
 *
 * Google login (googleLogin/desktopOauth) is DELIBERATELY not ported: it was
 * removed from the UI in 4.9.2 at the owner's explicit order, and the old
 * server actions leaked the desktop client secret + members' access codes to
 * unauthenticated callers. Do not re-add.
 */

function apiAuth_(email, code) {
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim().toUpperCase();
  if (!email || !code) return null;
  const hit = rosterWithCodes_().filter(m => m.active && m.email === email && m.code && m.code.toUpperCase() === code);
  return hit.length ? hit[0] : null;
}

function canManage_(user, team) {
  return user.role === 'Super Admin' || (user.role === 'Team Head' && user.team === team);
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

function randomCode_() {
  let code = '';
  for (let k = 0; k < 6; k++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return code;
}

/** Fills Roster column G with a personal code for each active member and emails
 *  everyone their code. Existing codes are NEVER changed (migration carries the
 *  old codes over, so the whole team keeps their muscle memory). */
function generateAccessCodes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEETS.ROSTER);
  if (sh.getRange('G1').getValue() !== 'Access Code') {
    sh.getRange('G1').setValue('Access Code').setFontWeight('bold').setBackground('#263238').setFontColor('#ffffff');
  }
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const data = sh.getRange(2, 1, last - 1, 7).getValues();
  let made = 0;
  data.forEach((r, i) => {
    const email = String(r[1]).trim();
    const active = String(r[5]).trim().toLowerCase() === 'yes';
    if (!r[0] || !email || email.indexOf('@example.com') !== -1 || !active) return;
    let code = String(r[6]).trim();
    if (!code) {
      code = randomCode_();
      sh.getRange(i + 2, 7).setValue(code);
      made++;
    }
    safeSend_(email, '[Task] 🔑 Your CreativeFlow login',
      baseCard_('#1a73e8', 'Your access code',
        '<p>Open CreativeFlow and sign in with:</p>' +
        '<p>Email: <b>' + esc_(email) + '</b><br>Access code: <b style="font-size:19px;letter-spacing:3px">' + esc_(code) + '</b></p>' +
        '<p>Keep it private — it identifies you and controls what you can edit.</p>'), '');
  });
  flushMailQueue_();
  log_('codes', '', '', made + ' new codes minted', true);
  return made;
}

/** Creates an access code for one roster member who doesn't have one yet. */
function mintCodeFor_(email) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROSTER);
  const last = sh.getLastRow();
  if (last < 2) return '';
  const data = sh.getRange(2, 1, last - 1, 7).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][1]).trim().toLowerCase() === String(email).trim().toLowerCase()) {
      let code = String(data[i][6]).trim();
      if (!code) {
        code = randomCode_();
        sh.getRange(i + 2, 7).setValue(code);
      }
      return code;
    }
  }
  return '';
}
