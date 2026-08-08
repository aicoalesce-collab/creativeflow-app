/**
 * mirrors.js — Dashboard formulas + per-team and per-member FILTER mirrors.
 */

function buildTeamTabs_(ss) {
  teams_().forEach(t => {
    const name = t.team + TEAM_TAB_SUFFIX;
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, 1, VISIBLE_COLS).setValues([HEADERS.slice(0, VISIBLE_COLS)])
      .setFontWeight('bold').setBackground('#004d40').setFontColor('#ffffff');
    sh.getRange('A2').setFormula(
      `=IFERROR(SORT(FILTER('${SHEETS.MASTER}'!A2:S, '${SHEETS.MASTER}'!D2:D="${t.team}"), 12, TRUE), "No tasks yet")`);
    sh.setFrozenRows(1);
  });
}

/** Creates / refreshes one read-only tab per active roster member. */
function rebuildMemberTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const members = roster_().filter(m => m.active && m.name && m.name.indexOf('Sample') !== 0);
  const wanted = {};
  members.forEach(m => {
    const tabName = MEMBER_TAB_PREFIX + m.name;
    wanted[tabName] = true;
    let sh = ss.getSheetByName(tabName);
    if (!sh) sh = ss.insertSheet(tabName);
    sh.clear();
    sh.getRange(1, 1, 1, VISIBLE_COLS).setValues([HEADERS.slice(0, VISIBLE_COLS)])
      .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
    sh.getRange('A2').setFormula(
      `=IFERROR(SORT(FILTER('${SHEETS.MASTER}'!A2:S, '${SHEETS.MASTER}'!E2:E="${m.name}"), 12, TRUE), "No tasks assigned right now 🎉")`);
    sh.setFrozenRows(1);
  });
  // Remove tabs for people no longer in the roster
  ss.getSheets().forEach(sh => {
    const n = sh.getName();
    if (n.indexOf(MEMBER_TAB_PREFIX) === 0 && !wanted[n]) ss.deleteSheet(sh);
  });
}

