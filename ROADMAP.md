# GameTracker — Remediation Roadmap

Source: full-codebase review of `main` @ `35d9502` (2026-09-25), covering the backend core,
`services/`, the frontend, and CI/Docker/MCP. Nothing was changed during the review.

Baseline at review time: root `npm test` passes (helpers 236, runtime 5, api-surface 18,
api-contract 30, openapi 37), `mcp/` `npm test` passes (28), and backend lint reports 0 errors
and 3 warnings. The `test/integration/` suites need Postgres and were not run.

Items marked ✔ were re-checked by hand against the code, not only reported by a reviewer.

---

## How to use this file

- Every finding has a stable ID (`P0-1`, `CC-3`, …). Use the ID in commit messages and
  PR titles, for example `Fix P0-2: exact-match ldap.requiredGroup`.
- Tick `[ ]` → `[x]` in the same PR that lands the fix, and fill in the **Fix log** at the
  bottom (ID, PR, date, one line).
- If you decide not to fix an item, tick it and mark it **Won't fix** with the reason. Don't
  delete it: the reasoning is the documentation.
- **Definition of done** for each item (from CLAUDE.md):
  1. A test that fails before the fix and passes after, where one can be written. Use the unit
     suite for pure logic and `test/integration/` for anything Postgres decides.
  2. `npm test`, `npm run lint`, and the `mcp/` tests are all green.
  3. CISO review for anything under auth/security/CI, Architect review for anything
     structural, and UI/UX review for anything under `frontend/`.
  4. Validated on GameTracker-stg, with a `STAGING_CHANGELOG.txt` entry, before production.
  5. A v1 response-shape change is almost certainly wrong. If one is truly needed,
     `test/api-contract.test.js` must change in the same PR.

Severity: **P0** means fix first. After that, sections are ordered by impact.

---

## Progress

| Section | Items | Done |
|---|---|---|
| P0 — Fix first | 6 | 6 |
| CC — Correctness & concurrency | 16 | 16 |
| SEC — Security (medium/low) | 17 | 15 |
| FE — Frontend | 22 | 21 |
| UP — Tidying & upkeep | 24 | 20 |
| **Total** | **85** | **78** |

---

## P0 — Fix first

### [x] P0-1 ✔ LDAP login can take over a same-named local account, including `root`
- **Where:** `index.js:268-277` (`getOrCreateUser`), `index.js:1890-1918` (LDAP login branch).
- **Problem:** after the directory authenticates a name, `getOrCreateUser` returns whatever
  row already has that username, whatever its `origin`. It then rewrites `origin='ldap'` and
  signs a JWT carrying that row's `can_manage_users`. `RESERVED_USERNAMES`
  (`user-rules.js`: me/root/admin) is never consulted, and LDAP is tried before local auth.
- **Failure:** anyone able to create a directory account named `root`, or the name of a local
  admin, logs in as that admin, and the local password is never checked.
- **Fix:**
  - Refuse to bind a directory login to a row whose `origin` is `local` (no silent
    conversion). Converting a local account to LDAP should be an explicit admin action.
  - Reject reserved usernames on the LDAP path with `validateUsername()`.
  - Never rewrite `origin` implicitly.
- **Tests:**
  - An LDAP-authenticated `root` is refused.
  - An LDAP login for an existing local user is refused, and the row is unchanged.
- **Done** (`3c81bb6`): `user-rules.js#directoryClaimRefusal` is the one rule. It is checked
  before the group test and before the lockout counter is cleared, and again inside
  `getOrCreateUser`. A refused claim falls back to the LOCAL password. Legacy passwordless
  rows stay claimable.
- **Review fix** (after `/code-review`): the rule is now keyed on the password hash, not on
  `origin`. The first version still let the directory claim rows the OLD code had taken over,
  because those rows kept their hash but had been relabelled `origin='ldap'`. It also narrows
  the refused names to `root` and `me`: `admin` is FreeIPA's default administrator, and
  refusing it locked a legitimate directory user out.
- **Operator follow-up:** rows the old code took over are no longer claimable, but they are
  still inconsistent (`origin='ldap'` with a hash). See SEC-13.
- **Behaviour change:** a local account with a password can no longer sign in with the
  directory password of a same-named directory entry. Only its local password works.

### [x] P0-2 ✔ `ldap.requiredGroup` check is a substring match
- **Where:** `ldap-helpers.js:360-371` (`satisfiesRequiredGroup`), which the login
  (`index.js:1859`) and sudo-mode minting both use.
- **Problem:** `g.includes('cn=' + want)`, so with `requiredGroup: "gamers"`,
  `cn=gamers-denied,…` and `cn=gamersx,…` both pass.
- **Fix:**
  - Parse the DN's first RDN and compare `cn` for exact (case-insensitive) equality.
  - Or require the full group DN and compare the whole DN.
  - Keep the existing trim behaviour.
- **Tests:** add prefix/suffix cases (`gamers-denied`, `xgamers`, `gamersx`) to
  `test/helpers.test.js` next to the existing cases at `:2085-2120`.
- **Done** (`3c81bb6`): matches the full DN, or the exact cn of the first RDN (escaped commas
  handled). Anything else fails closed.
- **Behaviour change:** a `requiredGroup` that only worked through the substring match now
  refuses those users. CLAUDE.md now recommends configuring the full DN.

### [x] P0-3 ✔ `TRUST_PROXY`, `CORS_ORIGINS`, `THEGAMESDB_API_KEY` never reach the backend
- **Where:** `docker-compose.yaml:64-83` (backend `environment:`). `index.js:108,120` read them.
- **Problem:** README (`:135-137`) and CLAUDE.md both call `TRUST_PROXY=2` mandatory after
  `BACKEND_BIND=127.0.0.1`, but compose never passes it through, so a value in `.env` does
  nothing.
- **Failure:** the backend stays at `trust proxy = 1` behind two hops. Every login then
  appears to come from the edge proxy's IP, so five bad passwords from anyone lock out every
  user for 15 minutes. `THEGAMESDB_API_KEY` from `.env` is silently ignored as well.
- **Fix:**
  - Add `TRUST_PROXY=${TRUST_PROXY:-1}`, `CORS_ORIGINS=${CORS_ORIGINS:-}` and
    `THEGAMESDB_API_KEY=${THEGAMESDB_API_KEY:-}` to the backend environment.
  - Add the same keys to `docker-compose.test.yml` (the two files must stay the same shape).
- **Test:** add a static check in `test/runtime.test.js` that every `process.env.X` read by
  `index.js` for these keys appears in both compose files.
- **Done** (`3c81bb6`, `6248d0f`): both compose files pass these variables, plus
  `IGDB_CLIENT_SECRET` and `STEAM_REGION`.
  - The CISO rejected the first version: the deploy job never reads the host's `.env`. It now
    carries these values itself, and `BACKEND_BIND` too, which had been missing the same way.
  - `runtime.test.js` checks two things:
    - Every variable the backend reads is passed through by both compose files.
    - Every variable production compose reads is carried by each deploy step.
- **Operator action:** set `BACKEND_BIND`, `TRUST_PROXY`, `CORS_ORIGINS` and `STEAM_REGION` as
  repository Variables, and `THEGAMESDB_API_KEY` and `IGDB_CLIENT_SECRET` as Secrets. A value
  kept only in `.env` has no effect on a CI deploy.

### [x] P0-4 ✔ On-demand price sweep ignores `STEAM_REGION`
- **Where:** `services/jobs.js:342` (`runJob('updatePrices')` calls `updatePrices()` with no
  arguments, so the region defaults to `'il'`). The cron at `index.js:3476` passes
  `process.env.STEAM_REGION`.
- **Failure:** with `STEAM_REGION=us`, prices are in USD on Monday and in ILS after an admin
  runs `POST /api/v2/jobs {kind:"updatePrices"}`. This is the drift `jobs.js` exists to prevent.
- **Fix:** resolve the region in one place, inside `jobs.js`, from `process.env.STEAM_REGION`
  (default `'il'`), and have every caller (cron, `runJob`, `update_library_prices.js`) use it.
  Remove the argument from the cron call.
- **Test:** a unit test that `runJob('updatePrices')` and the cron entry resolve the same region.
- **Done** (`3c81bb6`, `4160735`): `jobs.js#steamRegion()` is now the default for every price
  lookup. That covers the cron, `runJob`, the v1 `/api/game-price`, the v2 `/catalog/prices`
  default and `update_library_prices.js`. An invalid value falls back to `il` with one warning.

### [x] P0-5 `:latest` is retagged before Trivy and the smoke test pass (push to main)
- **Where:** `.github/workflows/docker-build-deploy.yml:320-352`. Trivy is at `:411-418` and
  runs later, as does smoke-test.
- **Failure:** a push to main fails Trivy on a HIGH CVE, so deploy is skipped. But `:latest`
  already points at the rejected image, and the next manual `docker compose up`, a reboot, or
  a restart runs it in production.
- **Fix:**
  - Build every run as `sha-<short>` (or `run-<id>`).
  - Promote to `:latest` only inside `deploy`, after every gate has passed.
  - Point the scans and the smoke stack at the immutable tag.
- **Test:** add a check in the workflow, or a static test, that no job before `deploy`
  writes a `:latest` tag.
- **Done** (`8fd5a87`, `cf46533`), together with SEC-6:
  - Builds are tagged `sha-<commit>` or `pr-<number>`, and the scans and the smoke stack test
    that tag.
  - Only deploy's promote step writes `:latest`, and it keeps the old one as `:previous`.
  - The cleanup job also removes a push run's `sha-` tags, after deploy, and never touches
    `latest` or `previous`.
  - `runtime.test.js` fails on any mention of `:latest` in a job other than deploy.

### [x] P0-6 ✔ Frontend: a 403 deletes the token but the app stays "logged in"
- **Where:** `frontend/src/App.jsx:388-392` (UserManagementPage) and
  `frontend/SharedLibrary.jsx:92-95`. `window.setUser` is never assigned anywhere.
- **Problem:**
  - Both places treat 403 like 401. They remove the token and navigate to `/login`, but never
    clear the React `user` state.
  - With `user` still set there is no `/login` route, so the catch-all route sends the user
    to `/search`.
  - The global interceptor (`App.jsx:55`) only redirects when a token is present.
- **Failure:** a non-admin opens `/users` (the route has no client-side gate, `App.jsx:257`).
  The token is silently deleted, and every later call is a 401 in an app that still looks
  logged in, until the user reloads.
- **Fix:**
  - Centralise logout (a context or `useAuth().logout()`) and route every 401 through it.
  - A 403 means "not allowed", not "logged out": show an error instead.
  - Gate `/users` on the client with `can_manage_users`.
  - Delete the `window.setUser` fallback.
- **Done:** a 403 on the users list or the sharing page now shows an error and ends nothing.
  A 401 is left to the one global interceptor, which already ends the session (and, since
  SEC-7, tells the login page why). `/users` and `/system-status` are gated on
  `can_manage_users` in the router and redirect a non-admin to `/search`; the server still
  decides. The global-setter fallback is gone. `test/runtime.test.js` now fails if any file
  but App.jsx deletes the token, if App.jsx does it anywhere beyond its three session paths,
  or if the fallback returns.
- **Deviation from the fix text (Architect):** the single owner of "the session is over" is
  the axios response interceptor, with a full reload, not a context or `useAuth().logout()`.
  It runs outside React, so it cannot call `setUser`; the reload instead guarantees that no
  in-memory state survives a refused credential. The intent (one owner, React never
  disagreeing with storage) is met.
- **Constraint this creates:** no authenticated `/api` endpoint may answer 401 for anything
  but an invalid session, or the interceptor logs the user out. Sudo mode holds to this
  correctly (a wrong password is 403, `index.js`). Guarding it is UP-18.
- **Review fixes:** a 401 with no stored token (a logout in another tab) no longer leaves a
  silent empty page; both pages say the session has ended. User Management's errors used to
  render only inside the Add User dialog, so a failed load, delete or LDAP sync with the
  dialog closed said nothing; they now show as a page-level alert, and the table is hidden
  rather than shown empty when the load failed. The sidebar uses the router's predicate.
  `.error-msg` was red text on a red background (~1.3:1) app-wide and is now ~7:1.
- **Known limit:** the router gate reads the JWT's `can_manage_users`, which can be up to
  12 hours stale. Someone promoted mid-session is redirected from a typed `/users` until
  they sign in again. It fails closed, and the server re-reads privilege on every request.

---

## CC — Correctness & concurrency

### [x] CC-1 Metadata refresh overwrites a status the user just set
- **Where:** `services/library.js:581-650` (`applyRefreshedMetadata`), fed by the snapshot
  taken at the start of `jobs.js#refreshMetadata`. The UPDATE at `:632` has no status guard.
- **Failure:**
  1. The snapshot has the game as `wishlist`.
  2. The user moves it to `playing`.
  3. The refresh finds a future date and writes `unreleased` over `playing`.
  4. It logs a `wishlist→unreleased` event that never happened.
- **Fix:** add `AND status IS NOT DISTINCT FROM <snapshot status>` to the UPDATE (or re-read
  the row `FOR UPDATE` inside a transaction). Skip the row and its event when 0 rows change.
- **Test:** an integration test that interleaves a user status change with a refresh.
- **Done** (`c42f066`): the status is decided from the row read `FOR UPDATE` in the same
  transaction as the write, never from the sweep's snapshot. A row deleted in the meantime is
  skipped.

### [x] CC-2 Status-event `from` is read outside the write's transaction
- **Where:** `services/library.js:903` (read), `:917` and `:941` (update by id), `:949`.
- **Failure:**
  - A concurrent write records a wrong `from` in the permanent log.
  - If the game is deleted in between, the UPDATE hits 0 rows but the event is still inserted,
    and `updated` is `undefined`.
- **Fix:**
  - Do the read with `SELECT … FOR UPDATE` inside the same `withTransaction`.
  - Derive `from` from `UPDATE … RETURNING` combined with the locked read.
  - Skip the event on 0 rows.
- **Test:** an integration test for the "deleted between read and write" case.
- **Done** (`c42f066`, review fix):
  - The read happens `FOR UPDATE` inside the transaction, after the backlog advisory lock (the
    lock order every writer now uses).
  - The row is read back inside the transaction too, so a delete after commit can't return an
    empty game.
  - Integration tests interleave a real concurrent writer and a real concurrent delete. Both
    fail on the old code.

### [x] CC-3 Release reminders are single-flighted on v2 only, so they can be sent twice
- **Where:** `index.js:3357` (08:00 cron), `index.js:3433` (`POST /api/admin/check-releases`),
  `run_notifications.js`, all calling `jobs.checkReleases` directly. The dedupe is
  `wasSent → await notify → markSent`.
- **Failure:** two overlapping runs both see "not sent", and both deliver to all four channels.
- **Fix:** take a Postgres advisory lock (`pg_try_advisory_lock`) inside `checkReleases`
  itself, so that every entry point is serialised, across processes too.
- **Done** (`7d61751`), with CC-4, by a per-reminder claim rather than a sweep-wide lock:
  exactly one sweep in any process wins each (user, game, threshold).
  `test/integration/reminders.test.js` runs three sweeps at once and gets one send; the old code
  sent three.
- **Accepted trade-off:** it fails "at most once". A crash between claim and send, or a
  holder that fails to deliver while another sweep skipped, drops that one threshold for that
  day.

### [x] CC-4 Sent-notification log is clobbered across processes and written non-atomically
- **Where:** `index.js:3327-3335`, plus `run_notifications.js`'s own in-memory copy.
- **Failure:** a manual run followed by the 08:00 cron on the same day sends duplicates and
  erases the script's records.
- **Fix:** move the dedupe log into a Postgres table (`migrations/006_…`) with a unique key and
  `INSERT … ON CONFLICT DO NOTHING RETURNING` as the claim. That also fixes CC-3's window.
  Failing that, re-read before writing and write via a temp file and rename.
- **Done** (`7d61751`):
  - Migration 006 adds `sent_reminders`, keyed `(user_id, game_id, type)`, with
    `ON DELETE CASCADE`.
  - `jobs.REMINDER_LOG` claims before sending and releases in a `finally` when nothing was
    delivered. `checkReleases` refuses the old `{wasSent, markSent}` shape.
  - The old file is not imported: only a same-day re-run could re-send once.
- **Follow-ups:**
  - Remove the `sent_notifications.json` bind mount (both compose files) and the smoke
    workflow's seeding of it **in the release after this one**. They are kept only so a
    rollback to the previous image finds its file.
  - `sent_reminders` has no retention. Consider pruning rows for past release dates.

### [x] CC-5 Local accounts get an email address from the directory
- **Where:** `services/notifications.js:312-340` (`resolveEmail`), called at `:459` with
  `channels.email || ''`. `directory.js#getLdapEmail` never checks `origin`.
- **Failure:** local user `jsmith` receives directory user `jsmith`'s address, which is saved to
  `users.email`, so their reminders go to someone else. A user who cleared their email to opt
  out gets it filled back in. It also costs one LDAP bind per notification.
- **Fix:** only look up the directory for `origin === 'ldap'`. Never write it back
  automatically; if a backfill is wanted, leave it to `backfill_ldap_display_names.js`.
