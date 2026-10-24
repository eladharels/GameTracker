# GameTracker Mobile — CLAUDE.md

## Project Overview

GameTracker Mobile is the **native Android companion app** for the GameTracker platform. Written in Kotlin using Jetpack components, it allows users to search for games, manage their personal library, and track play status — all connected to the GameTracker backend REST API.

---

## Tech Stack

- **Language**: Kotlin
- **Platform**: Android (Native)
- **Minimum SDK**: API 24 (Android 7.0 Nougat)
- **Target / Compile SDK**: API 36 (Android 16)
- **JVM Target**: Java 11
- **Build System**: Gradle with Kotlin DSL (`build.gradle.kts`)
- **UI Framework**: XML layouts and Fragments. No Compose: the theme files are deleted (MOB-22) and the
  plugin and dependencies go with MOB-21

### Key Libraries
Versions live in `gradle/libs.versions.toml` (MOB-21), the one place to read them; Dependabot
proposes bumps (`.github/dependabot.yml`). No Compose and no kapt.

| Library | Purpose |
|---|---|
| Retrofit + converter-gson | HTTP client / REST API calls; Gson binds `models.kt` by field name |
| OkHttp logging-interceptor | HTTP logging in **debug builds only**, at BASIC (no headers or bodies). Release builds have none (MOB-1) |
| Kotlin Coroutines | Async work, scoped to the view (MOB-17) |
| Glide | Image loading and caching (no annotation processor: there is no AppGlideModule) |
| AndroidX Biometric | The fingerprint prompt, always with a CryptoObject (MOB-6) |
| Material Components | UI components and theming |
| SwipeRefreshLayout, RecyclerView, Fragment KTX | Lists, pull-to-refresh, fragments |

---|---|---|
| Retrofit | 2.9.0 | HTTP client / REST API calls |
| OkHttp3 + Logging Interceptor | 4.11.0 | HTTP logging in **debug builds only**, at BASIC (no headers or bodies). Release builds have none (MOB-1) |
| Gson | — | JSON serialization/deserialization |
| Kotlin Coroutines | 1.6.4 | Async/non-blocking operations |
| Glide | 4.15.1 | Image loading and caching |
| AndroidX Biometric | — | Fingerprint / biometric authentication |
| Material 3 | — | UI components and theming |
| SwipeRefreshLayout | 1.1.0 | Pull-to-refresh |
| Fragment KTX | 1.6.2 | Fragment extensions and lifecycle |

---

## Architecture

### Pattern
**Single Activity + Multiple Fragments** with bottom navigation. `MainActivity` hosts all fragments and manages navigation. The legacy activities (`GameDetailsActivity`, `GameSearchActivity`, `MyLibraryActivity`) were never in the manifest and were deleted with MOB-17.

