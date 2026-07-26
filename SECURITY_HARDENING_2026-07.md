# Security Hardening — July 2026

**Scope:** Backend (`index.js`), frontend (`App.jsx`, `SharedLibrary.jsx`), Docker/compose, CI.
**Changelog entries:** Staging `#62`–`#66` (see `STAGING_CHANGELOG.txt`) → Production (see `../GameTracker/PRODUCTION_CHANGELOG.txt`).
**Reviews:** CISO, Architect, UI/UX — all approved (CISO condition C1 resolved by #66).
**Status:** Live in staging (green CI + deploy). Migrated to production.

> This document is the human-readable companion to the changelogs. The changelogs are the
> authoritative, step-by-step migration record; this file explains *what was wrong, what changed,
> and how to operate it*.

---

## TL;DR

The backend trusted the `:username` in the URL and left almost every route unauthenticated, the
JWT signing key defaulted to a hardcoded value, and `/api/settings` leaked every secret to anyone.
This pass:

- Removed the forgeable-JWT default (fail-fast on a missing/weak secret).
- Put **authentication + ownership** on every user-data route.
- Locked down settings so secrets never leave the server to non-admins.
- Moved notification-server config to **per-user** (each user picks their own ntfy/Gotify server).
- Hardened CORS, the login rate limiter, the root password, logging, and IGDB query building.
- Made the frontend attach the JWT automatically (one interceptor) so nothing broke.
- Cleared a wave of dependency CVEs and removed build-time npm/corepack from the runtime image.
- Added `.dockerignore` so secrets can't be baked into a local image build.

---

## 1. Threat summary — what was wrong (pre-hardening)

| # | Issue | Severity | Impact |
|---|---|---|---|
| 1 | `JWT_SECRET` defaulted to `'supersecretkey'` in `index.js` **and** `docker-compose.yaml` | Critical | Anyone could forge an admin JWT |
| 2 | `GET/POST /api/settings` unauthenticated | Critical | Read/overwrite SMTP pass, LDAP bind creds, Telegram bot token; GET even leaked the IGDB client secret |
| 3 | All `/api/user/:username/*` library routes unauthenticated, no ownership check | Critical | Read/modify **any** user's library via the URL |
| 4 | `/api/games/search`, `/api/game-price`, `/api/test/igdb`, `/api/crack-status/*`, a debug route — public | High | Abuse of paid external APIs; data exposure |
| 5 | `/api/admin/check-releases` checked `manage_users` (wrong field; real field is `can_manage_users`) | Low | Dead endpoint (always 403) — privilege confusion |
| 6 | Login rate limiter trusted `req.ip` with no `trust proxy` | Medium | Behind nginx all clients shared one IP → lockout-all or bypass |
| 7 | CORS fully open (`app.use(cors())`) | Low | Defense-in-depth gap (mitigated by bearer-token auth) |
| 8 | Root user seeded with well-known default password `Qq123456` | Medium | Trivial default-credential compromise on fresh installs |
| 9 | IGDB search query interpolated unescaped into the APIcalypse literal | Medium | Query injection into the IGDB call (self-scoped) |
| 10 | Verbose logging of raw LDAP entries / credential lengths | Low | Sensitive data in shared logs |

---

## 2. Fixes by area

### 2.1 Authentication & token integrity
- `JWT_SECRET` has **no fallback**. The backend `process.exit(1)`s at boot if it is missing,
  `< 16` chars, or equals `'supersecretkey'`. `docker-compose.yaml` uses
  `${JWT_SECRET:?...}` (fail-fast, no default) so the deploy also refuses to start without it.
- **Operational consequence:** the secret is now supplied only via environment (GitHub Actions
  secret → compose env). Rotating it invalidates all existing sessions (web + mobile re-login).

### 2.2 Authorization — ownership on every user route
- New `ownershipRequired` middleware (hoisted function declaration): allows the request only when
  `req.user.username === req.params.username` (case-insensitive) **or** `req.user.can_manage_users`.
- Applied (`authRequired, ownershipRequired`) to: add/list/delete game, `backlog-order`,
  `backlog-reorder`, both `refresh-metadata`, `crackrelease-status`, `crack-status`, and the debug route.
- The library-**share** routes keep their own inline `req.user.username !== ...` check (unchanged, intentional).

### 2.3 Settings & secret exposure
- `GET /api/settings`: requires auth; **never** returns the `apikeys` block (served masked only by the
  admin-only `GET /api/settings/apikeys`); returns `{}` to non-admins.
- `POST /api/settings`: requires auth; **all** server sections are admin-only to write —
  `ADMIN_ONLY_SETTINGS = ['smtp','ldap','telegram','ntfy','gotify']`; a non-admin write returns 403.
- `/api/admin/check-releases` gate fixed to `requirePermission('can_manage_users')`.

### 2.4 Per-user notification servers (feature change)
Notification *servers* are now a per-user choice instead of a shared server setting.
- **Schema:** `users.ntfy_url` and `users.gotify_url` (idempotent `ALTER TABLE … ADD COLUMN`, run on boot).
- **Send path:** `sendNtfy(...serverUrl)` / `sendGotify(...serverUrl)` prefer the user's own URL and
  fall back to the optional global default; wired at all three send sites (`notifyEvent`,
  `test-notification`, `sendReleaseReminder`).
- **API:** `GET /api/user/me` returns the new fields; `PUT /api/user/me/settings` accepts them
  (validated as `http(s)://…` or empty).
- **UI:** *My Account* gains "NTFY Server URL" and "Gotify Server URL" inputs. The ntfy/Gotify/Telegram
  tabs in *Settings* became **admin-only** (server infrastructure); non-admins land on the Diagnostics tab.
- **No private-IP block on the per-user URL — by design.** Users self-host ntfy/Gotify on their LAN
  (e.g. `http://10.0.0.30:…`), so RFC1918 is allowed. The SSRF is blind (response never returned).
  If ever cloud-hosted where the backend can reach a metadata endpoint, add an RFC1918/loopback/
  link-local deny-list in `PUT /api/user/me/settings`.

### 2.5 Network / infrastructure hardening
- **CORS:** deny-by-default allowlist via `CORS_ORIGINS` (comma-separated). Same-origin browser calls
  and non-browser clients are unaffected; route-level auth is the real protection.
- **Rate limiter:** `app.set('trust proxy', 1)` (configurable via `TRUST_PROXY`) so `req.ip` is the real
  client behind nginx. Never set to `true` (would allow `X-Forwarded-For` spoofing).
- **Root password:** seeded from `ROOT_PASSWORD`, else a `crypto.randomBytes` value printed once at first
  boot. `Qq123456` is gone. (Existing DBs keep their current root password — this only affects fresh DBs.)
- **IGDB query escaping:** `String(q).replace(/["\\]/g, '\\$&')` at all four `search "…"` sites
  (search, test-igdb, and both refresh-metadata handlers).
- **Logging:** removed raw LDAP entry dump and IGDB key-length details.

### 2.6 Frontend auth
- One global **axios request interceptor** attaches `Authorization: Bearer <token>` to **same-origin**
  `/api` requests only (never leaks the token to IGDB/Steam/etc.). This let the backend enforce auth
  without editing ~25 call sites.
- A **response interceptor** logs the user out (clears token → `/login`) on a `401`.
- `SharedLibrary.jsx` `API_BASE` changed to `${window.location.origin}/api` (was a hardcoded host/port
  that pointed at the production backend and bypassed the interceptor).

### 2.7 Dependency & image CVEs (the CI saga)
- **App deps:** overrides `brace-expansion >= 5.0.7` (CVE-2026-13149) and `tar >= 7.5.21`
  (CVE-2026-59873 CRITICAL, CVE-2026-59874 HIGH); lockfile bumped to match.
- **Root cause of the repeated Trivy failures:** the flagged versions (`tar 7.5.11`,
  `brace-expansion 2.0.2`, `sigstore 3.1.0`) were **bundled inside the global `npm@10`**, not the app —
  app-level `overrides` cannot touch them. `npm` is build-time-only, so the Dockerfile now removes
  `npm`, `corepack`, and the npm cache after `npm install --production`. This eliminates that entire
  class of finding (present and future) and shrinks the image.
- **Trivy gate:** `--severity CRITICAL,HIGH --ignore-unfixed`. LOW/MODERATE advisories (qs, body-parser,
  ip-address, @tootallnate/once) are below the gate and left for a routine dependency refresh.

### 2.8 Secrets-in-image (`.dockerignore`)
- Added `.dockerignore` (staging #66) excluding `.env*`, the SQLite DB, `settings.json`, notification
  state, `node_modules`, and VCS/CI/editor cruft. The Dockerfile's `COPY . .` would otherwise bake a
  local `.env` (real IGDB/RAWG keys) into an image. **CI-deployed images were never affected** (CI builds
  from a git checkout where `.env` is gitignored); this protects local builds and is defense-in-depth.

---

## 3. Endpoint authentication matrix (after)

| Route | Auth |
|---|---|
| `GET /api/health` | none (health/deploy check) |
| `POST /api/auth/login` | none (public, rate-limited) |
| `GET /api/games/search` | **auth** |
| `GET /api/game-price/:steamAppId` | **auth** |
| `GET /api/crack-status/cache-info` | **auth** |
| `GET /api/test/igdb` | **admin** |
| `POST /api/user/:username/games` | **auth + owner** |
| `GET /api/user/:username/games` | **auth + owner** |
| `DELETE /api/user/:username/games/:gameId` | **auth + owner** |
| `PUT /api/user/:username/games/:gameId/backlog-order` | **auth + owner** |
| `PUT /api/user/:username/backlog-reorder` | **auth + owner** |
| `POST /api/user/:username/refresh-metadata` | **auth + owner** |
| `POST /api/user/:username/games/:gameId/refresh-metadata` | **auth + owner** |
| `POST /api/user/:username/games/:gameId/crackrelease-status` | **auth + owner** |
| `GET /api/user/:username/crack-status` | **auth + owner** |
| `GET /api/debug/user/:username/game/:gameId` | **auth + owner** |
| `GET /api/settings` | **auth** (secrets stripped; `{}` for non-admins) |
| `POST /api/settings` | **auth**; server sections admin-only |
| `GET/POST /api/settings/apikeys`, `.../refresh-igdb-token` | **admin** |
| `GET /api/user/me`, `PUT /api/user/me/settings`, `.../sharing` | **auth** |
| `POST /api/admin/check-releases`, `/ldap-sync`, `/refresh-crackwatch-cache`, `/crackrelease-status` | **admin** |
| `POST /api/admin/test-notification` | **auth** (sends only to caller's own channels) |
| share routes (`/api/user/:username/share`, `/shared/:fromUser`, …) | **auth** + inline self-check |

---

## 4. Operational runbook

### Required environment / secrets
| Name | Where | Notes |
|---|---|---|
| `JWT_SECRET` | GitHub Actions secret → compose env | **Required.** ≥16 chars, not `supersecretkey`. Deploy fail-fasts without it. Rotating logs everyone out. |
| `IGDB_CLIENT_ID`, `IGDB_BEARER_TOKEN`, `RAWG_API_KEY` | GitHub secrets → compose env | Existing. |
| `ROOT_PASSWORD` | optional env | Fresh-DB root password; random-printed-once if unset. |
| `CORS_ORIGINS` | optional env | Comma-separated cross-origin allowlist. Usually empty (same-origin app). |
| `TRUST_PROXY` | optional env | Reverse-proxy hop count (default `1`). |

### Deploy
1. Ensure the `JWT_SECRET` **GitHub Actions secret** exists in the repo (Settings → Secrets and
   variables → Actions). Without it the deploy fails at the compose interpolation step by design.
2. Push to `main` → the pipeline (secret-scan, semgrep, trivy ×2, smoke test) gates the deploy.
3. Post-deploy health: `GET /api/health` → `{"status":"ok"}` (the deploy job waits on this).

### Recovering an unreadable `settings.json`
The Settings page shows **"settings.json could not be read"** and every section is empty, and
every save returns **409**. That is deliberate, and it is not the same as "unconfigured".

`settings.json` is written with `flag: 'w'`, which truncates in place — a container kill or a
full disk mid-write leaves a truncated, unparseable file. Before this refusal existed, the next
`POST /api/settings` (from *any* authenticated user, admin or not) rebuilt the file from the
empty defaults and **permanently erased** the SMTP password, the LDAP bind password, the Telegram
bot token and all five API keys. The server now refuses to write over a file it could not read.

Recover on the host — the UI cannot do this, by design:
```bash
docker compose -f docker-compose.yaml exec backend cat /app/settings.json   # see the damage
# restore from your backup, or rebuild it from settings.example.json and re-enter the secrets
docker compose -f docker-compose.yaml restart backend                       # not required: the
#   mtime check picks the repaired file up on the next request, restart only if you prefer
```
The parse error is in the backend log as `[settings] Failed to read/parse settings.json:`.
No restart is needed after a repair, and no credential is lost that was on disk before the crash.

### Key rotation (decision)
- `JWT_SECRET`: rotate any time; all sessions invalidate (web + mobile re-login).
- `IGDB_*` / `RAWG_API_KEY`: rotate **only if** a backend image built with a local `docker build .`
  (pre-`.dockerignore`) was ever distributed. CI-built images never contained `.env`.

---

## 5. Database schema changes
Two idempotent, auto-applied columns (no manual migration, no data backfill):
```sql
ALTER TABLE users ADD COLUMN ntfy_url   TEXT;
ALTER TABLE users ADD COLUMN gotify_url TEXT;
```

---

## 6. Staging → Production migration notes
Production (`../GameTracker/`) received the same logical changes, preserving intentional divergences:
- **No `- STAGING -` badge** in `App.jsx` (staging-only).
- Ports **3000 / 8080**, image tag **`:latest`**, `NODE_ENV=production`, volume path **`/data/`**
  (not `/data-stag/`).
- `index.js`, `SharedLibrary.jsx`, `package.json`, `package-lock.json` were copied verbatim (their entire
  prior delta was this change); `App.jsx`, `Dockerfile`, `docker-compose.yaml` were hand-applied to keep
  the divergences above. Production's deploy workflow already passes `JWT_SECRET` from secrets.

---

## 7. Post-deploy verification checklist
- [ ] Backend boots (no `[FATAL] JWT_SECRET …`); `GET /api/health` ok
- [ ] Fresh login works (all prior sessions invalidated by the secret rotation)
- [ ] Library: load / add / status change / backlog drag / refresh metadata
- [ ] Search, price lookup, System Status (admin)
- [ ] My Account: per-user ntfy/Gotify **Server URL** saves; a test notification delivers
- [ ] Non-admin sees only the Diagnostics tab in Settings
- [ ] Mobile app (production only): re-login, then search/list/add/delete/backlog/refresh

---

## 8. Known residual items / follow-ups (non-blocking)
- Login rate limiting is in-memory (per-process, resets on restart) — fine for a single container.
  **Update (§9):** now keyed per-account as well as per-IP, and swept hourly.
- No CSP/HSTS from the Node app — nginx owns those headers (see staging #58). HSTS is still not set
  anywhere in this repo's nginx.conf; it belongs on the TLS-terminating edge proxy.
- ~~LOW/MODERATE dependency advisories (qs, body-parser, ip-address, @tootallnate/once)~~ — cleared in
  §9 except the `node-gyp` chain under `sqlite3` (5 LOW, build-time only).
- Mobile app: uses plain `SharedPreferences` for the token and has always-on OkHttp `BODY` logging that
  prints the login body + bearer token — tracked in `../GameTracker-mobile/SECURITY_FIXES.md`.
- ~~`CLAUDE.md` describes notification config as server-level and "5 accent presets"~~ — already
  corrected; that item was itself stale when written.

---

## 9. Remediation pass — July 2026 (round 2)

A full codebase + documentation review, with independent CISO and Architect reviews, found a further
set of issues. Everything below is **fixed in code** unless explicitly listed under *Operator actions*.

### 9.1 CRITICAL — credentials in git history

`settings.json` was **tracked in git** and contained a live LDAP service-account bind password.
There are **two distinct passwords** across two commits:

| Commit | Leaked |
|---|---|
| `33eface` "add my project" | `bindPass` for `CN=GameTrackerusr` (`ldap://etechdc.etech.com`) |
| `811af90` "change ldap"    | `bindPass` for `uid=gametrackerusr` (`ldap://freeipa.etech.com`) |

The history also exposes the directory topology: base DN, service-account DN, required-group DN, and
the `mail.etech.ink` / `ntfy.etech.ink` hostnames.

Three controls each failed to catch it: `.gitignore` covered `.env` and the DB but not `settings.json`;
Gitleaks' default ruleset has no rule for a password in a generic JSON key; and the deployment
checklist *asserted* the file was not committed.

**Fixed:** `settings.json` untracked and gitignored; `settings.example.json` added as the template;
`.gitleaks.toml` gained a `gametracker-config-password` rule (matches `bindPass`/`smtp pass`/`password`
with a non-empty value) and a Telegram-bot-token rule. Both historical commits are allowlisted **by SHA**
so the new rules do not fail CI on unrewritable history — remove those entries if the history is purged.

> **Operator actions (cannot be done in code):**
> 1. **Rotate BOTH LDAP service-account passwords** and treat the account as compromised; audit what it
>    could reach.
> 2. Decide on `git filter-repo` + force-push to purge the blobs. Until then every clone still has them.
> 3. Switch the LDAP URL to `ldaps://` (see 9.2).

### 9.2 Fresh installs were broken (pre-existing, undetected)

`db.run` was called outside `db.serialize()`. node-sqlite3 defaults to **parallel** mode, so the
`ALTER TABLE … ADD COLUMN` migrations raced the `CREATE TABLE` statements and lost on a **fresh**
database — failing with "no such table" into empty `() => {}` error callbacks. A brand-new install came
up missing `user_games.backlog_order`, `users.telegram_chat_id`, `users.ntfy_url` and `users.gotify_url`,
so **adding any game returned 500**, backlog ordering failed, and the entire per-user notification
feature was inert. Existing databases were fine (migrated incrementally), and the CI smoke test only
asserted `/api/health`, so nothing surfaced it.

**Fixed:** schema creation and migrations run inside `db.serialize()` via `initializeSchema(done)`;
migration failures are logged unless they are the expected "duplicate column name"; `ensureRootUser()`
now runs *after* the schema instead of racing it; `user_shares` creation moved into the same block.

### 9.3 Backend

| # | Issue | Fix |
|---|---|---|
| C1 | **Pre-auth remote crash.** `ldap.createClient` had no `'error'` listener anywhere. An unreachable directory turned any anonymous `POST /api/auth/login` into an uncaught exception that killed the process — and each crash wiped the in-memory rate-limit counters. `/api/admin/ldap-sync` built a client per user, so one sync was a guaranteed crash. | `createLdapClient()` attaches an `'error'` handler + connect/read timeouts and fails over once. All three call sites use it. A `authCompleted` latch makes the login fallback idempotent (the socket error and the bind callback race). |
| H | **LDAP filter injection** at three sites — username interpolated raw, so `*` matched the whole directory. | `escapeLdapFilterValue()` (RFC 4515) + `buildUserSearchFilter()`. A search matching **more than one** entry is now refused rather than silently binding as whichever arrived last. |
| H | **SSRF error oracle.** `POST /api/admin/test-notification` (auth-only, by design) returned raw axios errors, distinguishing refused/filtered/404 — a port scanner for the internal network. `topic`/`token` were interpolated unencoded, giving control of the full path and query. | Errors collapsed to one generic message (`sanitizeDeliveryError`); detail stays in the server log. `topic` is `encodeURIComponent`'d; the Gotify token moved to the `X-Gotify-Key` header. Cloud **metadata** endpoints (169.254.0.0/16, `metadata.google.internal`, …) are blocked. **RFC1918 remains allowed — self-hosting ntfy/Gotify on a LAN is the documented design.** |
| H | **Authenticated open relay / HTML injection.** `sendEmail` interpolated `text` and `coverUrl` raw into the HTML body, and `email` was accepted with no validation — so one account could send arbitrary HTML to an arbitrary address from the deployment's SPF/DKIM-aligned domain. | Body HTML-escaped; `coverUrl` must be `https` on an allowlisted image host; `email` must be a single valid address (commas rejected — nodemailer treats `to` as a list). |
| H | **Rate-limit bypasses.** A successful login cleared the whole IP's counter, so one valid account gave unlimited guesses against `root`; the counter was cleared before the LDAP group check; entries never expired. | Counters keyed on **both** IP and account; only the authenticating account's keys clear; clearing moved after the group-membership check; hourly sweep. |
| M | **Authorization frozen in the 12-hour JWT.** `requirePermission` read the token claim, never the DB — so revoking admin left full admin access until expiry, and a deleted user's token kept working. | `authRequired` re-reads the user row per request and 401s if the account is gone. |
| M | **Prototype pollution.** `game_id` is attacker-controlled and SQLite stores `"__proto__"` happily; the notification-dedup map's guard was skipped and the write landed on `Object.prototype`, after which **all** release notifications silently stopped. | Null-prototype maps + rejection of `__proto__`/`constructor`/`prototype` keys. |
| M | **Crash via numeric password.** `12345678` passes `.length < 8` (`undefined < 8`) then rejects inside `bcrypt.hash`; unhandled, that exits the process. | `typeof === 'string'` checks + `.catch()` on both hash calls + an `unhandledRejection` backstop. |
| M | **Ghost users.** `getOrCreateUser` was used as a *read* helper in ~10 routes, so any request naming an unknown user provisioned a passwordless account that appeared in `/api/all-users` and the sharing picker. | `findUser` / `withExistingUser` (404 on miss); auto-create is now only on the LDAP login path. `getUserGames` uses a single JOIN. |
| M | **Share integrity.** Nonexistent and mixed-case usernames were accepted; SQLite does not enforce the declared FKs, so mixed-case shares were stored but could never match. | Targets normalized, de-duplicated, self-shares dropped, and verified to exist. Deleting a user now also deletes their share rows. |
| M | Staging ran `NODE_ENV=staging`, so Express's default handler returned `err.stack` **in the response body**. | Explicit error middleware returning a generic message; staging set to `NODE_ENV=production`. Unmatched `/api/*` now returns JSON 404 instead of the SPA's HTML. |
| L | `/api/health` (unauthenticated) leaked user count, the root account's id/username, and raw DB errors. | Returns `{"status":"ok"}` only. |
| L | Admin `GET /api/settings` returned `ldap.bindPass` / `smtp.pass` / `telegram.bot_token` in cleartext. | Masked as `__unchanged__`; `POST` maps the mask back to the stored value, so saving a section without retyping the password preserves it. An empty string still clears. |
| L | `settings.json` written 0644 (world-readable in-container); `SETTINGS_FILE` was a **relative** path, so scripts run from another directory read/created a different file; a corrupt file degraded silently. | Mode `0600`, absolute `path.join(__dirname, …)`, parse errors logged, and the parsed object cached with `mtime` validation (it was `readFileSync` on every hot-path call). |
| L | Admins could demote or delete themselves, or delete `root`, locking the instance out. | Refused. `me`/`root`/`admin` are reserved usernames (`me` would be shadowed by the `/api/user/me/*` routes). |
| L | Per-request logging wrote one line **per game** in a library, and dumped the full LDAP entry (DN, mail, memberOf) on every login. | One summary line per request; LDAP logs the DN only. |
| L | Username enumeration — LDAP-origin accounts got a distinct error message. | Uniform `Invalid credentials`; the reason goes to the log. |

### 9.4 Dependencies

`brace-expansion` was pinned `>=5.0.7`, but GHSA-mh99-v99m-4gvg covers `<=5.0.7` — a live **HIGH** that
would have failed the next Trivy run. Bumped to `>=5.0.8`, plus `qs >=6.15.3`, `body-parser >=2.3.0`,
`ip-address >=10.3.0`. `react-icons` (a frontend-only package) removed from the backend dependencies.

`npm audit --production`: **1 HIGH + 4 MODERATE → 0**. Five LOW remain in the `node-gyp` chain under
`sqlite3`, reachable only at build time and resolvable only by the `sqlite3` 6.x major bump — deferred.

> **`ldapjs` is decommissioned.** All `@ldapjs/*` packages print decommission notices on install; the
> entire enterprise auth path rests on an abandoned dependency that will never be patched. No drop-in
> replacement exists — this needs a planned migration.

### 9.5 Infrastructure & CI

- **`frontend/nginx.conf` had no `/api` proxy**, so `try_files` answered `/api/*` with **index.html and
  HTTP 200** — the frontend image could not serve a working app alone, and CI's "frontend returns 200"
  gate passed against a completely broken stack. Added a `location /api/` block using the
  `resolver 127.0.0.11` + variable-`proxy_pass` pattern (so nginx starts even when the backend is down)
  with 600s timeouts for the 5-minute bulk refresh. **If an external proxy already routes `/api`, this
  block is simply never reached.**
- The **container** backend port is now fixed at `3000` in all three compose files (only the *host*
  port varies), which is what makes that proxy work in the smoke stack too.
- Backend publish interface is now controlled by **`BACKEND_BIND`**. On `0.0.0.0` the backend is
  reachable directly, bypassing nginx — and with `trust proxy` set, a direct client controls
  `X-Forwarded-For` and can present a fresh IP per login attempt, defeating the rate limiter.

  **It defaults to `0.0.0.0`, which does NOT close that hole.** This deployment's reverse proxy runs on
  a separate machine and reaches the backend across the network, so a loopback default would have taken
  the API down on deploy. Closing it properly is an operator step, not a code change — see 9.6.
- **Smoke test now proves the real request path**: `/api/health` *through* the frontend port, plus a
  JSON-404 assertion. This is the first functional CI gate beyond "the process started".
- Smoke-test data directory moved from a fixed `/tmp` path to `mktemp -d`. The old path on a shared
  runner was a symlink-attack target: `echo` would truncate production `settings.json`, `chmod -R 777`
  would expose the live database, and teardown's `rm -rf` would **delete the production data directory**.
  Teardown now refuses to delete a symlink and uses `--one-file-system`.
- Trivy/Gitleaks installs **pinned and verified** (Trivy was `curl | sudo sh` from a mutable `main`).
  Both were `if ! command -v …`-guarded, so a stub binary on a persistent runner would permanently
  green-light the scan while CI reported success.
- `permissions: contents: read` + `persist-credentials: false` on all eight checkouts.
- Backend image builds with `npm ci --omit=dev` (was `npm install --production`) so it matches the lockfile.
- Staging `JWT_SECRET` uses `${JWT_SECRET:?…}` like production (it defaulted to `supersecretkey`, which
  only failed closed by accident because that exact literal is on the boot deny-list).

### 9.5b LDAP ambiguous matches and the FreeIPA `cn=compat` tree

**Control.** A username that matches more than one directory entry is **refused**. Binding as an
arbitrarily chosen match is an authentication bug: it lets whoever controls *any* matching entry
authenticate as the user whose name they collide with.

**Nothing is filtered out of the search result before that count is taken.** The guard is only
fail-closed if the set it counts is complete.

**The incident.** Adding this guard broke LDAP login completely for this deployment, and it stayed
broken until someone tried to log in. FreeIPA's Schema Compatibility plugin republishes every account
under `cn=compat`, so with `ldap.base = dc=etech,dc=com` every user matched twice:

```
uid=eladharels,cn=users,cn=accounts,dc=etech,dc=com   ← canonical
uid=eladharels,cn=users,cn=compat,dc=etech,dc=com     ← republished mirror
```

**Resolution: configuration.** `ldap.base` must point at the accounts subtree
(`cn=accounts,dc=etech,dc=com`) so the mirror is never in scope. When a refusal involves a compat
entry the backend logs the remediation, so this cannot recur silently.

**Two rejected code fixes, recorded so they are not retried.** Both were authentication bypasses,
both verified as a 401 → 200 inversion against a live directory:

1. *Drop anything under `cn=compat`.* FreeIPA with an AD trust publishes trusted-domain users under
   `cn=compat` **only**, so this deleted the real user; an attacker holding any colliding entry became
   the sole match and was issued a session with their own password.
2. *Drop a `cn=compat` entry only when its `cn=accounts` counterpart is present, proving it redundant.*
   The attacker **plants the counterpart**: given a real `uid=karen,…,cn=compat,…`, creating
   `uid=karen,…,cn=accounts,…` makes the real entry look like a mirror. It is dropped, the attacker is
   the sole match, and the legitimate user is locked out at the same time.

**The rule.** A DN is a *name*, not evidence. Any DN shape treated as proof that two entries are the
same person can be produced by anyone who can create a directory entry. Do not add a third variant.
Proving it needs directory data — a stable identity attribute such as `ipaUniqueID` or `entryUUID`
compared between the two entries. `test/helpers.test.js` asserts that `ldap-helpers.js` exports no
filtering function at all; that test exists to make a reintroduction fail CI.

**Known limitation.** Under a narrowed base, FreeIPA trusted-domain users that exist only under
`cn=compat` cannot log in. Accepted: the failure is availability, not authentication.

### 9.6 Still open — deliberately not changed

- **Cleartext `ldap://`.** A simple bind sends every user password and the service-account password
  unencrypted. The code now **warns loudly at startup** but does not refuse, because refusing would lock
  out the running deployment. **Switch to `ldaps://` and rotate.**
- **Backend directly reachable on the LAN (`BACKEND_BIND=0.0.0.0`).** The edge proxy lives on another
  host and currently points at **two** upstreams — `/api` → backend `:3000`, everything else →
  frontend `:8080` — so the backend port must stay published. While it is, anyone who can reach
  `<host>:3000` bypasses nginx and can spoof `X-Forwarded-For` past the login rate limiter.

  Now that `frontend/nginx.conf` proxies `/api` itself, the frontend port can serve the whole app and
  this exposure can be removed. Ordered so there is no downtime:

  1. Deploy, then confirm `curl http://<host>:8080/api/health` returns `{"status":"ok"}`.
  2. Repoint the edge proxy to send **all** paths to `:8080`; delete the `/api` → `:3000` rule.
  3. Verify the site end to end.
  4. Set `BACKEND_BIND=127.0.0.1` (or drop the backend's `ports:` entry) **and `TRUST_PROXY=2`**.

  > Step 4's `TRUST_PROXY` bump is mandatory: routing through the frontend adds a second proxy hop.
  > Left at `1`, `req.ip` becomes the frontend container's address and every failed login shares one
  > bucket — five bad passwords from anyone locks out every user for 15 minutes.

- **HSTS** — belongs on the TLS-terminating edge proxy, which is not in this repo.
- **`sqlite3` 6.x** major bump (clears the last 5 LOW advisories).
- **Existing ghost users** already in the database. Review with
  `SELECT id, username, created_at FROM users WHERE password IS NULL AND origin = 'local';`
  and delete the confirmed ones by hand — this is a live-data operation, not a migration.
- **Email address verification.** Changing `email` still takes effect without a confirmation round-trip;
  only the format is validated. A verification token is a feature, not a patch.
- **Long-running bulk refresh** is still a synchronous 5-minute HTTP request. The right shape is
  `202 Accepted` + a job id; deferred as a feature.

---

## 10. SQLite → PostgreSQL migration — security review (July 2026, Phase 1)

Branched from `claude/codebase-review-hml32s`. **That branch is not merged and not in
production**, so merging this ships the section 9 hardening and the database migration
together. Verified: production `/api/health` still returns `totalUsers` and `rootUser`,
which section 9.3 removed — production is running unhardened `main`.

### 10.1 Hardening items explicitly re-verified after the port

Each of these was tested against a real PostgreSQL 16 server, not reasoned about:

| Item | Status |
|---|---|
| Settings `__unchanged__` sentinel | **Intact.** `GET /api/settings` returns no cleartext secret; POSTing that response back preserves the stored password; empty string still clears it. |
| No auto-create on read | **Intact.** Unknown username → 404, user count unchanged. |
| Null-prototype notification maps | **Untouched.** Still `Object.create(null)` with `__proto__`/`constructor`/`prototype` rejection. `game_id` remains attacker-controlled, and is now `TEXT` in the database. |
| Privilege re-read per request | **Intact.** Demoting an admin takes effect on an already-issued token; a deleted user's token returns 401. |
| SSRF blocklist | **Untouched** — no notification-URL code was modified. |
| Schema-init error swallowing | **Fixed properly.** Replaced with transactional migrations that are fatal on failure. Fault-injection test: a deliberately broken migration exits 1 and leaves no partial state. |

### 10.2 New security posture

- **Database port is not published** in either compose file. The database is reachable
  only over the compose network. This matches every other database container on the host.
- **`POSTGRES_PASSWORD` uses the `:?` fail-fast form** — compose refuses to render without
  it, so the database can never come up with a blank or defaulted password. It must be
  added to the repository's Actions secrets before merge.
- **No credentials in logs.** `db.js` logs only the driver error code and message; the
  DSN (which contains the password) is never interpolated into a log line or an error
  response. Route handlers continue to return a generic `{ error: 'DB error' }`.
- **`read_only: true` is now set on the backend container** — SQLite's need for a writable
  `/app` was the only thing blocking it. Verified empirically that bind-mounted files stay
  writable under `read_only` while unmounted `/app` paths fail with `EROFS`.
- **Foreign keys are enforced for the first time.** SQLite declared them but ran with
  `PRAGMA foreign_keys` OFF, so deleting a user left dangling rows. `ON DELETE CASCADE`
  now prevents that class of debris accumulating.

### 10.3 Ghost users — section 9's follow-up item, now resolved

Section 9 left "existing ghost users" open pending a live-data check. Checked:

```
SELECT id, username, origin FROM users WHERE password IS NULL AND origin = 'local';
-- 0 rows
```

**There are no ghost users.** All eleven NULL-password accounts have `origin='ldap'`,
which is correct and expected — LDAP users authenticate against the directory. This item
can be closed.

### 10.4 Pre-existing data integrity problems surfaced by the migration

Postgres enforces what SQLite ignored, so these had to be dealt with:

- **30 `user_games` rows** reference `user_id` 2, 3, 4, 5 or 8 — none of which exist.
  Not previously known. Unreachable through the API, but still data: the migration halts
  and requires an explicit operator decision rather than dropping them.
- **2 `user_shares` rows** target `'Orelsh'` where the account is `'orelsh'`. A case
  mismatch, not a dead user — repaired by normalisation. Worth noting as a latent bug:
  usernames are lowercased on the user record but were not on the share record.

### 10.5 OPEN — requires CISO decision before Phase 2

**Should the LDAP bind password and SMTP password live in PostgreSQL at all?**

Phase 1 deliberately does not answer this: `settings.json` is untouched and still holds
those credentials at mode `0600`. The question only becomes live when settings move into
the database.

The honest framing is that storing them in the database **moves the secret rather than
removing it** — the connection string becomes the thing worth stealing, and it sits in
the environment of a container that is reachable from the internet-facing app. Options:

1. **Keep credentials in environment variables; store only non-secret config in the
   database.** Smallest secret surface. Costs the ability to edit them from the admin UI —
   a real usability regression the operator relies on today.
2. **Store encrypted, with the key from the environment.** Keeps the admin UI. The key
   still lives beside the data in the same container's environment, so it mainly protects
   against database backups and dumps leaking — which, given a new `pg_dump` backup
   procedure is being introduced here, is not a trivial benefit.
3. **Store plaintext and rely on database access control.** Weakest. A read-only SQL
   injection or a leaked dump yields the directory bind credential outright.

**Recommendation: option 2**, on the grounds that the operator has just rotated the LDAP
credentials after a leak, backups are about to start being written to disk regularly, and
option 1's loss of the admin UI is likely to be rejected in practice. This needs sign-off
before Phase 2 begins; it is not decided by this change.
