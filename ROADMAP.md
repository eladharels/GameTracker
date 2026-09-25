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
| P0 — Fix first | 6 | 5 |
| CC — Correctness & concurrency | 16 | 16 |
| SEC — Security (medium/low) | 13 | 4 |
| FE — Frontend | 12 | 0 |
| UP — Tidying & upkeep | 17 | 0 |
| **Total** | **64** | **25** |

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

### [ ] P0-6 ✔ Frontend: a 403 deletes the token but the app stays "logged in"
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

### [ ] SEC-4 GitHub Actions pinned by tag, not by commit SHA
- **Where:** `actions/checkout@v4`, `actions/setup-node@v4`, `docker/setup-buildx-action@v3`.
  The Semgrep rule that flags this is excluded at `:187`.
- **Why it matters:** the runner is the production host.
- **Fix:** pin to full SHAs with a version comment, remove the exclusion, and let Dependabot
  or Renovate bump them.

### [ ] SEC-5 Gitleaks allowlists whole documentation files
- **Where:** `.gitleaks.toml:75-85` (`CLAUDE.md`, `README.md`,
  `SECURITY_HARDENING_2026-07.md`, `.gitleaks.toml`).
- **Fix:** replace the path allowlists with regex or stopword allowlists for the specific
  example strings.

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

### [ ] SEC-7 Session JWT in localStorage, and `exp` is never checked on the client
- **Where:** `frontend/src/App.jsx:38,295,94-99`, `ApiTokensSection.jsx:52`.
- **Mitigation already in place:** `script-src 'self'` (`nginx.conf:30`).
- **Fix (short term):** check `exp` in `useAuth` and log out when it has expired.
- **Fix (long term):** move to an `HttpOnly; Secure; SameSite=Strict` cookie with CSRF
  protection. Needs Architect and CISO review, because the Android client uses Bearer.

### [ ] SEC-8 `crackInfo.url` goes straight into `href`
- **Where:** `frontend/src/App.jsx:2932`.
- **Fix:** allow only `http:` and `https:` before rendering the link, and apply the same
  check on the backend where the URL is scraped.

### [ ] SEC-9 `reset-root-password.js` takes the password from argv
- **Where:** `reset-root-password.js:21`.
- **Problem:** argv is visible in `/proc` and in shell history.
- **Fix:** read it from an environment variable or stdin, as `create-local-admin.js` does.

### [ ] SEC-10 `/api/debug/...` route still shipped
- **Where:** `index.js:1054`.
- **Fix:** remove it, or gate it on `NODE_ENV !== 'production'`, and update
  `test/api-surface.test.js`.

### [ ] SEC-11 `.env` variants not ignored
- **Where:** `.gitignore` and `.dockerignore` only cover `.env`, `.env.local` and
  `.env.*.local`.
- **Failure:** a `.env.production` is committed and copied into the image.
- **Fix:** ignore `.env*`, with an exception for `!.env.example` if one is added.

### [ ] SEC-12 `library` scope never actually required
- **Where:** `services/auth.js:299-305` (`authorize` checks only `admin`).
- **Failure:** an `["admin"]`-only token can use every library route, although the spec says
  `x-required-scope: library`.
- **Fix:** enforce `library` on library routes, or change the spec and docs to say admin
  implies library. Decide first; either way `test/openapi.test.js` should pin the result.

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

### [ ] FE-1 Crack-status requests fire again on every render
- **Where:** `frontend/src/App.jsx:1096` (`currentGames` is a new `.slice()` on every render),
  used as an effect dependency at `:1110` and `:1131`.
- **Problem:** in-flight requests aren't tracked, so each response re-renders and re-POSTs
  every pending game.
- **Fix:** memoise `currentGames`, track in-flight ids in a ref, and send one batched request.

### [ ] FE-2 Search results can come from an older query
- **Where:** `App.jsx:722-750` (`handleSearch`).
- **Failure:** a slow response to an earlier search replaces the results for the current
  query, and its price lookups land in the shared `gamePrices` map.
- **Fix:** use an `AbortController` or a request-sequence id, and ignore stale responses.