### Project Structure
```
mobile/                                       # inside the GameTracker repo (was ../GameTracker-mobile/)
├── app/
│   ├── src/main/
│   │   ├── java/ink/etech/gametracker/
│   │   │   ├── ApiClient.kt                  # Retrofit singleton; buildClient(BuildConfig.DEBUG)
│   │   │   ├── SessionStore.kt               # The session: token (IN MEMORY only), its sealed copy,
│   │   │   │                                 #   username, JWT exp, "ended" signal (MOB-6)
│   │   │   ├── TokenVault.kt                 # The Keystore key that seals the token: AES-256-GCM,
│   │   │   │                                 #   strong biometric per use, invalidated by a new
│   │   │   │                                 #   fingerprint (MOB-6)
│   │   │   ├── FingerprintUnlock.kt          # The ONE place fingerprint unlock is turned on/off/used,
│   │   │   │                                 #   and CryptoPrompt: the only BiometricPrompt, always
│   │   │   │                                 #   with a CryptoObject (MOB-6)
│   │   │   ├── MobileToken.kt                # The phone's 30-day library token: name, expiry, request
│   │   │   ├── MobileTokenApi.kt             #   and its mint/revoke calls, the only ones (MOB-9)
│   │   │   ├── SessionExpiryInterceptor.kt   # A 401 for the CURRENT token ends the session (MOB-5)
│   │   │   ├── GameTrackerApp.kt             # Application: initialises ApiClient
│   │   │   ├── GameTrackerApi.kt             # Retrofit API interface (all endpoints)
│   │   │   ├── models.kt                     # All data classes (Game, LoginRequest, etc.)
│   │   │   ├── GameAdapter.kt                # RecyclerView adapter for game lists
│   │   │   ├── LibraryMatch.kt               # "Already in the library?" — the THIRD copy of the
│   │   │   │                                 #   server's rule, held equal by the shared vectors
│   │   │   │                                 #   (MOB-10). Search never adds an owned game
│   │   │   ├── PendingRemovals.kt            # Undoable removals, sent from a process-lifetime
│   │   │   │                                 #   scope, never from a view callback (MOB-12)
│   │   │   ├── GameExtras.kt                 # Rating + note, stored on THIS DEVICE only. Nothing
│   │   │   │                                 #   may be derived from a hash of the id (MOB-11)
│   │   │   ├── UserData.kt                   # ONE account's on-phone data (MOB-7): notes, ratings,
│   │   │   │                                 #   search history; calendar settings in calendar.xml
│   │   │   │                                 #   (never backed up). Kept at sign-out (owner's call);
│   │   │   │                                 #   Profile -> "Remove my data from this phone" deletes it
│   │   │   ├── SignOut.kt                    # The ONE sign-out: ends the session, asks whether to
│   │   │   │                                 #   remove the account's calendar events
│   │   │   ├── LoginActivity.kt              # Entry point — auth screen
│   │   │   ├── MainActivity.kt               # Main container — hosts all fragments
│   │   │   ├── GameStatus.kt                 # The five statuses, the four a user may PICK, and
│   │   │   │                                 #   what the server says it stored (MOB-13)
│   │   │   ├── BacklogOrder.kt               # The backlog's order, positions and the one
│   │   │   │                                 #   whole-order request (MOB-14)
│   │   │   ├── SearchResults.kt              # Found / empty / failed-and-why (MOB-15)
│   │   │   ├── LibraryAdd.kt                 # THE add: fresh library, match, then post (MOB-10/16)
│   │   │   ├── LibraryCache.kt               # The one library copy's rules (MOB-19, JVM-tested)
│   │   │   ├── LibraryRepository.kt          #   and its wiring to the API: the only getLibrary
│   │   │   ├── LibraryWriteInterceptor.kt    # Every non-GET drops the copy (MOB-19)
│   │   │   ├── HomeAdapters.kt, CoverBinder.kt, DonutView.kt, ThemeManager.kt, SnackbarHelper.kt,
│   │   │   │   CalendarHelper.kt             # Home lists, covers, the Insights donut, accent
│   │   │   │                                 #   presets, snackbars, calendar sync
│   │   │   ├── fragments/
│   │   │   │   ├── HomeFragment.kt           # Greeting, now playing, up next, shortcuts
│   │   │   │   ├── SearchFragment.kt         # "Discover": catalog search
│   │   │   │   ├── LibraryFragment.kt        # User library management
│   │   │   │   ├── InsightsFragment.kt       # Counts and completion, from the library
│   │   │   │   ├── ProfileFragment.kt        # User profile + stats + settings
│   │   │   │   └── GameDetailsFragment.kt    # Game details, opened over the tab (MOB-19)
│   │   │   └── SafeUrl.kt                    # https-only gate for every server-supplied image URL
│   │   │                                     #   (MOB-8; twin of the web's safeUrl.js)
│   │   ├── res/
│   │   │   ├── layout/                       # XML layouts for all screens
│   │   │   ├── values/                       # Colors, strings, themes
│   │   │   ├── menu/                         # The bottom navigation (the toolbar menu is gone, MOB-22)
│   │   │   ├── drawable/                     # Icons and drawables
│   │   │   └── anim/                         # Slide transition animations
│   │   └── AndroidManifest.xml
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── build.gradle.kts                          # Root build config
├── settings.gradle.kts
├── gradle.properties
├── README.md
├── SECURITY_FIXES.md
└── UI_UX_IMPROVEMENTS.md
```

---

## Backend Connection

- **Base URL**: `BuildConfig.API_BASE`, per build type (MOB-23). Release is always
  `https://gametracker.etech.ink/api/` and no property changes it. Debug takes
  `-PgtDebugApiBase=https://<staging>/api/` (or `gtDebugApiBase` in `~/.gradle/gradle.properties`)
  and falls back to production only when none is set. https only, ending in `/api/`, or the
  build fails
- **Protocol**: HTTPS
- **Auth**: Bearer Token in `Authorization` header (held in memory; sealed by the Keystore when
  fingerprint unlock is on, MOB-6)
- **Data format**: JSON (Gson)

