/**
 * calendar.js — working-day calendar + deadline slots (tz-safe).
 * Config: WEEKLY_OFF, EXTRA_WORK_DATES, HOLIDAY_DATES, SLOT_EVE, SLOT_NOON.
 *
 * v5 fix vs old atLocal_: the old code did `new Date(y, m-1, d, h, m)` which is
 * only correct while the SCRIPT timezone equals the studio timezone. Every
 * local-time construction now goes through Utilities.parseDate with the Config
 * TIMEZONE, and setup() asserts script tz == sheet tz == Config tz anyway.
 */

function isWorkDay_(d) {
  const tz = tzStr_();
  const ymd = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  if (listCfg_('HOLIDAY_DATES').indexOf(ymd) > -1) return false;
  if (listCfg_('EXTRA_WORK_DATES').indexOf(ymd) > -1) return true;
  const off = String(cfg_('WEEKLY_OFF', 'Sunday')).split(',').map(function (s) { return s.trim(); });
  return off.indexOf(Utilities.formatDate(d, tz, 'EEEE')) === -1;
}

function nextWorkDay_(d) {
  let x = new Date(d.getTime());
  for (let i = 0; i < 30; i++) {
    x = new Date(x.getTime() + 86400000);
    if (isWorkDay_(x)) return x;
  }
  return x;
}

/** The instant of `hm` (e.g. '17:00') on d's calendar date, in the studio tz. */
function atLocal_(d, hm) {
  const tz = tzStr_();
  const ymd = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  let t = String(hm || '17:00');
  if (!/^\d{1,2}:\d{2}$/.test(t)) t = '17:00';
  try { return Utilities.parseDate(ymd + ' ' + t, tz, 'yyyy-MM-dd HH:mm'); }
  catch (e) {
    const p = ymd.split('-').map(Number), q = t.split(':').map(Number);
    return new Date(p[0], p[1] - 1, p[2], q[0] || 17, q[1] || 0, 0);
  }
}

/** Slot rule: changes sent before the evening slot on a working day → due today
 *  at SLOT_EVE; at/after it (or on an off day) → next working day at SLOT_NOON. */
function slotDue_(now) {
  const eve = String(cfg_('SLOT_EVE', '17:00'));
  const noon = String(cfg_('SLOT_NOON', '12:00'));
  const hhmm = Utilities.formatDate(now, tzStr_(), 'HH:mm');
  if (isWorkDay_(now) && hhmm < eve) return atLocal_(now, eve);
  return atLocal_(nextWorkDay_(now), noon);
}

/** Fractional working days between two instants (off days count zero). */
function workDaysBetween_(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || b <= a) return 0;
  let total = 0;
  let cur = new Date(a.getTime());
  for (let i = 0; i < 400 && cur < b; i++) {
    const dayStart = atLocal_(cur, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const sliceStart = Math.max(cur.getTime(), dayStart.getTime());
    const sliceEnd = Math.min(b.getTime(), dayEnd.getTime());
    if (sliceEnd > sliceStart && isWorkDay_(cur)) total += (sliceEnd - sliceStart) / 86400000;
    cur = dayEnd;
  }
  return total;
}
