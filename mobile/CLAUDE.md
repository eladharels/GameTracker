# GameTracker Mobile — CLAUDE.md

## Project Overview

GameTracker Mobile is the **native Android companion app** for the GameTracker platform. Written in Kotlin using Jetpack components, it allows users to search for games, manage their personal library, and track play status — all connected to the GameTracker backend REST API.

---

## Tech Stack

- **Language**: Kotlin
- **Platform**: Android (Native)
- **Minimum SDK**: API 24 (Android 7.0 Nougat)
- **Target / Compile SDK**: API 36 (Android 15)
- **JVM Target**: Java 11
- **Build System**: Gradle with Kotlin DSL (`build.gradle.kts`)
- **UI Framework**: Jetpack Compose (enabled) + XML layouts (Fragment-based architecture)

### Key Libraries
| Library | Version | Purpose |
|---|---|---|
| Retrofit | 2.9.0 | HTTP client / REST API calls |
| OkHttp3 + Logging Interceptor | — | HTTP logging in debug builds |
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
**Single Activity + Multiple Fragments** with bottom navigation. `MainActivity` hosts all fragments and manages navigation. Legacy activity files (`GameDetailsActivity.kt`, `GameSearchActivity.kt`, `MyLibraryActivity.kt`) still exist but have been superseded by the fragment-based architecture.

### Project Structure
```
GameTracker-mobile/
├── app/
│   ├── src/main/
│   │   ├── java/com/example/gmaetrackermobile/
│   │   │   ├── ApiClient.kt                  # Retrofit singleton (base URL, interceptors)
│   │   │   ├── GameTrackerApi.kt             # Retrofit API interface (all endpoints)
│   │   │   ├── models.kt                     # All data classes (Game, LoginRequest, etc.)
│   │   │   ├── GameAdapter.kt                # RecyclerView adapter for game lists
│   │   │   ├── LoginActivity.kt              # Entry point — auth screen
│   │   │   ├── MainActivity.kt               # Main container — hosts all fragments
│   │   │   ├── SettingsActivity.kt           # App settings screen
│   │   │   ├── fragments/
│   │   │   │   ├── SearchFragment.kt         # Game search UI
│   │   │   │   ├── LibraryFragment.kt        # User library management
│   │   │   │   ├── ProfileFragment.kt        # User profile + stats
│   │   │   │   └── GameDetailsFragment.kt    # Game detail bottom sheet / view
│   │   │   ├── [Legacy activities]
│   │   │   │   ├── GameDetailsActivity.kt
│   │   │   │   ├── GameSearchActivity.kt
│   │   │   │   └── MyLibraryActivity.kt
│   │   │   └── ui/theme/
│   │   │       ├── Color.kt
│   │   │       ├── Theme.kt
│   │   │       └── Type.kt
│   │   ├── res/
│   │   │   ├── layout/                       # XML layouts for all screens
│   │   │   ├── values/                       # Colors, strings, themes
│   │   │   ├── menu/                         # Navigation and action bar menus
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

- **Base URL**: `https://gametracker.etech.ink/api/`
- **Protocol**: HTTPS
- **Auth**: Bearer Token in `Authorization` header (stored in SharedPreferences)
- **Data format**: JSON (Gson)

### API Endpoints Used by the App

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/login` | User login |
| GET | `/games/search?q=` | Search games |
| GET | `/user/{username}/games` | Fetch user's game library |
| POST | `/user/{username}/games` | Add / update game in library |
| DELETE | `/user/{username}/games/{gameId}` | Remove game from library |
| PUT | `/user/{username}/games/{gameId}/backlog-order` | Move game in backlog |
| POST | `/user/{username}/games/{gameId}/refresh-metadata` | Refresh game info |

---

## Navigation Structure

```
LoginActivity  (LAUNCHER — entry point)
    ↓ on successful login