### API Endpoints Used by the App

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/login` | User login |
| GET | `/games/search?q=` | Search games |
| GET | `/user/{username}/games` | Fetch user's game library |
| POST | `/user/{username}/games` | Add / update game in library |
| DELETE | `/user/{username}/games/{gameId}` | Remove game from library |
| PUT | `/user/{username}/backlog-reorder` | The whole backlog order in one call, one transaction (MOB-14) |
| POST | `/user/{username}/games/{gameId}/refresh-metadata` | Refresh game info |
| GET | `/user/me` | After fingerprint unlock: does the stored session still work? (MOB-5) |
| POST | `/user/me/tokens` | Mint this phone's 30-day library token at a password sign-in (MOB-9) |
| DELETE | `/user/me/tokens/{tokenId}` | Revoke it, by its own id only (sign-out, or the next sign-in) |

> **This table is enforced.** The app is the v1 client the backend's freeze protects, and it
> lives in the same repo. `test/api-surface.test.js` fails if a route in `GameTrackerApi.kt` is
> not a live v1 route at a tier the app can reach. `test/api-contract.test.js` fails if a field
> in `models.kt` is not in a pinned response. Adding an endpoint or a field here means adding it
> to the backend's pins first. The gate reads `mobile/api-contract.json`, which `ApiContractTest`
> writes by reflection (MOB-25) and fails on when stale: after changing the API or a model, run
> the unit tests with `GT_WRITE_CONTRACT=1` and commit the diff. `@SerializedName`, `@JsonAdapter`,
> `@HTTP` and `@Url` are refused: keep Kotlin names equal to wire names.

---

## Navigation Structure

```
LoginActivity  (LAUNCHER — entry point)
    ↓ on successful login
MainActivity  (single activity host)
    ├── Bottom Navigation (5 tabs):
    │   ├── Home            → HomeFragment
    │   ├── Discover        → SearchFragment
    │   ├── Library         → LibraryFragment
    │   ├── Insights        → InsightsFragment
    │   └── Profile         → ProfileFragment
    │
    ├── SearchFragment
    │   ├── Search bar with 400ms debounce
    │   ├── RecyclerView of results (GameAdapter)
    │   └── Tap game → GameDetailsFragment (back stack)
    │
    ├── LibraryFragment
    │   ├── Status filter chips (All, Wishlist, Playing, Done, Backlog, Unreleased)
    │   ├── In-library search bar
    │   ├── Statistics header (total, playing, completed, backlog counts)
    │   ├── RecyclerView (GameAdapter) with pull-to-refresh
    │   ├── Long-press game → Bottom Sheet status selector
    │   ├── Drag-to-reorder (Backlog status only)
    │   └── Tap game → GameDetailsFragment (back stack)
    │
    ├── ProfileFragment
    │   ├── Username display
    │   ├── Library stats cards
    │   ├── Biometric login toggle
    │   └── Logout → LoginActivity
    │
    └── GameDetailsFragment  (pushed onto back stack)
        ├── Cover image (Glide)
        ├── Title, release date, price
        ├── Status chips (Wishlist, Backlog, Playing, Done; Unreleased is shown, never picked)
        ├── Rating and notes (this phone only), Refresh metadata
        ├── Remove from library (asks first)
        └── For a game NOT in the library: only "Add to library" (MOB-16)
