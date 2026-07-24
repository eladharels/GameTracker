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
- No CSP/HSTS from the Node app — nginx owns those headers (see staging #58).
- LOW/MODERATE dependency advisories (qs, body-parser, ip-address, @tootallnate/once) — routine refresh.
- Mobile app: uses plain `SharedPreferences` for the token and has always-on OkHttp `BODY` logging that
  prints the login body + bearer token — tracked in `../GameTracker-mobile/SECURITY_FIXES.md`.
- `CLAUDE.md` files describe notification config as server-level and "5 accent presets" — now stale
  (per-user notification servers; 6 accent presets). Worth a docs refresh.
