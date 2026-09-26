// Every in-process rate limit: ONE store, ONE implementation, ONE eviction sweep.
//
// Extracted from index.js (ROADMAP UP-22). The three per-user limiters were the same
// eight lines with different keys and budgets — and only libraryWriteLimit branched on
// the mount, so the other two would have sent v1's {error} envelope from a v2 route the
// day either was mounted there. They are now one factory, and the branch is not
// optional.
//
// Also here: the login and sudo counters' primitives (lockoutMinutes / trackFailures /
// clearFailures). index.js keeps the login and sudo WRAPPERS, which own their key
// namespaces; they share this store because a second copy of "count, then lock out for
// a window" is how the two drift on the day one is tuned — and the sweep below only
// evicts from the store it knows about.
//
// Required at the TOP of index.js. The limiters used to be function declarations
// defined ~900 lines below the routes that use them, working only because of hoisting.

const problem = require('./services/problem');
const v2 = require('./services/v2');
const { CODES } = require('./services/errors');

const store = new Map();

// The login budget. The defaults of lockoutMinutes, and the sweep's horizon: no window
// defined anywhere may exceed this, or the sweep would evict a live lockout early.
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

// Minutes left on the first exhausted key, or 0. An expired window is cleared here.
function lockoutMinutes(keys, max = MAX_LOGIN_ATTEMPTS, duration = LOCKOUT_DURATION) {
  const now = Date.now();
  for (const key of keys) {
    const attempts = store.get(key);
    if (!attempts) continue;
    if (attempts.count >= max) {
      const elapsed = now - attempts.firstAttempt;
      if (elapsed < duration) return Math.ceil((duration - elapsed) / 1000 / 60);
      store.delete(key);
    }
  }
  return 0;
}

function trackFailures(keys) {
  const now = Date.now();
  for (const key of keys) {
    const attempts = store.get(key) || { count: 0, firstAttempt: now };
    attempts.count++;
    if (attempts.count === 1) attempts.firstAttempt = now;
    store.set(key, attempts);
  }
}

const clearFailures = (keys) => { for (const key of keys) store.delete(key); };

// Entries for IPs that fail a few times and never return were never evicted — an
// unbounded slow leak under background scanning traffic. Sweep hourly. unref(): an
// operator script that requires index.js must still be able to exit.
setInterval(() => {
  const cutoff = Date.now() - LOCKOUT_DURATION;
  for (const [key, attempts] of store) {
    if (attempts.firstAttempt < cutoff) store.delete(key);
  }
}, 60 * 60 * 1000).unref();

// A per-USER budget for one kind of request.
//
//   name      the middleware's function NAME. Load-bearing: test/api-surface.test.js
//             and test/api-contract.test.js find a limiter in the live route stack by
//             `.name`, and an anonymous closure is invisible to both.
//   prefix    the key namespace — its own, so it cannot consume or be consumed by the
//             login budget or another limiter.
//   max, windowMs   the budget. Every request COUNTS, not only failures: what these
//             protect is consumed by success (a status-event row, an outbound request).
//   what      for the log line and the message: "Too many <what>".
//
// Keyed by user, not IP: several users behind one NAT must not share a budget. It must
// sit AFTER authentication: with no req.user it fails OPEN (authRequired is the control
// that matters, and this always runs after it — api-surface.test.js pins the order).
//
// A 429 with Retry-After in the SURFACE's wire format: problem+json on /api/v2, the
// frozen {error} envelope on v1. CLAUDE.md records why that 429 is not a v1 status move.
function perUserLimit({ name, prefix, max, windowMs, what }) {
  if (windowMs > LOCKOUT_DURATION) {
    throw new Error(`${name}: a ${windowMs}ms window outlives the sweep's ${LOCKOUT_DURATION}ms horizon`);
  }
  const limiter = function (req, res, next) {
    const userId = req.user && req.user.id;
    if (!userId) return next();
    const keys = [`${prefix}:${userId}`];
    const lockedFor = lockoutMinutes(keys, max, windowMs);
    if (lockedFor > 0) {
      console.warn(`[RateLimit] ${what} throttled for user ${userId}`);
      res.set('Retry-After', String(lockedFor * 60));
      const err = {
        code: CODES.RATE_LIMITED,
        message: `Too many ${what}. Try again in ${lockedFor} minute${lockedFor === 1 ? '' : 's'}.`,
      };
      // A request without originalUrl (a hand-built one in a test) is v1: the default surface.
      return String(req.originalUrl || '').startsWith('/api/v2') ? v2.send(res, err) : problem.send(res, err);
    }
    trackFailures(keys);
    return next();
  };
  Object.defineProperty(limiter, 'name', { value: name });
  return limiter;
}

// --- The three budgets -------------------------------------------------------------

// Library writes. Every status write appends a row to user_game_status_events, which has
// no UNIQUE to bound it — done -> playing -> done must produce two rows, so duplicates
// are the point — so a caller flipping one game between two statuses inflates it
// indefinitely. Raised by the CISO review of the statistics feature. GENEROUS: a library
// reorganisation or an agent working through a backlog is a burst of dozens; 240 in five
// minutes is one write every 1.25 s sustained.
const libraryWriteLimit = perUserLimit({
  name: 'libraryWriteLimit', prefix: 'libwrite', max: 240, windowMs: 5 * 60 * 1000,
  what: 'library changes',
});

// The Diagnostics "send test notification" button makes THIS server send a request to a
// URL the user chose. guardedLookup blocks the worst target; what is left is still an
// outbound request per click, and the 10 s timeout against an instant refusal is a timing
// signal about the server's network (ROADMAP SEC-1). Bounded so it cannot be a scanner.
const testNotificationLimit = perUserLimit({
  name: 'testNotificationLimit', prefix: 'notifytest', max: 10, windowMs: 5 * 60 * 1000,
  what: 'test notifications',
});

// CrackRelease checks (ROADMAP SEC-15). Each fetches a third-party site, and the per-game
// route also writes the answer. BOTH routes draw on this ONE budget: the cost is the same
// outbound request. The SPA's in-flight dedupe (FE-1) is a courtesy, not a control. A
// library page can ask for up to 24 at once, so generous for a person, far below a loop.
const crackCheckLimit = perUserLimit({
  name: 'crackCheckLimit', prefix: 'crackcheck', max: 60, windowMs: 5 * 60 * 1000,
  what: 'crack-status checks',
});

module.exports = {
  MAX_LOGIN_ATTEMPTS, LOCKOUT_DURATION,
  lockoutMinutes, trackFailures, clearFailures, perUserLimit,
  libraryWriteLimit, testNotificationLimit, crackCheckLimit,
  _store: store,
};