```

---

## Authentication

### Login Flow
1. User enters username + password in `LoginActivity`
2. `LoginInput`: the username is trimmed and lowercased; the password is sent as typed and only
   has to be non-empty (MOB-34)
3. `POST /auth/login` with `LoginRequest`
4. On success: the token is held IN MEMORY by `SessionStore`; only the username goes to the
   `"auth"` prefs. With fingerprint unlock on, one fingerprint prompt seals the new token
   (cancelling it turns fingerprint unlock off, with a toast saying where to turn it back on)
5. Navigate to `MainActivity`. It is **not exported** (MOB-2); it checks for a live session in
   `onCreate`/`onResume` and sends the user to login without one.
6. **MOB-9:** with fingerprint unlock on, the JWT is swapped for this phone's **30-day library
   token** (`MobileToken`), sealed by the same prompt. If the prompt doesn't seal it, it is
   revoked and the JWT stays. If the mint fails, the JWT stays and a toast says so. Sign-out
   revokes it. Turning fingerprint unlock off signs out, after a confirmation.
7. The JWT lasts **12 hours**. A 401 answering the CURRENT token ends the session
   (`SessionExpiryInterceptor`), and the visible activity shows login with a neutral
   "Your session expired" notice. Not on a network failure: offline is not signed out.

### Biometric (Fingerprint) Login (MOB-6: the fingerprint decrypts the session)
- `TokenVault` holds an AES-256-GCM key in the Android Keystore (StrongBox where available):
  `setUserAuthenticationRequired(true)`, per-use STRONG biometric (`setUserAuthenticationParameters(0,
  AUTH_BIOMETRIC_STRONG)`, `-1` validity below API 30), `setInvalidatedByBiometricEnrollment(true)`.
- Turning it on (the Profile switch, or after a password sign-in) runs a
  `BiometricPrompt` with an ENCRYPT `CryptoObject` and stores only the ciphertext, IV and the
  token's `exp` (`token_sealed_*_v1` in `"auth"` prefs).
- On `LoginActivity` load: prompt ONLY if fingerprint unlock is on AND a sealed copy exists
  whose `exp` is still live (60 s skew). The prompt's authorised cipher DECRYPTS the token;
  nothing else can. Then "Checking session…", `GET /user/me`: 401 means expired, a network
  failure lets the user in with an offline notice.
- A newly enrolled fingerprint invalidates the key: the sealed copy is dropped, unlock turns
  off, and the login screen says to sign in with the password and turn it on again.
- Any fingerprint enrolled on the phone unlocks the app (inherent to Android biometrics); the
  confirmation text says so.
- `CryptoPrompt` (in `FingerprintUnlock.kt`) is the only `BiometricPrompt` in the app, and it
  always passes a `CryptoObject`. `test/runtime.test.js` pins that, the key's parameters, and
  that nothing outside `SessionStore` touches the old plaintext `"token"` key.
- No `EncryptedSharedPreferences`: deprecated, and not bound to the biometric.

### Token Storage
- **Never on disk in the clear.** In memory for the life of the process; with fingerprint
  unlock on, a SEALED copy (above). With it off, nothing survives the process: after Android
  kills the app, the password is needed again.
- Sent as `Authorization: Bearer <token>` on all authenticated requests. Screens read it from
  `Session.get(context).token`, never from preferences.
- Updating from a version that stored `"token"` in the clear: `SessionStore.migrateLegacyToken`
  deletes it from disk on first start and keeps it in memory. With fingerprint unlock on, the
  first prompt seals it, and cancelling that prompt ends the session.
- **Always** cleared on logout and on a 401 (MOB-3, MOB-5), including the sealed copy. The
  username (to prefill) and the fingerprint setting stay.
- **Never backed up**: `auth.xml` is excluded from Auto Backup and from both Android 12+
  sections, including device-to-device transfer (MOB-4).

---

## State Management

- **The library: `LibraryRepository`** (MOB-19), the ONLY caller of `getLibrary`. One copy in
  memory, keyed by the credential, served for 30 s; `force = true` for pull-to-refresh and for
  the add-time duplicate check (MOB-10). EVERY non-GET request drops it
  (`LibraryWriteInterceptor`, in `ApiClient`; JVM-tested), so a new write path cannot forget to.
  Cleared at sign-out. The rules are `LibraryCache`, JVM-tested.
- **Tabs are shown and hidden, never replaced** (MOB-19, `MainActivity.loadFragmentForTab`): each
  keeps its scroll, filter and search text. A tab reloads in `onHiddenChanged(false)` and in
  `onResume` only when not hidden. Game Details opens with `MainActivity.openDetails`, which
  hides the tab (Back shows it again). No fragment calls `.replace(R.id.fragment_container)`.
- **No ViewModel/LiveData.** Deliberate, for now: with tabs kept and one library copy, a
  ViewModel would add no behaviour. What it would still buy is state across a configuration
  change; the FragmentManager restores the tabs, but not their in-memory lists (they re-read
  the copy).
- **Session values: `Session.get(ctx)`** (`token`, `username`, `bearer()`). No screen reads the
  `"auth"` preferences itself (pinned in `test/runtime.test.js`)
- **Auth state**: the token in memory (`SessionStore`); username, biometric flag and the sealed
  copy in SharedPreferences
- **Per-account local data**: `UserData` (MOB-7). Never a device-wide key: the next account
  on the phone must not see it. Device-wide prefs (`app_prefs`) hold only display settings
- **Network calls** (MOB-17): `lifecycleScope` in activities; `viewLifecycleOwner.lifecycleScope`
  in fragments for anything that touches a view. The fragment's own `lifecycleScope` only for
  work that must outlive the view, marked `// outlives the view: <why>`. No `CoroutineScope(...)`
  except `PendingRemovals`' process scope. All pinned in `test/runtime.test.js`