### [ ] FE-3 The "already in your library" check compares names, not ids
- **Where:** `App.jsx:766-772`.
- **Failure:** RE4 (2023) is blocked because RE4 (2005) is in the library. The check also
  downloads the whole library on every add.
- **Fix:** compare `game_id`, using the library already held in state or the server's
  answer to the add.

### [ ] FE-4 Login shows "Invalid username or password" for every error
- **Where:** `App.jsx:285-300`.
- **Failure:** a 429 lockout or a 503 LDAP outage tells the user their password is wrong, so
  they retry and extend the lockout.
- **Fix:** give distinct messages for 401, 429 (with the retry time) and 503/network errors.

### [ ] FE-5 A failed status change can undo other changes
- **Where:** `App.jsx:1147`, `:1164`.
- **Failure:** if game A's change fails after game B's succeeded, B is reverted in the UI too.
- **Fix:** roll back only the game that failed, from its own previous value.

### [ ] FE-6 Keyboard access: library cards and stats chips
- **Where:**
  - Cards only get `tabIndex` in backlog view (`App.jsx:1523`), and open only on click (`:1524`).
  - The stats chips are `<div onClick>` with no role (`:1353-1368`).
- **Fix:** use a `<button>` (or `role="button"` + `tabIndex=0` + Enter/Space handling).

### [ ] FE-7 GameDetailModal: no initial focus, no focus trap, no focus return
- **Where:** `frontend/src/GameDetailModal.jsx:84-103`.
- **Fix:** reuse the `handleModalFocusTrap` pattern (`App.jsx:343`). Focus the dialog when it
  opens and restore focus to the opener when it closes.

### [ ] FE-8 Duplicated Bearer headers and 403-logout logic
- **Where:** `App.jsx:366`, `:2001`, `:2188`, `:2434`, and `SharedLibrary.jsx`.
- **Problem:** these build their own headers even though the interceptor already adds them.
  This duplication is how P0-6 happened.
- **Fix:** rely on the interceptor and on one error handler.

### [ ] FE-9 `SharedLibrary.jsx` lives outside `src/`
- **Fix:** move it to `frontend/src/` and fix its imports (it currently imports
  `./src/contexts/...`).

### [ ] FE-10 `App.jsx` is ~3000 lines with at least eight page components
- **Fix:** split it into `src/pages/*` one page per PR, starting with the pages touched by
  FE-1 to FE-5. No behaviour change in the same PR.

### [ ] FE-11 CSP allows `style-src 'unsafe-inline'`
- **Where:** `frontend/nginx.conf:30`.
- **Status:** an accepted trade-off for inline styles and Swagger UI. Record the decision.
  Revisit if inline `style=` usage is removed.

### [ ] FE-12 Expired token renders the app until the first 401
- **Where:** `useAuth` (`App.jsx:94-99`).
- **Fix:** covered by SEC-7's short-term fix. Tick both together.

---

## UP — Tidying & upkeep

### [ ] UP-1 Stale `.trivyignore` entry
- **Problem:** `CVE-2026-33671` (picomatch via sqlite3) is in none of the three lockfiles,
  and because the suppression applies to all three images it would hide a future picomatch.
- **Fix:** remove it.

### [ ] UP-2 Frontend build stage uses `node:20` (EOL 2026-04-30)
- **Where:** `frontend/Dockerfile:2`.
- **Fix:**
  - Bump to `node:22`.
  - Add an `engines` floor to `frontend/package.json` and extend `test/runtime.test.js`.
  - Consider `npm ci --ignore-scripts`.
  - Consider pinning base images by digest.

### [ ] UP-3 `MCP_BIND=0.0.0.0` docs are wrong
- **Where:** `docker-compose.yaml:131-133` and `mcp/README.md:159` say it "just works", but
  `mcp/server.js:57` drops `0.0.0.0` from the derived Host allowlist.
- **Fix:** document that LAN use needs `MCP_ALLOWED_HOSTS`.

### [ ] UP-4 Stale workflow comment about sqlite3
- **Where:** `docker-build-deploy.yml:227-230` says the backend "depends on sqlite3", but it
  is a devDependency.