- **Done**: `resolveEmail` consults the directory only for `origin='ldap'` accounts. For those
  it still caches the address, because the directory owns their `mail`, and the LDAP login
  overwrites it on every sign-in anyway. `test/integration/email-resolution.test.js` fails on
  the old code.
- **Operator follow-up:** local accounts that were already filled in keep the wrong address.
  Check `SELECT username, email FROM users WHERE origin <> 'ldap' AND email <> '';` against
  what those users expect, or ask them to re-check My Account.

### [x] CC-6 Search merges different games that share a name
- **Where:** `services/catalog.js:297` (dedupe on lower-cased name, preferring the undated
  result), `catalog.js:584` (`resolveGame` matches by name), and `:275-282` (Steam App ID
  borrowed by name). `refreshMetadata` has the same problem.
- **Failure:**
  - Doom (1993) and Doom (2016) become one result.
  - An MCP `name:"Doom"` add resolves silently instead of returning CONFLICT with candidates.
  - A refresh can write another game's date, cover, status or price onto the row.
- **Fix:** dedupe on `(name, release year)` and prefer provider-id matches. Make
  `resolveGame` return CONFLICT whenever more than one candidate shares the name. Only borrow
  a Steam App ID when the years agree.
- **Done:**
  - `mergeResults` keeps same-named results from different years apart.
  - A Steam App ID is borrowed only within the same year. A cover may still be borrowed when
    one side is undated.
  - `findExactMatch` returns nothing when a name is ambiguous, and `resolveGame` answers
    CONFLICT listing just the collided games.
  - The refresh uses a new `catalog.matchForRow` (provider id, then the row's year, else skip)
    in all three places: `jobs.refreshMetadata` and both v1 refresh routes.
  - Unit tests fail on the old code.
- **Review fix (`/code-review`):** the Steam App ID rule and the collapse rule disagreed about
  whether an undated result is the same game. The undated survivor of "X (2020)" plus undated
  "X" lost its Steam App ID, so a game added from it was never priced. Both now use one
  `sameGame` rule.
- **Review fix:** `matchForRow` also refuses a lone same-named result whose year contradicts
  the row's. A capped refresh search may have returned only the other game.
- **Residual:** the v1 refresh routes report an ambiguous name as "Game not found in API search
  results". That is misleading, but a new message would be a v1 change. Revisit with CC-8.
- **Behaviour change:** a v1 search can now show two results with the same name. The SPA's
  duplicate check still compares names (FE-3), so adding the second one is blocked until FE-3
  is fixed.

### [x] CC-7 Schema-migration advisory lock is never released
- **Where:** `schema-migrate.js:52` (session-level `pg_advisory_lock`). The comment at `:86`
  claims `client.release()` releases it; it does not, because the pooled connection keeps it.
- **Failure:** during an overlapping deploy or with a second instance, the new process blocks
  on the lock until that pooled connection happens to close.
- **Fix:** call `pg_advisory_unlock` in a `finally` before `release()`, or use
  `pg_advisory_xact_lock` per transaction. Correct the comment.
- **Done:** `pg_advisory_unlock` runs in the `finally`. If the unlock fails, the connection is
  destroyed rather than pooled, and ending the session ends the lock.
  `test/integration/migration-lock.test.js` checks `pg_locks` after a run and starts a second
  migrating process. Both checks fail on the old code, and the second reproduced the hang.
- **Follow-up (CISO note):** `pg_advisory_lock` has no timeout, so a session that crashed while
  holding it would block startup indefinitely. Consider `SET lock_timeout` around the
  acquisition, with a clear fatal message.

### [x] CC-8 The single-game metadata refresh still has the bug the bulk refresh fixed
- **Where:** `index.js:1305-1309` uses `lookup.degraded`, while the bulk route uses
  `nobodyAnswered` (`:1243`).
- **Failure:** with no API keys configured, it reports "Game not found in API search results"
  instead of "lookup unavailable".
- **Fix:** move the single-game refresh into `jobs.js` or `library.js` next to the bulk
  refresh and share the decision.
- **Done:** `jobs.refreshOne` is the one "refresh this row" decision (search, then
  `matchForRow`, then `nobodyAnswered`, then apply). The v2 job and both v1 routes call it.
  The v1 routes keep their exact wording through a small `recordV1Refresh` formatter. A
  contract test drives the real single-game route with no API keys configured, and it fails on
  the old code.
- **Review fix (`/code-review`):** `refreshOne` answers "unavailable" when a provider FAILED
  (`degraded`) OR nobody was asked (`nobodyAnswered`). The bulk route had replaced the first
  check with the second instead of adding it, and the merged function inherited that. So a
  partial outage with no match read as "not found". That also corrects the bulk route and the
  v2 job's `reason`.

### [x] CC-9 v1 `PUT /api/user/me/settings` has its own copy of the rules
- **Where:** `index.js:3210-3269` versus `services/users.js#updateNotificationSettings`.
- **Problem:** v1 has no `MAX_NOTIFICATION_DAY` cap and no de-duplication. `ntfy_topic`,
  `gotify_token` and `telegram_chat_id` are stored with no type or length check and no
  `sanitizeText`.
- **Fix:** turn the v1 route into a thin adapter over the service, without changing the v1
  response shape.
- **Done:** the v1 route maps its snake_case keys onto `users.updateNotificationSettings`, the
  same rules `PATCH /api/v2/me/notifications` applies. It still answers `{success:true}`, and a
  refusal is still `400 {error}`, worded with v1's field names.
- **Review fixes:**
  - A numeric channel id (a Telegram chat id is a number) is converted to text instead of being
    silently wiped. The Architect rejected the first version for this and the CISO flagged it
    too.
  - Any other non-text value is refused with a 400, never blanked with a 200.
  - v1 error wording renames only the leading field name of the field in error.
- **Behaviour changes (v1 and v2 share them now):**
  - `notification_days` above the cap is now refused, and duplicates are removed.
  - Channel text fields are sanitised and capped at 200 characters. A number is kept as text,
    and any other non-text value gets a 400.
  - The `notification_days` refusal message now names the upper bound, and the URL messages end
    "…or empty to clear".
  - `null` for `email` or a URL clears it. It used to be stored as the string "null" and
    refused.
  - An account deleted mid-request now answers 404 instead of 200. A database error uses
    `problem.send`'s generic wording.

### [x] CC-10 Backlog swap reads positions before taking the lock
- **Where:** `services/library.js:119` (`listBacklog`) comes before the advisory lock at `:135`.
- **Failure:** a concurrent reorder writes stale positions back, and `backlog_order` ends up
  with duplicate values.
- **Fix:** read the positions after the lock, inside the same transaction.
- **Done:** `moveBacklogItem` runs entirely inside one transaction: lock, read, then swap. An
  integration test holds a real reorder open while a move waits. The old code left two games
  at position 1.

### [x] CC-11 CrackRelease status write
- **Where:** `index.js:740-763`.
- **Problem:**
  - The UPDATE is fire-and-forget.
  - Any fetch error overwrites a known `crack_status` with `unknown`.
  - It can store `unreleased`, which is outside the documented values.
  - It returns `err.message` to non-admins.
- **Fix:**
  - Await the write.
  - Keep the last known status on fetch errors.
  - Map values onto `cracked|uncracked|unknown`.
  - Return a generic error.
- **Done:**
  - The scraper reports whether the page was actually read, and only a read page changes the
    stored value, so an outage no longer erases known statuses.
  - Only `cracked` and `uncracked` are stored as themselves; anything else is `unknown`. The
    response still carries `unreleased`.
  - The write is awaited, and a failure is logged.
  - The `error`/`details` fields keep their shape but carry our own wording, never upstream
    text. The same applies to the admin CrackWatch refresh.
  - Contract tests fail on the old code.

### [x] CC-12 Unawaited writes on the LDAP login path
- **Where:** `index.js:275` and `:1910`.
- **Failure:** a failed write is silently lost, so `display_name` and `email` go stale.
- **Fix:** await both and log failures. This largely goes away once P0-1 and UP-16 are done.
- **Review fix (`/code-review`):** the guarded sync write (`AND password IS NULL`) refused
  the relabel, but the login still signed a session for the row. A sync that matches no rows
  now falls back to LOCAL authentication, as the claim check would.
- **Done:** the duplicate fire-and-forget UPDATE in `getOrCreateUser` is gone. The login
  route's own profile sync (display name, origin, email) is awaited, and a failure is logged
  without refusing a login the directory approved. The P0-1 login test helper now records
  `db.promises.run` too; before this, its "relabelled" check would have become vacuous.

### [x] CC-13 Errors thrown inside `db.*` callbacks never reach Express
- **Where:** the `db.js` shim runs callbacks inside `.then`, so a throw becomes an unhandled
  rejection (`index.js:3466` only logs it).
- **Failure:** a TypeError in any of the 18 inline callbacks leaves the request hanging.
- **Fix:** move the callback call out of the promise chain in the shim (for example with
  `process.nextTick`), or migrate the remaining call sites to `db.promises`.
- **Done (partly; the rest belongs to UP-16):**
  - The shim now catches a callback that throws or rejects, invokes it exactly once as
    before, and logs it loudly with the query. Before, it was a bare unhandled rejection.
  - `GET /api/user/me` and `PUT /api/user/me/sharing` are async with `db.promises`, so a throw
    there reaches Express 5 as a 500.
  - Unit tests fail on the old code.
- **Still open:** the shim cannot answer a request, because it has no `res`. So a throwing
  callback at the remaining ~12 call sites (`findUser`/`withExistingUser`, `getOrCreateUser`,
  `authRequired`, the login fallback, LDAP sync, the crack-status routes, the root seed,
  health) is now loud, but the request still hangs until the server timeout. Converting those,
  starting with `withExistingUser`, is part of UP-16.

### [x] CC-14 `users.create` stores the username untrimmed and duplicates the username rules
- **Where:** `services/users.js:272`.
- **Failure:** `" bob"` becomes an account distinct from `bob`. There is no length or
  character-set bound.
- **Fix:** call `user-rules.js#validateUsername()`, the shared rule, and store the trimmed
  value.
- **Also trim the LOGIN username** (`index.js` login route). From the CISO review of P0-1: AD
  ignores trailing spaces, so `root ` authenticates as the directory's `root` and gets its own
  unprivileged lookalike row. Deferred to this item because existing untrimmed local accounts
  would become unreachable. Migrate them first.
- **Done:**
  - `users.create` trims, lowercases, then calls the shared `validateUsername`.
  - The charset and length rule moved there from `create-local-admin.js`: `[a-z0-9._-]`, at
    most 64 characters. The API now enforces it too.
  - Tests fail on the old code.
  - The login-username trim noted above is still open. It waits for existing untrimmed rows to
    be migrated.
- **Behaviour change:** `POST /api/users` and v2 user creation now refuse names outside that
  charset, with a 400. Existing accounts are untouched.

### [x] CC-15 Forged `backlogOrder` cursor returns 500 instead of 400
- **Where:** `services/library.js` `listPage`. A non-numeric `lastKey` is bound against an
  INTEGER column.
- **Fix:** validate the cursor's type for each sort and throw `CODES.VALIDATION`.
- **Done:** `decodeCursor` checks `lastKey` against the pinned sort's column. `backlogOrder`
  needs a safe integer and the text sorts need a string; anything else is a 400 before any
  query runs. The unit test fails on the old code.

### [x] CC-16 Stats: `statusCounts` in `agentSummary` and understated `unrecordedCompletions`
- **Where:** `services/stats.js` `agentSummary`.
- **Problem:**
  - It returns `statusCounts`, against the rule that `stats.js` returns nothing the library
    already carries.
  - `unrecordedCompletions` (libraryDone − done events) is understated when a game was
    finished more than once.
- **Fix:** either document an exception for agents or drop `statusCounts`. Count the
  games that have at least one `done` event, not the events.
- **Done:**
  - `recordedCompletions` now counts GAMES currently done that have a user `done` event,
    which is what its own comment always said. It used to count completion EVENTS, capped at
    `MAX_ROWS`.
  - That corrects the stats page's "N of your finished games have no date" banner and the
    agent's `unrecordedCompletions`, with no response shape change.
  - `statusCounts` in `agentSummary` was a deliberate, documented exception. CLAUDE.md now says
    so instead of contradicting it.
  - The integration test fails on the old code.

---

## SEC — Security (medium / low)

### [x] SEC-1 The cloud-metadata block checks hostnames only (SSRF through notification URLs)
- **Where:** `services/notifications.js:71-100`. Any user can reach it through
  `POST /api/admin/test-notification` (`index.js:2712`).
- **Failure:**
  - `ntfy_url=http://169.254.169.254.nip.io`, or a DNS-rebinding name, reaches the metadata
    endpoint.
  - The 10s timeout versus an instant refusal also gives a timing-based port scan.
- **Fix:**
  - Resolve DNS and check every resolved address, pinning it through a custom `lookup` on
    the agent.
  - Block link-local and metadata ranges.
  - Rate-limit the test endpoint per user.
- **Done:**
  - The ntfy and Gotify requests connect through agents whose `lookup`
    (`notifications.guardedLookup`) checks EVERY resolved address. It is the same resolution
    the socket uses, so a rebinding answer has no second lookup to slip into.
  - The text check stays, for IP literals, which skip `lookup`.
  - The test button is limited to 10 per user per 5 minutes.
  - Unit tests stub `dns.lookup` and drive a real ntfy send through `dispatch`. They fail on
    the old code.
- **Review fixes:**
  - `proxy: false` on both calls (a CISO condition for approval): axios honours
    `HTTP(S)_PROXY`, and through a proxy the guard would check the proxy's host. Docker injects
    those variables into every container when the host's `~/.docker/config.json` sets
    `proxies`. A test now sets `HTTP_PROXY` and the block still holds.
  - All of `fe80::/10` is blocked, and so are the IPv4-compatible (`::a9fe:a9fe`) and NAT64
    (`64:ff9b::…`) embeddings of the metadata address.
- **Residual:**
  - A 10-second timeout versus an instant refusal is still a timing signal. The limiter bounds
    it, and it doesn't remove it.
  - The refusal message confirms that a name resolves to a link-local address, and nothing
    more.

### [x] SEC-2 ✔ v2 user writes accept string booleans for `canManageUsers`
- **Where:** `services/v2.js` `userWrite` (no type check), `services/users.js:152-157`, `:287`.
- **Failure:** `PATCH /api/v2/users/5 {"canManageUsers":"false"}` promotes the user, and the
  same input slips past the "cannot remove your own admin" check. Only admins can reach it.
- **Fix:** require `typeof === 'boolean'` in the v2 mapper, or better in the service, and
  answer 400 otherwise.
- **Done:** `v2.userWrite` refuses anything but a real boolean for `canManageUsers` and
  `sharesLibrary`, on create and on update, with a 400. v1 keeps its truthy reading, because it
  is frozen and its client sends real booleans. The unit test fails on the old code.

### [x] SEC-3 Semgrep is unpinned and can be stubbed
- **Where:** `.github/workflows/docker-build-deploy.yml:168-174`: an unversioned
  `pip3 install semgrep` behind a `command -v` guard, with `--config auto`.
- **Fix:** pin the version and verify it the way Gitleaks and Trivy are verified. Pin the
  rule-set (a registry pack at a fixed version, or vendored rules).
- **Done (the binary):** Semgrep `1.178.0` (`SEMGREP_VERSION`) is installed into a virtualenv
  keyed by version, verified by `--version`, and run by absolute path (`SEMGREP_BIN`). Nothing
  trusts `semgrep` on PATH any more. `runtime.test.js` pins all of this. The repo's own rules
  (`.semgrep.yml`) run clean on 1.178.0.
- **Not done (the rule set):** `--config auto` still pulls the registry's current rules,
  because the registry does not version them. A new rule can fail an unchanged build, which is
  the safe direction; a rule removed upstream goes unnoticed. Anything this repo depends on
  belongs in `.semgrep.yml`.
- **Not verified here:** the `auto` rule set could not be fetched from this environment
  (`semgrep.dev` is blocked). The first CI run on 1.178.0 is the check that the newer rules
  still pass.

### [x] SEC-4 GitHub Actions pinned by tag, not by commit SHA
- **Where:** `actions/checkout@v4`, `actions/setup-node@v4`, `docker/setup-buildx-action@v3`.
  The Semgrep rule that flags this is excluded at `:187`.
- **Why it matters:** the runner is the production host.
- **Fix:** pin to full SHAs with a version comment, remove the exclusion, and let Dependabot
  or Renovate bump them.
- **Done:**
  - Every `uses:` is pinned to the commit its current major tag points to (checkout v4.4.0,
    setup-node v4.4.0, setup-buildx v3.12.0), with a `# vX.Y.Z` comment.
  - Semgrep's mutable-action-tag rule is no longer excluded.
  - `runtime.test.js` fails on any unpinned `uses:` or a missing version comment.
  - I kept the current majors on purpose; newer majors (checkout v7, setup-node v7, buildx
    v4) are an upgrade to test separately.
  - **Follow-up:** all three pinned releases target Node 20, which GitHub has deprecated. CI
    already warns and forces Node 24. Move to releases that target Node 24 (checkout/setup-node
    v5+) in a separate, tested change.
- **Decision for you: no Dependabot yet.** Dependabot opens branches inside this repository,
  and the CI gate trusts same-repo pull requests only because push access here already implies
  deploy. A bot author breaks that assumption: its PRs would run CI on the production host.
  Keep bumping pins by hand, or move the PR path to GitHub-hosted runners first (see CLAUDE.md,
  "The gate's equivalence is conditional").

### [x] SEC-5 Gitleaks allowlists whole documentation files
- **Where:** `.gitleaks.toml:75-85` (`CLAUDE.md`, `README.md`,
  `SECURITY_HARDENING_2026-07.md`, `.gitleaks.toml`).
- **Fix:** replace the path allowlists with regex or stopword allowlists for the specific
  example strings.
- **Done:** every documentation path allowlist is gone. A scan of all 194 commits with them
  removed found nothing, so they bought nothing. Placeholders stay as exact `regexes` entries.
- **Found while doing it: the secret scan had been scanning NOTHING on the runner.** CI logs
  for `main` show git refusing the checkout ("detected dubious ownership"), then gitleaks
  logging "failed to scan Git repository", then "no leaks found" and exit 0. So secret-scan
  has been green without reading a commit, for as long as the runner has had that ownership
  mismatch.
  - The step now sets `safe.directory` for itself, through a throwaway global config in
    `$RUNNER_TEMP` (`GIT_CONFIG_GLOBAL`). That leaves the runner's real config alone.
  - The first version used `GIT_CONFIG_*`, which git before 2.38 ignores for
    `safe.directory`. The runner has 2.34.1, so the CISO rejected it.
  - Reproduced here: a checkout owned by another user gives exactly CI's "dubious
    ownership / failed to scan / no leaks found". With the fix it scans.
  - It fails unless gitleaks logged no error AND scanned at least 90% of the non-merge commits
    that change something (`git rev-list --count --no-merges HEAD -- .`).
  - It is a floor rather than equality, because gitleaks' own count runs about 2 below that
    number. A shallow or failed scan is far under it.
- **And the custom `gametracker-config-password` rule captured the KEY, not the value.**
  - Its reported "secret" was the word `password`, so `--redact` hid the key and printed the
    value into CI logs.
  - No regex allowlist entry could ever apply to it.
  - Fixed: the key group is non-capturing and `secretGroup = 1`. It still catches a real
    non-empty bindPass value and ignores the empty template.
  - With that fix, and an exact allowlist entry for the smoke test's fake MCP token, the full
    history scans clean with gitleaks 8.21.2.
- **Pinned:** `runtime.test.js` checks the `safe.directory` env, the fail-closed checks, the
  absence of doc path allowlists, and the rule's capture group. Each check fails on the old
  files.
- **Review fix:** this commit's own ROADMAP text contained a sample `bindPass` value, which
  the corrected rule flagged, so the branch failed its own scan. Both reviewers caught it. The
  commit was amended and force-pushed; it was on this unmerged branch only, so no text was
  allowlisted.
- **Operator note:** CI never scanned while this was broken, so the scan's first real run will
  be the first real scan of the history. It passes locally on exactly the same history.

### [x] SEC-6 Deploy stops production before starting the new version, with no rollback
- **Where:** `docker-build-deploy.yml:982-998`, then `:1037`.
- **Failure:** a new image fails its healthcheck and production stays down until someone
  steps in. There is also downtime on every deploy.
- **Fix:**
  - Keep the previous image tagged `:previous`.
  - `up -d` without an explicit stop.
  - On a failed health check, retag `:previous` → `:latest` and `up -d` again.
- **Done** (`8fd5a87`, `cf46533`): no `docker compose down`, so the database keeps running.
  On failure or cancellation, a rollback step restores `:previous` and brings it back up, and
  the job stays failed.
- **Review fix** (after `/code-review`): cleanup deleted a push run's `sha-` images even when
  the run never deployed. "Re-run failed jobs" does not rebuild, so a transient scan failure
  could only be recovered by a full rebuild. A push run now keeps its tags until a deploy
  succeeds, and a successful deploy removes every leftover `sha-` tag.
- **Known limits:**
  - A rollback cannot undo a schema migration. CLAUDE.md now requires every migration to leave
    the previous release able to run.
  - A release that changes a compose network definition needs a manual `down` / `up`.
  - Re-running a whole workflow for an already-deployed commit leaves no older image to roll
    back to.
  - `sha-` tags from push runs that never deployed pile up until the next successful deploy.
    On a runner that has already run out of disk once, consider also removing tags older than N
    days (CISO note).

### [x] SEC-7 Session JWT in localStorage, and `exp` is never checked on the client
- **Where:** `frontend/src/App.jsx:38,295,94-99`, `ApiTokensSection.jsx:52`.
- **Mitigation already in place:** `script-src 'self'` (`nginx.conf:30`).
- **Fix (short term):** check `exp` in `useAuth` and log out when it has expired.
- **Fix (long term):** move to an `HttpOnly; Secure; SameSite=Strict` cookie with CSRF
  protection. Needs Architect and CISO review, because the Android client uses Bearer.
- **Done (short term):** `frontend/src/session.js#readSession` checks `exp`. It is used at boot
  and at login. An expired or malformed token is dropped, and a timer logs out at expiry
  while the app is open. It also decodes base64URL correctly: the inline `atob()` threw on
  payloads encoding to `-`/`_` and read those users as logged out. **The long-term cookie
  move is split out as SEC-14.**

### [x] SEC-8 `crackInfo.url` goes straight into `href`
- **Where:** `frontend/src/App.jsx:2932`.
- **Fix:** allow only `http:` and `https:` before rendering the link, and apply the same
  check on the backend where the URL is scraped.
- **Done:** `frontend/src/safeUrl.js#safeExternalUrl` guards the link. On the backend the URL
  is built as `https://crackrelease.com/<slug>/` from a `[a-z0-9-]` slug and never taken
  from the page. A contract test pins that with hostile game names.

### [x] SEC-9 `reset-root-password.js` takes the password from argv
- **Where:** `reset-root-password.js:21`.
- **Problem:** argv is visible in `/proc` and in shell history.
- **Fix:** read it from an environment variable or stdin, as `create-local-admin.js` does.
- **Done:** it reads `NEW_ROOT_PASSWORD`. argv is still accepted with a warning, because this
  is the break-glass path and a runbook using it must not be stranded mid-lockout. The README
  runbook adds `unset NEW_ROOT_PASSWORD` afterwards.
- **Before production (CISO):** on GameTracker-stg, confirm that the host's compose passes a
  value-less `exec -e NEW_ROOT_PASSWORD` through. If it does not, the break-glass path fails
  with "at least 8 characters" in the middle of a lockout.

### [x] SEC-10 `/api/debug/...` route still shipped
- **Where:** `index.js:1054`.
- **Fix:** remove it, or gate it on `NODE_ENV !== 'production'`, and update
  `test/api-surface.test.js`.
- **Resolved differently: kept.** v1 is frozen and "no route disappears". The Android app and
  scripts cannot be grepped from here, so nothing proves it unused. The route is
  owner-or-admin and returns five fields of the caller's own row, so its danger was not the
  route itself. What is gone: logging every request (username, the raw `:gameId`, the row)
  at info level, and its own SQL. It is now an adapter over `libraryService.findGame`, the
  read v2 uses, with its six-field shape pinned in `test/api-contract.test.js`. Remove it
  only if a v1 sunset is ever decided.
- **Follow-up (CISO, non-blocking):** announce it in `/api/capabilities` `deprecations[]`,
  pointing at `GET /api/v2/library/games/:gameId`, and gather hit counts (route only, no
  username or game id) so a sunset can be decided on evidence. Not done here:
  `deprecations[]` has no defined element shape yet, and inventing one in passing would
  freeze it by accident. It needs an Architect decision first.

### [x] SEC-11 `.env` variants not ignored
- **Where:** `.gitignore` and `.dockerignore` only cover `.env`, `.env.local` and
  `.env.*.local`.
- **Failure:** a `.env.production` is committed and copied into the image.
- **Fix:** ignore `.env*`, with an exception for `!.env.example` if one is added.
- **Done:** `.env*` in `.gitignore` and `**/.env*` in all three `.dockerignore` files.
  `.dockerignore` patterns are anchored at the context root, so a bare `.env*` there left
  `frontend/.env.production` in the backend context (caught in review).
  `test/runtime.test.js` checks each file and allows only `!.env.example` as a negation.

### [ ] SEC-14 Move the web session to an HttpOnly cookie (split from SEC-7)
- **Where:** `frontend/src/App.jsx` (`localStorage` token), `index.js#authRequired`.
- **Why:** a token in `localStorage` is readable by any script that runs in the origin.
  `script-src 'self'` makes that hard, not impossible.
- **Fix:** an `HttpOnly; Secure; SameSite=Strict` cookie for the SPA, with CSRF protection,
  and Bearer kept for Android, scripts and PATs. This is a design change: it needs Architect
  and CISO sign-off before any code.
- **Constraint (CISO):** `/api/v2` must never accept the cookie. v2 is PAT-only by design, and a
  session cookie there is exactly the scope-less JWT that design excludes.

### [x] SEC-15 `crackrelease-status` has no server-side rate limit (CISO, FE-1 review)
- **Where:** `POST /api/user/:username/games/:gameId/crackrelease-status` (`index.js`).
- **Why:** each call writes to the database and fetches a third-party site. FE-1's
  in-flight dedupe is a courtesy in one client, not a control: a script or a PAT can loop.
- **Fix:** a per-user budget, like `testNotificationLimit`, pinned in
  `test/api-surface.test.js`.
- **Done:** `crackCheckLimit` — 60 checks per user per 5 minutes, every attempt counted, 429
  `{error}` with `Retry-After` — on the per-game route AND the admin variant (same outbound
  cost). Pinned on both chains in `test/api-surface.test.js`; the 61st call is a 429 in
  `test/api-contract.test.js`. BOTH routes share ONE budget per caller.
- **Review fixes:** the limiter's POSITION (after authentication and authz — before it, it fails
  open) is pinned for this and `testNotificationLimit` (CISO). A throttled check is no longer
  cached as `unknown` for the session: the SPA leaves it unset and sends nothing until
  `Retry-After` has passed (CISO). The admin route does not write — docs corrected — and
  CLAUDE.md's freeze note now says an abuse-bounding 429 in the `{error}` envelope with
  `Retry-After` is not a "status move" (Architect).
