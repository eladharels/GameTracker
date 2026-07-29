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
import { bucketKey, bucketRange, bucketLabel } from './dateUtils';

const API_BASE = `${window.location.origin}/api`;

const PERIODS = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
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
      if (!s.data || typeof s.data !== 'object' || !Array.isArray(s.data.completions)) {
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
    const series = keys.map((k) => ({ key: k, label: bucketLabel(k, period), value: counts.get(k) }));

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
        // Compact on the axis — this chart lives in a ~280px card and a 4-digit year
        // per 26px slot overlaps. The full year goes to the data table below it.
        label: k === 'Unknown' ? '?' : `\u2019${k.slice(2)}`,
        fullLabel: k === 'Unknown' ? 'Unknown release date' : k,
        value: v,
      }));

    const providers = new Map();
    for (const g of games) {
      const p = String(g.game_id || '').split('_')[0] || 'other';
      providers.set(p, (providers.get(p) || 0) + 1);
    }
    const providerMix = [...providers.entries()].map(([k, v]) => ({
      key: k, label: k, value: v,
      color: k === 'igdb' ? 'var(--color-status-wishlist)'
        : k === 'rawg' ? 'var(--color-status-playing)'
          : 'var(--color-status-unreleased)',
    }));

    const thisBucket = bucketKey(new Date(), period);
    // NOTHING RECORDED YET is not the same fact as ZERO RECORDED THIS MONTH, and the
    // difference matters most on day one. Once the log has seen anything, a 0 is a real
    // observation and is shown. Before that it is an absence, and shows as an em dash.
    const observed = Boolean(stats.trackingSince);
    return {
      series,
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

  const cov = stats.coverage;
  const unrecorded = Math.max(0, cov.libraryDone - cov.recordedCompletions);

  return (
    <div className="stats-page">
      <div className="library-header">
        <h2 className="library-title">Statistics</h2>
        <div className="filter-bar stats-period">
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
        <div className="gt-alert gt-alert--page stats-coverage" role="status">
          <FaExclamationCircle aria-hidden="true" />
          <div>
            <strong>{unrecorded} of your {cov.libraryDone} finished games have no completion date.</strong>
            <br />
            Status history started being recorded
            {stats.trackingSince ? ` on ${fmtDate(stats.trackingSince)}` : ' recently'}, and there is no
            honest way to backdate what happened before that. The charts below cover only
            what has been observed since — they will fill in as you play.
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
        <div className="stats-chip stats-chip--backlog">
          <FaList aria-hidden="true" />
          <span>{orDash(derived.backlogDepth)}</span>
          <small>in backlog</small>
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
          <div className="ss-card-label">Releases by year</div>
          <BarChart data={derived.releaseYears} color="var(--color-status-wishlist)"
            ariaLabel="Games in the library grouped by release year." />
          <ChartData caption="Releases by year" rows={derived.releaseYears} />
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
