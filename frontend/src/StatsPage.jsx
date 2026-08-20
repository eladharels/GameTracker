// Statistics: what the status-event log (migration 005) knows about when things
// happened, plus what the library itself says about its current shape.
//
// TWO SOURCES, DELIBERATELY. `/stats` answers only "when" — completions and durations,
// derived from events. Everything else (status mix, release years, provider mix) is
// computed here from the library response the app already fetches, because those
// numbers already exist there and a second server-side source for them would disagree
// the first time either changed.
//
// CHARTS ARE HAND-ROLLED, and the reason is theming rather than bundle size. The six
// accent presets work by mutating a CSS custom property at runtime (`--color-accent`),
// and everything downstream derives from it via color-mix. CSS and SVG inherit that for
// free; a canvas chart cannot, and would need to read getComputedStyle and re-render on
// every accent change or visibly desync from the page. That rules out the smaller
// canvas libraries on the merits, before bundle size is even discussed.
//
// THE ERROR STATE IS THE POINT OF THIS FILE'S STRUCTURE. Every number here is a derived
// count, so a failed load must render the error and NOTHING else — no chips reading 0,
// no empty axes, no "0 games finished this year". That is the same failure that made a
// user believe their library had been deleted, and on this page it would be worse: a
// confident zero is indistinguishable from a real one.

import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import {
  FaChartBar, FaExclamationCircle, FaSync, FaCheckCircle, FaPlay,
  FaList, FaRegCalendarAlt, FaHourglassHalf,
} from 'react-icons/fa';
import { useToast } from './contexts/ToastContext';
import { bucketKey, bucketRange, bucketLabel, bucketFullLabel, formatDurationShort, formatDurationLong } from './dateUtils';

const API_BASE = `${window.location.origin}/api`;

const PERIODS = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

// A NEUTRAL categorical ramp for series that are not statuses.
//
// --color-status-* may only ever mean its status. Painting providers and release years
// with them put the same blue on screen meaning "Wishlist" in one legend, "igdb" in
// another and "a release year" in between — three meanings, one colour, one screenful.
// These derive from --color-accent so they still follow the theme.
const CATEGORICAL = [
  'color-mix(in srgb, var(--color-accent) 85%, white 15%)',
  'color-mix(in srgb, var(--color-accent) 60%, white 40%)',
  'color-mix(in srgb, var(--color-accent) 45%, var(--color-fg-muted) 55%)',
  'color-mix(in srgb, var(--color-accent) 25%, var(--color-fg-muted) 75%)',
];

const STATUS_ORDER = ['playing', 'done', 'backlog', 'wishlist', 'unreleased'];
const STATUS_LABEL = {
  playing: 'Playing', done: 'Done', backlog: 'Backlog',
  wishlist: 'Wishlist', unreleased: 'Unreleased',
};

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// A number that is not known is not zero. Every KPI renders through this.
const orDash = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

// --- charts ------------------------------------------------------------------------
//
// Bars are CSS/flex; the donut is SVG. Both are fluid: this app's content box runs from
// ~340px on a phone to unbounded under the widescreen toggle, so a fixed pixel canvas
// breaks at both ends.