- **Watch in operation (CISO):** titles CrackRelease does not know stay NULL, so a large library
  of them re-requests on every reload and hits the budget first. If that is reported, stop
  re-requesting known misses (a server-side checked-at time). **Do not raise the budget.**

### [x] SEC-16 React Router HIGH advisory in the shipped SPA (found by `npm audit`, UP-20)
- **Where:** `frontend/package.json` `react-router-dom@^6.30.1` → `@remix-run/router <=1.23.2`:
  GHSA-2w69-qvjg-hvjx and GHSA-2j2x-hqr9-3h42 (open redirect / XSS via a same-origin redirect
  whose path starts with `//`). A production dependency: it ships in the nginx image.
- **Exposure here:** the one path-from-storage navigation (`navigate(sessionEnd.from)`) is
  already guarded by `session.js#safeReturnPath`, which refuses `//` and `/\`.
- **Fix:** bump to the patched 6.x and re-run the component tests and the build.
- **Done:** `react-router-dom` 6.30.6 (`@remix-run/router` 1.23.4) clears both HIGH advisories.
  `npm audit fix` (non-breaking only) also cleared two more HIGH ones and a moderate one in the
  shipped bundle, all via Swagger UI on the API Reference page: `brace-expansion`, `js-yaml`
  (which parses the spec in the browser) and `dompurify`. Lint, the build and the component
  tests pass. **Remaining:** one moderate React Router advisory whose fix is v7, a breaking
  upgrade (FE-22).
- **What that fix changed in production (CISO review):** `npm audit fix` moved more than the
  advisories: `swagger-ui-react` 5.33.0, `immutable` **4 → 5** and `swagger-client`'s
  `neotraverse` **0 → 1** (both major bumps), a new `@tanstack/react-virtual`, and
  `redux-immutable` dropped. All of it is the API Reference page's lazy chunk. Checked in a
  real browser (Playwright, built bundle under `vite preview`, the real spec routed in): all
  35 operations render, the title reads `GameTracker API 2.0.0`, an operation expands, and there
  are no page errors. **Still load `/api-docs` on GameTracker-stg** before promoting: that
  check stubbed every other `/api` call.
- **Found along the way:** the Vite dev proxy key `'/api'` also matched the SPA's own
  `/api-docs`, so reloading that page under `npm run dev` or `vite preview` was proxied to the
  backend. It is now `'^/api/'`, the same boundary as nginx's `location /api/`. This was never
  a production defect.

### [x] SEC-17 CI tool installs: fixed /tmp paths, no checksum, then `sudo install` (UP-7 review)
- **Where:** the Gitleaks step and the three Trivy steps in `docker-build-deploy.yml`.
- **Problem:** each one downloaded to a fixed `/tmp/<tool>.tar.gz`, extracted to `/tmp`, and
  ran `sudo install` from there. On a self-hosted runner that IS the production host, a
  pre-planted `/tmp/gitleaks` (a symlink, or a binary raced in between the extract and the
  install) is what gets installed as root. Nothing checked the download beyond TLS, and
  the version pin says nothing about the bytes.
- **Done:**
  - **Private download dir:** each install downloads into a `mktemp -d` under
    `RUNNER_TEMP` (mode 0700, removed on exit).
  - **Pinned checksum:** it checks the tarball against a SHA-256 PINNED in the workflow,
    BEFORE extracting and before `sudo install`. The pins were taken from each release's
    `checksums.txt` AND recomputed from an independent download; both agreed. A checksum
    fetched from the same release would prove nothing if the release were what had been
    tampered with.
  - **Rehearsed locally:** the correct hash installs gitleaks 8.21.2 and leaves no temp
    dir; a wrong hash fails with nothing installed.
  - **Pinned in `runtime.test.js`:** no step uses a fixed `/tmp` path; every
    `sudo install` has `sha256sum -c` before `tar -x`, before `sudo install`, with a
    64-hex pin. Mutation-checked: dropping a check, or restoring a `/tmp` path, fails.
  - **Review fixes:** the pin now catches quoted and assigned `/tmp` paths (`-o "/tmp/x"`,
    `DL=/tmp/fixed`), and requires that the variable fed to `sha256sum -c` is itself a
    pinned 64-hex value, not merely that a hash appears somewhere. All three evasions are
    mutation-checked. A comment records that the hash protects the DOWNLOAD; a binary
    already installed at the pinned version is not re-hashed, and the version check
    still fails closed.

### [x] SEC-12 `library` scope never actually required
- **Where:** `services/auth.js:299-305` (`authorize` checks only `admin`).
- **Failure:** an `["admin"]`-only token can use every library route, although the spec says
  `x-required-scope: library`.
- **Fix:** enforce `library` on library routes, or change the spec and docs to say admin
  implies library. Decide first; either way `test/openapi.test.js` should pin the result.
- **Decided: enforce the spec** (owner's choice). The scopes are independent; `admin` does not
  imply `library`, and existing admin-only tokens lose library access.
- **Done:** `services/auth.js#holdsScope` is the one rule. v2 carries `requireLibraryScope` on its
  23 library routes (tier `pat-library`). v1's `authRequired` lets a PAT without `library` reach
  only `requirePermission`-gated routes, a set pinned in `test/api-surface.test.js`. It fails
  closed, so `GET/POST /api/settings` (inline admin check) refuse such a token; use v2
  `PATCH /settings`. `GET /api/v2/jobs/:jobId` is `x-required-scope: as-started`: the scope of the
  call that started the job, checked after ownership. Every spec operation documents its 403.
  The token UI no longer describes Admin as "everything above".
- **Operator action (before or at deploy):** list affected tokens with
  `SELECT t.id, u.username, t.name, t.scopes FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.scopes NOT LIKE '%"library"%';`
  and re-mint each that needs library access as `library,admin`, then revoke the old one.
  Record this breaking change in `GameTracker-stg/STAGING_CHANGELOG.txt` and
  `PRODUCTION_CHANGELOG.txt` (not in this checkout). An admin-only token handed to the MCP now
  gets 403 from every tool.
- **Reviews:** CISO and Architect approved with conditions (doc precision, the operator
  communication above, this tick). Code review: 0 high. All conditions are addressed in the
  follow-up commit. UI/UX reviewed the token-copy change.

### [ ] SEC-13 Audit accounts taken over before P0-1 (operator action)
- **Why:** before P0-1, an LDAP login relabelled a same-named local account `origin='ldap'` and
  kept its password hash. P0-1 now refuses directory claims on any hashed row, so login is
  safe. Two things remain:
  - Such a row signs in with its LOCAL password, which skips `requiredGroup`.
  - Sudo-mode minting (`services/users.js#verifyPassword`) still sends `origin='ldap'` rows to
    the directory. So a session that existed before the deploy can still mint a token.
- **Action:** on staging and then production, run
  `SELECT username, can_manage_users FROM users WHERE origin='ldap' AND password IS NOT NULL;`.
  For each row, decide what it is:
  - A real directory account: clear the hash.
  - A local account that was taken over: set `origin='local'` and rotate its password.
  - **Either way, revoke that account's API tokens.** A token minted during a takeover
    survives everything else here. Use `DELETE /api/v2/users/:id/tokens`.
  - Record the outcome here.