MainActivity  (single activity host)
    ├── Bottom Navigation:
    │   ├── Search Icon     → SearchFragment
    │   ├── Library Icon    → LibraryFragment
    │   └── Profile Icon    → ProfileFragment
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
        ├── Status spinner
        ├── Update status / Refresh metadata buttons
        └── Remove from library button
```

---

## Authentication

### Login Flow
1. User enters username + password in `LoginActivity`
2. Client validates non-empty, trims whitespace, lowercases username
3. `POST /auth/login` with `LoginRequest`
4. On success: token + username saved to SharedPreferences (`"auth"` prefs)
5. Navigate to `MainActivity`

### Biometric (Fingerprint) Login
- Uses `AndroidX BiometricPrompt`
- Device capability checked via `BiometricManager.BIOMETRIC_STRONG`
- Toggle in `ProfileFragment` saves `fingerprint_enabled` flag to SharedPreferences
- On `LoginActivity` load: if biometrics enabled + token exists → show fingerprint prompt
- On success: navigate to `MainActivity` with existing token

### Token Storage
- SharedPreferences key: `"token"` (in `"auth"` prefs)
- Sent as `Authorization: Bearer <token>` on all authenticated requests
- Cleared on logout; optionally cleared when biometrics is disabled

---

## State Management

- **No ViewModel/LiveData** — fragment-level mutable lists + coroutines
- **Auth state**: SharedPreferences (token, username, biometric flag)
- **Network calls**: `lifecycleScope` coroutines on `Dispatchers.IO`, results posted to `Dispatchers.Main`
- **State reload**: Fragments reload from API on resume / lifecycle events (no persistent cache)

---

## Design System

### Color Palette
| Role | Hex | Usage |
|---|---|---|
| Primary Background | `#181A20` | Screen backgrounds |
| Card/Surface | `#23262F` | Game cards, bottom sheets |
| Accent Blue | `#22B8F6` | Buttons, active states, status "Playing" |
| Text Primary | `#F5F6FA` | Main text |
| Text Secondary | `#A0A3B1` | Subtitles, metadata |
| Status Wishlist | `#6B7280` | Gray |
| Status Playing | `#22B8F6` | Blue |
| Status Done | `#22C55E` | Green |
| Status Backlog | `#F97316` | Orange |
| Status Unreleased | `#8B5CF6` | Purple |

### UI Patterns
- Material Design 3 components throughout
- Dark-first theme
- Snackbar for user feedback (not dialogs)
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
- Token stored in app's private SharedPreferences (not accessible to other apps)

---

## Known Technical Debt

- Legacy activity files (`GameDetailsActivity`, `GameSearchActivity`, `MyLibraryActivity`) still in the codebase — superseded by fragments but not yet removed
- Package name typo in namespace: `com.example.gmaetrackermobile` (should be `gametracker`) — do not change without a coordinated rename refactor
- App name string has typo: `GmaeTrackerMobile` — cosmetic, low priority
- No ViewModel/LiveData — state reloads on every fragment resume (network-heavy)

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
- Consistency with the dark theme color palette (`#181A20`, `#22B8F6` accent, status colors)
- Material Design 3 component usage and guidelines compliance
- Touch target sizes (minimum 48dp for interactive elements)
- Accessibility: content descriptions, TalkBack support, sufficient color contrast
- Loading state feedback (progress indicators visible and appropriately placed)
- Empty state designs (helpful, non-alarming messages)
- Error handling UX (Snackbar usage, not intrusive dialogs)
- Animation consistency (200ms slide transitions, no janky transitions)
- Responsiveness across screen sizes (phones from small to large)
- Bottom navigation behavior and tab state preservation
- Status color system consistency (Wishlist gray, Playing blue, Done green, Backlog orange, Unreleased purple)
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
- [ ] ProGuard/R8 rules verified for release build
- [ ] OkHttp logging interceptor is **disabled** in release build (no credential leaking)
- [ ] No hardcoded secrets, tokens, or credentials in source code
- [ ] `versionCode` incremented in `build.gradle.kts`
- [ ] APK tested against the live production backend (`https://gametracker.etech.ink/api/`)
