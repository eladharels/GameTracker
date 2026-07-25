# GameTracker

A self-hosted, multi-user web app for tracking games, their metadata, and your play status. Searches
IGDB, RAWG and TheGamesDB in one query, tracks Steam prices and DRM status, and sends release
reminders over email, ntfy, Gotify or Telegram. Dark glassmorphism UI, local or LDAP/AD accounts.

---

## Features

- **Multi-source search** — IGDB + RAWG + TheGamesDB queried together and deduplicated.
- **Personal library** — five statuses: `wishlist`, `playing`, `done`, `backlog`, `unreleased`.
- **Backlog ordering** — drag-and-drop queue with position badges.
- **Release notifications** — a daily job flips released games out of `unreleased` and sends reminders
  on each user's own schedule (default 0/7/30 days before release), with cover art.
- **Per-user notification channels** — each user configures their own email, ntfy server + topic,
  Gotify server + token and Telegram chat ID under **My Account**.
- **Steam pricing** — weekly sync for every library game with a Steam App ID.
- **CrackWatch / CrackRelease** — cached DRM status shown on library cards.
- **Library sharing** — share a read-only view of your library with specific users.
- **Admin panel** — user management, permissions, LDAP sync, API-key management, System Status.

---

## Quick Start (local development)

### 1. Clone and install

```bash
git clone https://github.com/yourusername/gametracker.git
cd gametracker
npm ci                      # backend
cd frontend && npm ci && cd ..
```

### 2. Configure environment

Create `.env` in the project root (same directory as `index.js`):

```env
IGDB_CLIENT_ID=your_igdb_client_id
IGDB_BEARER_TOKEN=your_igdb_bearer_token
RAWG_API_KEY=your_rawg_api_key
THEGAMESDB_API_KEY=optional_but_recommended

# REQUIRED. The backend refuses to start without it.
JWT_SECRET=at_least_16_characters_of_random_junk

# Optional
PORT=3000
ROOT_PASSWORD=            # password for the seeded `root` user on a FRESH database
CORS_ORIGINS=             # comma-separated cross-origin allowlist; empty for a same-origin deploy
TRUST_PROXY=1             # reverse-proxy hop count used by the login rate limiter
```

> **`JWT_SECRET` is mandatory.** The backend calls `process.exit(1)` at boot if it is missing, shorter
> than 16 characters, or set to the old `supersecretkey` default. Generate one with
> `openssl rand -base64 32`. Rotating it invalidates every existing session.

Then seed the runtime settings file:

```bash
cp settings.example.json settings.json
```

`settings.json` holds SMTP, LDAP and Telegram credentials and is **gitignored** — never commit it.
Everything in it is editable at runtime from **Settings** in the web UI (admin only).

### 3. Run

```bash
node index.js                 # backend on :3000
cd frontend && npm run dev    # frontend on :5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to `http://localhost:3000`; override
the backend address with `VITE_API_PROXY_TARGET` if it runs elsewhere.

### First login

On a **fresh database** a `root` administrator is created. If `ROOT_PASSWORD` is set it is used;
otherwise a random password is generated and **printed once** to the backend log at first boot. Log in
as `root`, then change it. There is no hardcoded default password.

---

## Docker

```bash
docker compose up --build
```

Backend on **3000** (bound to `127.0.0.1`), frontend on **8080**. The frontend image's nginx serves the
SPA *and* proxies `/api` to the backend container, so the stack is self-sufficient — if you also run an
external reverse proxy that routes `/api` itself, that takes precedence and this proxy is never reached.

Persistent state is bind-mounted from the host and must be writable by UID 1000 (the container's `node`
user). After the first deploy:

```bash
chown -R 1000:1000 /home/docker/gametracker/data/
```

`JWT_SECRET` is **not** defaulted in compose — the stack refuses to start without it.

---

## Authentication & authorization

- **Local accounts**: bcrypt-hashed passwords, minimum 8 characters.
- **LDAP / Active Directory**: search-then-bind, supporting `sAMAccountName` (AD) and `uid` (FreeIPA),
  with an optional required-group check. Falls back to local auth when the directory is unreachable.
  > Use `ldaps://`. A simple bind over plain `ldap://` sends every user password and the service-account
  > password in cleartext; the backend logs a warning at startup if you do.
