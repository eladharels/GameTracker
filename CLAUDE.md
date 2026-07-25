# GameTracker — CLAUDE.md

## Project Overview

GameTracker is a self-hosted, multi-user **game library management web application**. Users can search for games across multiple external databases, add them to a personal library, and track their play status. The application is containerized with Docker and deployed as a full-stack monolith.

---

## Tech Stack

### Backend
- **Runtime**: Node.js 18
- **Framework**: Express.js 5.x
- **Database**: SQLite3 (file-based, `gametracker.db`)
- **Authentication**: JWT (jsonwebtoken) + bcryptjs for local auth, ldapjs for LDAP/Active Directory
- **Email**: Nodemailer (SMTP)
- **Push Notifications**: ntfy.sh, Gotify, Telegram Bot API
- **Scheduling**: node-cron (release checks daily at 8 AM, price updates Mondays at 3 AM)
- **HTTP client**: Axios (for external API calls)
- **Entry point**: `index.js` (~3950 lines — monolithic Express server)

### Frontend
- **Framework**: React 18 with React Router 6
- **Build tool**: Vite 5
- **HTTP client**: Axios
- **Icons**: react-icons
- **Styling**: Custom CSS, glassmorphism dark theme, 6 accent color presets (Violet default, Blue, Emerald, Amber, Rose, Cyan)
- **Entry point**: `frontend/src/App.jsx` (~2600 lines — single large component)

### Infrastructure
- **Containerization**: Docker + docker-compose
- **Backend port**: 3000
- **Frontend port**: 8080 (Docker), 5173 (Vite dev server)
- **Persistent volumes**: SQLite database, settings.json, sent_notifications.json

> **Dockerfile layer order (critical):** The backend `Dockerfile` must install system build tools (`python3`, `make`, `g++`, `sqlite3`) **before** running `npm ci --omit=dev`. The `sqlite3` package has no prebuilt NAPI binary for the `node:18-slim` image and compiles from source via `node-gyp`, which requires Python3. Wrong order → build failure.
>
> Dependencies install with `npm ci` (not `npm install`) so the image matches `package-lock.json` exactly.

---

## Architecture

```
GameTracker/
├── index.js                        # Backend: Express server + all API routes + cron jobs
├── package.json                    # Backend dependencies
├── Dockerfile                      # Backend image (node:18-slim)
├── docker-compose.yaml             # Production orchestration
├── docker-compose.staging.yaml     # Staging orchestration
├── docker-compose.test.yml         # CI smoke-test stack (isolated ports/data)
├── .env                            # API credentials (GITIGNORED — never commit)
├── settings.example.json           # Template for settings.json (committed, no secrets)
├── settings.json                   # SMTP / LDAP / Telegram / API-key runtime config
│                                   #   (GITIGNORED — holds live credentials)
├── gametracker.db                  # SQLite database (gitignored)
├── sent_notifications.json         # Notification deduplication log (gitignored)
├── crackwatch-cache.json           # Cached DRM status (gitignored)
├── system-status-cache.json        # Last-OK timestamps per service (gitignored)
├── .dockerignore                   # Keeps secrets/state out of the image build context
├── .gitleaks.toml                  # Secret-scanning rules + allowlist
├── .semgrep.yml                    # Custom SAST rules
├── .trivyignore                    # Documented CVE suppressions
├── .github/workflows/
│   └── docker-build-deploy.yml     # CI: scan → build → smoke test → deploy
├── frontend/
│   ├── src/
│   │   ├── App.jsx                 # Main React app (all pages/views in one file)
│   │   ├── App.css                 # Global styles (glassmorphism theme, ~6200 lines)
│   │   ├── GameDetailModal.jsx     # Game detail overlay
│   │   ├── main.jsx                # React entry point
│   │   ├── contexts/
│   │   │   └── ToastContext.jsx    # Global toast notification context
│   │   └── styles/
│   │       └── Toast.css
│   ├── SharedLibrary.jsx           # Shared-library page (NOTE: lives outside src/)
│   ├── nginx.conf                  # Serves the SPA + proxies /api to the backend
│   ├── vite.config.js              # Dev server + /api proxy for local development
│   ├── eslint.config.js
│   ├── package.json
│   └── Dockerfile                  # Frontend image (multi-stage: Node build → Nginx)
├── [Docs]:
│   ├── README.md                   # Setup, API reference, operations
│   ├── SECURITY_HARDENING_2026-07.md  # Threat history + operational runbook (authoritative)
│   ├── PRODUCTION_CHANGELOG.txt    # Record of changes promoted from staging
│   ├── SECURITY_FIXES.md           # Historical — early credential-validation fix
│   ├── NOTIFICATION_FIXES.md       # Historical — notification system rework
│   └── RELEASE_STATUS_UPDATE.md    # Historical — unreleased→wishlist transition
└── [Utility scripts]:
    ├── create-local-admin.js
    ├── reset-root-password.js
    ├── update_library_prices.js
    ├── refresh_igdb_token.js
    ├── backfill_steam_app_ids.js
    ├── backfill_ldap_display_names.js
    ├── test_ldap_sync.js
    └── run_notifications.js
```