- **State reload**: tabs re-read the shared library copy when shown (MOB-19); nothing is cached on disk

---

## Design System

### Color Palette
`res/values/colors.xml` is the source; this is a summary of it, not a second copy. Screens are
`gt_surface_1` `#111218`, cards `gt_surface_2`/`gt_card`, body text `gt_text_primary` `#F0F1F8`,
secondary text `gt_text_secondary` `#8890A8`. The accent is one of the web's six presets (`ThemeManager`, Violet default), not
a fixed colour. Status colours are `gt_status_*`, the web's `--color-status-*` (MOB-33). Contrast rules: MOB-29 in `mobile/ROADMAP.md`.

### UI Patterns
- Material Design 3 components throughout
- Dark-first theme
- Snackbar for feedback; a dialog only to confirm something that cannot be undone (Remove, sign-out)
- Loading progress indicators on async operations
- Empty state messages with guidance
- Slide animations (200ms) on fragment transitions (`slide_in_right`, `slide_out_left`)

---

## Key Features

- **Game Search**: Debounced search-as-you-type (400ms), results with cover art
- **Library Management**: Filter by status, in-library search, pull-to-refresh, stats header
- **Backlog Ordering**: Drag-to-reorder games in the backlog queue
- **Game Details**: Status change, metadata refresh, remove from library
- **Biometric Login**: Fingerprint authentication using Android BiometricPrompt
- **Profile**: Stats overview and biometric toggle

---

## Security Notes (from `SECURITY_FIXES.md`)

- Client-side validation prevents empty credential submission
- Input trimming and whitespace rejection on login
- Login button disabled during active request (prevents rapid submissions)
- Username normalized to lowercase before sending
- HTTPS enforced via hardcoded base URL
- The token is never stored in the clear: in memory, or sealed by a biometric-bound Keystore key
  (MOB-6). The preferences file is also excluded from backups (MOB-4).
- Release builds do not log HTTP at all; debug logs only the request line and status (MOB-1)
- Only the launcher activity is exported (MOB-2; pinned by the root `test/runtime.test.js`)

The full list of known problems, with severities, is **`mobile/ROADMAP.md`** (MOB-1 to MOB-35).

## CI

`.github/workflows/android.yml` builds every change under `mobile/`: `testDebugUnitTest`,
`testReleaseUnitTest`, `lintDebug` (against `app/lint-baseline.xml`, so only NEW findings fail)
and `assembleRelease`. It runs in a pinned container on the self-hosted runner, which is the
production host. Every download is pinned, and dependencies are verified strictly against
`gradle/verification-metadata.xml`.

**Distribution (MOB-40).** On a push to `main`, the job signs the release APK with the key in the
`android-release` GitHub environment and publishes it as the ONE file served at
`https://gametracker.etech.ink/download/gametracker.apk`. The key never enters the Gradle
container. `versionCode` is the workflow run number, so each publish installs as an update.
With no key configured, nothing is published. Setup: the root `OPERATOR_RUNBOOK.md`.

**Adding or upgrading a dependency means regenerating `verification-metadata.xml` in the same PR.** Otherwise the
build fails verification.

