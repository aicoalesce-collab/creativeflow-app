/**
 * reports.js — organisation-wide numbers for Team Heads and Super Admins.
 *
 * A Team Head's task scope is deliberately their own team: they must not be
 * able to read another team's briefs, deliverables or notes. This action gives
 * them the COUNTS across every team without any of that — aggregates only, no
 * titles, no links, no per-task rows. That's the whole point of it being a
 * separate action rather than widening scopedRows_.
 */

function apiTeamStats_(user, req) {
  if (['Team Head', 'Super Admin'].indexOf(user.role) === -1) {
    return { ok: false, error: 'FORBIDDEN', message: 'Team-wide reports are for team heads and admins.' };
  }
  const days = Math.min(3650, Math.max(1, Math.floor(Number(req.days) || 30)));
  const from = Date.now() - days * 86400000;

  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  const rows = master.getLastRow() < 2 ? []
    : master.getRange(2, 1, master.getLastRow() - 1, LAST_COL2).getValues().filter(r => r[COL.ID - 1]);

  const teamsWanted = teams_().map(t => t.team);
  const blank = function (name, team) {
    return { name: name, team: team || '', open: 0, overdue: 0, inReview: 0, done: 0, rejected: 0,
             onTime: 0, closedWithDue: 0, rounds: 0, roundsTasks: 0, turnaroundDays: 0, turnaroundTasks: 0 };
  };
  const byTeam = {}; teamsWanted.forEach(t => byTeam[t] = blank(t, t));
  const byPerson = {};
  const active = roster_().filter(m => m.active && m.role !== 'Super Admin' && m.role !== 'Assigner');
  active.forEach(m => byPerson[m.name] = blank(m.name, m.team));

  const now = Date.now();
  rows.forEach(function (r) {
    const team = String(r[COL.TEAM - 1]).trim();
    const who = String(r[COL.ASSIGNEE - 1]).trim();
    const status = String(r[COL.STATUS - 1]).trim();
    const closed = status === 'Done' || status === 'Rejected';
    const completed = r[COL.COMPLETED - 1] instanceof Date ? r[COL.COMPLETED - 1].getTime() : null;
    const due = dueDateTime_(r[COL.DUE_DATE - 1], r[COL.DUE_TIME - 1]);
    const started = r[X.STARTED - 1] instanceof Date ? r[X.STARTED - 1].getTime() : null;

    const buckets = [];
    if (byTeam[team]) buckets.push(byTeam[team]);
    if (byPerson[who]) buckets.push(byPerson[who]);
    if (!buckets.length) return;

    buckets.forEach(function (b) {
      if (!closed) {
        b.open++;
        if (status === 'In Review') b.inReview++;
        else if (status !== 'On Hold' && due && due.getTime() < now) b.overdue++;
      }
      if (completed && completed >= from) {
        if (status === 'Done') b.done++;
        const rounds = Number(r[COL.REVISIONS - 1]) || 0;
        b.rounds += rounds; b.roundsTasks++;
        if (due) { b.closedWithDue++; if (completed <= due.getTime()) b.onTime++; }
        if (started) { b.turnaroundDays += (completed - started) / 86400000; b.turnaroundTasks++; }
      }
      if (status === 'Rejected' && completed && completed >= from) b.rejected++;
    });
  });

  const finish = function (b) {
    return {
      name: b.name, team: b.team, open: b.open, overdue: b.overdue, inReview: b.inReview,
      done: b.done, rejected: b.rejected,
      onTimePct: b.closedWithDue ? Math.round((b.onTime / b.closedWithDue) * 100) : null,
      avgRounds: b.roundsTasks ? Math.round((b.rounds / b.roundsTasks) * 10) / 10 : null,
      avgTurnaroundDays: b.turnaroundTasks ? Math.round((b.turnaroundDays / b.turnaroundTasks) * 10) / 10 : null,
    };
  };

  return {
    ok: true, days: days,
    teams: teamsWanted.map(t => finish(byTeam[t])),
    people: active.map(m => finish(byPerson[m.name])).filter(p => p.open || p.done || p.rejected),
    serverTime: new Date().toISOString(),
  };
}