- **At the P0-1 deploy, rotate `JWT_SECRET`** (a CISO condition for leaving the minting gap
  open until this audit is done). That ends every session from before the deploy, so none can
  reach the minting endpoint. Everyone has to sign in again.
- **Follow-up:** make `services/users.js#verifyPassword` decide by the hash alone, as
  `directoryClaimRefusal` does: a row with a hash is checked locally, a row without one goes to
  the directory. Then login and minting follow one rule instead of two that disagree about
  `origin='ldap'` rows that still hold a hash.

---

## FE — Frontend

### [x] FE-1 Crack-status requests fire again on every render
- **Where:** `frontend/src/App.jsx:1096` (`currentGames` is a new `.slice()` on every render),
  used as an effect dependency at `:1110` and `:1131`.
- **Problem:** in-flight requests aren't tracked, so each response re-renders and re-POSTs
  every pending game.
- **Fix:** memoise `currentGames`, track in-flight ids in a ref, and send one batched request.
- **Done:** effects are keyed on `currentPageKey` (the visible ids), not the per-render array, and
  crack-status requests are tracked in flight, one per game. **Not batched:** that needs a new
  endpoint; the per-game loop now sends each at most once. Pinned in `test/runtime.test.js`.

### [x] FE-2 Search results can come from an older query
- **Where:** `App.jsx:722-750` (`handleSearch`).
- **Failure:** a slow response to an earlier search replaces the results for the current
  query, and its price lookups land in the shared `gamePrices` map.
- **Fix:** use an `AbortController` or a request-sequence id, and ignore stale responses.
- **Done:** a request-sequence ref; a result, error or price from any search but the latest is
  dropped. Pinned in `test/runtime.test.js`.

### [x] FE-3 The "already in your library" check compares names, not ids
- **Where:** `App.jsx:766-772`.
- **Failure:** RE4 (2023) is blocked because RE4 (2005) is in the library. The check also
  downloads the whole library on every add.
- **Fix:** compare `game_id`, using the library already held in state or the server's
  answer to the add.
- **Done:** `frontend/src/libraryMatch.js#libraryMatch`: 'same' (same id, or same name AND same
  known year) refuses the add; 'possible' (same name, a year unknown) adds it with a note
  that a same-named game is already there — search keeps the undated copy, so a strict
  yes/no let true duplicates through silently (code review); a remake with two different
  known years is neither. Reads the five-column
  `/api/user/me/games`, not the whole library. Tested in `helpers.test.js`.

### [x] FE-4 Login shows "Invalid username or password" for every error
- **Where:** `App.jsx:285-300`.
- **Failure:** a 429 lockout or a 5xx LDAP outage (the server sends 500) tells the user their password is wrong, so
  they retry. (Correction from the UI/UX review: retries do NOT extend the lockout; the
  server checks it before counting an attempt. They just keep failing.)
- **Fix:** give distinct messages for 401, 429 (with the retry time) and 503/network errors.
- **Done:** `frontend/src/loginErrors.js#loginErrorMessage`: 401 wrong password, 429 the
  server's message with its minutes, 5xx temporarily unavailable, no response can't reach the
  server. Tested in `helpers.test.js`.
- **Review fixes:** the server's lockout message said "1 minutes", and FE-4 now shows it
  verbatim; it is pluralised, says "sign-in", and carries `Retry-After` like the other two
  limiters. The button says "Sign in" and shows "Signing in…" while in flight, since a slow
  directory bind looked idle. A duplicate add is an info toast, not an error.

### [x] FE-5 A failed status change can undo other changes
- **Where:** `App.jsx:1147`, `:1164`.
- **Failure:** if game A's change fails after game B's succeeded, B is reverted in the UI too.
- **Fix:** roll back only the game that failed, from its own previous value.
- **Done:** the failure restores that game's previous status, and only if its status is still
  the one this request set. Pinned in `test/runtime.test.js`.
- **Known edge (code review, not a regression):** two quick changes to one game that BOTH
  fail (wishlist→playing, then playing→done) end on "playing" while the server holds
  "wishlist". The old snapshot restore was wrong here too. Re-fetching that game on
  failure would close it.

### [x] FE-6 Keyboard access: library cards and stats chips
- **Where:**
  - Cards only get `tabIndex` in backlog view (`App.jsx:1523`), and open only on click (`:1524`).
  - The stats chips are `<div onClick>` with no role (`:1353-1368`).
- **Fix:** use a `<button>` (or `role="button"` + `tabIndex=0` + Enter/Space handling).
- **Done:** the six chips are `<button>`s with `aria-pressed` and a label that says what they
  do; the pressed chip now has a visible state (it had none), and choosing one returns to page 1.