### Architectural Pattern
- **Full-stack monolith**: All backend logic lives in a single `index.js`
- **Single-page application**: All frontend views/pages live in `App.jsx` + React Router
- **File-based config**: Runtime settings (SMTP, LDAP, Telegram, API keys) in `settings.json`,
  read through a cached `loadSettings()` that revalidates on the file's mtime
- **Stateless API**: JWT-based authentication — no server-side session state. The token carries
  identity; **privilege is re-read from the database on every request**, so revoking admin or deleting
  an account takes effect immediately rather than at token expiry.

> **Schema initialization is order-sensitive.** All `CREATE TABLE` / `ALTER TABLE` statements run inside
> `db.serialize()` in `initializeSchema()`. node-sqlite3 defaults to *parallel* mode, where the ALTER
> migrations race the CREATEs and fail on a fresh database — which silently shipped installs missing
> `backlog_order`, `telegram_chat_id`, `ntfy_url` and `gotify_url`. Never add schema statements outside
> that block, and never pass an empty error callback to a migration.

---

## Database Schema

### `users`
| Column | Type | Notes |
|---|---|---|
| id | PK | Auto-increment |
| username | TEXT UNIQUE | Normalized to lowercase |
| password | TEXT | bcrypt hash; NULL for LDAP users |
| can_manage_users | INTEGER | Admin flag (0/1) |
| email | TEXT | For notifications |
| ntfy_url | TEXT | Per-user ntfy **server URL** (My Account); falls back to global default if empty |
| ntfy_topic | TEXT | User-specific ntfy topic (personal, set in My Account) |
| gotify_url | TEXT | Per-user Gotify **server URL** (My Account); falls back to global default if empty |
| gotify_token | TEXT | User-specific Gotify app token (personal, set in My Account) |
| telegram_chat_id | TEXT | User-specific Telegram chat ID (personal, set in My Account) |
| created_at | TEXT | ISO timestamp |
| origin | TEXT | `local` or `ldap` |
| display_name | TEXT | LDAP sync or manual |
| shares_library | INTEGER | Library sharing toggle (0/1) |
| notification_days | TEXT | JSON array of days-before-release to send reminders (e.g. `[0,7,30]`) |

### `user_games`
| Column | Type | Notes |
|---|---|---|
| id | PK | Auto-increment |
| user_id | FK → users.id | |
| game_id | INTEGER | External API game ID |
| game_name | TEXT | |
| cover_url | TEXT | Image URL |
| release_date | TEXT | YYYY-MM-DD |
| status | TEXT | `wishlist`, `playing`, `done`, `backlog`, `unreleased` |
| steam_app_id | TEXT | For Steam price lookups |
| last_price | TEXT | Formatted price string (e.g., "₪59.99") |
| last_price_updated | TEXT | ISO timestamp |
| crack_status | TEXT | `cracked`, `uncracked`, `unknown` |
| backlog_order | INTEGER | Drag-and-drop position (backlog only) |