function buildDashboard_(ss) {
  let sh = ss.getSheetByName(SHEETS.DASH);
  if (!sh) sh = ss.insertSheet(SHEETS.DASH);
  sh.clear();
  const M = `'${SHEETS.MASTER}'`;

  sh.getRange('A1').setValue('📊 TASK COMMAND CENTER').setFontSize(16).setFontWeight('bold');
  sh.getRange('A3:F3').setValues([['Open tasks', 'Overdue now', 'Due today', 'Due in 7 days', 'Done this month', 'On-time % (30d)']])
    .setFontWeight('bold').setBackground('#1a237e').setFontColor('#ffffff');
  sh.getRange('A4').setFormula(`=COUNTIFS(${M}!A2:A,"<>",${M}!K2:K,"<>Done")`);
  sh.getRange('B4').setFormula(`=COUNTIF(${M}!N2:N,"*OVERDUE*")`);
  sh.getRange('C4').setFormula(`=COUNTIFS(${M}!A2:A,"<>",${M}!K2:K,"<>Done",${M}!L2:L,">="&TODAY(),${M}!L2:L,"<"&TODAY()+1)`);
  sh.getRange('D4').setFormula(`=COUNTIFS(${M}!A2:A,"<>",${M}!K2:K,"<>Done",${M}!L2:L,">="&TODAY(),${M}!L2:L,"<"&TODAY()+7)`);
  sh.getRange('E4').setFormula(`=COUNTIFS(${M}!O2:O,">="&EOMONTH(TODAY(),-1)+1)`);
  sh.getRange('F4').setFormula(`=IFERROR(COUNTIFS(${M}!P2:P,"*On time*",${M}!O2:O,">="&TODAY()-30)/COUNTIFS(${M}!O2:O,">="&TODAY()-30),"—")`);
  sh.getRange('F4').setNumberFormat('0%');
  sh.getRange('A4:F4').setFontSize(14).setFontWeight('bold');

  // Per-team block
  let r = 6;
  sh.getRange(r, 1, 1, 5).setValues([['Team', 'Open', 'Overdue', 'Due 7 days', 'Done this month']])
    .setFontWeight('bold').setBackground('#004d40').setFontColor('#ffffff');
  teams_().forEach((t, i) => {
    const row = r + 1 + i;
    sh.getRange(row, 1).setValue(t.team);
    sh.getRange(row, 2).setFormula(`=COUNTIFS(${M}!D2:D,"${t.team}",${M}!K2:K,"<>Done",${M}!A2:A,"<>")`);
    sh.getRange(row, 3).setFormula(`=COUNTIFS(${M}!D2:D,"${t.team}",${M}!N2:N,"*OVERDUE*")`);
    sh.getRange(row, 4).setFormula(`=COUNTIFS(${M}!D2:D,"${t.team}",${M}!K2:K,"<>Done",${M}!L2:L,">="&TODAY(),${M}!L2:L,"<"&TODAY()+7)`);
    sh.getRange(row, 5).setFormula(`=COUNTIFS(${M}!D2:D,"${t.team}",${M}!O2:O,">="&EOMONTH(TODAY(),-1)+1)`);
  });

  // Per-member table (bounded to 25 rows so the arrays never collide below)
  r = 6 + teams_().length + 3;
  sh.getRange(r, 1, 1, 7).setValues([['Member', 'Team', 'Open', 'Overdue', 'Due 7 days', 'Done 30d', 'On-time % (30d)']])
    .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  const dr = r + 1;
  const AR = `$A${dr}:$A$${dr + 24}`;
  sh.getRange(dr, 1).setFormula(`=IFERROR(SORT(FILTER({'${SHEETS.ROSTER}'!A2:A, '${SHEETS.ROSTER}'!C2:C}, '${SHEETS.ROSTER}'!F2:F="Yes"), 2, TRUE),)`);
  sh.getRange(dr, 3).setFormula(`=ARRAYFORMULA(IF(${AR}="",,COUNTIFS(${M}!E2:E,${AR},${M}!K2:K,"<>Done",${M}!A2:A,"<>")))`);
  sh.getRange(dr, 4).setFormula(`=ARRAYFORMULA(IF(${AR}="",,COUNTIFS(${M}!E2:E,${AR},${M}!N2:N,"*OVERDUE*")))`);
  sh.getRange(dr, 5).setFormula(`=ARRAYFORMULA(IF(${AR}="",,COUNTIFS(${M}!E2:E,${AR},${M}!K2:K,"<>Done",${M}!L2:L,">="&TODAY(),${M}!L2:L,"<"&TODAY()+7)))`);
  sh.getRange(dr, 6).setFormula(`=ARRAYFORMULA(IF(${AR}="",,COUNTIFS(${M}!E2:E,${AR},${M}!O2:O,">="&TODAY()-30)))`);
  sh.getRange(dr, 7).setFormula(`=ARRAYFORMULA(IF(${AR}="",,IFERROR(COUNTIFS(${M}!E2:E,${AR},${M}!P2:P,"*On time*",${M}!O2:O,">="&TODAY()-30)/COUNTIFS(${M}!E2:E,${AR},${M}!O2:O,">="&TODAY()-30),"—")))`);
  sh.getRange(dr, 7, 50, 1).setNumberFormat('0%');

  // Live overdue list
  const or = dr + 26;
  sh.getRange(or, 1).setValue('🚨 OVERDUE RIGHT NOW').setFontWeight('bold').setFontColor('#c0392b');
  sh.getRange(or + 1, 1, 1, 6).setValues([['Task ID', 'Team', 'Assigned To', 'Task Title', 'Priority', 'Due Date']])
    .setFontWeight('bold').setBackground('#c0392b').setFontColor('#ffffff');
  sh.getRange(or + 2, 1).setFormula(
    `=IFERROR(SORT(FILTER({${M}!A2:A, ${M}!D2:D, ${M}!E2:E, ${M}!F2:F, ${M}!J2:J, ${M}!L2:L}, ${M}!N2:N<>""), 6, TRUE), "Nothing overdue 🎉")`);

  sh.setColumnWidths(1, 7, 150);
  sh.setColumnWidth(4, 260);
}

function orderSheets_(ss) {
  const order = [SHEETS.DASH, SHEETS.MASTER];
  order.reverse().forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(1); }
  });
}
