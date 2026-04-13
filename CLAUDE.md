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
- **Push Notifications**: ntfy.sh webhooks
- **Scheduling**: node-cron (release checks daily at 8 AM, price updates Mondays at 3 AM)
- **HTTP client**: Axios (for external API calls)
- **Entry point**: `index.js` (~2800 lines — monolithic Express server)

### Frontend
- **Framework**: React 18 with React Router 6
- **Build tool**: Vite 5
- **HTTP client**: Axios
- **Icons**: react-icons
- **Styling**: Custom CSS with glassmorphism dark theme, accent color support
- **Entry point**: `frontend/src/App.jsx` (~1700 lines — single large component)

### Infrastructure
- **Containerization**: Docker + docker-compose
- **Backend port**: 3000
- **Frontend port**: 8080 (Docker), 5173 (Vite dev server)
- **Persistent volumes**: SQLite database, settings.json, sent_notifications.json

> **Dockerfile layer order (critical):** The backend `Dockerfile` must install system build tools (`python3`, `make`, `g++`, `sqlite3`) **before** running `npm install --production`. The `sqlite3` package has no prebuilt NAPI binary for the `node:18-slim` image and compiles from source via `node-gyp`, which requires Python3. Wrong order → build failure.

---

## Architecture

```
GameTracker/
├── index.js                        # Backend: Express server + all API routes + cron jobs
├── package.json                    # Backend dependencies
├── Dockerfile                      # Backend image (node:18-slim)
├── docker-compose.yaml             # Production orchestration
├── docker-compose.staging.yaml     # Staging orchestration
├── .env                            # API credentials (gitignored)
├── settings.json                   # SMTP / LDAP / ntfy runtime config
├── gametracker.db                  # SQLite database (gitignored)
├── sent_notifications.json         # Notification deduplication log
├── frontend/
│   ├── src/
│   │   ├── App.jsx                 # Main React app (all pages/views in one file)
│   │   ├── App.css                 # Global styles (glassmorphism theme)
│   │   ├── main.jsx                # React entry point
│   │   ├── contexts/
│   │   │   └── ToastContext.jsx    # Global toast notification context
│   │   └── styles/
│   │       └── Toast.css
│   ├── vite.config.js
│   ├── package.json
│   └── Dockerfile                  # Frontend image (multi-stage: Node build → Nginx)
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
- **File-based config**: Runtime settings (SMTP, LDAP, ntfy) stored in `settings.json`
- **Stateless API**: JWT-based authentication — no server-side session state

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
| ntfy_topic | TEXT | User-specific ntfy topic (personal, set in My Account) |
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
| **IGDB** (igdb.com) | Primary game search + metadata | `IGDB_CLIENT_ID` + `IGDB_BEARER_TOKEN` (Twitch Dev) |
| **RAWG.io** | Secondary game search + metadata | `RAWG_API_KEY` |
| **TheGamesDB** | Tertiary game source + box art | `THEGAMESDB_API_KEY` (optional) |
| **Steam Store API** | Game pricing by region | No auth (public) |
| **SMTP** | Email notifications | Configured in `settings.json` |
| **ntfy.sh** | Push notifications | Server URL in `settings.json`; per-user topic in `users.ntfy_topic` |
| **Gotify** | Self-hosted push notifications | Server URL in `settings.json`; per-user token in `users.gotify_token` |
| **Telegram Bot API** | Push notifications via Telegram | Bot token in `settings.json`; per-user chat ID in `users.telegram_chat_id` |
| **LDAP/Active Directory** | Enterprise authentication | Bind DN + password in `settings.json` |

---

## Authentication & Security

- **Local auth**: bcrypt-hashed passwords stored in SQLite
- **LDAP auth**: Supports Active Directory (`sAMAccountName`) and FreeIPA (`uid`); falls back to local auth on failure
- **JWT tokens**: 12-hour expiry, signed with `JWT_SECRET`
- **Rate limiting**: 5 failed login attempts → 15-minute IP lockout
- **Security headers**: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy
- **Default root credentials**: username `root`, password `Qq123456` (change immediately on first run)

---

## Key Features

- **Multi-source game search**: Queries IGDB, RAWG, and TheGamesDB simultaneously; deduplicates results
- **Personal game library**: Track games with statuses — wishlist, playing, done, backlog, unreleased
- **Backlog ordering**: Drag-and-drop reordering for the backlog queue with position badges
- **Steam pricing**: Weekly price sync for all library games with Steam App IDs
- **Release notifications**: Daily cron checks; sends reminders per user-configured schedule (default 0/7/30 days) via email, ntfy, and Gotify, with game cover images
- **Gotify push notifications**: Self-hosted push support; server URL in Settings, per-user token in My Account
- **Telegram push notifications**: Bot-based push support; bot token in Settings, per-user chat ID in My Account; cover images via sendPhoto
- **Library sharing**: Share your game library (read-only) with specific other users
- **Admin panel**: Create/edit/delete users, manage permissions, LDAP sync
- **Metadata refresh**: Manual and automatic refresh of game info from source APIs
- **My Account page**: Per-user notification channels (email, ntfy topic, Gotify token) and reminder schedule
- **Settings page**: Server infrastructure only — SMTP, ntfy server URL, Gotify server URL, LDAP

---

## Environment Configuration

### `.env` (Required)
```env
IGDB_CLIENT_ID=<twitch_client_id>
IGDB_BEARER_TOKEN=<twitch_bearer_token>
RAWG_API_KEY=<rawg_api_key>
THEGAMESDB_API_KEY=<optional>
JWT_SECRET=<strong_random_secret>
PORT=3000
NODE_ENV=production
```

### `settings.json` (Runtime, managed via Admin UI)
```json
{
  "smtp": { "host": "", "port": 587, "user": "", "pass": "", "from": "", "to": "" },
  "ntfy": { "url": "https://ntfy.sh" },
  "gotify": { "url": "" },
  "telegram": { "bot_token": "" },
  "ldap": { "url": "", "base": "", "bindDn": "", "bindPass": "", "requiredGroup": "" }
}
```

---

## Scheduled Tasks (Cron Jobs)

| Schedule | Task |
|---|---|
| Daily at 8:00 AM | Check released games; update status `unreleased → wishlist`; send release notifications and reminders (30d, 7d, 0d) |
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
- [ ] Docker images build successfully
- [ ] Health check endpoint (`GET /api/health`) passes after deployment