### `user_shares`
| Column | Type | Notes |
|---|---|---|
| from_user | TEXT | FK → users.username |
| to_user | TEXT | FK → users.username |
| shared_at | TEXT | ISO timestamp |

---

## External API Integrations

| API | Purpose | Auth |
|---|---|---|
| **IGDB** (igdb.com) | Primary game search + metadata | `IGDB_CLIENT_ID` + `IGDB_BEARER_TOKEN` (Twitch OAuth — expires ~60 days) |
| **RAWG.io** | Secondary game search + metadata | `RAWG_API_KEY` |
| **TheGamesDB** | Tertiary game source + box art | `THEGAMESDB_API_KEY` (optional) |
| **Steam Store API** | Game pricing by region | No auth (public) |
| **CrackWatch** | DRM/crack status (daily cached) | No auth (public) |
| **SMTP** | Email notifications | Configured in `settings.json` |
| **ntfy.sh** | Push notifications | Server URL in `settings.json`; per-user topic in `users.ntfy_topic` |
| **Gotify** | Self-hosted push notifications | Server URL in `settings.json`; per-user token in `users.gotify_token` |
| **Telegram Bot API** | Push notifications via Telegram | Bot token in `settings.json`; per-user chat ID in `users.telegram_chat_id` |
| **LDAP/Active Directory** | Enterprise authentication | Bind DN + password in `settings.json` |

### API Key Management
API keys for IGDB, RAWG, and TheGamesDB can be managed in two ways:
1. **Environment variables** (`.env`) — set at deploy time, require container restart to change
2. **Admin UI** (Settings → API Keys) — stored in `settings.json` under `apikeys`, take effect immediately, override env vars

The `resolveApiKey(envName)` helper checks `settings.json → apikeys` first, then falls back to `process.env[envName]`.

**IGDB token expiry**: Twitch OAuth `access_token` values expire every ~60 days. Use **Settings → API Keys → Refresh IGDB Token** to auto-fetch a new token from Twitch using the stored Client ID + Client Secret — no redeploy needed.

---

## Authentication & Security

- **Local auth**: bcrypt-hashed passwords stored in SQLite
- **LDAP auth**: Supports Active Directory (`sAMAccountName`) and FreeIPA (`uid`); falls back to local auth on failure
- **JWT tokens**: 12-hour expiry, signed with `JWT_SECRET`. **`JWT_SECRET` is required** — the backend fail-fasts (exits) if it is missing, `<16` chars, or the old `supersecretkey` default. Supplied via env (GitHub Actions secret → compose); rotating it invalidates all sessions.
- **Route authorization**: every `/api/user/:username/*` route requires `authRequired` + ownership (self-or-admin); data routes (search/price/crack-status) require auth; `GET/POST /api/settings` never exposes secrets and all server sections are admin-only to write. See `SECURITY_HARDENING_2026-07.md`.
- **Rate limiting**: 5 failed login attempts → 15-minute IP lockout (`trust proxy` set so `req.ip` is the real client behind nginx; `TRUST_PROXY` configurable)
- **CORS**: deny-by-default allowlist via `CORS_ORIGINS` (same-origin app needs none)
- **Security headers**: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy from the Node app; CSP + Permissions-Policy from `frontend/nginx.conf`. **HSTS is not set anywhere in this repo** — it belongs on the TLS-terminating edge proxy.
- **Root user**: seeded from `ROOT_PASSWORD`, else a random password printed once at first boot (no hardcoded default; existing DBs keep their current root password)
- **Secrets never in the image**: `.dockerignore` excludes `.env`, the DB, and `settings.json` from the build context

---

## Key Features