- **Fix:** correct the comment.

### [ ] UP-5 Backend `.dockerignore` misses `mcp/node_modules`
- **Fix:** add `mcp/node_modules` (and `**/node_modules`).

### [ ] UP-6 Two smoke stacks can't run concurrently
- **Where:** hard-coded `container_name`s in `docker-compose.test.yml`. The workflow comment
  at `:72-79` already notes that a main run's smoke test can be cancelled.
- **Fix:** drop the `container_name`s from the test stack, or add a concurrency group that
  never cancels a `push: main` run.

### [ ] UP-7 No end-to-end coverage of `/api/v2` or the MCP→backend path
- **Problem:** the smoke test never calls v2, and the MCP handshake uses a fake PAT.
- **Fix:** in the smoke stage:
  1. Mint a PAT with `create-api-token.js`.
  2. Call one v2 read and one v2 write.
  3. Call one MCP tool that reaches the backend.

### [ ] UP-8 `saveSettings` is not atomic
- **Where:** `settings-store.js`.
- **Fix:** write to `settings.json.tmp`, `fsync`, then `rename`. Bind mounts of a single file
  need care: rename replaces the inode, so bind-mount the directory, or copy then truncate
  as a fallback. Check with Architect.

### [ ] UP-9 `refresh_igdb_token.js` can have no effect
- **Where:** `refresh_igdb_token.js:69`.
- **Problem:** it writes `.env`, but a `settings.json` bearer token takes precedence.
- **Fix:** write through `settings-store` (as the UI button does), or warn when a settings
  value overrides it.

### [ ] UP-10 v1 Steam price route is a separate implementation
- **Where:** `index.js:812-842`.
- **Problem:** no timeout, no id validation, and it returns `error.message`.
- **Fix:** adapt it over `jobsService.fetchSteamPrice` without changing the v1 shape.

### [ ] UP-11 Provider call volume
- **Problem:**
  - RAWG makes one detail request per result (`catalog.js:163`), up to 20 per search and
    about 10 per game on refresh.
  - `updatePrices` fetches the same `steam_app_id` once per owning user
    (`jobs.js:161,225`).
- **Fix:** skip RAWG details where the list payload is enough, cache them, and dedupe Steam
  lookups by app id within a sweep.

### [ ] UP-12 Telegram legacy Markdown on unescaped game names
- **Where:** `services/notifications.js:256,272,278`.
- **Failure:** a name containing `_`, `*` or `[` gets a 400 from Telegram, so the channel
  silently never delivers for those games.
- **Fix:** switch to `HTML` parse mode with escaping, or escape for MarkdownV2.

### [ ] UP-13 `replaceOutgoing` builds an unbounded `IN (...)` list
- **Where:** `services/shares.js:38`.
- **Failure:** a huge array exceeds Postgres's 65,535-parameter limit and returns 500.
- **Fix:** cap the array length (validation 400), or use `= ANY($1::text[])`.

### [ ] UP-14 `rate_limited` in job `REASONS` has no producer
- **Where:** `services/job-runner.js:47-55`.
- **Fix:** produce it or remove it. It is in the spec enum, so update
  `openapi/gametracker-v2.yaml` together with `test/openapi.test.js`.

### [ ] UP-15 Leftovers
- `console.log('About to schedule cron job')` at `index.js:3354`.
- A stray "GET /api/v2/shares" comment above the stats route (`index.js:2237`).
- `ensureRootUser` logs `[FATAL]` but lets the server start (`index.js:176-178`, `196-198`).
  Decide whether that is fatal or a warning, and make the log level match.
- 3 backend lint warnings (for example the unused `shareCols` at `:121`).

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

### [ ] UP-17 Warn at deploy when `TRUST_PROXY > 1` but the backend is still published on `0.0.0.0`
- **Why:** from the CISO review of P0-3. `TRUST_PROXY=2` is only safe with
  `BACKEND_BIND=127.0.0.1`. Set on its own, a client connecting directly can spoof
  `X-Forwarded-For` past the login rate limiter.
- **Fix:** log a warning at boot or during deploy for that combination.

---

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