function BarChart({ data, color, ariaLabel, valueSuffix = '' }) {
  // CSS/flex, NOT SVG, and the reason is responsiveness rather than taste. An SVG with
  // a viewBox scales with preserveAspectRatio, which letterboxes a narrow chart into a
  // wide panel — the bars ended up clustered in the middle with empty space either
  // side. Filling the container correctly would mean measuring it with a ResizeObserver
  // and recomputing on every widescreen toggle. Percentage heights on flex children do
  // it for free, at any width from a 340px phone to an unbounded ultrawide, and inherit
  // the accent tokens exactly as the SVG did.
  const max = Math.max(1, ...data.map((d) => d.value));
  // Thin labels rather than overlapping them into mush.
  const every = data.length <= 16 ? 1 : Math.ceil(data.length / 12);
  return (
    <div className="stats-chart-scroll">
      <div
        className="stats-bars"
        role="img"
        aria-label={ariaLabel}
        style={{ minWidth: data.length > 16 ? `${data.length * 26}px` : undefined }}
      >
        {data.map((d, i) => (
          <div className="stats-bar-col" key={d.key} title={`${d.label}: ${d.value}${valueSuffix}`}>
            <div className="stats-bar-track">
              {d.value > 0 && <span className="stats-bar-num">{d.value}</span>}
              {/* Nothing at all for a zero bucket. A min-height hairline reads as a
                  small value, which is worse than the empty slot it replaces. */}
              {d.value > 0 && (
                <div
                  className="stats-bar-fill"
                  style={{ height: `${(d.value / max) * 100}%`, background: color }}
                />
              )}
            </div>
            <div className="stats-bar-label">{i % every === 0 ? d.label : '\u00a0'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Donut({ slices, ariaLabel }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg className="stats-donut" viewBox="0 0 140 140" role="img" aria-label={ariaLabel}>
      <g transform="translate(70,70) rotate(-90)">
        {total === 0 ? (
          <circle r={R} fill="none" strokeWidth="16" className="stats-donut-empty" />
        ) : slices.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * C;
          const el = (
            <circle key={s.key} r={R} fill="none" strokeWidth="16" stroke={s.color}
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}>
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </g>
      <text x="70" y="66" textAnchor="middle" className="stats-donut-total">{total}</text>
      <text x="70" y="84" textAnchor="middle" className="stats-donut-caption">games</text>
    </svg>
  );
}

// A table carrying the same numbers, for anyone who cannot see the chart. `role="img"`
// on an SVG hides its internals from assistive tech, so without this the data is
// unreachable rather than merely unlabelled.
function ChartData({ caption, rows, unit = '' }) {
  if (!rows.length) return null;
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}><th scope="row">{r.fullLabel || r.label}</th><td>{r.value}{unit}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

// --- page --------------------------------------------------------------------------

export default function StatsPage({ user }) {
  const [games, setGames] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(Boolean(user));
  const [loadError, setLoadError] = useState(null);   // null | {responded, status}
  const [retrying, setRetrying] = useState(false);
  const [period, setPeriod] = useState('month');
  const { showToast } = useToast();

  // Both requests together: the page is meaningless with one of them, so a partial
  // success is a failure. Promise.all rejects on the first, which is the behaviour we
  // want — rendering half a statistics page is how a number ends up unexplained.
  const fetchAll = useCallback(async () => {
    if (!user) return true;
    setLoadError(null);
    try {
      const t = Date.now();
      const [g, s] = await Promise.all([
        axios.get(`${API_BASE}/user/${user.username}/games?t=${t}`),
        axios.get(`${API_BASE}/user/${user.username}/stats?t=${t}`),
      ]);
      // Shape guards: a proxy answering with an HTML error page yields a string, and
      // rendering that as data is how a failure becomes a confident zero.
      if (!Array.isArray(g.data)) throw new Error('unexpected library response');
      // EVERY field the render dereferences, not just the arrays. `coverage` is read
      // unguarded further down, and with no error boundary anywhere in this app a
      // TypeError during render empties #root — no sidebar, no nav, no route back to
      // the library, just a white page. That is the deleted-library incident reproduced
      // by one absent field, and CLAUDE.md documents a six-second window on every
      // deploy where the SPA is served against an API that is not ready yet.
      if (!s.data || typeof s.data !== 'object'
          || !Array.isArray(s.data.completions)
          || !Array.isArray(s.data.durations)
          || !s.data.coverage || typeof s.data.coverage !== 'object'
          || typeof s.data.coverage.libraryDone !== 'number') {
        throw new Error('unexpected stats response');
      }
      setGames(g.data);
      setStats(s.data);
      return true;
    } catch (err) {
      setGames([]);
      setStats(null);
      setLoadError({ responded: Boolean(err?.response), status: err?.response?.status });
      return false;
    }
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAll().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchAll]);

  const retry = useCallback(async () => {
    setRetrying(true);
    const started = Date.now();
    const ok = await fetchAll();
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
    setRetrying(false);
    if (!ok) showToast('error', 'Still can\'t reach the server.');
  }, [fetchAll, showToast]);

  const derived = useMemo(() => {
    if (!stats) return null;
    const completions = stats.completions.map((c) => ({ ...c, date: new Date(c.at) }));

    // Buckets span from the first completion to today, so the current period is always
    // the last column even when nothing has been finished in it yet.
    const from = completions.length ? completions[0].date : null;
    const keys = bucketRange(from, new Date(), period);
    const counts = new Map(keys.map((k) => [k, 0]));
    for (const c of completions) {
      const k = bucketKey(c.date, period);
      if (counts.has(k)) counts.set(k, counts.get(k) + 1);
    }
    const series = keys.map((k) => ({
      key: k, label: bucketLabel(k, period), fullLabel: bucketFullLabel(k, period),
      value: counts.get(k),
    }));

    // Games ADDED per period. Unlike completions this has FULL history — added_at has
    // been on user_games since migration 004 — so on day one it is the one chart with
    // something in it. Nulls (rows predating 004) are excluded rather than bucketed as
    // "unknown", and the note under the chart says how many.
    const added = games
      .map((g) => (g.added_at ? new Date(g.added_at) : null))
      .filter((d) => d && !Number.isNaN(d.getTime()));
    const addedKeys = added.length
      ? bucketRange(new Date(Math.min(...added)), new Date(), period) : [];
    const addedCounts = new Map(addedKeys.map((k) => [k, 0]));
    for (const d of added) {
      const k = bucketKey(d, period);
      if (addedCounts.has(k)) addedCounts.set(k, addedCounts.get(k) + 1);
    }
    const addedSeries = addedKeys.map((k) => ({
      key: k, label: bucketLabel(k, period), fullLabel: bucketFullLabel(k, period),
      value: addedCounts.get(k),
    }));

    // WHICH games, not just how many. The service has returned these all along and the
    // page threw them away, which is why it could only ever answer "12" to "what have I
    // finished". Newest first: the question is almost always about the recent past.
    const durationByGame = new Map(stats.durations.map((d) => [d.gameId, d]));
    const finishedList = [...stats.completions].reverse().map((c) => ({
      ...c,
      duration: durationByGame.get(c.gameId) || null,
    }));
    const playingList = [...(stats.inProgress || [])];

    // Fastest and longest, with the GAME NAMED. "median 14d" tells you about a
    // distribution; "Hades, 3 days" tells you about your year. The tooltip carries the
    // name because the chip has room for one number and the number alone is trivia.
    const byLength = [...stats.durations].sort((a, b) => a.days - b.days);
    const fastest = byLength[0] || null;
    const longest = byLength.length > 1 ? byLength[byLength.length - 1] : null;

    const days = stats.durations.map((d) => d.days);
    // Fixed buckets rather than a computed range: "under a day" and "over a year" are
    // the two answers people actually want, and a linear axis over one 400-day outlier
    // squashes everything else into the first bar.
    const BANDS = [
      { key: 'd1', label: '<1d', test: (d) => d < 1 },
      { key: 'd3', label: '1-3d', test: (d) => d >= 1 && d < 3 },
      { key: 'd7', label: '3-7d', test: (d) => d >= 3 && d < 7 },
      { key: 'd14', label: '1-2w', test: (d) => d >= 7 && d < 14 },
      { key: 'd30', label: '2-4w', test: (d) => d >= 14 && d < 30 },
      { key: 'd90', label: '1-3m', test: (d) => d >= 30 && d < 90 },
      { key: 'd365', label: '3-12m', test: (d) => d >= 90 && d < 365 },
      { key: 'dmax', label: '1y+', test: (d) => d >= 365 },
    ];
    const histogram = BANDS.map((b) => ({
      key: b.key, label: b.label, value: days.filter(b.test).length,
    }));

    const statusCounts = STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS_LABEL[s],
      value: games.filter((g) => (g.status || '').toLowerCase() === s).length,
      color: `var(--color-status-${s})`,
    }));

    const years = new Map();
    for (const g of games) {
      // String slicing, never Date parsing: release_date is a bare YYYY-MM-DD and
      // `new Date(...)` would read it as UTC midnight, shifting the year for anyone
      // west of UTC on a 1 January release.
      const y = (g.release_date || '').slice(0, 4);
      const key = /^\d{4}$/.test(y) ? y : 'Unknown';
      years.set(key, (years.get(key) || 0) + 1);
    }
    const releaseYears = [...years.entries()]
      .sort((a, b) => (a[0] === 'Unknown' ? 1 : b[0] === 'Unknown' ? -1 : a[0].localeCompare(b[0])))
      .map(([k, v]) => ({
        key: k,
        label: k === 'Unknown' ? 'Unknown' : k,
        fullLabel: k === 'Unknown' ? 'Unknown release date' : k,
        value: v,
      }));

    const providers = new Map();
    for (const g of games) {
      const p = String(g.game_id || '').split('_')[0] || 'other';
      providers.set(p, (providers.get(p) || 0) + 1);
    }
    const providerMix = [...providers.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v], i) => ({ key: k, label: k, value: v, color: CATEGORICAL[i % CATEGORICAL.length] }));

    const thisBucket = bucketKey(new Date(), period);
    // NOTHING RECORDED YET is not the same fact as ZERO RECORDED THIS MONTH, and the
    // difference matters most on day one. Once the log has seen anything, a 0 is a real
    // observation and is shown. Before that it is an absence, and shows as an em dash.
    const observed = Boolean(stats.trackingSince);
    return {
      series,
      addedSeries,
      addedUnknown: games.length - added.length,
      finishedList,
      playingList,
      fastest,
      longest,
      histogram,
      statusCounts,
      releaseYears,
      providerMix,
      finishedThisPeriod: observed ? (counts.get(thisBucket) ?? 0) : null,
      medianDays: median(days),
      totalFinished: observed ? completions.length : null,
      inProgress: games.filter((g) => (g.status || '').toLowerCase() === 'playing').length,
      backlogDepth: games.filter((g) => (g.status || '').toLowerCase() === 'backlog').length,
    };
  }, [stats, games, period]);

  const periodNoun = period === 'week' ? 'week' : period === 'year' ? 'year' : 'month';

  if (loading) {
    return (
      <div className="stats-page">
          <div className="ss-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ss-card">
              <div className="skeleton-line skeleton-line--short" />
              <div className="skeleton-line skeleton-line--med" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Checked BEFORE anything else, and rendering nothing alongside it. Every figure on
  // this page is a derived count; showing chips at 0 next to an error message is the
  // same lie the error message is there to prevent.
  if (loadError) {
    return (
      <div className="stats-page">
        <div className="empty-state" role="alert">
          <FaExclamationCircle className="empty-state-icon empty-state-icon--error" aria-hidden="true" />
          <p className="empty-state-title">Couldn&apos;t load your statistics</p>
          <p className="empty-state-sub">
            Your games are safe — nothing in your library has changed.{' '}
            {loadError.responded
              ? `The server returned an error${loadError.status ? ` (${loadError.status})` : ''}.`
              : 'The server didn’t respond.'}
          </p>
          <button type="button" className="retry-btn" onClick={retry} disabled={retrying}>
            <FaSync className={retrying ? 'spin' : ''} aria-hidden="true" />
            {retrying ? ' Retrying…' : ' Try again'}
          </button>
        </div>
      </div>
    );
  }

  if (!games.length) {
    return (
      <div className="stats-page">
        <div className="empty-state">
          <FaChartBar className="empty-state-icon" aria-hidden="true" />
          <p className="empty-state-title">Nothing to chart yet</p>
          <p className="empty-state-sub">Add some games to your library and your statistics will appear here.</p>
        </div>
      </div>
    );
  }

  // stats and derived are set together or not at all, but that invariant lives in a
  // different function. One line here means a future reordering of the guards above
  // cannot white-screen the app — there is no error boundary to catch it if it does.
  if (!stats || !derived) return null;

  const cov = stats.coverage;
  const unrecorded = Math.max(0, cov.libraryDone - cov.recordedCompletions);

  return (
    <div className="stats-page">
      <div className="library-header">
        <h2 className="library-title">Statistics</h2>
        <div className="filter-bar stats-period" role="group" aria-label="Chart period">
          {PERIODS.map((p) => (
            <button key={p.value} type="button"
              className={`filter-btn ${period === p.value ? 'active' : ''}`}
              onClick={() => setPeriod(p.value)}
              aria-pressed={period === p.value}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* The single most important element on the page. Tracking began when migration
          005 deployed, so a library full of finished games reports almost none of them.
          Stating the gap is the difference between an honest empty chart and a page
          that implies you have achieved nothing. */}
      {unrecorded > 0 && (
        <div className="gt-alert gt-alert--info stats-coverage" role="status">
          <FaExclamationCircle aria-hidden="true" />
          <div>
            {stats.trackingSince ? (
              <>
                <strong>Completion tracking started on {fmtDate(stats.trackingSince)}.</strong>
                <br />
                {unrecorded} of your {cov.libraryDone} finished games were already done by
                then, so they have no completion date and do not appear in the charts below.
                Everything you finish from now on is counted.
              </>
            ) : (
              <>
                <strong>Completion tracking has just been switched on.</strong>
                <br />
                None of your {cov.libraryDone} finished games have a recorded date yet — the
                charts fill in as you play.
              </>
            )}
          </div>
        </div>
      )}

      <div className="library-stats-bar">
        <div className="stats-chip stats-chip--done">
          <FaCheckCircle aria-hidden="true" />
          <span>{orDash(derived.finishedThisPeriod)}</span>
          <small>this {periodNoun}</small>
        </div>
        <div className="stats-chip stats-chip--done">
          <FaChartBar aria-hidden="true" />
          <span>{orDash(derived.totalFinished)}</span>
          <small>recorded total</small>
        </div>
        <div className="stats-chip stats-chip--playing">
          <FaHourglassHalf aria-hidden="true" />
          <span>{derived.medianDays === null ? '—' : `${derived.medianDays}d`}</span>
          <small>median to finish</small>
        </div>
        <div className="stats-chip stats-chip--playing">
          <FaPlay aria-hidden="true" />
          <span>{orDash(derived.inProgress)}</span>
          <small>playing now</small>
        </div>
        {derived.fastest && (
          <div className="stats-chip stats-chip--done"
            title={`Fastest finish: ${derived.fastest.name || derived.fastest.gameId} — ${formatDurationLong(derived.fastest.days)}`}>
            <FaCheckCircle aria-hidden="true" />
            <span>{formatDurationShort(derived.fastest.days)}</span>
            <small>fastest finish</small>
          </div>
        )}
        {derived.longest && (
          <div className="stats-chip stats-chip--backlog"
            title={`Longest finish: ${derived.longest.name || derived.longest.gameId} — ${formatDurationLong(derived.longest.days)}`}>
            <FaHourglassHalf aria-hidden="true" />
            <span>{formatDurationShort(derived.longest.days)}</span>
            <small>longest finish</small>
          </div>
        )}
        <div className="stats-chip stats-chip--backlog">
          <FaList aria-hidden="true" />
          <span>{orDash(derived.backlogDepth)}</span>
          <small>in backlog</small>
        </div>
      </div>

      {/* THE TWO PANELS THAT NAME GAMES. Everything else on this page is a count; these
          answer "which one, and when" — which is the question the counts provoke and
          could not answer. Both come from data summary() already returned. */}
      <div className="ss-grid stats-lists">
        <div className="ent-section stats-panel">
          <div className="ent-section-header">
            <span className="ent-section-icon-wrap"><FaPlay aria-hidden="true" /></span>
            <h3>Playing now</h3>
          </div>
          {derived.playingList.length ? (
            <ul className="stats-gamelist">
              {derived.playingList.map((g) => (
                <li key={g.gameId} className="stats-gamerow">
                  <span className="stats-gamerow-name" title={g.name || g.gameId}>
                    {g.name || g.gameId}
                  </span>
                  <span className="stats-gamerow-meta">
                    {g.startedAt ? (
                      <>
                        <span className="stats-gamerow-when">
                          since {new Date(g.startedAt).toLocaleDateString()}
                        </span>
                        <span className="stats-dur stats-dur--playing"
                          title={`Playing for ${formatDurationLong(g.days)}`}>
                          {formatDurationShort(g.days)}
                        </span>
                      </>
                    ) : (
                      /* Already playing when tracking began. An em dash, never a 0 —
                         "we don't know when you started" is not "you started today". */
                      <span className="stats-gamerow-when stats-gamerow-when--unknown"
                        title="This game was already in progress before tracking began, so there is no start date to measure from.">
                        started before tracking &mdash;
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="stats-note">Nothing in progress. Set a game to <em>playing</em> and it appears here.</p>
          )}
        </div>

        <div className="ent-section stats-panel">
          <div className="ent-section-header">
            <span className="ent-section-icon-wrap"><FaCheckCircle aria-hidden="true" /></span>
            <h3>Recently finished</h3>
          </div>
          {derived.finishedList.length ? (
            <>
              <ul className="stats-gamelist">
                {derived.finishedList.slice(0, 12).map((c) => (
                  <li key={`${c.gameId}-${c.at}`} className="stats-gamerow">
                    <span className="stats-gamerow-name" title={c.name || c.gameId}>
                      {c.name || c.gameId}
                    </span>
                    <span className="stats-gamerow-meta">
                      <span className="stats-gamerow-when">
                        {new Date(c.at).toLocaleDateString()}
                      </span>
                      {c.duration ? (
                        <span className="stats-dur stats-dur--done"
                          title={`Took ${formatDurationLong(c.duration.days)} — started ${new Date(c.duration.startedAt).toLocaleDateString()}`}>
                          {formatDurationShort(c.duration.days)}
                        </span>
                      ) : (
                        <span className="stats-dur stats-dur--none"
                          title="This game never passed through `playing`, so there is no start to measure from.">
                          &mdash;
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {derived.finishedList.length > 12 && (
                <p className="stats-note">
                  Showing the 12 most recent of {derived.finishedList.length} recorded completions.
                </p>
              )}
            </>
          ) : (
            <p className="stats-note">
              No completions recorded yet. Mark a game <em>done</em> and it will appear here
              with the date.
            </p>
          )}
        </div>
      </div>

      <div className="ent-section stats-panel">
        <div className="ent-section-header">
          <span className="ent-section-icon-wrap"><FaCheckCircle aria-hidden="true" /></span>
          <h3>Games finished per {periodNoun}</h3>
        </div>
        {derived.series.length ? (
          <>
            <BarChart data={derived.series} color="var(--color-status-done)"
              ariaLabel={`Games finished per ${periodNoun}. ${derived.totalFinished} recorded in total.`} />
            <ChartData caption={`Games finished per ${periodNoun}`} rows={derived.series} />
          </>
        ) : (
          <p className="stats-note">
            No completions recorded yet. Mark a game as done and it will appear here.
          </p>
        )}
      </div>

      <div className="ent-section stats-panel">
        <div className="ent-section-header">
          <span className="ent-section-icon-wrap"><FaRegCalendarAlt aria-hidden="true" /></span>
          <h3>Games added per {periodNoun}</h3>
        </div>
        {/* The one chart with FULL history: added_at has been recorded since migration
            004, so this is populated on day one while the completion charts are still
            empty. */}
        {derived.addedSeries.length ? (
          <>
            <BarChart data={derived.addedSeries} color={CATEGORICAL[1]}
              ariaLabel={`Games added to the library per ${periodNoun}.`} />
            <ChartData caption={`Games added per ${periodNoun}`} rows={derived.addedSeries} />
            {derived.addedUnknown > 0 && (
              <p className="stats-note">
                {derived.addedUnknown} game{derived.addedUnknown === 1 ? '' : 's'} added before
                this was recorded {derived.addedUnknown === 1 ? 'is' : 'are'} not shown — their
                date is unknown, which is not the same as zero.
              </p>
            )}
          </>
        ) : (
          <p className="stats-note">No games have a recorded date for when they were added.</p>
        )}
      </div>

      <div className="ent-section stats-panel">
        <div className="ent-section-header">
          <span className="ent-section-icon-wrap"><FaHourglassHalf aria-hidden="true" /></span>
          <h3>How long games take</h3>
        </div>
        {derived.histogram.some((h) => h.value > 0) ? (
          <>
            <BarChart data={derived.histogram} color="var(--color-status-playing)"
              ariaLabel="Distribution of time taken from starting a game to finishing it." />
            <ChartData caption="Time from playing to done" rows={derived.histogram} unit=" games" />
            <p className="stats-note">
              Measured from when a game was set to <em>playing</em> until it was marked{' '}
              <em>done</em>. {stats.completions.length - stats.durations.length > 0 && (
                <>
                  {stats.completions.length - stats.durations.length} completion
                  {stats.completions.length - stats.durations.length === 1 ? ' is' : 's are'} not
                  shown here, because {stats.completions.length - stats.durations.length === 1 ? 'it' : 'they'}
                  {' '}never passed through <em>playing</em> — there is no start to measure from.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="stats-note">
            Nothing to measure yet. A duration needs a game to move to <em>playing</em> and
            later to <em>done</em>; only completions recorded after tracking began can have one.
          </p>
        )}
      </div>

      <div className="ent-section stats-panel">
        <div className="ent-section-header">
          <span className="ent-section-icon-wrap"><FaRegCalendarAlt aria-hidden="true" /></span>
          <h3>Releases by year</h3>
        </div>
        {/* FULL WIDTH, not a card in the grid. In a ~280px cell this chart hid 43-56%
            of its bars at every breakpoint — worst at 1920 with widescreen on, where
            .ss-grid lays out five tracks for three cards — with no scrollbar and no
            affordance, so it presented a truncated distribution as a complete one. A
            chart that silently lies about its own x-axis is the same defect as a
            confident zero. */}
        <BarChart data={derived.releaseYears} color={CATEGORICAL[0]}
          ariaLabel="Games in the library grouped by release year." />
        <ChartData caption="Releases by year" rows={derived.releaseYears} />
      </div>

      <div className="ss-grid">
        <div className="ss-card stats-card">
          <div className="ss-card-label">Library by status</div>
          <Donut slices={derived.statusCounts} ariaLabel="Library broken down by status." />
          <ul className="stats-legend">
            {derived.statusCounts.filter((s) => s.value > 0).map((s) => (
              <li key={s.key}>
                <span className="stats-swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}<b>{s.value}</b>
              </li>
            ))}
          </ul>
          <ChartData caption="Library by status" rows={derived.statusCounts} />
        </div>

        <div className="ss-card stats-card">
          <div className="ss-card-label">Where games came from</div>
          <Donut slices={derived.providerMix} ariaLabel="Games grouped by the database they were added from." />
          <ul className="stats-legend">
            {derived.providerMix.map((p) => (
              <li key={p.key}>
                <span className="stats-swatch" style={{ background: p.color }} aria-hidden="true" />
                {p.label}<b>{p.value}</b>
              </li>
            ))}
          </ul>
          <ChartData caption="Games by source database" rows={derived.providerMix} />
        </div>
      </div>
    </div>
  );
}