- **Multi-source game search**: Queries IGDB, RAWG, and TheGamesDB simultaneously; deduplicates results
- **Personal game library**: Track games with statuses — wishlist, playing, done, backlog, unreleased
- **Backlog ordering**: Drag-and-drop reordering for the backlog queue with position badges
- **Steam pricing**: Weekly price sync for all library games with Steam App IDs
- **Release notifications**: Daily cron checks; sends reminders per user-configured schedule (default 0/7/30 days) via email, ntfy, Gotify, and Telegram, with game cover images
- **Per-user notification servers**: each user sets their own **ntfy/Gotify server URL** (+ topic/token) in My Account; the `settings.json` ntfy/Gotify URL is only an optional admin-set default fallback
- **Telegram push notifications**: Bot-based push support; bot token in Settings (admin-only), per-user chat ID in My Account; cover images via sendPhoto
- **CrackWatch integration**: Daily cache of DRM/crack status for all games; shown on library cards
- **Library sharing**: Share your game library (read-only) with specific other users
- **Admin panel**: Create/edit/delete users, manage permissions, LDAP sync
- **Metadata refresh**: Manual and automatic refresh of game info from source APIs
- **Widescreen layout toggle**: Sidebar button to expand to widescreen; persisted to localStorage
- **My Account page**: Per-user notification setup — email, **ntfy server URL + topic**, **Gotify server URL + token**, Telegram chat ID, and reminder schedule
- **Settings page**: Server infrastructure, **admin-only** — SMTP, LDAP, API Keys, and the optional default ntfy/Gotify/Telegram server config. Non-admins see only the **Diagnostics** tab (test their own channels).
- **System Status page** (admin-only): Real-time connectivity check for all 6 external services (IGDB, RAWG, TheGamesDB, Steam, CrackWatch, Database). Shows HTTP status code, last-OK timestamp, provider info, latency. Persists last-OK times to `system-status-cache.json`.

---

## Environment Configuration

### `.env` (Required)
```env
IGDB_CLIENT_ID=<twitch_client_id>
IGDB_BEARER_TOKEN=<twitch_bearer_token>
RAWG_API_KEY=<rawg_api_key>
THEGAMESDB_API_KEY=<optional>
JWT_SECRET=<strong_random_secret>   # REQUIRED, >=16 chars, not 'supersecretkey' — backend exits without it
PORT=3000
NODE_ENV=production
# Optional:
# ROOT_PASSWORD=<fresh-DB root password; random-printed-once if unset>
# CORS_ORIGINS=<comma-separated cross-origin allowlist; usually empty (same-origin app)>
# TRUST_PROXY=<reverse-proxy hop count for the login rate limiter; default 1>
```
> In deployment `JWT_SECRET` (and the API keys) come from **GitHub Actions secrets** injected into the
> compose env; the compose uses `${JWT_SECRET:?...}` (fail-fast). `.env` is gitignored and excluded from
> images via `.dockerignore`.

### `settings.json` (Runtime, managed via Admin UI)
```json
{
  "smtp":    { "host": "", "port": 587, "user": "", "pass": "", "from": "", "to": "" },
  "ntfy":    { "url": "https://ntfy.sh" },
  "gotify":  { "url": "" },
  "telegram":{ "bot_token": "" },
  "ldap":    { "url": "", "base": "", "bindDn": "", "bindPass": "", "requiredGroup": "" },
  "apikeys": {
    "igdb_client_id": "", "igdb_client_secret": "", "igdb_bearer_token": "",
    "rawg_api_key": "", "thegamesdb_api_key": ""
  }
}
```
> `apikeys` values override environment variables. The `igdb_client_secret` is used exclusively by the Settings → API Keys → **Refresh IGDB Token** button, which calls Twitch OAuth and auto-saves the new bearer token.

---

## Scheduled Tasks (Cron Jobs)

| Schedule | Task |
|---|---|
| Daily at 4:00 AM | Refresh the CrackWatch DRM-status cache for all games |
| Daily at 8:00 AM | Check released games; update status `unreleased → wishlist`; send release reminders on each user's own `notification_days` schedule (default 0/7/30) |
| Every Monday at 3:00 AM | Fetch current Steam prices for all library games with a Steam App ID |

