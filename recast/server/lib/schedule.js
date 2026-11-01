// Scheduling helpers: immediate, delay, and recurring time slots in the user's timezone.

/** Offset (ms) of `tz` from UTC at instant `date`. */
function tzOffset(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/** Convert a wall-clock time in `tz` to a UTC epoch ms. */
export function zonedTimeToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let ts = guess - tzOffset(new Date(guess), tz);
  // second pass handles DST boundaries
  ts = guess - tzOffset(new Date(ts), tz);
  return ts;
}

/** Wall-clock parts of instant `ts` in `tz`. */
export function zonedParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, wd };
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Next free slot after `from`.
 * schedule = { mode:'slots', days:[0-6], times:['09:00','17:30'] }
 * taken = Set of epoch ms already used on this destination.
 */
export function nextSlot(schedule, from, tz = 'UTC', taken = new Set()) {
  const days = (schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6]).map(Number);
  const times = (schedule.times || []).map((t) => String(t).match(/^(\d{1,2}):(\d{2})$/)).filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!times.length) return from;
  const start = zonedParts(from, tz);
  for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
    // advance calendar date using UTC math on the wall-clock date
    const base = new Date(Date.UTC(start.y, start.mo, start.d + dayOffset));
    const wd = base.getUTCDay();
    if (!days.includes(wd)) continue;
    for (const [h, mi] of times) {
      const ts = zonedTimeToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, mi, tz);
      if (ts > from && !taken.has(ts)) return ts;
    }
  }
  return from;
}

/** Compute when a post should go live. */
export function computeScheduledAt(schedule = {}, { now = Date.now(), tz = 'UTC', taken = new Set() } = {}) {
  switch (schedule.mode) {
    case 'delay': return now + Math.max(0, Number(schedule.minutes || 0)) * 60_000;
    case 'slots': return nextSlot(schedule, now, tz, taken);
    case 'at': return Math.max(now, Number(schedule.at) || now);
    default: return now;
  }
}