**Regenerate it with an EMPTY Gradle home**, for example
`GRADLE_USER_HOME=$(mktemp -d) ./gradlew --write-verification-metadata sha256 testDebugUnitTest
testReleaseUnitTest lintDebug assembleRelease`. A warm cache serves parent POMs and Gradle module
files from its cached resolution metadata, so they are never fetched and never recorded. The first
file (PR #6) missed three that way, and `main`'s first cold build refused them (PR #7). Review the
diff: a regeneration only ADDS entries. A changed checksum is a stop sign, not an update.

---

## Known Technical Debt

- (Fixed, MOB-20.) The app id and package are `ink.etech.gametracker`; the theme is
  `Theme.GameTracker`. The old `com.example.gmaetrackermobile` is a DIFFERENT app to Android:
  a phone that had it must uninstall it and install the new one once. Its on-phone notes and
  ratings do not carry over. Never change the id again: every later change is that again
- No ViewModel/LiveData (see State Management: tabs are kept and the library is cached, MOB-19)

---

---

# Mandatory Agent Review Process

**Every time work is done on this project — whether adding features, fixing bugs, refactoring, or deploying a new APK/release — the following three agents MUST be consulted and must give approval before the work is considered complete or released.**

---

## 1. CISO Agent — Security Review (Final Authority)

**Role**: Chief Information Security Officer. Has **final say** on all security-related decisions. No release or deployment may proceed without CISO approval.

**Invocation**: Launch the CISO agent to review any changes before releasing.

**Scope of review**:
- Authentication logic (BiometricPrompt implementation, token storage, login flow)
- Credential storage security (SharedPreferences usage — consider EncryptedSharedPreferences)
- Network security (certificate pinning, HTTPS enforcement, logging interceptor in production)
- Input validation and sanitization (login fields, search inputs)
- Permissions in `AndroidManifest.xml` (INTERNET, USE_BIOMETRIC — are any new ones appropriate?)
- Sensitive data handling (tokens, usernames — not logged, not in crash reports)
- ProGuard / R8 rules for release builds (obfuscation, reflection)
- Dependency vulnerabilities (Retrofit, OkHttp, Glide — known CVEs)
- Any new API communication added (authentication requirements, data transmitted)

**The CISO agent must explicitly approve or reject the changes. If rejected, no APK release proceeds until issues are resolved.**

---

## 2. Architect Agent — Code Structure Review

**Role**: Software Architect. Ensures the codebase structure, patterns, and technical decisions remain sound, maintainable, and aligned with Android best practices.

**Invocation**: Launch the Architect agent to review architectural decisions and code organization.

**Scope of review**:
- Fragment lifecycle management (avoid memory leaks, view binding cleanup)
- Coroutine scope usage (lifecycleScope vs. viewModelScope appropriateness)
- API layer design (Retrofit interface additions, response handling consistency)
- Data class changes in `models.kt` (Gson compatibility, Parcelable where needed)
- Navigation pattern consistency (back stack behavior, fragment transactions)
- RecyclerView and adapter patterns (DiffUtil, ListAdapter usage)
- Introduction of new dependencies (necessity, SDK compatibility, size impact)
- Avoidance of code duplication across fragments
- Legacy code cleanup strategy (removing deprecated activity files when appropriate)
- Build config changes (SDK versions, ProGuard, Gradle)

**The Architect agent must confirm the changes are architecturally sound before release.**

---

## 3. UI/UX Agent — Frontend Design Review

**Role**: UI/UX Design Authority. Ensures all UI changes meet current Android design standards, Material Design 3 guidelines, and usability expectations — consistent with the established visual identity.

**Invocation**: Launch the UI/UX agent to review any UI changes.

**Scope of review**:
- Consistency with the dark theme palette in `res/values/colors.xml` (accent presets in `ThemeManager`)
- Material Design 3 component usage and guidelines compliance
- Touch target sizes (minimum 48dp for interactive elements)
- Accessibility: content descriptions, TalkBack support, sufficient color contrast
- Loading state feedback (progress indicators visible and appropriately placed)
- Empty state designs (helpful, non-alarming messages)
- Error handling UX (Snackbar usage, not intrusive dialogs)
- Animation consistency (200ms slide transitions, no janky transitions)
- Responsiveness across screen sizes (phones from small to large)
- Bottom navigation behavior and tab state preservation
- Status color system consistency (MOB-33, the web's palette: Wishlist sky #38BDF8, Playing emerald #34D399,
  Done violet #C084FC, Backlog amber #FBBF24, Unreleased slate #94A3B8), each badge carrying its label
- Game card design and cover image aspect ratio (portrait 3:4)
- Alignment with today's standards for Android app design and interactivity

**The UI/UX agent must approve any UI changes before release.**

---

## Release Checklist

Before releasing a new APK or publishing to any distribution channel:

- [ ] CISO agent has reviewed and **approved** all changes
- [ ] Architect agent has reviewed and **approved** all changes
- [ ] UI/UX agent has reviewed and **approved** all UI changes (if applicable)
- [ ] Tested on at least one physical device or emulator at minimum SDK (API 24)
- [ ] ProGuard/R8 rules verified for release build. A new class in `models.kt` needs a keep rule
      in `proguard-rules.pro` AND a field in android.yml's `R8_KEPT_FIELDS` (runtime.test.js
      enforces both; android.yml then checks the BUILT dex). A Gson model outside `models.kt`
      is not covered: keep them there
- [ ] OkHttp logging interceptor is **disabled** in release build (no credential leaking)
- [ ] No hardcoded secrets, tokens, or credentials in source code
- [ ] `versionCode` incremented in `build.gradle.kts`
- [ ] Debug builds tested against staging (`-PgtDebugApiBase`), then the release APK against production