- **JWT**, 12-hour expiry. Privilege is re-read from the database on every request, so revoking admin or
  deleting an account takes effect immediately rather than at token expiry.
- **Login throttling**: 5 failed attempts per IP *and* per account → 15-minute lockout.
- Every `/api/user/:username/*` route requires authentication **and** ownership (self, or an admin).

See [`SECURITY_HARDENING_2026-07.md`](SECURITY_HARDENING_2026-07.md) for the full endpoint
authentication matrix, threat history and operational runbook.

---

## API

All routes are under `/api`. Everything except `GET /api/health` and `POST /api/auth/login` requires an
`Authorization: Bearer <token>` header.

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness probe — returns `{"status":"ok"}` |
| `POST /api/auth/login` | none | Obtain a JWT (rate-limited) |
| `GET /api/games/search?q=` | auth | Unified IGDB + RAWG + TheGamesDB search |
| `GET /api/game-price/:steamAppId` | auth | Steam price lookup |
| `GET /api/user/:username/games` | auth + owner | List a library |
| `POST /api/user/:username/games` | auth + owner | Add a game / change status |
| `DELETE /api/user/:username/games/:gameId` | auth + owner | Remove a game |
| `PUT /api/user/:username/backlog-reorder` | auth + owner | Reorder the backlog |
| `POST /api/user/:username/refresh-metadata` | auth + owner | Refresh the whole library (slow) |
| `GET /api/user/me` · `PUT /api/user/me/settings` | auth | Own profile and notification settings |
| `GET /api/shared-libraries` · `/api/user/:username/share` | auth | Library sharing |
| `GET`/`POST /api/settings` | auth | Server settings — admin-only to write, secrets always masked |
| `GET`/`POST /api/settings/apikeys` | admin | API-key management (masked) |
| `GET /api/users` · `POST` · `PUT` · `DELETE /api/users/:id` | admin | User management |
| `GET /api/system-status` | admin | Live connectivity check for all external services |
| `POST /api/admin/check-releases` · `/ldap-sync` · `/refresh-crackwatch-cache` | admin | Manual jobs |

Unknown `/api/*` paths return a JSON 404.

---

## Scheduled jobs

| Schedule | Task |
|---|---|
| Daily 04:00 | Refresh the CrackWatch DRM-status cache |
| Daily 08:00 | Flip released games `unreleased` → `wishlist`; send release reminders |
| Mondays 03:00 | Refresh Steam prices for all library games with a Steam App ID |

---

## Utility scripts

| Script | Purpose |
|---|---|
| `create-local-admin.js` | Create a local admin from the CLI |
| `reset-root-password.js` | Reset the `root` password |
| `run_notifications.js` | Run the release-notification check manually (mirrors the 08:00 job) |
| `update_library_prices.js` | Trigger a Steam price update |
| `refresh_igdb_token.js` | Refresh the IGDB OAuth bearer token |
| `backfill_steam_app_ids.js` | Populate missing Steam App IDs |
| `backfill_ldap_display_names.js` | Sync display names from LDAP |
| `test_ldap_sync.js` | Debug the LDAP connection |

All honour `DB_PATH` so you can point them at the right `gametracker.db`.

---

## Development notes

- **Backend**: `index.js` — a single-file Express server (routes, cron jobs, notification senders).
- **Frontend**: `frontend/src/App.jsx` — React 18 + React Router 6, built with Vite.
- **Database**: SQLite. The schema is created and migrated at boot inside `initializeSchema()`.
- **Never commit** `.env`, `settings.json`, or `gametracker.db` — all three are gitignored, and CI runs
  Gitleaks over the full history.
- CI (`.github/workflows/docker-build-deploy.yml`) gates every push to `main` on Gitleaks, Semgrep,
  ESLint + Vite build, Trivy on both images, and a smoke test that exercises the real
  browser → nginx → backend request path.

---

## Contributing

Issues and pull requests welcome. Changes touching authentication, routes, secrets or Docker config
should say so explicitly in the PR description — see the review process in `CLAUDE.md`.

---

## License

MIT
