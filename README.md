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
BACKEND_BIND=0.0.0.0      # host interface the backend port is published on (Docker only)
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

Backend on **3000**, frontend on **8080**. The frontend image's nginx serves the SPA *and* proxies
`/api` to the backend container, so the stack is self-sufficient — if you also run an external reverse
proxy that routes `/api` itself, that takes precedence and this proxy is never reached.

See [Reverse proxy topology](#reverse-proxy-topology) below before changing how the backend port is
published — `BACKEND_BIND` and `TRUST_PROXY` have to move together.

Persistent state is bind-mounted from the host and must be writable by UID 1000 (the container's `node`
user). After the first deploy:

```bash
chown -R 1000:1000 /home/docker/gametracker/data/
```

`JWT_SECRET` is **not** defaulted in compose — the stack refuses to start without it.

### Reverse proxy topology

The frontend image is self-sufficient: its nginx serves the SPA **and** proxies `/api` to the backend
over the compose network. So a reverse proxy in front only needs **one** upstream — the frontend port.

Two compose variables control how the backend is exposed:

| Variable | Default | Meaning |
|---|---|---|
| `BACKEND_BIND` | `0.0.0.0` | Host interface the backend port is published on |
| `TRUST_PROXY` | `1` | Number of reverse-proxy hops in front of the backend |

**If your reverse proxy runs on another machine** and points at the backend port directly, leave
`BACKEND_BIND=0.0.0.0` — a loopback bind would make the API unreachable.

> **Security note.** On `0.0.0.0` the backend is reachable directly, bypassing nginx. Because
> `trust proxy` is enabled, a client connecting straight to that port controls `X-Forwarded-For` and can
> present a fresh IP on every login attempt — walking straight through the rate limiter.

**The hardened topology** removes that exposure entirely — point the proxy at the frontend port for
everything, so the backend needs no published port at all:

1. Deploy as-is and confirm `curl http://<host>:8080/api/health` returns `{"status":"ok"}`.
2. Repoint the reverse proxy: send **all** paths to the frontend port. Delete any `/api` → backend rule.
3. Verify the site works end to end.
4. Set `BACKEND_BIND=127.0.0.1` (or remove the backend's `ports:` entry) **and set `TRUST_PROXY=2`**.

> Step 4's `TRUST_PROXY` change is **mandatory**, not optional. Routing through the frontend adds a
> second proxy hop. Left at `1`, `req.ip` resolves to the frontend container's address, so every failed
> login in the world shares one bucket — five bad passwords from anyone locks out **every** user for
> 15 minutes.

---

## Authentication & authorization

- **Local accounts**: bcrypt-hashed passwords, minimum 8 characters.
- **LDAP / Active Directory**: search-then-bind, supporting `sAMAccountName` (AD) and `uid` (FreeIPA),
  with an optional required-group check. Falls back to local auth when the directory is unreachable.
  > Use `ldaps://`. A simple bind over plain `ldap://` sends every user password and the service-account
  > password in cleartext; the backend logs a warning at startup if you do.
  >
  > **The LDAP base must not span a compatibility tree.** A username that matches more than one
  > directory entry is **refused** — binding as an arbitrarily chosen match is an authentication bug.
  > FreeIPA's Schema Compatibility plugin republishes every account under `cn=compat`, so a base of
  > `dc=example,dc=com` returns each user *twice* and **no LDAP user can log in**. Point the base at the
  > accounts subtree instead:
  >
  > ```
  > ldap.base = cn=accounts,dc=example,dc=com     ✅
  > ldap.base = dc=example,dc=com                 ❌ spans cn=compat
  > ```
  >
  > This is deliberately **not** resolved automatically. Two attempts to detect and drop the duplicate
  > from the DN were both authentication bypasses: a DN is a name, not evidence, and anyone who can
  > create a directory entry can forge whatever shape the code treats as proof. When a refusal is caused
  > by a compat tree the backend logs the remediation, so the failure explains itself.
  >
  > *Known limitation:* under a narrowed base, FreeIPA users that exist **only** under `cn=compat`
  > (trusted-domain accounts from an AD trust) are out of scope and cannot log in. Supporting them needs
  > a directory-data identity check (`ipaUniqueID`/`entryUUID`), not a DN heuristic — refusing is the
  > safe default until someone needs it.
- **JWT**, 12-hour expiry. Privilege is re-read from the database on every request, so revoking admin or
  deleting an account takes effect immediately rather than at token expiry.
- **Login throttling**: 5 failed attempts per IP *and* per account → 15-minute lockout.
- Every `/api/user/:username/*` route requires authentication **and** ownership (self, or an admin).

### Personal access tokens

For scripts, the terminal, and anything non-interactive — so nothing has to store your
password. A token is an ordinary bearer credential on the same header a browser session uses.

```bash
docker compose -f docker-compose.yaml exec backend \
  node create-api-token.js <username> "laptop cli" library

curl -H "Authorization: Bearer gt_pat_..." https://your-host/api/user/me/games
```

**The token is printed once and cannot be recovered.** Only its SHA-256 hash is stored, so a
database dump yields no working credentials — and neither the API nor the script can show it
to you again. Lost it? Revoke and mint another. It goes to stdout alone, so
`... > token.txt` captures exactly the secret and nothing else.

**Scopes are `library` and `admin`, and they only ever NARROW what the account can already
do.** A `library`-scoped token held by an administrator is *not* an administrator — it gets
403 on every admin route. An `admin`-scoped token held by a non-admin does not become one; a
scope filters privilege, it never grants it. Grant `admin` only to something that genuinely
needs to manage users or read API keys — an MCP server tending your library does not.

> `library` is a slight misnomer worth knowing about: it means *everything that is not
> admin*, not "read-only" and not "only the library". A `library` token can still change its
> own account's notification settings and share its library with another user. What it
> cannot do is manage users or read server configuration and API keys.

**Revoking is deleting the row**, which is the whole reason tokens are looked up rather than
self-describing: unlike a session JWT, revoking one does not mean rotating `JWT_SECRET` and
signing out the web app and the phone as well.

```bash
node create-api-token.js <username> --list
node create-api-token.js <username> --revoke <token-id>
```

Privilege is re-read from the database on every request, so demoting or deleting an account
takes effect on its tokens immediately, and deleting a user removes their tokens with it.
`--expires-in-days N` adds an optional expiry, but the safety mechanism is revocation, not
expiry.

Password login and its 12-hour JWT are unchanged, and the login rate limiter does not apply
to token authentication — five retries from a script would otherwise lock you out of your own
instance for 15 minutes.

See [`SECURITY_HARDENING_2026-07.md`](SECURITY_HARDENING_2026-07.md) for the full endpoint
authentication matrix, threat history and operational runbook.

---

## API

All routes are under `/api`. Everything except `GET /api/health` and `POST /api/auth/login` requires an
`Authorization: Bearer <token>` header — either a 12-hour session JWT from `POST /api/auth/login`,
or a personal access token (see above).

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
| `create-api-token.js` | Mint / list / revoke personal access tokens |
| `reset-root-password.js` | Reset the `root` password |
| `run_notifications.js` | Run the release-notification check manually (mirrors the 08:00 job) |
| `update_library_prices.js` | Trigger a Steam price update |
| `refresh_igdb_token.js` | Refresh the IGDB OAuth bearer token |
| `backfill_steam_app_ids.js` | Populate missing Steam App IDs |
| `backfill_ldap_display_names.js` | Sync display names from LDAP |
| `test_ldap_sync.js` | Debug the LDAP connection |

Only `reset-root-password.js` and `run_notifications.js` are ported to PostgreSQL; run them inside
the backend container so the `PG*` variables are already set. The remaining scripts still target the
old SQLite file and now **exit 1 with a clear message** rather than silently creating an empty
database — port them to `./db` (see `reset-root-password.js` for a worked example) before use.
`DB_PATH` no longer applies.

---

## Development notes

- **Backend**: `index.js` — a single-file Express server (routes, cron jobs, notification senders).
- **Frontend**: `frontend/src/App.jsx` — React 18 + React Router 6, built with Vite.
- **Database**: PostgreSQL 16, in its own `postgres-gametracker` container on the compose network.
  The connection lives in `db.js`; the schema is applied at boot by `schema-migrate.js` from the
  ordered files in `migrations/`, inside a transaction, tracked in a `schema_migrations` table.
  **A migration failure is fatal — the backend will not start against an unverified schema.**
  To change the schema, add a new numbered file in `migrations/`; never edit an applied one.
- **Migrating from the old SQLite build**: `scripts/migrate-sqlite-to-postgres.js`, run manually.
  See `PRODUCTION_CHANGELOG.txt` for the full cutover, rollback and backup procedure.
- **Never commit** `.env`, `settings.json`, or `gametracker.db` — all three are gitignored, and CI runs
  Gitleaks over the full history.
- **Backups**: `docker exec postgres-gametracker pg_dump -U gametracker -Fc gametracker > file.dump`.
  Note that `docker compose down --volumes` deletes the `gametracker-pgdata` volume — never pass
  `--volumes` against the production stack.
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