- **Revised after UI/UX review:** the first version put an `aria-label` on the focusable card
  `<div>` — invalid ARIA with no role, and where honoured it hid the date, price and status.
  Now every library and search card has a real title BUTTON that opens the details (in every
  view, the backlog included), and the library card is a `role="group"` labelled by it. The
  card takes focus only in the backlog, for reordering, with the instructions in
  `aria-describedby`. The status select and the icon buttons are named per game ("Status for
  X", "Remove X"). The reorder-held card has a dashed ring, distinct from focus. The filter
  buttons also expose `aria-pressed`. Pinned in `test/runtime.test.js`.

### [x] FE-7 GameDetailModal: no initial focus, no focus trap, no focus return
- **Where:** `frontend/src/GameDetailModal.jsx:84-103`.
- **Fix:** reuse the `handleModalFocusTrap` pattern (`App.jsx:343`). Focus the dialog when it
  opens and restore focus to the opener when it closes.
- **Done:** the trap moved to `frontend/src/focusTrap.js`, shared by App.jsx's dialogs and
  GameDetailModal and tested in `helpers.test.js` (SharedLibrary's dialogs: FE-19). The dialog focuses its close button on open and returns focus to the
  opener (the card) on close, keyed on open/closed, so the library's refetches do not steal it.
  When the opener is gone (Remove, or a status change that filters the card out), focus goes
  to the list it was in (`fallbackFocusRef`), not `<body>` (UI/UX review). Named by its heading
  (`aria-labelledby`).

### [x] FE-8 Duplicated Bearer headers and 403-logout logic
- **Where:** `App.jsx:366`, `:2001`, `:2188`, `:2434`, and `SharedLibrary.jsx`.
- **Problem:** these build their own headers even though the interceptor already adds them.
  This duplication is how P0-6 happened.
- **Fix:** rely on the interceptor and on one error handler.
- **Done (with P0-6):** hand-built headers removed from 28 call sites (17 constructions: 13
  inline plus 4 helpers; the commit message's "24" is wrong) across App.jsx,
  SharedLibrary.jsx and ApiTokensSection.jsx. The interceptor adds the header to every same-origin `/api` call,
  and Swagger UI's own client on the API page is the one deliberate exception. Pinned in
  `test/runtime.test.js`. Four lint warnings went with them.

### [x] FE-9 `SharedLibrary.jsx` lives outside `src/`
- **Fix:** move it to `frontend/src/` and fix its imports (it currently imports
  `./src/contexts/...`).
- **Done** (`git mv`, so history follows it). `test/runtime.test.js` now refuses any `.jsx`
  outside `frontend/src/`.

### [x] FE-10 `App.jsx` is ~3000 lines with at least eight page components
- **Fix:** split it into `src/pages/*` one page per PR, starting with the pages touched by
  FE-1 to FE-5. No behaviour change in the same PR.
- **In progress:**
  1. `UserManagementPage` (and its `userApiError` helper) moved to
     `src/pages/UserManagementPage.jsx`, verbatim apart from its imports. App.jsx went from
     3,168 to 2,757 lines.
     - The pages FE-1 to FE-5 touch (Search, Library) are held back on purpose: their
       source-text pins in `test/runtime.test.js` read `App.jsx`, and should move to
       behaviour tests as those pages are extracted.
     - Verified: lint, the component tests (27 at the time), the runtime pins (the dialog-per-hook pin now
       covers the new file), and both User Management browser checks from FE-18 and FE-19,
       unchanged.
  2. `SystemStatusPage` → `src/pages/`. It renders mocked probe results in the built app
     with no page errors.
  3. `SettingsPage`, with the five components only it uses (`SettingsSection`,
     `SettingsField`, `SectionSaveBar`, `DiagSelect`, `AkField`), → `src/pages/`. App.jsx is
     now 1,845 lines.
     - Verified in the built app: all seven tabs render with no page errors. The first run
       hit "J.map is not a function" on Diagnostics; it was the same on `HEAD` and came from
       my mock answering `{}` where `/user/me/games` returns an array (pinned in
       `api-contract.test.js`), so it was not the extraction.
  4. `CalendarPage` and `AccountPage` → `src/pages/`. Two orphans left behind by blank
     lines move with them: the `formatDateLocal` note, and `NOTIF_DAY_OPTIONS`, used only by
     AccountPage. `App.jsx` also lost 16 icon imports and `ApiTokensSection`, which it no
     longer used; lint allows unused capitalised names, so nothing flagged them.
     - App.jsx is now **1,517 lines, down from 3,168**.
     - Verified in the built app: the calendar shows a mocked release, and the account page
       shows its reminder options and the API Tokens section, with no page errors.
  5. `SearchPage` → `src/pages/`. The status helpers it shares with the library
     (`STATUSES`, `isGameReleaseInFuture`, `isGameUnreleased`, `normalizeStatus`) move
     verbatim to `src/gameStatus.js` rather than being imported back from App.
     - **The FE-2 source-text pin is retired.** It counted `seq !== searchSeq.current`
       guards. `pages/SearchPage.test.jsx` now drives the page instead, with four tests:
       a stale search's late results, late error, late price and late price failure must
       each change nothing. Removing each guard fails its own test.
     - The FE-6 title-button pin reads App.jsx plus SearchPage.jsx. The FE-7 wiring pin no
       longer names a file: every `<GameDetailModal` in `src/` and `src/pages/` must pass
       `fallbackFocusRef`. Deleting SearchPage's fallback fails it.
     - App.jsx is now **1,276 lines**.
     - Verified in the built app: a search shows its result and Steam price, the detail
       dialog opens, and Escape returns focus to the title, with no page errors.
  6. `LibraryPage` → `src/pages/`, byte-identical apart from `export default` and its
     imports. App.jsx is now **370 lines, down from 3,168**: the shell, the routes and
     `LoginPage`.
     - **The FE-1, FE-5 and FE-6 source-text pins are retired.** `pages/LibraryPage.test.jsx`
       drives the page instead, with seven tests. Ten mutations were each caught:
       - removing the crack-check in-flight set, or the 429 back-off;
       - dropping the rollback's `g.status === status` condition, or restoring a
         whole-library snapshot;
       - one chip losing `aria-pressed`;
       - a card losing `role="group"` for an `aria-label`;
       - a card that is a tab stop outside the backlog;
       - Escape after the inner-control guard, or no inner-control guard at all;
       - a card control losing its name.
     - One shape pin stays, because nothing on screen shows it: no effect may be keyed on
       the per-render `currentGames` array. The in-flight set already stops the duplicate
       requests, so only the wasted effect runs remain.
     - The "component tests exist" check now wants a minimum test count per file (Architect
       review): an emptied file passed an existence check.
     - **Found by the new tests:** keyboard reordering of the backlog has never moved
       anything. That is **FE-23**, fixed separately, because this change moves code
       without changing behaviour.
     - Verified in the built app: cards, crack dots, and the title button opening the
       dialog with focus returned on Escape; backlog cards take focus. No page errors.
  - **Review of step 6 (Architect):** two things the retired pins covered were not yet in a
    test. They are now:
    - a search result's title BUTTON opens the dialog (`SearchPage.test.jsx`);
    - no `aria-label` on a BACKLOG card, which is where the FE-6 regression shipped.
    The test-count guard also counts `test(` and refuses `.skip`/`.only`/`.todo`. A skipped
    test counted and ran nowhere.
  7. `LoginPage` → `src/pages/`, byte-identical apart from `export default` and its imports.
     Its test moves with it to `pages/LoginPage.test.jsx`. App.jsx drops the named
     `export { LoginPage }` that existed only for that test, plus the `api` import, which
     only the login used.
     - **App.jsx is now 262 lines, down from 3,168:** the shell and the route table.
     - Verified in the built app: a signed-out visit to /library lands on /login; a
       refused password shows "Invalid username or password."; the next sign-in lands on
       /search. No page errors.
  - **Done.** Every page App.jsx used to hold is in `src/pages/`. `StatsPage`,
    `SharedLibrary` and `ApiDocsPage` were always separate files in `src/` and stay there:
    moving them is churn with no behaviour attached.

### [x] FE-11 CSP allows `style-src 'unsafe-inline'`
- **Where:** `frontend/nginx.conf:30`.
- **Status:** an accepted trade-off for inline styles and Swagger UI. Record the decision.
  Revisit if inline `style=` usage is removed.
- **Done: removed, not just recorded, because the premise was wrong.** React's `style={{}}`
  props are applied through the CSSOM (`element.style`), which CSP does not govern; only
  `<style>` elements and `style="…"` in MARKUP are.
  - **Measured in Chromium:** the built bundle was served with `style-src` WITHOUT
    `'unsafe-inline'`, with a `securitypolicyviolation` listener installed before any
    script. Login, search, library, settings, stats, account and `/api-docs` (Swagger UI,
    35 operations, one expanded) raised ZERO violations. A planted `<style>` and
    `style="…"` raised two, which proves the detector works.
  - **Nothing injects either:** no `dangerouslySetInnerHTML`, no runtime `<style>`, in the
    app or in swagger-ui-react and react-icons.
  - **Pinned:** `test/runtime.test.js` requires the CSP to carry no `unsafe-*`, and no SPA
    module to set style through markup.
  - **Coverage limit:** the pages ran against empty API responses.
  - **CISO condition, staging check before promotion:** on GameTracker-stg, in Chromium AND
    Firefox, with the DevTools console open, it must show no CSP errors while you:
    - load the library with real covers;
    - drag-reorder the backlog;
    - open the detail dialog with its history;
    - trigger a toast;
    - open the shared library page and stats;
    - open `/api-docs` and expand an operation;
    - check that Google Fonts load.
  - **Review fix:** the markup scan also refuses `.innerHTML =`, `insertAdjacentHTML` and a
    JSX `<style>`; a planted JSX `<style>` fails it. Swagger UI's markdown can emit
    `style="text-align"`, but it goes through DOMPurify with `FORBID_ATTR: ["style"]`,
    because `useUnsafeMarkdown` is off, so it never reaches the DOM.

### [x] FE-12 Expired token renders the app until the first 401
- **Where:** `useAuth` (`App.jsx:94-99`).
- **Fix:** covered by SEC-7's short-term fix. Tick both together.

### [x] FE-13 Flag admin-only tokens in the token list (from the SEC-12 UI/UX review)
- **Where:** `frontend/src/ApiTokensSection.jsx` (token badges).
- **Why:** tokens minted under the old "Admin: everything above" copy show only an Admin
  badge, and nothing tells their owner they can no longer reach the library.
- **Fix:** a muted "No library access" hint on tokens whose scopes are exactly `['admin']`.
- **Done:** a dashed, muted "No library access" badge on tokens whose scopes are exactly
  `['admin']`, with a tooltip saying why and what to mint instead.

### [x] FE-14 Return path after an ended session ignores who signs in next (UI/UX review)
- **Where:** `frontend/src/session.js#markSessionEnded`, `LoginPage` (`App.jsx`).
- **Why:** on a shared machine, a different user signing in after someone else's session
  expired is sent to the previous user's page, for example another user's library path,
  and may land on an error.
- **Fix:** record the username with `from`, and honour `from` only when it matches the new
  login. The boot path needs the expired token's `username`, which `readSession`
  deliberately refuses to return, so this needs a small decode-ignoring-`exp` helper.
- **Done:**
  - `session.js#sessionOwner(token)` names a token's user while ignoring `exp`. It is used
    ONLY for this decision, never for rendering; `readSession` still refuses expired tokens.
  - `endSession` reads the owner BEFORE removing the token and records `{from, owner}`.
  - `returnPathFor(sessionEnd, newToken)` returns the stored path only when the NEW
    token's user is the same. A record without an owner (written before this change) is
    never honoured.
  - `LoginPage` navigates through it.
  - **Tests:**
    - unit tests: the owner survives expiry, case-insensitive matching, bob-after-alice,
      and a legacy record;
    - two routed `LoginPage` component tests: the same user returns to their page, a
      different user lands on `/search`. Reverting the navigate fails exactly the
      second one.

### [x] FE-18 One banner style for page messages (UI/UX review of P0-6)
- **Where:** User Management shows a translucent `gt-alert` for errors next to a solid,
  centred `.success-msg`; dialogs use solid `.error-msg` blocks.
- **Fix:** success/info variants of `gt-alert` (`gt-alert--info` exists) for page-level
  messages; auto-dismiss or move success notices to the global toast, the app's usual
  feedback; give the sticky page banner `top: 1rem` and a more opaque background outside
  scrolling panels.
- **Done:**
  - **Success messages go to the global toast,** the app's usual feedback, which dismisses
    itself: user created, deleted, updated, the LDAP sync result (four calls). The
    solid, centred green blocks, in the dialog and on the page, and their
    `.success-msg` CSS are gone.
  - **The Add User dialog's errors** use the same translucent `gt-alert--danger` as the
    page banner, with `role="alert"`.
  - **The sticky page banner** sits at `top: 1rem` and is opaque (12% danger over
    `--surface-1`), so content scrolling under it no longer shows through its text.
  - **Found while checking:** Add User answered every failure "Failed to create user". It
    now shows the server's own 4xx reason, such as "User already exists", or the
    permission text for a 403, and stays generic otherwise. The backend only exposes
    `expose: true` messages.
  - **Screenshots and measurements from the built app** cover the page banner (at
    `top: 16px`, opaque) and the dialog error ("User already exists").
  - **Review fixes (UI/UX Shoulds):**
    - **Delete is disabled while it runs** (`aria-busy`, "Deleting…"). The dialog now
      stays open across the delete, and a double-click sent a second DELETE, which 404'd
      into "Failed to delete user" right after the success toast. Verified: a double-click
      sends one request.
    - **The password dialog stays open on failure and says why.** The error sits under the
      field (`aria-describedby`, `aria-invalid`) and clears on edit. It used to close
      regardless, with a generic page error. Verified: a policy rejection shows "Password
      must be at least 8 characters." in the open dialog.
    - **One rule for the message:** `userApiError()` is shared by create and edit. It gives
      the server's exposed 4xx text, a fixed sentence for 403, and a generic message
      otherwise.
    - **The LDAP sync toast** stays up for 10 s: a sentence with two numbers must be read
      before it goes.
  - **Second review round:**
    - Delete uses `aria-disabled`, not `disabled`. Disabling the FOCUSED button dropped
      focus to `<body>`: the trap stopped and "Deleting…" was never announced. The useless
      `aria-busy` is removed, and a CSS rule gives `aria-disabled` buttons the disabled
      look.
    - Cancel, Escape and a background click cannot close the dialog mid-delete.
    - The password dialog ignores a second submit while one is in flight.
    - Verified in the built app: mid-delete, focus stays on the button, which reads
      "Deleting…" with `aria-disabled`; Escape leaves the dialog open; one request is sent.
  - **Left:** `.error-msg` is still used by the login page, search, library and
    SharedLibrary for single-line inline errors. That is a separate component (inline, not
    a page banner) and was not in this item's scope.

### [x] FE-15 SettingsPage still has 401 branches the interceptor makes unreachable
- **Where:** `App.jsx` API-keys loader and its `apiKeysAuthError` banner.
- **Why:** since P0-6 a 401 is the interceptor's (it reloads to `/login`), so these branches
  either never run or race the reload.
- **Fix:** remove them; keep the 403 messages.
- **Done:** the API-keys loader and its "Session expired — log out and log back in" banner are
  gone; a 401 reaching that page's error text now only happens without a stored token and
  says "Your session has ended. Please sign in again.", like the other pages.

### [x] FE-16 One `API_BASE` and one axios instance (pair with FE-9)
- **Where:** `API_BASE` is defined five times (`${origin}/api` in four files, `'/api'` in
  `ApiTokensSection.jsx`), and every page depends on App.jsx having modified the GLOBAL
  axios instance on import.
- **Fix:** a `frontend/src/api.js` owning `API_BASE` and the interceptors on an
  `axios.create()` instance, and update the "only App.jsx" pins in `test/runtime.test.js`.
- **Done:**
  - **`frontend/src/api.js`** owns `API_BASE` and an `axios.create()` instance with both
    interceptors:
    - the token goes to `/api/` only, absolute or relative, and never to `/api-docs` or
      another host;
    - a 401 ends the session through `endSession` and goes to `/login`.
  - **Every call site** in App.jsx, GameDetailModal, StatsPage, SharedLibrary and
    ApiTokensSection now uses `api`. They were all our own API; the four other
    `API_BASE` definitions are gone. The GLOBAL axios now carries no interceptors, and a
    test asserts that.
  - **Pins updated:** only `api.js` imports axios, `API_BASE` is defined once, the one
    Bearer header is in `api.js`, and the 401 interceptor's `endSession` is in `api.js`.
  - **Tests:** `LoginPage.test.jsx` spies on `api.post`. Spying on the global would have
    been a silent false pass. New `api.test.js` covers the token placement, the global
    being untouched, a 401 ending the session, and a 403 NOT ending it. Mutation-checked:
    removing the `endSession` call fails one test, and sending the token everywhere fails
    another.
  - **Review follow-ups folded in (FE-14 review):**
    - Reduced motion also stops the infinite login-background drift and the status-pill
      and accent-dot hover scales (measured).
    - The markup scan strips comments before matching, uses `innerHTML =` but not `==`,
      and also catches `outerHTML =` and `document.write`.
  - **Review fixes (UI/UX rejected the first cut):**
    - `.theme-dot:hover` also matched the ACTIVE dot, so under reduced motion hovering it
      snapped the dot from 1.2 to 1.0. It is now `:not(.active):hover`. Measured: the
      active dot stays at 1.2 and an inactive dot doesn't grow.
    - Only the transform transition goes now; colour transitions stay, as in the card
      rule.
    - The comment stripper was not string-aware: `'//'` or `'image/*'` in a string could
      hide the code after it. It now strips only comments that START a line, and JSX
      `{/* */}`. Mutation-checked: code after `'image/*'` is caught, and a comment
      mentioning innerHTML is ignored.
    - The axios pin also catches `import('axios')` and `'axios/…'` subpaths.
    - Stale "global interceptor" and `axios.post` comments are updated.

### [x] FE-17 One `endSession()` in `session.js`
- **Why:** three call sites remove the token, and a count of 3 is pinned. One function
  would make the claim "one way to end a session" literal and the pin 1. It must touch
  storage only inside the function: `helpers.test.js` imports `session.js`.
- **Done:** `session.js#endSession({explain, fromPath})`; the 401 interceptor, the expiry check
  at boot, sign-out and the expiry timer all call it. `test/runtime.test.js` now pins ONE
  `removeItem('token')`, in session.js, and a unit test pins that a manual sign-out leaves no
  "session ended" notice.

### [x] FE-19 One `useDialogFocus()` hook for every dialog (Architect, FE-7 review)
- **Where:** the user-management dialogs set focus with `setTimeout(…, 50)` and never return it;
  the delete-confirm `alertdialog` gets no initial focus at all (an alertdialog needs one);
  SharedLibrary.jsx's two `aria-modal` dialogs have no trap, no initial focus and no return.
- **Fix:** a `frontend/src/useDialogFocus.js` hook, `(isOpen, initialRef) → { onKeyDown }`,
  owning focus-on-open, focus-return and the trap (focusTrap.js stays React-free for its
  `import()` test). It can put `tabIndex=-1` on the container, which closes a gap in the
  trap: a click on a non-focusable area moves focus out of the dialog. Migrate
  GameDetailModal to it. **Until then, no dialog copies GameDetailModal's effect by hand.**
- **Also (UI/UX):** make the page behind an open dialog `inert`; the trap only wraps at the
  first and last focusable elements.
- **Done:**
  - **The hook:** `frontend/src/useDialogFocus.js`, `(isOpen, { initialRef, dialogRef,
    fallbackRef, onEscape }) → { onKeyDown }`. It is GameDetailModal's FE-7 effect,
    generalised: focus in on open; back to the opener on close; else the fallback, else
    `.page-title`, never `<body>`; plus the trap.
  - **The dialogs on it:**
    - GameDetailModal, whose six tests pass unchanged;
    - the three user-management dialogs, whose 50 ms `setTimeout` focus is gone. The
      delete `alertdialog` now opens on **Cancel**, its least destructive action;
    - SharedLibrary's two dialogs, which had no focus handling at all. They also gain
      `aria-labelledby`, so they have an accessible name.
  - **Trap gap closed:** focus on the dialog container itself, after a click on a
    non-focusable area or when the container took the initial focus, used to let Shift+Tab
    leave. It now wraps inside.
  - **Tests:** a hook harness covers initial focus, container focus, return, the fallback
    when the opener is gone, the trap from the container, and Escape.
    - Mutation-checked: removing the container wrap fails exactly that test.
    - `runtime.test.js` refuses a file with more dialogs than `useDialogFocus` calls, and
      any `setTimeout(() => ….focus())`.
  - **Checked in the built app:** Manage Sharing opens on Close, is announced by name,
    keeps Shift+Tab inside, and Escape returns focus to the button.
  - **Review fixes (both Shoulds):**
    - **The container-wrap claim above was an overclaim when first shipped.** In the five
      App.jsx and SharedLibrary dialogs, `role` and `tabIndex=-1` sat on the backdrop but
      `onKeyDown` sat on the inner window. A click on the window's padding focused the
      backdrop, outside the handler, and Shift+Tab left. `onKeyDown` now sits on the role
      element. GameDetailModal's dialog gets `tabIndex=-1`, so a click inside keeps focus
      in it rather than on `<body>`.
    - **After a delete, focus went to `<body>`.** The confirmation closed while the row
      still existed, so focus returned to its Delete button, which the refetch then
      removed. It now closes after the delete AND the refetch, so the hook falls back to
      the page heading.
    - **Verified in the built app:**
      - a click on the dialog's padding, then Shift+Tab, stays inside;
      - the confirmation opens on Cancel;
      - after the delete, focus is on the "User Management" heading.
  - **Not done: `inert` on the page behind.** Every dialog is rendered INSIDE its page, so
    making the page inert would disable the dialog too. That needs the dialogs portalled
    out first; recorded for FE-10's page extraction.
  - **FE-20 review nit:** the unused `.unreleased-badge` CSS (no element carries it) is
    deleted.

### [x] FE-20 Accent presets collide with the fixed status colours (UI/UX, pre-existing)
- **Where:** `App.css` `.stats-chip--*` and the status colours. Under Violet, Wishlist and Done
  are both purple; under Emerald, Wishlist and Playing are both green; under Amber, Wishlist is
  close to Backlog's orange. The chips stay distinguishable only by icon.
- **Fix:** give Wishlist a colour independent of `--color-accent`, or pick the status palette
  so no preset collides.
- **Done:** the app already had the answer. The `--color-status-*` tokens (Wishlist
  `#38bdf8`) were used by the status dots, the card edges and the stats page. Three places
  did not use them, and now do:
  - the library's stats chips: a second, hard-coded palette, with Wishlist on the accent;
  - the card hover glows: the same;
  - an unscoped "detail page" block: pink Wishlist, ACCENT Playing, green Done.
  - **Measured in Chromium on the real library page** (one game per status), old then new:
    - Old: under Violet the Wishlist chip was `rgb(139,92,246)` beside Done's
      `rgb(168,85,247)`; under Emerald it was `rgb(16,185,129)` beside Playing's
      `rgb(34,197,94)`.
    - New: all five are fixed and distinct under every preset.
    - Screenshots also showed the Backlog chip (orange) did not match the Backlog card edge
      (amber); now it does. The cards themselves are unchanged.
  - **Left as is:** `.unreleased-badge` still uses the accent. It is a release badge, not a
    status chip, and it sits beside no other status colour.

### [x] FE-21 `.game-card`'s entry animation overrides every card transform (UI/UX, code review)
- **Where:** `App.css` — `.game-card { animation: cardEnter 0.3s ease both }`. Fill-mode `both`
  keeps the last keyframe's `transform: translateY(0)`, which beats normal declarations, so
  the grid and list hover lifts and the backlog drag-over `scale(1.02)` never apply (measured
  in Chromium: identity matrix).
- **Fix:** `animation-fill-mode: backwards`, or animate `translate`/`opacity` instead of
  `transform`. Then mind the cascade: `.game-card:hover` (0,2,0) beats
  `.card-keyboard-selected` (0,1,0).
- **Done:** `animation-fill-mode: backwards`. The end state is the card's own style, where it
  lands anyway.
  - `.card-drag-over` is now `.game-card.card-drag-over` (0,2,0), placed after
    `:hover`, so a hovered drop target shows the drop cue, not the lift.
  - `.card-keyboard-selected` keeps no transform: `:hover` (0,2,0) outranks it (0,1,0), so
    a lift there would fight the pointer. Its comment now says that.
  - New: `prefers-reduced-motion: reduce` turns the entry animation off.
  - **Measured in Chromium** (built CSS), old then new:

    | | Old | New |
    |---|---|---|
    | Resting | identity | `none` |
    | Hovered | identity | `translateY(-5px)` |
    | Hovered drag-over | identity | `scale(1.02)` |

    With reduced motion, no animation runs.
  - **Review fixes (UI/UX):**
    - List view's hover (0,4,0) out-ranked the drop cue. A hovered drop target in list
      view now scales too (measured 1.02).
    - Reduced motion now also stops the TRANSFORMS this change brought back to life: the
      hover lift, the cover zoom and the drag-over scale (measured `none`). The border,
      shadow and outline cues stay.
  - **Nit, left:** with the pointer in a card's bottom 5px, the lift moves the card out
    from under it, so it can flicker. The fix is to lift an inner wrapper; recorded for the
    card rework.

### [x] FE-22 React Router 7 (moderate advisory; breaking upgrade)
- **Why:** `npm audit --omit=dev` still reports `react-router 6.0.0–7.17.0` (moderate,
  GHSA-wrjc-x8rr-h8h6: open redirect via a backslash in `<Link>`/`useNavigate`); the fix is v7.
  Exposure: the one storage-driven `navigate()` goes through `safeReturnPath`, which already
  refuses `/\` (`session.js` sanitises it both when storing and when reading back). Every other
  `<Link>`/`<Navigate>`/`navigate()` target is a string literal, so no attacker-supplied path
  reaches the router. GHSA-337j-9hxr-rhxg (same range) does not apply at all: it needs
  server-side rendering, and this SPA has none. The v7 future flags (`v7_startTransition`, `v7_relativeSplatPath`) already warn in
  the component tests.
- **Fix:** opt in to the future flags on v6 first, run the component tests, then upgrade.
- **Done:** `react-router-dom` 7.18.4. **The full `npm audit`, dev and production, is at 0
  vulnerabilities**, clearing GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg.
  - **What the app uses:** `BrowserRouter`, `Routes`, `Route`, `Link`, `Navigate`,
    `useNavigate`, `useLocation`, and `MemoryRouter` in tests. There are no data routers,
    loaders or splat routes, so v7's breaking changes did not apply, and the code needed no
    change.
  - **Production lockfile moves:**
    - `react-router`/`react-router-dom` 6.30.6 → 7.18.4;
    - `@remix-run/router` removed (v7 absorbed it);
    - new: `cookie` 1.1.1 and `set-cookie-parser` 2.7.2, React Router's server helpers.
    Some of that reaches the bundle: the main chunk grew from about 370 kB to 389 kB (121 kB
    gzip).
  - **Verified on the built bundle:**
    - navigation across five pages, with no console errors;
    - an unknown path goes to `/search`;
    - the token plus 401 → `/login` flow, with its notice;
    - the lazy `/api-docs` (35 operations);
    - dialog focus on SharedLibrary and User Management.

    The 27 component tests pass, including the routed FE-14 login tests, and the v6
    future-flag warnings are gone.
  - **The same staging check as SEC-16 applies:** load the app and `/api-docs` on
    GameTracker-stg before promoting.
  - **Review (Architect and UI/UX REJECTED the first cut):** React Router 7 wraps router
    updates in `React.startTransition` by default, which v6 did not. LoginPage's
    `setUser(session)` is an ordinary update, so the signed-in app rendered while the
    location was still `/login`. It matched the signed-in catch-all
    `<Navigate to="/search"/>`, which overtook `navigate(returnPath)`, still waiting in its
    transition. **FE-14's "back to where you were" was broken.** My checks missed it
    because `LoginPage.test.jsx` routes `*` to a location probe, not the real catch-all.
    - **Fix:** `src/routerConfig.js#ROUTER_PROPS = { useTransitions: false }`, the v6
      behaviour, used by `main.jsx` AND the routed tests, so a test renders the router the
      app ships.
    - **Test:** `App.relogin.test.jsx` renders the real `App` with its real route table:
      the same user returns to `/calendar`, a different one lands on `/search`.
      Mutation-checked: without the setting, the same-user test fails, reproducing the bug.
    - **Pin:** `runtime.test.js` requires `main.jsx` to spread `ROUTER_PROPS`.
    - **Staging:** add "sign in again after the session expires, and you return to the page
      you were on" to the SEC-16 check.

---

## UP — Tidying & upkeep

### [x] FE-23 Keyboard reordering of the backlog has never moved anything (found by FE-10's tests)
- **Where:** `frontend/src/pages/LibraryPage.jsx`, the card's `onKeyDown` and `handleBacklogDrop`.
- **Defect:** Enter/Space on a card sets `keyboardDragId`, and Enter on a second card calls
  `handleBacklogDrop(target)`. That function reads `draggedGameId`, which only a MOUSE drag
  sets, so it returns at its first line. No request is sent. The card is released, the live
  region goes silent, and the order is unchanged. The screen-reader path advertised in
  `#backlog-reorder-hint` does nothing.
- **Why nobody saw it:** the FE-6 pin in `test/runtime.test.js` checked that the TEXT
  `handleBacklogDrop(game.game_id)` appeared in the key handler, and it did. The first
  behaviour test to press the keys found it.
- **Fix:** `handleBacklogDrop(sourceId, targetId)`, with both paths passing the source
  explicitly, and a test asserting the `backlog-reorder` PUT carries the new order.
  Kept out of the FE-10 extraction, which changes no behaviour.
- **Done:** `handleBacklogDrop(sourceGameId, targetGameId)`. The mouse passes
  `draggedGameId` and the keyboard passes `keyboardDragId`.
  - The live region used to go silent on drop. It now says "Moved Charlie to position 1 in
    the backlog." once the server confirms the move, and clears when the next card is
    picked up.
  - **Tests** (`pages/LibraryPage.test.jsx`, three new):
    - the keyboard move sends the right order and announces it;
    - Enter twice on the same card sends nothing;
    - the mouse drag still reorders.
    Giving either path the other's id fails its test.
  - **Verified in the built app:** Charlie → Alpha's place sends `[3, 1, 2]`; the cards
    re-render in that order with badges #1–#3, and the move is announced. No page errors.
  - **Review follow-ups (UI/UX, Architect):**
    - Enter on the held card now puts it back, as the hint says ("Escape, or Enter on the
      same game, cancels"). Before, it did nothing.
    - After a confirmed keyboard move, focus goes to the card that MOVED, via a
      `data-game-id` lookup. Before, it stayed on the drop target, and moving up
      re-inserts that node, which drops focus to `<body>` in browsers. Chromium confirms
      focus lands on the moved card.
    - The announcement is cleared when the filter changes.
    - New tests for all three, plus Space as a pick-up/drop key.
  - **Second review:**
    - The focus move no longer takes focus from elsewhere. It acts only when focus is on
      `<body>` or inside the list, and it always clears its id, so a stale id cannot pull
      focus later. A test covers a user who typed in the search box during a slow PUT.
    - The live region's "Selected…" text names Space and Enter-on-the-same-game.
    - The three backlog comparators, one with a different sentinel, became one
      `byBacklogOrder`.
  - **Third review (all approved), non-blocking items applied:**
    - a test for focus that stayed inside the list, the one branch no test covered;
    - "Enter or Space" in both cancel texts;
    - the undo restore appends instead of sorting every status by backlog position.

    UP-25's disk guard now measures `docker info`'s real root and warns when it cannot
    measure. Before, a custom data-root skipped the check silently.

### [x] FE-24 Reordering the backlog with a search typed corrupted `backlog_order` (Architect, FE-23 review)
- **Where:** `frontend/src/pages/LibraryPage.jsx`: `handleBacklogDrop` and
  `handleMoveToTopOfBacklog`. Pre-existing, on the mouse path too.
- **Defect:** both built the new order from `filteredUserGames`, which is the SEARCH-filtered
  list. With "ap" typed over a four-game backlog they sent two ids, and
  `services/library.js#reorderBacklog` renumbered those two 1..2. That collided with the
  hidden games' positions, and the announcement stated a position that held only within the
  filtered list.
- **Fix:** `fullBacklog()` builds the order from every backlog game in `userGames`, sorted by
  `backlog_order`. A move then places the game relative to its target in the WHOLE backlog.
  The announced position is the real one.
- **Tests** (`pages/LibraryPage.test.jsx`): a keyboard move and "move to top" with a search
  typed each send the full four- or three-game order. Reverting either to
  `filteredUserGames` fails its test.
- **Not fixed here:** the server accepts a partial list. Making `reorderBacklog` refuse or
  complete one is a v1 behaviour change. The SPA now sends the whole list; the Android
  client is not in this repo, so what it sends is unknown.

### [x] UP-1 Stale `.trivyignore` entry
- **Problem:** `CVE-2026-33671` (picomatch via sqlite3) is in none of the three lockfiles,
  and because the suppression applies to all three images it would hide a future picomatch.
- **Fix:** remove it.
- **Done:** removed. Checked that `picomatch` is in none of the image dependency trees:
  - the backend and MCP lockfiles have none;
  - the frontend lockfile has 4.0.7, a fixed version, dev-only and in the build stage only.
  The file now keeps a header stating that an entry applies to all three scans, and what
  every entry must record.

### [x] UP-2 Frontend build stage uses `node:20` (EOL 2026-04-30)
- **Where:** `frontend/Dockerfile:2`.
- **Fix:**
  - Bump to `node:22`.
  - Add an `engines` floor to `frontend/package.json` and extend `test/runtime.test.js`.
  - Consider `npm ci --ignore-scripts`.
  - Consider pinning base images by digest.
- **Done:**
  - **Frontend build stage:** now `node:22-slim`. Nothing from the build stage ships, but it
    runs `npm ci` over the whole tree on the production host. `swagger-client`, which does
    ship, declares `engines >=22`: it was being built on an unsupported Node.
  - **The floor itself was stale, which is the bigger finding.**
    `test/runtime.test.js#MIN_SUPPORTED_MAJOR` read 20 ("the lowest Node still receiving
    security updates") five months after 20's EOL. The backend and MCP `engines` said
    `>=20`. All three packages, the frontend included, now declare `>=22`, and the constant
    is 22. Its comment and CLAUDE.md name the next date, 2027-04-30, because no test notices
    a date by itself.
  - **The frontend is now in the runtime gate's `IMAGES`:** Dockerfile base ≥ floor, floor
    supported, CI's major equal. Mutation-checked: `FROM node:20` and `"node": ">=20"`
    each fail.
  - **`npm ci --ignore-scripts` in the frontend image.** Seven packages (eight lockfile
    entries) had install scripts, and none is needed for a browser bundle:
    - `@scarf/scarf` is a telemetry beacon that phoned home from every image build.
    - `tree-sitter` and its grammars compiled a native Node binding through node-gyp. It
      only worked because the full `node:20` image carried a compiler. It never reached the
      page: the built bundle contains no tree-sitter at all and parses YAML with js-yaml.
    - The rest are a banner, esbuild's binary self-check, and macOS-only `fsevents`.

    Verified: a scriptless install, then the build, the component tests, and `/api-docs` in a
    real browser (35 operations parsed from the YAML spec). The image build itself is left to
    CI; there is no Docker daemon here.
  - **Digest pinning: not adopted, deliberately.** There is no Renovate or Dependabot here to
    move a digest. A pinned `nginx-unprivileged:alpine` would silently stop receiving the
    Alpine fixes that the `apk upgrade` layer and Trivy currently surface. Revisit it
    together with automated base-image bumps.

### [x] UP-3 `MCP_BIND=0.0.0.0` docs are wrong
- **Where:** `docker-compose.yaml:131-133` and `mcp/README.md:159` say it "just works", but
  `mcp/server.js:57` drops `0.0.0.0` from the derived Host allowlist.
- **Fix:** document that LAN use needs `MCP_ALLOWED_HOSTS`.
- **Done:** `docker-compose.yaml` and `mcp/README.md` now say that `0.0.0.0` alone refuses
  every LAN request, and show the `MCP_ALLOWED_HOSTS` form. The server also logs a startup
  warning when `MCP_BIND` is `0.0.0.0` and `MCP_ALLOWED_HOSTS` is empty. The allowlist itself
  is unchanged: deriving nothing from `0.0.0.0` is correct.

### [x] UP-4 Stale workflow comment about sqlite3
- **Where:** `docker-build-deploy.yml:227-230` says the backend "depends on sqlite3", but it
  is a devDependency.
- **Fix:** correct the comment.
- **Done:** the comment now says `sqlite3` is a devDependency. The backend Dockerfile's
  `--omit=dev` never sees it, and `--ignore-scripts` only spares CI a node-gyp build for tests
  that never load it.

### [x] UP-5 Backend `.dockerignore` misses `mcp/node_modules`
- **Fix:** add `mcp/node_modules` (and `**/node_modules`).
- **Done:** `**/node_modules` and `**/dist` replace the two per-directory lines, so no nested
  package can ship its host-built `node_modules` into the backend image.

### [x] UP-6 Two smoke stacks can't run concurrently
- **Where:** hard-coded `container_name`s in `docker-compose.test.yml`. The workflow comment
  at `:72-79` already notes that a main run's smoke test can be cancelled.
- **Fix:** drop the `container_name`s from the test stack, or add a concurrency group that
  never cancels a `push: main` run.
- **Done: both halves, because neither works alone.** A partitioned group lets two stacks
  start at once, and fixed names or ports then collide.
  - **Per-run project:** each run gets `gametracker-smoke-<main|pr>-<run_id>-<attempt>`,
    and the four `container_name`s are gone. Every log and exec step addresses the stack
    through the project.
  - **Split group:** the smoke-test concurrency group is split into main and PR partitions,
    and each partition has its own host ports (PR 3099/8099/3199, main 3098/8098/3198).
    A PR can no longer cancel a queued main run's smoke test, and with it that merge's
    deploy.
  - **Leftover cleanup:** a stack left behind in the same partition is removed before
    start. The group guarantees it belongs to no live run.
  - **Pinned in `test/runtime.test.js`:** mutation-checked, both a re-added `container_name`
    and the old single group fail.
  - **Residual:** within the main partition a newer merge can still replace a queued older
    one. That is harmless, since main is linear and the newer commit contains the older.
  - **Not verifiable here:** there is no Docker daemon, so the first real run is this
    push's CI.
  - **Review fixes:**
    - The pin also refuses `--project-name gametracker-smoke` and any
      `docker logs|exec|inspect|stop|rm|kill` against a fixed smoke name.
    - It pins the cleanup pattern's anchoring, since unanchored it would `down --volumes`
      the other partition's live stack.
    - It requires all six host ports to be distinct and clear of production's.
    - Mutation-checked: all four mutations fail.
    - `docker-compose.test.yml`'s isolation header is corrected.
    - Switchover note: a stack left over under the OLD fixed project `gametracker-smoke` is
      not matched by the cleanup. Teardown runs `if: always()`, so this matters at most once.

### [x] UP-7 No end-to-end coverage of `/api/v2` or the MCP→backend path
- **Problem:** the smoke test never calls v2, and the MCP handshake uses a fake PAT.
- **Fix:** in the smoke stage:
  1. Mint a PAT with `create-api-token.js`.
  2. Call one v2 read and one v2 write.
  3. Call one MCP tool that reaches the backend.
- **Done:** a new smoke step, "Verify /api/v2 and the MCP-to-backend path with a real
  token".
  - **The token:** it mints a real PAT inside the throwaway stack with
    `create-api-token.js`, scoped `library,admin`, expiring in a day, and destroyed at
    teardown. It `::add-mask::`s the token in the log.
  - **The checks:**
    1. v2 without a token must be `401 application/problem+json`, never the v1 envelope.
    2. A v2 READ, the library.
    3. A v2 WRITE that needs no external provider: `PUT /shares/outgoing`.
    4. An MCP `tools/call whoami`, which can only return the caller's user if the MCP
       server forwarded the token and v2 accepted it.
  - **Rehearsed locally:** the step's own script, extracted from the YAML, ran against a
    local backend, MCP server and Postgres. It passed, and two negative controls failed
    with clear messages: whoami returning another user, and a failed mint.
  - **A silent failure fixed along the way:** under `set -e` plus `pipefail`, a failed mint
    killed the step with no output. It is now caught and reported with the script's
    stderr.
  - **Review fixes:**
    - **Least privilege:** the token is `library` only. Every call is a library operation,
      and a library-only token working is itself worth proving.
    - **No fixed `/tmp` paths on the production host,** in this step or in the older smoke
      steps (`smoke-404.json`, `smoke-stats.json`, `smoke-hist.json`, `smoke-mcp.txt`).
      `curl -o` and `2>` follow a symlink. They now use a per-run `mktemp -d` under
      `RUNNER_TEMP` (`SMOKE_TMP`, mode 0700), which teardown removes.
    - **Failures say why:** a curl that cannot connect no longer ends the step silently.
    - **Pinned in `runtime.test.js`:**
      - the step exists;
      - the mask comes before the first use of the token;
      - the scope is exactly `library`;
      - the MCP call is a `tools/call` that reaches the backend;
      - no smoke step writes `/tmp/smoke-*`.

      Mutation-checked for the scope and the `/tmp` path.
    - **Rehearsed again locally:** it passes with the library-only token, and an
      unreachable MCP server now fails with a clear message.

### [x] UP-8 `saveSettings` is not atomic
- **Where:** `settings-store.js`.
- **Fix:** write to `settings.json.tmp`, `fsync`, then `rename`. Bind mounts of a single file
  need care: rename replaces the inode, so bind-mount the directory, or copy then truncate
  as a fallback. Check with Architect.
- **Done, as far as the current mount allows:**
  - **New helper:** `settings-store#replaceFileContents` writes a temp file beside the
    target, `fsync`s it and `rename`s it over, wherever that is possible: local dev, bare
    metal, or a directory mount.
  - **Why production can't use it:** today settings.json is a SINGLE-FILE bind mount inside a
    `read_only` container. Creating the temp fails with `EROFS`, and `rename()` onto a mount
    point fails with `EBUSY`.
  - **The fallback is an in-place rewrite:** it writes the new bytes, THEN truncates, THEN
    `fsync`s. The old code truncated first (flag `'w'`), so an interrupted save could leave an
    empty file. It no longer passes through empty, and success is no longer reported for bytes
    still in the page cache.
  - **Still not atomic in production.** A torn file is what `readSettings()` reports as
    `degraded`, and writers refuse to build on it.
  - **Other fixes:** a stale temp from a crash (the container pid is always 1) no longer
    wedges every later save. Real errors such as `ENOSPC` still throw and remove the temp.
  - **Tests:** six tests in `helpers.test.js` over an in-memory `fs` (that file allows no disk
    I/O). Mutation-checked: truncate-first fails, and so does dropping the stale-temp
    removal. Also run on a real disk: atomic, mode 0600, no temp left.
  - **Making production atomic is UP-24.**
  - **Review fixes (the Architect rejected the first cut):**
    - `writeSync`'s return value was ignored. Node does not retry a short write, and a
      filling disk reports a short count before it reports `ENOSPC`. So the atomic path could
      rename a torn temp over a good file and report success, which is worse than the
      `writeFileSync` it replaced, since that one loops. `writeAll` now loops until every
      byte is written, and throws if a write makes no progress.
    - Two new tests: a short write is completed, and a write with no progress throws with
      the old file intact. Mutation-checked: going back to the single unchecked write fails
      them.
    - The EROFS test now fails the `open`, so its "no temp left" assertion can actually fail.
    - `refresh_igdb_token.js` prints the path it wrote. Outside the container that is the
      checkout's own file, which no running server reads.
    - The UP-6 pin now matches each step's `run` text. Through `JSON.stringify`, a quoted
      fixed name slipped past it; three mutations are now caught.
    - Not done (Nit): an `fsync` of the directory after the rename. A crash can then lose that
      one save's durability, but never produce a torn file.

### [ ] UP-24 Bind-mount the settings DIRECTORY, not the file (operator migration; from UP-8)
- **Why:** it is the only way `saveSettings` can rename atomically in production. See UP-8.
- **Fix:**
  - mount a directory such as `/home/docker/gametracker/data/config/` at `/app/config`;
  - have `SETTINGS_FILE` follow it (env var, added to both compose files);
  - move settings.json on the host as a deploy step.
- **Risk to manage:** a deploy that runs before the file is moved sees an EMPTY directory,
  which reads as "nothing configured": LDAP login and every API key vanish until it is moved.
  The backend should refuse to start if the configured directory is empty while the old
  single-file path still exists. Needs the owner's go-ahead and a staging run.

### [x] UP-9 `refresh_igdb_token.js` can have no effect
- **Where:** `refresh_igdb_token.js:69`.
- **Problem:** it writes `.env`, but a `settings.json` bearer token takes precedence.
- **Fix:** write through `settings-store` (as the UI button does), or warn when a settings
  value overrides it.
- **Done:** the script now calls `services/settings#storeIgdbToken`, the button's own call,
  and reads the client ID and secret with the button's precedence (settings, then env;
  arguments still override). The backend picks the token up with no restart. The `.env`
  rewrite is gone: it did nothing inside the backend container, where scripts are meant to
  run, and it lost to any `settings.json` token.
  - A failed store is reported separately from a Twitch failure.
  - A corrupt settings.json is refused, not overwritten.
  - Verified end to end against a stubbed Twitch: the token is stored, other keys are kept,
    and a corrupt file exits 1 untouched.

### [x] UP-10 v1 Steam price route is a separate implementation
- **Where:** `index.js:812-842`.
- **Problem:** no timeout, no id validation, and it returns `error.message`.
- **Fix:** adapt it over `jobsService.fetchSteamPrice` without changing the v1 shape.
- **Done:** `GET /api/game-price/:steamAppId` is now an adapter over `fetchSteamPrice`, the
  same lookup the weekly sweep and v2 use. That brings the timeout, the refused redirects
  and the bounded third-party strings.
  - **Service:** it now also returns `currency` (three capital letters), `discount` (an
    integer from 0 to 100) and `originalPrice`, each `null` when off-type. v2 picks its own
    fields and never sees them.
  - **One id rule:** `isSteamAppId` (1-10 digits) is shared by v1 and v2. Before, v1 put the
    raw path value into the outbound request.
  - **Frozen shape kept:** 200 `{price, currency, discount, original_price}`, 404 for "not on
    Steam" and for "no price". A non-Steam id gets that same 404, which is what Steam itself
    answered for it before.
  - **500 is now the plain `{error}` envelope:** `details: error.message` is gone, and the
    upstream text is logged instead.
  - **Verified over real HTTP against the live Express app,** with Steam stubbed: priced,
    absent, free, down, `44a` and `..%2Fx`. Unit tests cover the new fields, typing and the
    id rule.

### [x] UP-11 Provider call volume
- **Problem:**
  - RAWG makes one detail request per result (`catalog.js:163`), up to 20 per search and
    about 10 per game on refresh.
  - `updatePrices` fetches the same `steam_app_id` once per owning user
    (`jobs.js:161,225`).
- **Fix:** skip RAWG details where the list payload is enough, cache them, and dedupe Steam
  lookups by app id within a sweep.
- **Done, all three:**
  - **Skip:** RAWG's list payload names each game's stores by id, without URLs. When those
    stores exclude Steam (id 1), the detail request cannot find a Steam App ID, so it is
    not made. When the list omits `stores`, it still asks.
  - **Cache:** detail ANSWERS, "Steam id X" or "not on Steam", are kept per RAWG id in a
    process-local map, bounded at 5,000 entries (oldest evicted first) with a 7-day TTL.
    Failures are never cached, so an outage is not remembered as "not on Steam". Search
    and the metadata refresh both go through `searchRawg`, so both benefit.
  - **Dedupe:** `updatePrices` makes one Steam request per app id per sweep, so a game five
    users own costs one request instead of five. The report still counts rows, and a
    failure is logged once per id. A stored value that is not a Steam id is no longer sent
    to Steam; it counts as an error.
  - **Tests:** the skip, the cache (including that a failure is NOT cached), the bound, the
    oldest-first eviction, the TTL, and the dedupe (seven rows, one request). The old code
    fails them.
  - **Not done:** telling an upstream 429 apart from an outage (see UP-14).
  - **Review nits:**
    - A stored non-id is now logged once per value.
    - The cache comment says plainly that it evicts by fetch time and is not an LRU.
    - Accepted: a "no Steam" answer is cached for 7 days, so a game newly listed on Steam
      can go unpriced for up to a week.

### [x] UP-12 Telegram legacy Markdown on unescaped game names
- **Where:** `services/notifications.js:256,272,278`.
- **Failure:** a name containing `_`, `*` or `[` gets a 400 from Telegram, so the channel
  silently never delivers for those games.
- **Fix:** switch to `HTML` parse mode with escaping, or escape for MarkdownV2.
- **Done:** HTML parse mode. The text comes from `telegramText()`, a pure exported function
  that uses the module's existing `escapeHtml`; Telegram accepts every entity it emits,
  including `&#39;`. Tests cover names that broke legacy Markdown, and markup-injection
  attempts arriving as literal text.

### [x] UP-13 `replaceOutgoing` builds an unbounded `IN (...)` list
- **Where:** `services/shares.js:38`.
- **Failure:** a huge array exceeds Postgres's 65,535-parameter limit and returns 500.
- **Fix:** cap the array length (validation 400), or use `= ANY($1::text[])`.
- **Done, both halves:**
  - **One array parameter:** the lookup is `username = ANY(?::text[])`. Real Postgres took
    a 70,000-name array with no parameter-limit error.
  - **The spec's cap is now enforced:** the v2 spec has declared `maxItems: 200` from the
    start, but nothing enforced it, and v1 reaches the same function with no bound.
    `MAX_SHARE_RECIPIENTS = 200` now applies to the raw length before any query, and
    `test/openapi.test.js` ties the constant to the spec.
  - **Tests:** the lookup now goes through `db.promises.all`, so a test can assert the SQL
    and the single parameter. The old code fails both new tests.
  - **Why v1's new 400 fits the freeze:** v1's `POST /api/user/:u/shares` now answers 400 for
    more than 200 recipients. It already answered 400 (a non-array) through the same
    `problem.send` and the frozen `{error}` envelope. No list a person builds comes near
    200. The only requests whose status changes are ones that were abuse, or that already
    failed with 500 past the parameter limit. That is the same test CLAUDE.md applies to
    the per-user limiters.
  - **Review fixes:**
    - v2's adapter check now reads `sharesService.MAX_SHARE_RECIPIENTS` instead of its own
      literal 200. It stays only to name v2's field in `details`.
    - `isSteamAppId` moved above `fetchSteamPrice`'s doc comment, which it had split.
    - v2's price-failure log goes through `safeForLog`, like v1's.

### [x] UP-14 `rate_limited` in job `REASONS` has no producer
- **Where:** `services/job-runner.js:47-55`.
- **Fix:** produce it or remove it. It is in the spec enum, so update
  `openapi/gametracker-v2.yaml` together with `test/openapi.test.js`.
- **Done: removed, not produced.** Nothing can emit it:
  - no job throws `RATE_LIMITED`; only the request limiters do;
  - a provider's 429 surfaces through `catalog.js` as `degraded`, so a whole-job failure and
    a per-item failure both report `provider_unavailable`.

  Producing it would mean the catalog classifying upstream 429s, which belongs with UP-11.
  The value is removed from `job-runner.js#REASONS` and from the spec's `FailureReason`
  together. The spec now says a rate-limited sweep reads as `provider_unavailable`. No
  client can depend on a value no server has sent. `openapi.test.js` and `helpers.test.js`
  still compare the two sets exactly. `Problem.code`'s own `rate_limited`, for 429
  responses, is unaffected.

### [x] UP-15 Leftovers
- `console.log('About to schedule cron job')` at `index.js:3354`.
- A stray "GET /api/v2/shares" comment above the stats route (`index.js:2237`).
- `ensureRootUser` logs `[FATAL]` but lets the server start (`index.js:176-178`, `196-198`).
  Decide whether that is fatal or a warning, and make the log level match.
- 3 backend lint warnings (for example the unused `shareCols` at `:121`).
- **Done:**
  - The cron log line is gone.
  - The stray comment is moved onto `GET /api/v2/shares`, the route it describes.
  - Backend lint is at 0 warnings: two stale disable directives and the unused `shareCols`.
  - **`ensureRootUser` stays non-fatal, and now logs `[ERROR]` with the recovery path.** It
    runs after `migrateOrExit()` has already proved the database reachable, so a failure is
    transient, and existing installs already have root. Exiting would crash-loop the
    service over the one account with two CLI recoveries. Logging `[FATAL]` while carrying
    on was the actual defect.

### [ ] UP-16 Shrink `index.js` (3,517 lines)
- **Move into services, one per PR, each an adapter-only change:**
  - login (`:1684-1939`, ~250 lines);
  - LDAP sync (`:2779-3014`, ~235 lines, which repeats bind and search instead of using
    `ldap-helpers`);
  - the CrackWatch cache and scraper (`:523-809`);
  - the sent-notification store;
  - the `/api/user/me*` routes;
  - the Steam price route.
- **Also closes, fully or partly:** CC-8, CC-9, CC-11, CC-12, CC-13, UP-10.
- **Note:** leave the order to the Architect review.

### [x] UP-17 Warn at deploy when `TRUST_PROXY > 1` but the backend is still published on `0.0.0.0`
- **Why:** from the CISO review of P0-3. `TRUST_PROXY=2` is only safe with
  `BACKEND_BIND=127.0.0.1`. Set on its own, a client connecting directly can spoof
  `X-Forwarded-For` past the login rate limiter.
- **Fix:** log a warning at boot or during deploy for that combination.
- **Done, at deploy:** the backend cannot check this at boot, because the bind is a
  host-side port mapping it never sees.
  - A deploy step before `up` emits a GitHub `::warning` for `TRUST_PROXY>=2` with a
    non-loopback bind: spoofable `X-Forwarded-For`.
  - It also warns on the mirror case, `BACKEND_BIND=127.0.0.1` with `TRUST_PROXY=1`. There
    every request arrives from nginx, so one user's failed logins would lock out everyone.
  - It warns rather than fails: a proxy on another machine legitimately needs `0.0.0.0`.
  - Exercised on seven input pairs; pinned in `test/runtime.test.js`, which also requires it
    to run before the stack starts.

### [x] UP-18 Guard "a 401 always means the session is over"
- **Why:** since P0-6 the SPA's interceptor logs the user out on any 401. An endpoint that
  answered 401 for another reason, such as a wrong sudo password, would sign people out.
  Sudo mode answers 403 today, and nothing pins that.
- **Fix:** an `api-contract` or smoke-test assertion that a wrong sudo password answers 403.
- **Done:** the sudo 403 was already pinned (`api-contract.test.js`, "a wrong password mints
  NOTHING and answers 403"). What was missing was the general rule, so `runtime.test.js` now
  pins WHERE a 401 may come from:
  - in `index.js`, only inside `authRequired`, `patRequired`, `selfOnly`,
    `ownershipRequired` and the login route;
  - no service may throw `UNAUTHENTICATED`, since `problem.js` would turn that into a 401
    on both surfaces.

  Mutation-checked: turning the sudo refusal into a 401 fails with the line and the route
  named.
- **Review fixes:**
  - **The latent case, fixed.** The final error handler answered `err.status || 500`, and
    axios sets `status` on every `AxiosError` to the UPSTREAM's status. So an uncaught IGDB
    call with an expired token answered the client 401, and the SPA signed the user out.
    `problem.js#statusForUnhandled` now lets only an `expose: true` 4xx other than 401
    through (body-parser's 400 and 413); everything else is 500.
    - Tested with a real `AxiosError`.
    - Checked over HTTP that malformed JSON still answers 400.
  - **The scan is harder to fool:**
    - Attribution resets at every column-0 closer, so code placed after an allowed
      function no longer inherits its name.
    - It matches ANY non-comment `401` literal (`sendStatus`, `statusCode =`,
      `writeHead`).
    - It refuses a status set from a variable, unless it is allowlisted with a reason.
    - It covers the top-level modules as well as `services/`.
    - Three mutations, all caught.
  - **Deploy warning:** a non-numeric `TRUST_PROXY` now explains what actually happens.
    `Number()` gives NaN, so no proxy hop is trusted and everyone shares one limiter key.

### [ ] UP-19 Library duplicate detection belongs in the service (Architect, FE-3 review)
- **Why:** cross-provider "same game" detection on add lives only in the SPA
  (`frontend/src/libraryMatch.js`). v1 POST, v2 `POST /library/games`, the MCP and Android
  dedupe by id alone, through the upsert — "adapters own no rules" says it belongs in
  `services/library.js`, returned from the add (a hint on v1, a 409 or hint on v2).
- **Keep:** the both-years-known rule. It is deliberately stricter than `catalog.js`'s two
  (see that file's header), because a false positive REFUSES a legitimate add.
- **Optional, same area:** a batch crack-status read, if the library page size grows.
- **Proposal, waiting on the owner (2026-09-26). Not started, because it is a v2 contract
  decision:**
  - **v1 is out.** A hint in `POST /api/user/:u/games` adds a response field, and
    `api-contract.test.js` pins that key set exactly.
  - **v2: a hint, not a 409.** `POST /library/games` answers as today, plus an optional
    `possibleDuplicates: [{ gameId, name, releaseDate, match: 'same' | 'possible' }]`. It
    is additive, so no v2 client breaks, and the MCP `add_game` tool can say it to the user.
  - **Why not a 409:** refusing would turn the SPA's UX rule into a hard API rule for
    agents, and a name-plus-year match is certain enough to WARN about but still not an
    id.
  - **One copy of the rule:** it is currently ESM in `frontend/src/libraryMatch.js`. It
    would move to `services/library.js` (CommonJS), with the SPA keeping its own copy
    pinned EQUAL by a test that runs both over the same table. Today there is no
    cross-boundary module, and a backend `import()` of a frontend source file would couple
    the images.
  - **Weigh also (review):** a hint arrives AFTER the possible duplicate has been written,
    so an agent must undo it. Two alternatives:
    - a pre-add check, such as `?dryRun`, or `onPossibleDuplicate=warn|reject` with `warn`
      as the default;
    - keeping the two copies equal through shared JSON test vectors rather than one test
      running both codebases.

### [x] UP-20 A DOM test harness for the SPA (Architect; pair with FE-10)
- **Why:** component fixes (FE-1, FE-2, FE-5, FE-6, FE-7, the session notice) can only be
  pinned by source text in `test/runtime.test.js`, a stopgap that an equivalent rewrite can
  fail and a differently-shaped regression can pass. **Do this before the next frontend batch**
  (Architect): it is now the cheapest way to retire those pins.
- **Fix:** Vitest, happy-dom or jsdom, and `@testing-library/react` as frontend
  devDependencies (never in the nginx image), a CI step in `frontend-quality`, then turn the
  shape pins into behaviour tests. Easiest once FE-10 splits `App.jsx` into pages.
- **Done (the harness, and the first two conversions):** Vitest + jsdom + Testing Library as
  frontend devDependencies, `cd frontend && npm test`, a CI step in `frontend-quality`.
  `GameDetailModal.test.jsx` covers FE-7 behaviourally (focus in, trap both ways, return to the
  opener, the list fallback when the opener is gone, Escape); `LoginPage.test.jsx` covers FE-4's
  messages, the busy button, the once-only "session ended" notice and the clock-skew refusal.
  Their shape pins were retired from `test/runtime.test.js`, which now checks the test files
  exist and CI runs them. Mutation-checked: removing the fallback or the notice-clearing effect
  fails exactly one test each.
- **No longer shape-pinned (FE-10):** FE-2 moved to behaviour tests in
  `pages/SearchPage.test.jsx`, and FE-1, FE-5 and FE-6 moved to `pages/LibraryPage.test.jsx`.
  One wiring pin each for FE-1 (no effect keyed on `currentGames`) and FE-7 (every page
  passes the dialog a focus fallback) stays in `test/runtime.test.js`, because no rendered
  output shows either.
- **Versions (Architect review):** Vitest **3.2.7** — the first cut used Vitest 2, which the full
  audit rates CRITICAL (GHSA-5xrq-8626-4rwp, the UI server; <3.2.6). Vitest 3 runs on this Vite 5.
- **Known (dev-only, never shipped):** the moderate `@vitest/mocker` advisory
  (GHSA-82fw-gwwq-j7x9, <4.1.11) remains until Vitest 4, which needs Vite 6+. The Vite 5.4 dev
  server itself is rated **HIGH** by the full audit (`vite <=6.4.2`), and that includes
  GHSA-4w7w-66w2-5vf9, a path traversal through the optimized-deps `.map` handler on every OS.
  Also open: esbuild GHSA-67mh-4wv8-2f99 and GHSA-fx2h-pf6j-xcff (`server.fs.deny` on Windows).
  They matter because `server.host` is `0.0.0.0`, so `npm run dev` is reachable from the LAN.
  `vitest run` opens no server, and none of this reaches the nginx image. **Cleared by UP-23**
  (Vite 6.4.3, Vitest 4.1.11).
- **Review fixes:** the login tests render under `<StrictMode>` (as `main.jsx` does — the property
  the retired pin guarded); the wiring pin "both call sites pass `fallbackFocusRef`" is restored
  until FE-10, since the component test uses its own harness.
- **Code-review fixes:**
  - **jsdom's origin is pinned to `http://gametracker.test/`.** The default,
    `http://localhost:3000`, is the backend's port on the self-hosted runner, and that runner IS
    production. App.jsx builds `API_BASE` from it, so an unstubbed test would have sent a real
    login to the live backend.
  - Fake tokens are base64URL, as real ones are.
  - The trap test asserts the dialog has more than one focusable element.
  - The CI pin finds the step inside `frontend-quality`, in either key order, and refuses
    `continue-on-error`, `if:` and `||`. It also pins `npm test` to `vitest run`.
  - A new check refuses an app module that imports a `*.test.*` file, since the auth scan
    excludes those files by name.
  - Mutation-checked: `|| true` on the step and three import shapes each fail.
  - Known, and not a defect: running with `--isolate=false` breaks the suite. The config uses
    the isolated default.

### [ ] UP-21 An unreachable directory answers "wrong password" at login (code review, FE-4)
- **Where:** the login route in `index.js`. When `verifyLdapCredentials` returns
  `unreachable`, it falls back to local auth; a directory account has no local hash, so the
  answer is 401 `Invalid credentials`, and the attempt counts toward the lockout.
- **Why it matters:** FE-4 cannot tell a directory outage from a typo, so an outage still
  tells every directory user their password is wrong, and burns their lockout budget.
- **Fix:** answer 503 when the directory is unreachable AND the row has no local hash, and
  do not count it. This is a new status on a frozen v1 route: it needs an Architect and
  CISO decision, recorded in `test/api-contract.test.js`, before code.

### [x] UP-22 One `perUserLimit()` factory and a `rate-limits.js` module (Architect, SEC-15)
- **Why:** `libraryWriteLimit`, `testNotificationLimit` and `crackCheckLimit` are the same
  eight lines with different keys and budgets — and only the first uses the v1/v2 renderer
  branch, so the other two would send the v1 envelope if ever mounted on a v2 route.
- **Fix:** `perUserLimit({ name, keys, max, windowMs, what })` returning a NAMED middleware (the
  name is load-bearing for `api-surface.test.js` and `api-contract.test.js`), always using the
  renderer branch; move it, the shared store, `lockoutMinutes`/`trackFailures`/`clearFailures`
  and the hourly sweep into `rate-limits.js`, required at the top of index.js so nothing relies
  on function hoisting. A behaviour-preserving refactor: its own commit, not inside a fix.
- **Done:** `rate-limits.js` now holds:
  - the one store;
  - `lockoutMinutes`/`trackFailures`/`clearFailures`;
  - the hourly sweep (`unref`'d, so importing it keeps no process alive);
  - `perUserLimit({ name, prefix, max, windowMs, what })`;
  - the three budgets, defined through `perUserLimit`.

  `index.js` requires it at the top and keeps only the login and sudo WRAPPERS, which own
  their key namespaces.
  - **Named middleware:** each limiter keeps its function NAME, so `api-surface.test.js`
    and `api-contract.test.js` still find all three in the live route stack, unchanged.
  - **Both surfaces:** every limiter now renders v1's `{error}` or v2's problem+json
    according to the mount. Before, only `libraryWriteLimit` did.
  - **Window guard:** a window longer than the sweep's horizon is refused when the limiter
    is defined, since the sweep would otherwise evict a live lockout.
  - **Tests:**
    - the names;
    - within budget / 429 + `Retry-After` on BOTH surfaces;
    - fail-open without `req.user`;
    - the window guard;
    - budget isolation from each other and from the login keys.

    Every existing contract and route-tier test passes unchanged.
  - **Review fixes:**
    - Express's router answers an invalid percent-encoding in a path parameter with a
      `URIError` whose status is 400 and which has no `expose`. The clamp had turned that
      into a 500; it now keeps the 400. Checked over HTTP with `/api/user/%E0/games`.
    - The library limiter's log line says `library writes throttled` again, through a
      `logWhat` option, in case an operator greps for it.

### [x] UP-23 Vite ≥ 6.4.3 (HIGH dev-server advisories; unblocks Vitest 4) (CISO, UP-20 review)
- **Why:** `npm audit` rates `vite <=6.4.2` HIGH. The issues are the dev server's path
  traversal (GHSA-4w7w-66w2-5vf9) and esbuild's GHSA-67mh-4wv8-2f99, and `vite.config.js`
  binds the dev server to `0.0.0.0`. They are dev-only: production is nginx serving the
  emitted assets. The upgrade also clears Vitest 4's prerequisite (`@vitest/mocker`
  GHSA-82fw-gwwq-j7x9).
- **Fix:** Vite 6.4.3+ with a matching `@vitejs/plugin-react`, then Vitest 4. Re-run the build,
  the component tests and the `/api-docs` browser check. Until then, prefer
  `npm run dev -- --host 127.0.0.1` on an untrusted network. **Do it before the next
  frontend-dependency change** (CISO).
- **Done:**
  - **Versions:** `vite` 6.4.3, `@vitejs/plugin-react` 4.7.0, `vitest` 4.1.11 (and
    `@vitest/mocker` 4.1.11), `esbuild` 0.25.12. Vite 6 is the smallest step that clears the
    HIGH. Vite 7/8 and plugin-react 5/6 are later, separate upgrades.
  - **Audit:** the full `npm audit`, devDependencies included, is down to the two moderate
    React Router advisories that FE-22 tracks.
  - **No production entry moved:** the lockfile diff was checked entry by entry, and every
    changed package is dev-only.
  - **Resolved with npm 11:** npm 10's arborist crashes on Vitest 4's peer set
    (`Cannot read properties of null (reading 'edgesOut')` in `#loadPeerSet`), both on a
    fresh install and with the stale entries removed. `npx npm@11 install` resolved it, and
    the result was then verified with npm 10's `npm ci` on a clean `node_modules`, which is
    what CI and the Dockerfile run. **If a later `npm install` on npm 10 fails the same way,
    use npm 11 for the resolve. Never delete the lockfile:** a full re-resolve would move
    production dependencies too.
  - **Verified:**
    - the 14 component tests
    - lint, 0 errors
    - `vite build`
    - `/api-docs` in a real browser against the built bundle: 35 operations, the title, an
      operation expands
    - the dev server routes `/api-docs` to the SPA and `/api/*` to the proxy
    - the frontend image build is left to CI, since this environment has no Docker daemon

---

### [x] UP-25 CI fills the runner's disk: BuildKit's build cache is never pruned (CI, PR #5)
- **Where:** `.github/workflows/docker-build-deploy.yml`, `build-images`. The runner is the
  production host.
- **Symptom (2026-09-26):** two consecutive runs failed as only a full disk explains:
  - the smoke stack's Postgres exited 1 on start (fb203d9);
  - `apt-get update` in the backend build rejected every Debian index with "At least one
    invalid signature was encountered" (f9ae700). apt verifies signatures through /tmp.

  Neither commit touched the images.
- **Cause (likely):** backend and frontend build with `--no-cache`, which still writes new
  build-cache entries, and the only prunes anywhere are `docker image prune -f`, which never
  touches the build cache.
- **Done so far:**
  - A step before the builds prints `df` and `docker system df`, then runs
    `docker builder prune -f --filter until=24h`. That removes build cache only: never an
    image, container, network or volume, so the running production stack and its database
    are untouched.
  - The smoke stack's start-failure handler now prints `ps -a`, every service's logs and
    `df`, instead of the backend's logs alone.
- **Measured (9219883, the first run of the step):** `/` at **100%**, 87G with 0 available.
  Build Cache was **19.44 GB**, 0 active and all reclaimable; Images 13.1 GB; Local Volumes
  2.2 GB, 1.9 GB of it unreferenced. The first prune freed 59 MB: `builder prune` without
  `-a` removes only DANGLING cache. It is now `docker builder prune -af`, which still
  touches build cache only.
- **This is a production incident, not only a CI one:** the runner is the production host,
  so production's Postgres was on a full disk. The operator should check the live app,
  then look at the rest of the disk. The four Docker stores total about 35 GB of the 83 GB
  used, and CI cannot see the other ~48 GB. Unreferenced volumes are left for the operator
  on purpose: CI must never prune volumes on the host that holds the production database.
- **Review (CISO):**
  - A prune failure is no longer hidden behind `|| true`; it prints as a warning.
  - The step fails by name when under 5 GiB remains after the prune, so a full disk reads
    as a full disk, not as an apt signature error three steps later.
  - Host disk alerting belongs to the operator.
- **Confirmed (27f4d2d, the run after the `-af` prune):**
  - `/` at **71%**: 59G used, 25G available, down from 100% with 0 available.
  - Build Cache is down to 404 MB, so the `-af` prune on 6189e50 reclaimed about 24 GB.
  - Every job passed, including the smoke stack that had failed on Postgres.
- **Still for the operator:**
  - check production's database and backend logs for write failures during the full-disk
    window;
  - account for the ~20 GB outside Docker;
  - remove the 1.9 GB of unreferenced volumes by hand;
  - add host disk alerting.

  CI now clears the build cache on every build and refuses to build below 5 GiB free, so it
  can no longer be the thing that fills the disk unnoticed. If the build cache is not what
  fills the disk, the operator needs to look at the host (volumes, logs, other projects),
  which CI cannot and should not do.

## Suggested order of work

1. **P0-1 to P0-4.** Small, contained, and security- or data-affecting. One PR each.
2. **P0-5 and SEC-6**, together, since both change how images are tagged and promoted.
3. **P0-6, FE-4 and SEC-7's short-term fix.** One frontend auth-state PR, with UI/UX review.
4. **CC-1, CC-2, CC-3 and CC-4.** Concurrency, with integration tests against Postgres.
5. **CC-5, CC-6 and SEC-1.** Notification and catalog correctness.
6. **The remaining SEC items**, then FE-1 to FE-3 and FE-5 to FE-7.
7. **UP items.** Opportunistic. UP-16 and FE-10 are ongoing refactors, done one piece per PR.

---

## Fix log

Reviews for P0-1 to P0-4: **Architect approved. CISO rejected P0-3** (the deploy job didn't
carry the variables), **then approved** after `6248d0f`. A `/code-review` of the branch then
found two problems in the P0-1 rule, fixed in `2ef5fd9`. The CISO approved that fix, on
condition that `JWT_SECRET` is rotated at deploy and SEC-13 is carried out.

Reviews for P0-5 and SEC-6: **Architect approved. CISO rejected** (the `:latest` check missed
`docker tag x:sha x:latest`), **then approved** after `cf46533`. Workflow-only change, so no UI/UX
review was needed. Exercised with a stubbed `docker`, but **not yet run on the real runner**.
The first push to `main` after merging is the real test.

Reviews for SEC-2 to SEC-5 (plus the CC-12 zero-row fix): **both rejected once**, on the
branch failing its own secret scan, and the CISO also on `GIT_CONFIG_*` being ignored for
`safe.directory` by git < 2.38. After `7a9be5a`, **both approve**.

**MERGE PRECONDITION (CISO): a green `secret-scan` job on the self-hosted runner.** That the
runner's git 2.34.1 honours `safe.directory` from `GIT_CONFIG_GLOBAL` comes from git's source
and docs; it was reproduced only on git 2.43 here. If that is wrong, the step fails red rather
than passing, so it would block deploys but hide nothing. A pull request from this branch runs
the whole pipeline except deploy and is the way to get that evidence.

Reviews for CC-10 to CC-16 (plus the `refreshOne` review fix): **CISO approved. Architect
approved.** The notes acted on:
- The LDAP profile sync write now requires `password IS NULL`.
- CrackRelease `fetched` now requires a status word on the page.
- The spec's `Username` schema is tied to `validateUsername` by a test.
- A test pins the callback guard's `this` binding.

Reviews for the CC-6 follow-up and CC-7 to CC-9: **CISO approved. Architect rejected CC-9**
(a numeric channel id was wiped with a 200). Fixed in `6919d03` plus the next commit: numbers
become text, other non-text is refused, and the field rename is safer.

Reviews for CC-5, CC-6 and SEC-1: **Architect approved. CISO approved on one condition**:
`proxy: false` on the guarded calls, which is done and tested. The other notes were acted on as
well: fe80::/10 plus the NAT64 and IPv4-compatible forms, the year check in `matchForRow`,
`resolveEmail` reading `email` and `origin` in one query, and a stale comment.

Reviews for CC-1 to CC-4: **CISO approved. Architect approved.** Both sets of non-blocking notes
were acted on: a stale comment, a real concurrent-delete test, the read-back inside the
transaction, the `LOCKS` comment, and a warning in the test header. Verified against a local
Postgres 16: status-events 15/15, stats 18/18, upsert-release-date 10/10, reminders 5/5. No frontend changes, so no UI/UX
review was needed. **Not yet validated on GameTracker-stg.**

| ID | PR | Date | Summary |
|---|---|---|---|
| P0-1 | `3c81bb6`, `2ef5fd9` | 2026-09-25 | LDAP login can no longer claim `root`/`me` or any row holding a password hash |
| P0-2 | `3c81bb6` | 2026-09-25 | `requiredGroup` is an exact full-DN or first-RDN cn match |
| P0-3 | `3c81bb6`, `6248d0f` | 2026-09-25 | Backend settings reach the container through both compose files and the deploy job |
| P0-4 | `3c81bb6`, `4160735` | 2026-09-25 | `jobs.js#steamRegion` is the one reader of `STEAM_REGION` |
| P0-5 | `8fd5a87`, `cf46533`, review fix | 2026-09-25 | Builds are `sha-<commit>`/`pr-<n>`, and only deploy promotes to `:latest` |
| CC-1, CC-2 | `c42f066` + review fix | 2026-09-25 | Status decided from the locked current row; events can no longer be invented or mis-attributed |
| CC-3, CC-4 | `7d61751` | 2026-09-25 | Reminder dedupe is a primary-key claim in Postgres (migration 006) |
| SEC-6 | `8fd5a87`, `cf46533` | 2026-09-25 | No `down` before `up`, and deploy rolls back to `:previous` on failure or cancel |
| SEC-12 | `5520939` + review fix | 2026-09-26 | `library` enforced on v1 and v2; `admin` no longer implies it; job poll is `as-started` |
| CI (PR #5) | review fix | 2026-09-26 | Semgrep pin installs with `pip --target` (the runner has no `python3-venv`); nodemailer 9.1 (GHSA-2x7j-588g-ccc2), fast-uri 3.1.8 (four SSRF CVEs), frontend `apk upgrade` + `--pull --no-cache` (libexpat CVE-2026-93990) |
| SEC-7, FE-12 | this batch | 2026-09-26 | Client checks `exp` (boot, login, timer) and decodes base64URL; cookie move split out as SEC-14 |
| SEC-8 | this batch | 2026-09-26 | Only http(s) reaches the CrackRelease `href`; server-built URL pinned |
| SEC-9 | this batch | 2026-09-26 | Root reset reads `NEW_ROOT_PASSWORD`; argv warns |
| SEC-10 | this batch | 2026-09-26 | Debug route kept (v1 freeze), logging removed, now a service adapter |
| SEC-11 | this batch | 2026-09-26 | `.env*` ignored in git and every image build context |
| P0-6, FE-8 | this batch | 2026-09-26 | A 403 no longer logs out; admin routes gated; one auth header, one session-ending path |
| FE-1..FE-5 | this batch | 2026-09-26 | Crack requests once per game; stale searches dropped; library match by id or name+year; login errors by cause; per-game rollback |
| FE-6, FE-7 | this batch | 2026-09-26 | Chips are buttons, cards focusable everywhere; the detail dialog traps and returns focus |
| FE-13, FE-15, FE-17 | this batch | 2026-09-26 | Admin-only token badge; dead 401 banner removed; one endSession() |
| SEC-15 | this batch | 2026-09-26 | Per-user limit on both crack-status routes |
| UP-20 | this batch | 2026-09-26 | Vitest + jsdom component tests in CI; FE-7 and the login page converted from shape pins |
| SEC-16 | this batch | 2026-09-26 | React Router 6.30.6; npm audit fix clears 4 HIGH/moderate advisories in the shipped SPA |
| UP-23 | this batch | 2026-09-26 | Vite 6.4.3 + Vitest 4.1.11: clears the HIGH dev-server and the mocker advisories; no production entry moved |
| UP-1–5 | this batch | 2026-09-26 | Node floor 20→22 everywhere (20 is EOL) and the frontend build stage in the runtime gate; scriptless frontend install; stale trivyignore, workflow comment, `.dockerignore`, `MCP_BIND` docs |
| UP-6 | this batch | 2026-09-26 | Smoke stack per run (project, no container_name) and smoke concurrency split main/PR with separate ports: a PR can no longer cancel a merge's deploy |
| UP-8, UP-9 | this batch | 2026-09-26 | settings.json saved atomically where the mount allows, else write-then-truncate-then-fsync; production atomicity split out as UP-24. The IGDB token script stores through the settings service like the UI button |
| UP-10, 12, 13, 15 | this batch | 2026-09-26 | v1 Steam price route adapted over the shared lookup (shape kept, no error.message); Telegram HTML mode; share list as one array param + the spec's 200 cap enforced; leftovers, backend lint at 0 |
| UP-14 | this batch | 2026-09-26 | Unproduced `rate_limited` removed from job REASONS and the spec's FailureReason together |
| UP-11 | this batch | 2026-09-26 | RAWG detail skipped when the list rules Steam out, answers cached (bounded, TTL); Steam price sweep deduped per app id |
| UP-17, UP-18 | this batch | 2026-09-26 | Deploy warns on either TRUST_PROXY/BACKEND_BIND mismatch; a 401 may only come from authentication (the SPA logs out on every 401) |
| UP-22 (+UP-18 review) | this batch | 2026-09-26 | rate-limits.js: one store, one sweep, a named perUserLimit() factory rendering both surfaces; the final error handler no longer passes an upstream 401 through |
| FE-11, FE-21 (+UP-22 review) | this batch | 2026-09-26 | CSP style-src drops 'unsafe-inline' (measured: zero violations; React styles are CSSOM); card animation no longer pins transform; router's URIError 400 kept |
| FE-14 | this batch | 2026-09-26 | The post-login return path is honoured only for the user whose session ended |
| FE-9, FE-16 | this batch | 2026-09-26 | SharedLibrary.jsx into src/; one API client (api.js, axios.create) owning both interceptors, pages no longer depend on App.jsx patching the global axios |
| FE-20 | this batch | 2026-09-26 | Every status colour (chips, hover glows, detail block) now from the --color-status-* tokens; no accent preset makes two statuses look alike |
| FE-19 | this batch | 2026-09-26 | One useDialogFocus() hook for all six dialogs: focus in/back, trap (now also from the container); alertdialog opens on Cancel |
| FE-18 (+FE-19 review) | this batch | 2026-09-26 | User Management successes → toast, dialog errors = page banner style, sticky banner opaque at 1rem; Add User shows the server's reason; dialog trap on the role element, delete returns focus to the heading |
| UP-7 | this batch | 2026-09-26 | Smoke stage mints a real PAT and drives v2 (401, read, write) and MCP whoami through to the backend |
| FE-22 | this batch | 2026-09-26 | React Router 7.18.4: npm audit (dev + prod) at 0; router transitions turned off (`routerConfig.js`) after review caught them breaking the post-login return path |
| SEC-17 | this batch | 2026-09-26 | Gitleaks/Trivy installs: private mktemp dir + pinned SHA-256 checked before `sudo install` |