---

## Relationship to Other Projects

- **GameTracker-stg** (`../GameTracker-stg/`): The staging environment for this project. All new features and fixes are developed and tested there first. The `STAGING_CHANGELOG.txt` in that project documents every pending change with step-by-step migration instructions for applying to this production instance.
- **GameTracker-mobile** (`../GameTracker-mobile/`): A native Android companion app (Kotlin) that connects to this backend's REST API at `https://gametracker.etech.ink/api/`.

---

## Utility Scripts

| Script | Purpose |
|---|---|
| `create-local-admin.js` | Create a new admin user from the CLI |
| `reset-root-password.js` | Reset the root user's password |
| `update_library_prices.js` | Manually trigger a Steam price update |
| `refresh_igdb_token.js` | Refresh the IGDB OAuth Bearer token |
| `backfill_steam_app_ids.js` | Populate missing Steam App IDs for existing library entries |
| `backfill_ldap_display_names.js` | Sync display names from LDAP for all LDAP-origin users |
| `test_ldap_sync.js` | Test and debug the LDAP connection and sync |
| `run_notifications.js` | Manually trigger the release notification check |

---

## CI/CD Security Pipeline

**Added**: 2026-04-24 (from staging Changes #44, #45, #46)

Every push to `main` must pass a full security gauntlet before code reaches the running production stack.

### Pipeline Job Graph

```
push: main
│
├── secret-scan      Gitleaks — full git history scan
├── semgrep          Semgrep auto ruleset + custom rules (.semgrep.yml)
├── frontend-quality ESLint + Vite build (no test framework; build = typecheck)
└── build-images     Build backend + frontend Docker images
    ├── trivy-api    Trivy — backend image  (CRITICAL/HIGH → fail)
    └── trivy-web    Trivy — frontend image (CRITICAL/HIGH → fail)

smoke-test  (needs: build-images + all 3 scan jobs)
  └─► docker compose -p gametracker-smoke -f docker-compose.test.yml
       Backend: GET http://localhost:3099/api/health → {"status":"ok"}
       Frontend: GET http://localhost:8099/ → HTTP 200
       Teardown: if: always() — guaranteed cleanup

deploy  (needs: ALL 7 upstream jobs)
  └─► docker compose up + post-deploy health check on :3000/api/health
```

### Security Tools

| Tool | Job | Failure Condition |
|---|---|---|
| Gitleaks | `secret-scan` | Any detected secret in git history |
| Semgrep | `semgrep` | Any ERROR-severity finding |
| Trivy | `trivy-api` | CRITICAL or HIGH unfixed CVE in backend image |
| Trivy | `trivy-web` | CRITICAL or HIGH unfixed CVE in frontend image |
| ESLint | `frontend-quality` | Any lint error |
| Vite build | `frontend-quality` | Build failure |
| Smoke test | `smoke-test` | Backend health ≠ 200 or frontend ≠ 200 |

### Container Hardening

| Component | Hardening |
|---|---|
| Backend | `no-new-privileges:true`, runs as `node` user (UID 1000) |
| Frontend | `no-new-privileges:true`, `read_only: true`, tmpfs for `/tmp`, `/var/cache/nginx`, `/var/run`, runs as `nginx` user via `nginxinc/nginx-unprivileged:alpine` |
| Backend read_only | **Cannot be enabled** — SQLite requires writable `/app/` for WAL/journal files |

### Smoke Test Isolation

| Property | Value |
|---|---|
| Compose project | `gametracker-smoke` (separate Docker network) |
| Backend port | `3099` (no conflict with production `3000`) |
| Frontend port | `8099` (no conflict with production `8080`) |
| Data directory | `/tmp/gametracker-smoke-data/` — ephemeral, wiped after test |
| Production DB | **Never touched** — `/home/docker/gametracker/data/` not mounted |

### Docker Prune Change

Old: `docker system prune -a -f` (destroys layer cache, slow rebuilds)
New: `docker image prune -f` (dangling only — preserves cache)

### Post-Deploy Requirement

After first deployment with USER node active, run on the host:
```bash
chown -R 1000:1000 /home/docker/gametracker/data/
```

---

---

# Mandatory Agent Review Process

**Every time work is done on this project — whether adding features, fixing bugs, refactoring, or deploying — the following three agents MUST be consulted and must give approval before the work is considered complete. Their sign-off is required before any deployment.**

---

## 1. CISO Agent — Security Review (Final Authority)

**Role**: Chief Information Security Officer. Has **final say** on all security-related decisions. No deployment may proceed without CISO approval.

**Invocation**: Launch the CISO agent to review any changes before merging or deploying.

**Scope of review**:
- Authentication and authorization logic (JWT handling, LDAP integration, bcrypt usage, rate limiting)
- Input validation and sanitization (SQL injection, XSS, command injection risks)
- Secret and credential management (`.env` handling, `settings.json` exposure, API keys)
- HTTP security headers (X-Frame-Options, CSP, CORS configuration)
- Dependency vulnerabilities (outdated packages, known CVEs)
- File and data access controls
- Docker security (image hardening, exposed ports, volume permissions)
- Any new API endpoints (authentication requirements, authorization checks)
- Any changes to user management or permissions logic

**The CISO agent must explicitly approve or reject the changes. If rejected, no deployment proceeds until issues are resolved.**

---

## 2. Architect Agent — Code Structure Review

**Role**: Software Architect. Ensures the codebase structure, patterns, and technical decisions remain sound, maintainable, and scalable.

**Invocation**: Launch the Architect agent to review architectural decisions and code organization.

**Scope of review**:
- Code organization and separation of concerns (backend routes, middleware, cron jobs)
- Frontend component structure and state management patterns
- Database schema changes and migration strategy
- API design consistency (endpoint naming, HTTP methods, response shapes)
- Introduction of new dependencies (necessity, size, maintenance status)
- Avoidance of code duplication and unnecessary abstractions
- Alignment with existing patterns in `index.js` and `App.jsx`
- Docker and deployment configuration changes
- Performance implications of changes (query patterns, caching, N+1 risks)

**The Architect agent must confirm the changes are architecturally sound before deployment.**

---

## 3. UI/UX Agent — Frontend Design Review

**Role**: UI/UX Design Authority. Ensures all frontend changes meet current design standards, usability expectations, and visual consistency.

**Invocation**: Launch the UI/UX agent to review any frontend changes.

**Scope of review**:
- Visual consistency with the existing glassmorphism dark theme and accent color system
- Responsiveness across desktop and mobile screen sizes
- Accessibility (color contrast ratios, keyboard navigation, ARIA attributes)
- User interaction patterns (loading states, empty states, error states, feedback mechanisms)
- Toast/notification UX consistency
- Form design and validation feedback
- Animation and transition appropriateness
- Alignment with modern web design standards (Material Design principles where applicable)
- Icon usage consistency (react-icons library)
- Any new pages, modals, or views must match the established visual language

**The UI/UX agent must approve any frontend changes before deployment.**

---

## Deployment Checklist

Before any production deployment:

- [ ] CISO agent has reviewed and **approved** all changes
- [ ] Architect agent has reviewed and **approved** all changes
- [ ] UI/UX agent has reviewed and **approved** all frontend changes (if applicable)
- [ ] Changes were first validated in **GameTracker-stg** (staging environment)
- [ ] Migration steps are documented in `GameTracker-stg/STAGING_CHANGELOG.txt`
- [ ] `.env` and `settings.json` are not committed to version control
      (both are gitignored; `settings.json` was leaked historically — see `SECURITY_HARDENING_2026-07.md` §9.1)
- [ ] Docker images build successfully
- [ ] Health check endpoint (`GET /api/health`) passes after deployment
