// Date helpers shared by the calendar and the statistics page.
//
// Extracted rather than copied. Both pages bucket dates into calendar days, and two
// implementations of "which day is this" drift in exactly the way that is invisible
// until a month boundary — at which point two pages in the same app disagree about
// when July ended.

// A Date -> 'YYYY-MM-DD' in LOCAL time.
//
// The local part is the whole point. `new Date('2026-07-01')` parses as UTC midnight,
// so `.getMonth()` returns June for anyone west of UTC and `.toISOString().slice(0,10)`
// returns the wrong day for anyone east of it after ~21:00. Everything that buckets a
// real instant into a calendar day has to go through this.
export function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The Sunday that starts this date's week, in local time.
//
// SUNDAY, matching CalendarPage's `weekdayNames = ['Sun', ...]` and its use of
// getDay(). ISO weeks start on Monday and would have been the defensible other choice,
// but two pages in one app must not disagree about when a week begins.
export function startOfWeekLocal(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// The bucket key an instant falls into, for a given period. Keys sort
// lexicographically, which is why they are strings rather than Date objects.
export function bucketKey(date, period) {
  if (period === 'year') return String(date.getFullYear());
  if (period === 'week') return formatDateLocal(startOfWeekLocal(date));
  return formatDateLocal(date).slice(0, 7); // month
}

// Every bucket key from `from` to `to` inclusive, with no gaps.
//
// DENSE, deliberately. A month in which nothing was finished must render as a
// zero-height bar rather than being absent: a sparse series silently rescales the axis
// and makes a gap look like a different month, which is a chart that lies about its own
// x-axis. Returns [] when either bound is missing.
export function bucketRange(from, to, period) {
  if (!from || !to) return [];
  const keys = [];
  const cursor = period === 'week'
    ? startOfWeekLocal(from)
    : new Date(from.getFullYear(), period === 'year' ? 0 : from.getMonth(), 1);
  const end = bucketKey(to, period);
  // Bounded: a decade of weeks is ~520, and a corrupt date cannot spin forever.
  for (let i = 0; i < 4000; i++) {
    const key = bucketKey(cursor, period);
    keys.push(key);
    if (key >= end) break;
    if (period === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else if (period === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

// Human label for a bucket key.
export function bucketLabel(key, period) {
  if (period === 'year') return key;
  if (period === 'month') {
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'short' });
  }
  const [y, m, day] = key.split('-');
  return new Date(Number(y), Number(m) - 1, Number(day))
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
