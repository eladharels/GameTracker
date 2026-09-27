# GameTracker Mobile — Remediation Roadmap

Source: a three-role review (CISO, Architect, UI/UX) of the Android app **as added** in
commit `9334c1a` ("add mobile"), 2026-09-27. Every item was read from
`git show 9334c1a:mobile/<path>`. Line numbers refer to that commit, not to the working tree.
Nothing was changed during the review.

Baseline at review time: `mobile/` has no tests beyond the two Android Studio templates
(`ExampleUnitTest.kt`, `ExampleInstrumentedTest.kt`). There was no CI job for it; the Android
workflow arrives in PR #6. The app talks to the frozen **v1** API
(`https://gametracker.etech.ink/api/`) with the 12-hour session JWT from
`POST /api/auth/login`.

Items marked ✔ were checked by hand against the backend as well as against the app. That
applies where the finding depends on what the server does, for example MOB-10 and MOB-13.

---

## How to use this file

- Every finding has a stable ID (`MOB-1`, `MOB-2`, …). Use the ID in commit messages and PR
  titles, for example `Fix MOB-12: undo snackbar must not touch a destroyed view`.
- Tick `[ ]` → `[x]` in the same PR that lands the fix, and add a line to the **Fix log** at
  the bottom (ID, PR, date, one line).
- If you decide not to fix an item, tick it and mark it **Won't fix** with the reason. Don't
  delete it: the reasoning is the documentation.
- **Definition of done** for each item (from `mobile/CLAUDE.md` and the root `CLAUDE.md`):
  1. A test that fails before the fix and passes after, where one can be written. Use a JVM
     unit test under `mobile/app/src/test/` for logic, and a Robolectric or instrumented test
     for lifecycle and view behaviour.
  2. The Android CI job (`.github/workflows/android.yml`) is green.
  3. CISO review for anything touching auth, storage, network or the manifest. Architect
     review for anything structural. UI/UX review for anything a user sees.
  4. Anything that changes what the app sends to the backend must keep
     `test/api-contract.test.js` and `test/api-surface.test.js` green. v1 shapes are frozen.

Severity: **Critical**: fix before anyone installs a build. **High**: fix before the next
release. **Medium**: planned work. **Low**: cleanup or polish.

---

## Progress

