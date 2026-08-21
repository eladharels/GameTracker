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

// Short label for a bucket key, for a cramped axis.
//
// January carries the year, so a series crossing a boundary is not twelve unlabelled
// months followed by twelve more. Everything else stays short — a 26px slot cannot hold
// "Aug 2025".
export function bucketLabel(key, period) {
  if (period === 'year') return key;
  if (period === 'month') {
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    const short = d.toLocaleDateString(undefined, { month: 'short' });
    return m === '01' ? `${short} \u2019${y.slice(2)}` : short;
  }
  const [y, m, day] = key.split('-');
  const d = new Date(Number(y), Number(m) - 1, Number(day));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// UNAMBIGUOUS label, for the visually-hidden data table.
//
// The axis may abbreviate because a sighted reader has the sequence to orient by. A
// screen-reader user gets a flat list of rows, so three years of monthly buckets read
// "Aug, Sep, ... Jul, Aug, Sep, ..." with nothing to tell 2024 from 2026 — the one
// artefact that exists to carry this data to them could not distinguish them.
export function bucketFullLabel(key, period) {
  if (period === 'year') return key;
  if (period === 'month') {
    const [y, m] = key.split('-');
    return new Date(Number(y), Number(m) - 1, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  const [y, m, day] = key.split('-');
  const d = new Date(Number(y), Number(m) - 1, Number(day));
  return `week of ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

// --- durations ---------------------------------------------------------------------
//
// How long something took, in words. Shared for the same reason the bucketing above is:
// the library card, the detail modal and the statistics page all state the SAME number,
// and three roundings of "32 days" into "1 month" / "1.1 months" / "4 weeks" is exactly
// the drift this file exists to prevent.
//
// null in, null out. A duration that is not known must reach the page as null and render
// as an em dash — never as 0, which reads as "finished the same day" and is a different
// claim entirely. Every caller here has a real "we do not know" case: a game finished
// without ever passing through `playing`, or one already in progress when tracking began.

// The compact form, for a badge with no room: '3d', '2w', '5mo', '1.4y'.
export function formatDurationShort(days) {
  if (days == null || !Number.isFinite(days)) return null;
  if (days < 1) return '<1d';
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

// The sentence form, for prose and tooltips: 'about 1 month', '3 weeks', 'less than a day'.
//
// Deliberately approximate above a fortnight, and it says so with "about". Reporting
// "1 month and 2 days" implies a precision the source does not have — the event log
// records when a status CHANGED, not when the person actually stopped playing, and a
// game marked done a week late is indistinguishable from one finished that morning.
export function formatDurationLong(days) {
  if (days == null || !Number.isFinite(days)) return null;
  // 'less than a day', NOT 'the same day': the callers prefix it, and "Playing for the
  // same day" is not a sentence.
  if (days < 1) return 'less than a day';
  const n = Math.round(days);
  if (n === 1) return '1 day';
  if (days < 14) return `${n} days`;
  // The month boundary is 30, not 60. A game started in March and finished in April
  // took "about a month" to everyone who played it; reporting "5 weeks" is arithmetically
  // defensible and reads as though the app is avoiding the word.
  if (days < 30) {
    const w = Math.round(days / 7);
    return `about ${w} week${w === 1 ? '' : 's'}`;
  }
  if (days < 365) {
    const m = Math.round(days / 30);
    return `about ${m} month${m === 1 ? '' : 's'}`;
  }
  const y = days / 365;
  return `about ${y.toFixed(1)} years`;
}

// One date format for every surface that shows a recorded instant.
//
// This file already exists so two pages cannot disagree about which day an instant
// belongs to; they were still disagreeing about how to WRITE it. The statistics page
// rendered "21 Aug 2026" in its coverage banner and "8/21/2026" in the game rows
// directly below, because the rows called `toLocaleDateString()` raw — as did the card
// tooltips and the modal timeline. Locale-aware, explicit fields, one implementation.
export function formatDateReadable(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// The same instant WITH a time, for the timeline.
//
// A date alone cannot order two transitions on the same day, and `backlog -> playing ->
// done` in one sitting is ordinary. Two identical date strings with no tiebreak read as
// a duplicate row rather than as a sequence.
export function formatDateTimeReadable(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// The five statuses as PROSE. The stored values are lowercase database tokens, and the
// modal's timeline was rendering them raw ("wishlist → playing") beside its own KICKER
// map and the statistics page's STATUS_LABEL, which both capitalise. Three spellings of
// five words.
export const STATUS_PROSE = Object.freeze({
  wishlist: 'Wishlist',
  playing: 'Playing',
  done: 'Done',
  backlog: 'Backlog',
  unreleased: 'Unreleased',
});

export const statusProse = (s) => STATUS_PROSE[s] || s;