| Section | Items | Done |
|---|---|---|
| SEC — Security | 9 | 0 (5 in PR #6) |
| COR — Correctness | 9 | 0 |
| ARC — Architecture & build | 8 | 0 |
| UX — Design & accessibility | 9 | 0 |
| **Total** | **35** | **0** |

By severity: **Critical 2 · High 7 · Medium 18 · Low 8**.

---

## SEC — Security

### [x] MOB-1 ✔ Critical — Release builds log bearer tokens and the login password — *fixed in PR #6*
- **Where:** `app/src/main/java/com/example/gmaetrackermobile/ApiClient.kt:10-14`.
- **Why:** `HttpLoggingInterceptor.Level.BODY` is installed unconditionally, in release as well
  as debug. Every request and response is written to logcat, including:
  - the `Authorization: Bearer <jwt>` header on every call;
  - the `POST /auth/login` body, which holds the password in plaintext;
  - the response body, which holds the token.

  On many devices logcat is readable over `adb`, and it ends up in bug reports and OEM crash
  uploads. `mobile/CLAUDE.md:23` says the interceptor is for "debug builds". The code does not
  do that.
- **Fix:**
  - Install the interceptor only when `BuildConfig.DEBUG` is true.
  - Even in debug, use `Level.HEADERS` with `redactHeader("Authorization")`, never `BODY`,
    because the login body is the password.
  - Add a JVM test that builds the release client and asserts it has no logging interceptor.

### [x] MOB-2 ✔ Critical — `MainActivity` is exported, so any app or `adb` can skip login and biometrics — *fixed in PR #6*
- **Where:** `AndroidManifest.xml:29-33`, `MainActivity.kt:41-65`.
- **Why:** `android:exported="true"` with no permission lets any installed app, or
  `adb shell am start -n …/.MainActivity`, open the main screen directly. `MainActivity`
  never checks for a session. It reads the token from `SharedPreferences` in every fragment.
  So a device with a stored token opens straight into the library, and the fingerprint prompt
  in `LoginActivity` never runs. The biometric lock is decided by which door you use.
- **Fix:**
  - Set `exported="false"`. `LoginActivity` stays the only launcher.
  - `MainActivity.onCreate` must itself refuse to render without a live session and route to
    `LoginActivity`.

### [x] MOB-3 ✔ High — Logout keeps the token when biometrics is on — *fixed in PR #6*
- **Where:** `MainActivity.kt:149-153`, `ProfileFragment.kt:304-308`.
- **Why:** both logout paths remove `token` only when `fingerprint_enabled` is false. With
  biometrics on, "Log out" leaves a working bearer token on disk. The next fingerprint touch
  (any enrolled finger on the device) resumes the session. The user asked to end the session,
  and it did not end.
- **Fix:**
  - Logout always deletes the credential.
  - Fingerprint unlock is for a *live* session only; after a logout the user types the
    password again.
  - Clear the per-user local data at the same time (see MOB-7).

### [x] MOB-4 ✔ High — `allowBackup="true"` with empty rules backs up the token — *fixed in PR #6*
- **Where:** `AndroidManifest.xml:11-13`, `res/xml/backup_rules.xml:8-13`,
  `res/xml/data_extraction_rules.xml:6-19`. Both rule files are the unedited templates.
- **Why:** Auto Backup copies every `SharedPreferences` file to the user's cloud backup and to
  device-to-device transfers. That includes `auth.xml` (token, username, biometric flag) and
  `app_prefs.xml` (notes, search history). A restored device, or a new phone, starts with a
  still-valid bearer token that was never issued to it.
- **Fix:**
  - Exclude the `auth` preferences from `cloud-backup` and `device-transfer`, for both the
    API 31+ `data_extraction_rules` and the pre-31 `full-backup-content`.
  - Alternatively set `allowBackup="false"`.
  - Once MOB-6 lands, the token is bound to a Keystore key that never leaves the device, so a
    restored copy is useless anyway. The exclusion is still needed until then.

### [x] MOB-5 ✔ High — No 401 handling: after the 12-hour JWT expires everything fails silently — *fixed in PR #6*
- **Where:** every call site. Examples: `LibraryFragment.kt:450-475` (a non-2xx is simply not
  rendered), `HomeFragment.kt:101-115`, `InsightsFragment.kt:43-57`, `ProfileFragment.kt:78-101`
  (`// fail silently`), `SearchFragment.kt:298` (a 401 becomes "No games found").
  Also `LoginActivity.kt:45-53`: the biometric unlock succeeds on any stored token.
- **Why:** the backend session is a 12-hour JWT. After it expires, every screen shows empty
  or stale data with no message. Fingerprint unlock "succeeds" into a dead session, because it
  only checks that a string exists in preferences. Users read this as "my library is empty".
  The web app had the same defect (root ROADMAP P0-6).
- **Fix:**
  - One OkHttp interceptor that recognises a 401 on an authenticated call. It clears the
    session, records why ("session expired"), and sends the user to `LoginActivity`, which
    says so.
  - Before unlocking with a fingerprint, compare the token's `exp` with the clock and treat
    an expired token as no token.
  - A 403 is not a 401 and must not sign the user out.

### [ ] MOB-6 High — Token stored in plaintext; biometric is a UI gate with no `CryptoObject`
- **Where:** `LoginActivity.kt:114-118` (the token goes into `SharedPreferences("auth")` in the
  clear), `LoginActivity.kt:43-57` and `:69-78` (`BiometricPrompt.authenticate(promptInfo)`
  with no `CryptoObject`), `ProfileFragment.kt:178-211`, `SettingsActivity.kt:41-81`.
- **Why:**
  - The fingerprint check decides nothing cryptographically. Its only effect is a
    `startActivity` call. Anything that can read or bypass the app's code path gets the
    token: MOB-2 is one example, a backup is another (MOB-4), and on a rooted or debuggable
    build the preferences file itself.
  - `mobile/CLAUDE.md:222` and `SECURITY_FIXES.md:61` describe this as secure storage.
    It isn't.
- **Fix:**
  - Generate an AES-256-GCM key in the Android Keystore with
    `setUserAuthenticationRequired(true)` and
    `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`. Use `StrongBox` where the
    device has it.
  - Keep only the ciphertext and IV in preferences.
  - Decrypt only inside `BiometricPrompt.authenticate(promptInfo, CryptoObject(cipher))`, so
    a successful prompt is what produces the token.
  - Handle `KeyPermanentlyInvalidatedException`, which fires when fingerprints are
    re-enrolled: drop the key and fall back to the password.
  - Do **not** use `EncryptedSharedPreferences` / `security-crypto`. It is deprecated, and it
    does not bind decryption to the biometric.
- **Behaviour note:** any finger enrolled on the device unlocks the app. That is inherent to
  Android biometrics and should be stated where the toggle is.

### [ ] MOB-7 Medium — Local per-user data outlives logout, and notes are stored under two keys
- **Where:**
  - Notes: `GameDetailsFragment.kt:210-227` writes `app_prefs/note_<sanitised id>`, while
    `GameExtras.kt:83-90` reads and writes `game_extras/note_<raw id>`. `GameExtras.note()` is
    never called.
  - Ratings: `GameExtras.kt:71-81`.
  - Search history: `SearchFragment.kt:140-174`.
  - Calendar settings and event map: `CalendarHelper.kt:18-22`. These are kept in the **`auth`**
    preferences file, next to the credential.
  - Logout: `MainActivity.kt:149-159`.
- **Why:** none of this is keyed by user, and logout clears none of it. On a shared device the
  next account sees the previous user's notes, star ratings and search history. Calendar
  events for the previous user's games stay in the calendar, and the new user's sync calls
  `deleteAllEvents` on them. Two note stores also mean a future sync or migration reads the
  wrong one.
- **Fix:**
  - One store for notes and ratings, keyed by username.
  - Move the calendar settings out of `auth`.
  - On logout or user switch, clear the per-user stores and offer to remove the calendar
    events.

### [ ] MOB-8 Low — Certificate pinning: decision recorded; add a network security config instead
- **Where:** `ApiClient.kt:13-15` (default `OkHttpClient`); there is no
  `android:networkSecurityConfig`. `minSdk = 24` (`build.gradle.kts:15`).
- **Why:**
  - **Do not pin.** The server is self-hosted behind Let's Encrypt-style certificates that
    rotate every 60–90 days, and the app ships to a handful of users with no remote config.
    A pin that goes stale bricks every installed copy until an update ships. The threat it
    addresses (a mis-issued certificate for `etech.ink`, or a user-installed CA) is small for
    this deployment.
  - What *is* worth doing: on API 24–27 cleartext is permitted by default. Glide loads
    server-supplied cover URLs, so an `http://` cover goes out in the clear. Unlike
    `frontend/src/safeUrl.js`, nothing on the client checks the scheme of those URLs.
- **Fix:**
  - Add `network_security_config.xml` with `cleartextTrafficPermitted="false"` and
    system-only trust anchors in release. User CAs are allowed in the debug overlay only.
  - Load cover URLs only when the scheme is `https`.
  - Revisit pinning (with a backup pin and an expiry) only if the app is ever distributed
    publicly.

### [ ] MOB-9 Low — A longer-lived, revocable mobile credential (follow-up to MOB-5)
- **Where:** the app uses the 12-hour session JWT (`LoginActivity.kt:101-118`).
- **Why:** once MOB-5 lands, users must type their password after every 12-hour expiry. The
  backend already has the right primitive:
  - library-scoped personal access tokens (`services/auth.js`), SHA-256 hashed at rest;
  - revocable by the owner and by an admin (`GET/DELETE /api/v2/users/:id/tokens`);
  - listed in My Account.

  Such a token, stored as MOB-6 describes and unlocked by the fingerprint, would give
  convenience without a long-lived JWT, which cannot be revoked.
- **Fix:** design first (CISO), for example: mint a `library` PAT on first login with a
  device label, after a password re-prompt (sudo mode). This needs more than a token swap:
  - the PAT is refused by `/api/v2` scope rules for anything but library routes;
  - on v1, `authRequired` narrows it (see root CLAUDE.md, SEC-12).

  Verify every route the app calls, and pin the list in `test/api-surface.test.js`.

---

## COR — Correctness

### [ ] MOB-10 ✔ High — "Add" on a search result silently demotes a game already in the library
- **Where:** `SearchFragment.kt:315-321` (always sends `status = "Wishlist"`),
  `GameAdapter.kt:150-153` (the Add button shows for every result). On the backend:
  `services/library.js:408` (`ON CONFLICT(user_id, game_id) DO UPDATE SET status=excluded.status`)
  and `recordStatusEvent`.
- **Why:** tapping Add on a game the user has already marked `done` rewrites it to `wishlist`.
  The upsert does what it was asked. The consequences go beyond that one row:
  - A `source='user'` row lands in `user_game_status_events`. That history is permanent.
    Per the root CLAUDE.md it "cannot be backfilled", and it skews the statistics page.
  - A status-change notification goes out on every channel the user has configured.
  - Search results carry no "already in your library" indicator, so nothing warns the user.
    The web app refuses this case (`libraryMatch.js`, FE-3).
- **Fix:**
  - Fetch the library once and match results by `game_id`, using the shared
    `test/library-match-vectors.js` rules.
  - Show "In library · Done" instead of Add.
  - Never send a status on a re-add of an owned game.

### [ ] MOB-11 High — Invented statistics are presented as the user's own
- **Where:** `GameExtras.kt:5-16`, `:36`, `:56-66`, `:71-77`. They are consumed at:
  - `HomeFragment.kt:124,129` ("Hours tracked");
  - `HomeAdapters.kt:39-41` (progress bar and "Nh played");
  - `InsightsFragment.kt:75-99` (total hours, average rating, "Top genres");
  - `LibraryFragment.kt:552-556` ("N games · Nh tracked");
  - `GameDetailsFragment.kt:115-116,128-129` (genre, "Nh played").
- **Why:** hours played, completion progress, genre and default star ratings are derived from
  a hash of the game id, "so the UI looks real" (`GameExtras.kt:9-10`). Nothing tells the user
  the numbers are invented. A finished game shows "4.5★ · 87h" the user never entered, and the
  Insights page draws a "Top genres" chart from random labels. The web app goes the other way
  on purpose: the stats page shows an em dash rather than an invented zero. This does not
  "look real". It is wrong data.
- **Fix:**
  - Remove every mock value.
  - Show only what the server knows: counts by status, release years, and the real
    `GET /api/user/:username/stats` completions and durations.
  - Where the server has nothing, show nothing or "—".
  - Genre can come from the catalog later. Hours can't come from anywhere today, so drop the
    UI for them.
  - Ratings and notes may stay as *local* features only if they are labelled "on this
    device".

### [ ] MOB-12 High — Undo snackbar crashes the app when the user leaves the screen within 5 s, and the delete is lost
- **Where:** `LibraryFragment.kt:504-547`, especially `:518-523`.
- **Why:** the delete is deferred to `Snackbar.onDismissed`. That callback calls
  `viewLifecycleOwner.lifecycleScope` and `requireContext()`. If the user switches tab or opens
  a game during the 5-second window, the fragment's view is destroyed. The timeout still fires,
  and `getViewLifecycleOwner()` throws `IllegalStateException`, which is a crash. Even without
  the crash, the removal was never sent, so the "removed" game comes back on the next load.
- **Fix:**
  - Run the deferred delete in a scope that outlives the view, for example an
    application-scoped repository or `WorkManager`.
  - Or send the DELETE immediately and make Undo re-add the game.
  - Never touch `viewLifecycleOwner` from a callback that can outlive the view.
  - Add a Robolectric test: delete, then destroy the view, then advance 5 s.

### [ ] MOB-13 ✔ Medium — Status writes ignore the server's answer; `unreleased` is offered as a choice; `""` is sent for an unknown date
- **Where:**
  - `GameTrackerApi.kt:22-27`: `Response<Unit>` discards the body.
  - `LibraryFragment.kt:301` offers "Unreleased" as a choice; `:346-385` updates optimistically.
  - `GameDetailsFragment.kt:53` omits Unreleased entirely.
  - `models.kt:35`: `release` returns `""`, which `SearchFragment.kt:319`,
    `LibraryFragment.kt:367` and `GameDetailsFragment.kt:247` send as `releaseDate`.
- **Why:**
  - `POST /api/user/:u/games` answers `{success, status, coerced}`. The server decides
    `unreleased` from the stored date (`statusForDate`, D7). Asking for `playing` on a
    future-dated game stores `unreleased`, and asking for `unreleased` on a released game
    stores `wishlist`. The app shows the requested value and a success snackbar, until the
    next reload contradicts it.
  - The statuses are sent capitalised (`"Done"`). The server lowercases them only because
    this app does that (`library.js:306-312`).
  - `""` for an unknown date works today only because `effectiveReleaseDate` treats it as
    falsy. The correct value is `null`.
- **Fix:**
  - Model the response.
  - Render `status` from it, and when `coerced` is true explain why ("Not released yet, kept
    as Unreleased").
  - Remove Unreleased from the pickers.
  - Send the lowercase canonical values, and `null` for an unknown date.

### [ ] MOB-14 Medium — Backlog reorder is N unconditional calls with the results ignored
- **Where:** `LibraryFragment.kt:248-271`. The drag delta is computed on the filtered list at
  `:490-495`. `GameAdapter.kt:129-131` shows `#backlog_order`; `HomeAdapters.kt:74` shows
  `#position+1`.
- **Why:**
  - A drag of k places sends k sequential `PUT …/backlog-order {direction}` calls and never
    checks a response. A failure part-way leaves the backlog half-moved, with no error.
  - The positions come from the list *after* the in-library search filter. With a search
    active, "moved 2 down" in the filtered view is a different move in the real backlog.
  - Library cards show the stored `backlog_order` while Home shows the list index. Once the
    stored numbers have gaps, the two screens disagree about the same game's position (web
    FE-24).
  - The backend already has the right primitive: `PUT /api/user/:username/backlog-reorder`
    with the whole order, in one transaction (`index.js:973`).
- **Fix:**
  - Send one `backlog-reorder` call with the full backlog order.
  - Disable drag while a search filter is active.
  - Show the list position everywhere.
  - On failure, reload and say so.

### [ ] MOB-15 Medium — Search: a failure reads as "No games found", and stale responses win
- **Where:** `SearchFragment.kt:292-303` (every non-2xx and every exception becomes
  `emptyList()`), `:263-289` (the `catch` is therefore unreachable), `:44-45` and `:229-241`
  (debounce with no cancellation of the previous request).
- **Why:**
  - A network outage, a 401 (MOB-5), a 429, or a provider outage all render the empty state
    "No games found for 'x'". The user concludes the game doesn't exist.
  - Each keystroke pause launches a new coroutine without cancelling the last. A slow earlier
    query can land after a later one and overwrite it. This is the web's FE-2.
- **Fix:**
  - Return a result type that can say empty, failed or unauthorised, and show a retry state
    for failures.
  - Hold the search `Job` and cancel it before starting another. Alternatively, drop any
    response whose query is not the current one.

### [ ] MOB-16 Medium — Game Details offers library-only actions for games that are not in the library
- **Where:** `GameDetailsFragment.kt:111-130`, `:198-206`, opened from search at
  `SearchFragment.kt:121-130`.
- **Why:** the same screen serves search results and library entries. For a search result it
  still shows "Remove from library" (a DELETE for a row that doesn't exist), "Refresh"
  (metadata refresh of a non-library game fails) and local notes/rating. Its status chips
  silently *add* the game. The "Remove" button has no confirmation and no undo, while the
  library list has a 5-second undo.
- **Fix:**
  - Pass an `inLibrary` flag, or look the game up.
  - For non-library games show a single "Add to library" action.
  - Give Remove the same undo (or a confirmation) as the list.

### [ ] MOB-17 Medium — Coroutine scopes: unscoped `CoroutineScope(Dispatchers.IO)` and fragment-scoped work on views
- **Where:**
  - `LoginActivity.kt:99` and `ProfileFragment.kt:79`: unscoped `CoroutineScope(Dispatchers.IO)`.
  - Fragment `lifecycleScope` doing view work: `GameDetailsFragment.kt:234,277,311`;
    `SearchFragment.kt:263,309,357,362`; `ProfileFragment.kt:240,256`.
  - `SearchFragment.kt:44-45`: `searchHandler` is never cleared in `onDestroyView`.
- **Why:**
  - Unscoped jobs outlive the screen. `ProfileFragment` calls `requireContext()` on an IO
    thread after the fragment may have detached, and swallows the resulting exception.
  - Fragment `lifecycleScope` outlives the *view* when the fragment goes on the back stack,
    so these coroutines update destroyed views.
  - The debounce runnable can fire `performSearch()` against a destroyed view.
- **Fix:**
  - `lifecycleScope` in activities; `viewLifecycleOwner.lifecycleScope` for anything that
    touches views.
  - Remove callbacks in `onDestroyView`.
  - This is largely subsumed by MOB-19 (ViewModels).

### [ ] MOB-18 Low — Library "Unreleased" filter and count include any game with a blank date
- **Where:** `LibraryFragment.kt:418-421`, `:485-487`.
- **Why:** a `done` or `playing` game with no stored date is counted, and listed, as Unreleased.
  The chip count then disagrees with the server's status and with the web app.
- **Fix:** filter on `status == "unreleased"` only.

---

## ARC — Architecture & build

### [ ] MOB-19 Medium — No data layer: every screen refetches the whole library, twice
- **Where:**
  - `LibraryFragment.kt:74` and `:81-84`, `HomeFragment.kt:40` and `:43-46`,
    `InsightsFragment.kt:35-41` (each loads in `onViewCreated` **and** `onResume`, so there
    are two GETs every time a tab opens).
  - `ProfileFragment.kt:51` and `:78-101`, `ProfileFragment.kt:273-296` (more full fetches).
  - `MainActivity.kt:85-97`: a new fragment instance on every tab tap.
  - The token and username are read from `SharedPreferences` in about 20 places.
- **Why:**
  - The full library is downloaded roughly 2× per tab switch.
  - Scroll position, filter and search text are lost on every tab change.
  - Auth handling (MOB-5) has no single place to live.
  - `mobile/CLAUDE.md:231` already lists this as debt.
- **Fix:**
  - A `LibraryRepository` (single in-memory source, explicit refresh).
  - Finish `SessionStore` as the ONLY reader of the credential. It exists since PR #6
    (MOB-3/MOB-5), but about 25 call sites still read
    `getSharedPreferences("auth").getString("token")` themselves (Home, Library, Search,
    Insights, Profile, GameDetails), with `"auth"`/`"token"` hard-coded outside
    `SessionStore.PREFS`/`KEY_TOKEN`. Those raw reads are the debt; route them through
    `Session.get(ctx).bearer()`.
  - One `ViewModel` per screen.
  - Show/hide fragments instead of replacing them, or use Navigation with saved state.

### [ ] MOB-20 Medium — Release build: no R8, a `com.example` application id, no signing or versioning
- **Where:** `app/build.gradle.kts:10`, `:14`, `:17-18`, `:24-25`; `proguard-rules.pro` (template only).
- **Why:**
  - `isMinifyEnabled = false`: no shrinking or obfuscation, so the release APK carries every
    unused library, Compose included (MOB-22).
  - `applicationId = "com.example.gmaetrackermobile"`: Google Play rejects the `com.example`
    namespace. Changing the id later is a *new app* to Android, so users lose their data and
    must reinstall. Better to change it before anyone depends on it.
  - The "gmae" typo runs through the namespace and theme (`Theme.GmaeTrackerMobile`).
  - `versionCode = 1` with no release signing config.
- **Fix:**
  - Pick the final id now, for example `ink.etech.gametracker`, and rename the package in
    the same change.
  - Enable R8, with keep rules for the Gson-reflected models in `models.kt` (a missing rule
    serialises every field as `null`) and for Retrofit interfaces.
  - Add a signing config that reads from CI secrets, never from the repo.

### [ ] MOB-21 Medium — Outdated dependencies and `kapt`
- **Where:** `app/build.gradle.kts:63-83`, `gradle/libs.versions.toml:10`.
- **Why:** several libraries are two or more years behind current stable:
  - `retrofit`/`converter-gson` 2.9.0, `okhttp logging-interceptor` 4.11.0;
  - `material` 1.9.0 (under a Material 3 theme that expects newer components);
  - `biometric` 1.1.0, `kotlinx-coroutines-android` 1.6.4 (on Kotlin 2.0.21);
  - `fragment-ktx` 1.6.2, `recyclerview` 1.3.1, `glide` 4.15.1.

  Glide's compiler runs through `kapt`, which is in maintenance mode and slows every build.
  Nothing tracks vulnerabilities for this tree: no Dependabot, and Trivy scans only the
  Docker images.
- **Fix:**
  - Move everything into `libs.versions.toml` and upgrade to current stable.
  - Glide via KSP.
  - Add a Dependabot `gradle` entry for `/mobile`, and include `mobile/` in the
    dependency-verification metadata that the CI job enforces.

### [ ] MOB-22 Medium — Dead code: three legacy activities, an unused Compose stack, an unreachable logout menu
- **Where:**
  - `GameDetailsActivity.kt`, `GameSearchActivity.kt`, `MyLibraryActivity.kt` (434 lines, not
    in the manifest, so they crash if ever started) and their three layouts.
  - `ui/theme/Color.kt`, `Theme.kt`, `Type.kt` (the Compose theme, never called).
  - `build.gradle.kts:4`, `:39-41`, `:47-60`: the Compose plugin, `compose = true`, the BOM,
    `ui`, `material3`, `activity-compose`, tooling and test artifacts.
  - `activity_main.xml:8-14` (a `gone`, 0-dp toolbar holding `main_menu`) and
    `MainActivity.kt:73-83` and `:149-159`: that logout path can never be reached.
  - `MainActivity.kt:161-166` (`refreshCurrentFragment`, never called).
  - `GameDetailsFragment.kt:69-74`: `callback = parentFragment as? …` is always `null`,
    because details are added to the activity container, so every `callback?.` is a no-op.
  - `GameExtras.kt:83-90` (the unused note API; see MOB-7).
  - `display_name` is read (`HomeFragment.kt:53`, `ProfileFragment.kt:65`) but never written.
- **Why:** this is the Compose runtime shipped for nothing, and two logout implementations,
  one of them dead. When MOB-3 was fixed, it had to be fixed in both. Reviewers keep
  re-reading code that cannot run.
- **Fix:**
  - Delete all of it.
  - For the display name, either fetch it from `GET /api/user/me` or drop the lookup.

### [ ] MOB-23 Medium — Server URL is hard-coded to production; debug builds use the live backend
- **Where:** `ApiClient.kt:17`; `mobile/CLAUDE.md:323` ("APK tested against the live
  production backend").
- **Why:**
  - Every debug build, test run and emulator session logs in to production with real
    accounts. Combined with MOB-1, that put real passwords in developer logcat.
  - GameTracker is self-hosted, yet the app can only ever talk to one instance.
  - Staging (`GameTracker-stg`) can't be targeted at all.
- **Fix:**
  - `buildConfigField("String", "API_BASE", …)` per build type: debug → staging, release →
    production.
  - Optionally a server-URL field on the login screen (https only; see MOB-8).

### [ ] MOB-24 Medium — No tests
- **Where:** `app/src/test/…/ExampleUnitTest.kt` and `app/src/androidTest/…/ExampleInstrumentedTest.kt`
  (templates only).
- **Why:** none of the behaviour in this file is pinned: logging in release (MOB-1), logout
  (MOB-3), 401 handling (MOB-5), the undo crash (MOB-12), the stale-search race (MOB-15).
  The backend repo pins its equivalents; this tree has nothing.
- **Fix:** start with JVM tests for the pure logic, and Robolectric for fragment lifecycle.
  Each item above names the test it needs.

### [ ] MOB-25 Low — Emit the app's API contract from the code instead of regex-parsing Kotlin
- **Where:** the backend drift gate (`test/mobile-api.js`, added alongside PR #6) reads
  `GameTrackerApi.kt` and `models.kt` with regular expressions.
- **Why:** a regex over source text breaks on formatting, default arguments, annotations
  spread over lines, or a `@SerializedName`. A break shows up either as a false failure or,
  worse, as a silently empty route list.
- **Fix:**
  - A JVM unit test in `mobile/` reflects over `GameTrackerApi` (the Retrofit method
    annotations: verb, path, `@Path`/`@Query`/`@Body` types) and over the request and
    response models (field names, after `@SerializedName`).
  - It writes `mobile/api-contract.json`, which is committed.
  - The backend gate reads that JSON. A CI step fails if regenerating it changes it.

### [ ] MOB-26 Medium — Documentation contradicts the code
- **Where and what:**
  - `mobile/CLAUDE.md`:
    - `:14` says API 36 is "Android 15"; it is Android 16.
    - `:23` says the logging interceptor is "debug builds"; it is in every build (MOB-1).
    - `:108-114` describes 3 tabs; there are 5: Home, Discover, Library, Insights, Profile.
    - `:139` mentions a "Status spinner"; the screen uses chips.
    - `:150` says the username is trimmed; it isn't (MOB-34).
    - `:165` says the token is "Cleared on logout"; it isn't with biometrics (MOB-3).
    - `:173` says network calls use `lifecycleScope`; see MOB-17.
    - `:181-192`: the palette table matches nothing in `colors.xml` (`#181A20` vs `#111218`,
      accent `#22B8F6` vs `#5B8DEF`, wishlist `#6B7280` vs `#8890A8`).
    - `:222` says the token is protected; see MOB-4 and MOB-6.
    - `:230` says the app name is misspelled; it's the theme name that is.
  - `mobile/SECURITY_FIXES.md`:
    - `:61` claims "Tokens are stored securely in SharedPreferences".
    - `:67` claims the change "Eliminates the credential bypass vulnerability". That was a
      client-side empty-field check; the server is the control.
  - `mobile/UI_UX_IMPROVEMENTS.md` describes things that are not in the code:
    - `:7-11` a 3-item nav;
    - `:15-19` a toolbar with settings and logout (it is `gone`);
    - `:33-34` source filter chips and pull-to-refresh on search;
    - `:51` source pills.
  - Root `CLAUDE.md:1022`: `GameTracker-mobile` (`../GameTracker-mobile/`), but the app now
    lives in `mobile/` in this repo.
- **Why:** the mandatory reviewers read these files as the specification. A reviewer who
  trusted `CLAUDE.md:23` would have passed MOB-1.
- **Fix:**
  - Rewrite `mobile/CLAUDE.md` from the code.
  - Mark `SECURITY_FIXES.md` and `UI_UX_IMPROVEMENTS.md` as historical, the way the root
    repo does.
  - Update the root `CLAUDE.md` pointer.

---

## UX — Design & accessibility

### [ ] MOB-27 Medium — Error messages show raw server JSON and exception text; lockout and outage read as a failed password
- **Where:**
  - `LoginActivity.kt:123-126` (`"Login failed: " + errorBody().string()`) and `:128-134`
    (`"Error: ${e.localizedMessage}"`).
  - `"Error: ${e.message}"` snackbars: `LibraryFragment.kt:382,541`,
    `GameDetailsFragment.kt:268,298,337`, `SearchFragment.kt:286,338`.
  - `MainActivity.kt:130,144`.
- **Why:**
  - Users see `Login failed: {"error":"Invalid credentials"}` and
    `Error: Unable to resolve host "gametracker.etech.ink"`.
  - A 429 lockout (15 minutes) and the 503 directory outage (UP-21) are shown the same way
    as a wrong password. That invites more retries, which prolong the lockout. The web app
    fixed exactly this (FE-4, `loginErrors.js`).
  - Exception text also leaks host and stack details into screenshots.
- **Fix:** one mapping from HTTP status and exception class to a sentence:
  - 401 → "Wrong username or password";
  - 429 → "Too many attempts, try again in N min" (from `Retry-After`);
  - 503 → "Sign-in is unavailable right now";
  - I/O failure → "Can't reach the server".

  Parse `{error}` only for logging.

### [ ] MOB-28 Medium — Settings screen states things that aren't true
- **Where:** `SettingsActivity.kt:86-96`; the biometric toggle is duplicated at
  `SettingsActivity.kt:27-83` and `ProfileFragment.kt:167-212`.
- **Why:**
  - "Notifications — On", "Connected sources — Steam, IGDB, RAWG — 3" and
    "Appearance — Dark" are string literals. The app knows nothing about the user's
    notification channels; they live in My Account on the web. It doesn't know which
    providers the server has configured either.
  - Two screens edit the same biometric flag with different copy.
- **Fix:**
  - Remove the rows, or back them with real data. `GET /api/capabilities` and the
    notification settings on `/api/user/me` are candidates.
  - Keep one biometric control.

### [ ] MOB-29 Medium — Text contrast fails WCAG AA across the app
- **Where and ratios (computed, WCAG 2.x):**
  - `gt_text_muted #4A5068` (`colors.xml:52`): **2.35:1** on the screen `#111218`, **2.18:1**
    on cards `#181A22`. It is used for real content, not decoration:
    - the search result header "No games found for '…'" (`fragment_search.xml:170`) and
      "Recent searches" (`:100`);
    - Game Details section labels (`fragment_game_details.xml:124,161,197`);
    - `activity_settings.xml:63,117`, `fragment_profile.xml:181,233`;
    - every input hint (`activity_login.xml:96,128`, `fragment_library.xml:105`,
      `fragment_search.xml:62`).
  - `gt_text_dim #5B6175` (`colors.xml:58`): **3.04:1** on `#111218`, **2.82:1** on `#181A22`
    (`widget_settings_row.xml:39`, `activity_settings.xml:150`).
  - White on the status badges (`item_game.xml:55`, `:103`, at 9–10 sp): **2.28:1** on done
    `#22C55E`, **2.27:1** on playing `#22B8F6`, **2.80:1** on backlog `#F97316`.
  - The error snackbar `#FF4D4F` on `#2D3142` (`SnackbarHelper.kt:41,55`): **3.94:1** at 14 sp.
  - White on the default accent `#5B8DEF` (`themes.xml:40-44`, `colorOnPrimary`): **3.23:1**,
    and **3.53:1** on the Pink preset. Passes only for large or bold ≥14 sp labels.

  AA requires 4.5:1 for body text and 3:1 for large text.
- **Fix:**
  - Raise muted/dim text to at least `#8890A8` (5.88:1), which the palette already uses as
    `gt_text_secondary`.
  - Use dark text (`#0C0D11`) on the light status colours.
  - Brighten the error red for text on dark surfaces.
  - Pick `colorOnPrimary` per preset by contrast. The web app computes it the same way for
    its presets.

### [ ] MOB-30 Medium — Screen-reader semantics: labels on decoration, none on controls, drag-only reorder
- **Where:**
  - Unlabelled controls: the five accent dots (`fragment_profile.xml:195-223`) are
    focusable `View`s with no `contentDescription` and no selected state.
    `ThemeManager.PRESET_NAMES` exists and is never used for accessibility. The star rating
    (`GameDetailsFragment.kt:187`) announces "Rate 3 star" with no current value.
  - Decorative icons that *are* labelled, so TalkBack reads each row twice:
    `fragment_profile.xml:261,322,397,415`; `fragment_library.xml:64,96,180`.
    Every cover is labelled "Game cover" (`item_game.xml:42`, `item_continue.xml:37`,
    `item_up_next.xml:42`), which is noise in a list.
  - The login error (`activity_login.xml:164`) has no `accessibilityLiveRegion`, so a failed
    sign-in is silent to a screen-reader user.
  - The username and password fields (`activity_login.xml:89-125`) have no `autofillHints`,
    so password managers work poorly.
  - Backlog reordering is drag-only (`GameAdapter.kt:133-138`) and the status sheet is
    long-press-only (`GameAdapter.kt:157-160`). Neither has an accessibility action. The web
    fixed the equivalent in FE-23.
- **Fix:**
  - Label the dots with the preset names and expose the selected state.
  - Set decorative icons to `importantForAccessibility="no"`.
  - Add a live region to the login error, and `autofillHints="username"` / `"password"`.
  - Add `AccessibilityAction`s "Move up", "Move down" and "Change status" to library rows.

### [ ] MOB-31 Medium — Edge-to-edge is not handled, although `targetSdk = 36`
- **Where:** `build.gradle.kts:16`; `activity_main.xml:2-35`. There are no
  `fitsSystemWindows`, `WindowInsets` or `enableEdgeToEdge` references anywhere in `mobile/`.
- **Why:** from Android 15, apps targeting SDK 35+ are drawn edge-to-edge, and on Android 16
  the opt-out is gone. Screen headers can sit under the status bar. The fixed-height 72-dp
  bottom nav, plus the fragment container's hard-coded `paddingBottom="80dp"`, will clip or
  overlap under the gesture/navigation bar. **Verify on an Android 15/16 device before
  fixing.**
- **Fix:**
  - Call `enableEdgeToEdge()` in each activity.
  - Apply the status-bar inset to screen headers, and the navigation-bar inset to the bottom
    nav (drop the fixed height).
  - Size the fragment container's bottom padding from the nav's measured height.

### [ ] MOB-32 Low — Touch targets under 48 dp, and 9–11 sp text
- **Where:**
  - Game Details back button, 40×40 dp (`fragment_game_details.xml:36-38`).
  - Library clear-search button, 40×40 dp (`fragment_library.xml:114-116`).
  - Sort button, 40 dp tall (`fragment_library.xml:47-49`).
  - 14 text views at 8–11 sp, including the 9 sp and 10 sp status badges
    (`item_game.xml:55`, `:103`).
- **Why:** Material and Android accessibility guidance call for 48×48 dp targets. 9–10 sp
  all-caps on a coloured badge is unreadable for many users, and fails contrast too (MOB-29).
- **Fix:**
  - Use `minWidth`/`minHeight="48dp"`, or `TouchDelegate`, keeping the visual size.
  - Set a floor of 12 sp.

### [ ] MOB-33 Low — Accent palette differs from the web app, and one preset matches a status colour
- **Where:** `ThemeManager.kt:31-40`, `themes.xml:40-73`, `colors.xml:33`.
- **Why:**
  - The web ships six presets: Violet `#8b5cf6` (the default), Blue, Emerald, Amber, Rose
    and Cyan.
  - The app ships five: Blue `#5B8DEF` (the default), Purple, Green, Orange and Pink. The
    names differ and the hues don't match, so the same user sees two brands.
  - The Purple preset `#8B5CF6` is also the *Unreleased* status colour, and Green and Orange
    match *Done* and *Backlog*. With those accents, an accent-coloured control looks like a
    status.
- **Fix:**
  - Adopt the web's six presets, names and default.
  - Move the status colours off the preset hues, or render status with a shape or icon as
    well as colour.

### [ ] MOB-34 Low — Login input handling
- **Where:** `LoginActivity.kt:81-97`.
- **Why:**
  - The username is lowercased but not trimmed, so an autocorrect trailing space sends
    `"alice "`.
  - A password made only of spaces is refused client-side (`password.trim().isEmpty()`),
    although the server may accept it.
- **Fix:**
  - Trim the username.
  - Only check that the password is non-empty.

### [ ] MOB-35 Low — Smaller UX defects
- **Where and what:**
  - Biometric switch (`ProfileFragment.kt:191-195`): `onAuthenticationFailed` is
    *non-terminal* (the prompt stays open), yet it un-checks the switch. That fires the
    listener, which says "Fingerprint login disabled" while the prompt is still up.
  - Cancelling the auto-shown fingerprint prompt prints
    "Authentication error: Cancel" in the error style (`LoginActivity.kt:58-62`).
  - No re-lock when the app returns from the background. The fingerprint gate runs only at
    cold start. Decide whether it is an app lock; if it is, see MOB-6.
  - Missing price shows "TBA" (`GameDetailsFragment.kt:119`), which reads as an unannounced
    release date.
  - Missing cover in list rows falls back to the system "broken image" icon
    (`GameAdapter.kt:125`); `CoverBinder` already draws a letter tile.
  - About 99% of copy is hard-coded (`strings.xml` has two entries; layouts carry
    `tools:ignore="HardcodedText"`). There is no localisation, and the RTL layout declared by
    `supportsRtl` is untested.
- **Fix:** individually small. Group them into one UI polish PR after MOB-29 to MOB-31.

### [ ] MOB-36 Low — Session and fingerprint polish left over from PR #6 (UI/UX review)
- **Where and what:**
  - `Session.ended` has no replay, so an expiry signalled while another activity is on top
    is dropped. Since PR #6, `MainActivity.onResume` still shows the expiry notice (it reads
    `Session.redirecting`). A future activity that calls the API must collect the flow or
    re-check the session on resume (documented on `Session.ended`).
  - The Sign In button stays enabled during "Checking session…" (`LoginActivity.verifyAndEnter`).
    The token check is already race-safe (`clearIfCurrent`); disabling the button is polish.
  - After cancelling the fingerprint prompt there is no way to retry it: `btnBiometric`
    (`activity_login.xml`) is `gone` and never shown. Show it when `hasLiveToken()` is true.
    Also treat `ERROR_NEGATIVE_BUTTON`/`ERROR_USER_CANCELED` as silent (see MOB-35).
  - Mixed terms: "Sign In" on the button, "sign in again" in the notice, "login with
    password" in the failure text. Settle on "sign in" and "fingerprint". The two toggle-off
    messages also differ ("Fingerprint unlock off." vs "Fingerprint unlock off").
  - The expiry notice is set in `onCreate`, before the view is attached, so the live region
    may not announce it. Use `announceForAccessibility` after layout.
  - When the username is prefilled, focus the password field.
  - The offline notice is a Toast. The rest of the app uses `SnackbarHelper`.
- **Fix:** one small PR, with MOB-35.

---

## Operational notes

- **Android CI runs on the production host.** `.github/workflows/android.yml` (PR #6) runs on
  the self-hosted runner, which is the machine running production (root `CLAUDE.md`,
  "CI/CD Security Pipeline"). A Gradle build executes third-party code: plugins at
  configuration time, `kapt` processors at compile time, and lint jars. So the job never runs
  Gradle on the host. It uses:
  - a throwaway container from a digest-pinned JDK image, with all capabilities dropped,
    `no-new-privileges`, resource limits and a noexec `/tmp`;
  - only `mobile/` mounted: no Docker socket, no `.git`, no secrets;
  - separate cache volumes for pull requests and `main`;
  - pinned SHA-256 hashes for the command-line tools, the Gradle distribution and the wrapper
    jar, plus strict dependency verification.

  It is a separate workflow and never a dependency of `deploy`. With one runner, a mobile
  build can delay a deploy but never skip one. The public-repo same-repo-PR gate from the
  root pipeline applies here too.
  - Nothing executable is trusted from a cache volume: the SDK is reinstalled every run, the
    Gradle distribution is re-downloaded and re-checked, and the Gradle home is pruned to
    the dependency cache BEFORE the build as well as after (CISO review, PR #6).
  - The PR/main volume split prevents accidents, not attacks: a PR runs its own copy of the
    workflow. The same-repo gate is the boundary.
  - **Residual risk:** the SDK components `sdkmanager` installs are verified only against
    Google's repository metadata.
  - **Residual risk, open:** the build container is on Docker's default bridge, so build
    code (kapt, lint jars, unit tests) can reach every port the host publishes and the LAN,
    including the directory server. The fix is two phases: resolve dependencies and the SDK
    with network, then run `--offline` test/lint/assemble under `--network none`. It needs
    iterating on the runner, so it is a follow-up.
  - **Upgrades:** any dependency upgrade (MOB-21) must regenerate the verification metadata
    in the same PR.
- **Visible behaviour change from MOB-3/MOB-5:** after PR #6, a session ends 12 hours after
  sign-in. The user is sent to the login screen with an explanation and **must type their
  password**. Fingerprint no longer revives an expired or logged-out session. Tell users
  before the release that carries it. MOB-9 is the follow-up that restores convenience
  without a long-lived JWT.
- **The backend image does not contain `mobile/`.** `.dockerignore` excludes it (commit
  `96d08d9`). None of the Android tree, its Gradle wrapper jar or its docs reaches the backend
  build context. Keep it that way. A future shared artifact such as `api-contract.json`
  (MOB-25) is read by the backend's *tests*, not by the image.
- **v1 remains frozen for this client.** The app is one of the v1 clients `test/api-contract.test.js`
  protects (it binds to the `steamAppId` alias, among others). Server-side fixes prompted by
  this roadmap must not change a v1 response shape.

---

## Fix log

| ID | PR | Date | Note |
|---|---|---|---|
| MOB-1 | #6 | 2026-09-27 | No logging interceptor in release; debug logs BASIC with `Authorization` redacted. `ApiClientLoggingTest` (MockWebServer) + static pins in `test/runtime.test.js` |
| MOB-2 | #6 | 2026-09-27 | `MainActivity` `exported="false"`, and it re-checks for a live session in `onCreate`/`onResume`. Only the launcher is exported (pinned) |
| MOB-3 | #6 | 2026-09-27 | Logout always removes the token and keeps the username and fingerprint setting (`SessionStore.endSession`, `SessionStoreTest`) |
| MOB-4 | #6 | 2026-09-27 | `auth.xml` excluded from legacy backup, cloud backup and device transfer (pinned) |
| MOB-5 | #6 | 2026-09-27 | `SessionExpiryInterceptor` ends the session only for a 401 on the CURRENT token. The fingerprint unlocks only a live token, then checks `GET /api/user/me`; offline is not a sign-out. Neutral expiry notice |
