# GameTracker operator runbook

Steps only someone on the production host can take. Code cannot do these, because each one
needs a person's judgement or host access. Each section names its ROADMAP item. When a step is
done, record the outcome under that item.

Run every `node` command **inside the backend container**, so the `PG*` variables and
`settings.json` are production's own:

```bash
cd /home/docker/gametracker            # wherever docker-compose.yaml lives on the host
docker compose -f docker-compose.yaml exec backend node <script> [args]
```

---

## UP-25: after the full disk (2026-09-26)

On 2026-09-26 the host's `/` reached **100%, with 0 bytes free**. It was mostly BuildKit build
cache (19.4 GB). CI now clears that cache on every build and refuses to build below 5 GiB
free, and the disk recovered to 71% (25 GB free). Production's database **ran on a full disk**
for part of that window, so check for damage before anything else.

1. **The database.** Look for write failures during the window. The times below are **UTC**;
   `--since` and `--until` are read in the host's local timezone unless they end in `Z`.
   ```bash
   docker compose -f docker-compose.yaml logs --since 2026-09-26T09:00:00Z --until 2026-09-26T11:10:00Z db \
     | grep -iE "no space|could not (write|extend)|PANIC|FATAL" | head -50
   docker compose -f docker-compose.yaml logs --since 2026-09-26T09:00:00Z --until 2026-09-26T11:10:00Z backend \
     | grep -iE "ENOSPC|no space|DB error|Database error" | head -50
   ```
   - If both are empty, nothing was lost.
   - If Postgres logged `PANIC` or `could not write`, run the integrity check below and compare
     row counts against the last backup:
     ```bash
     docker compose -f docker-compose.yaml exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
       "SELECT count(*) AS users FROM users; SELECT count(*) AS games FROM user_games;"'
     ```
2. **Where the other ~20 GB goes.** Docker accounted for about 35 GB of the 59 GB used after the
   prune. Find the rest:
   ```bash
   sudo du -xh --max-depth=2 / 2>/dev/null | sort -h | tail -25
   sudo journalctl --disk-usage
   docker system df -v | head -60
   ```
   The usual suspects are container logs under `/var/lib/docker/containers/*/*-json.log`, the
   journal, and other projects on the same host (GameTracker-stg shares this daemon).
3. **The 1.9 GB of unreferenced Docker volumes.** CI never prunes volumes, because this host
   holds the production database, and **other applications' databases** too (see the header of
   `docker-compose.yaml`: another app and Guacamole run Postgres here). "Dangling" only means
   no container is attached right now: a database volume whose stack is stopped is dangling.
   ```bash
   docker volume ls -f dangling=true
   docker volume inspect <name> --format '{{ index .Labels "com.docker.compose.project" }} {{ .CreatedAt }}'
   ```
   - The production volume is PROJECT-PREFIXED, e.g. `<project>_gametracker-pgdata`, because
     the compose file sets no `name:`. Never remove it, or any volume whose project label
     belongs to a stack you still run, staging included.
   - Before removing anything, take a backup, then remove volumes one at a time:
     ```bash
     docker run --rm -v <name>:/v -v "$PWD":/b alpine tar czf /b/<name>.tgz -C /v .
     docker volume rm <name>
     ```
   - `docker volume prune` is **not** safe on this host.
4. **Disk alerting.** Nothing warned before the disk filled. A minimal version reuses the ntfy
   server you already run. Add it to root's crontab:
   ```
   */30 * * * * [ "$(df -P / | awk 'NR==2 {print $5+0}')" -ge 85 ] && curl -s -d "gametracker host disk at $(df -P / | awk 'NR==2 {print $5}')" https://<your-ntfy>/<topic>
   ```
   If that ntfy server runs on this same host, a full disk can stop it delivering the alert.
   Prefer an ntfy server somewhere else, or ntfy.sh.

---

## SEC-13: accounts taken over before P0-1

Before P0-1, a directory (LDAP) login for a username that already existed locally relabelled
the row `origin='ldap'` and **kept its local password hash**.

- **Login** has been safe since P0-1: it ignores the directory's claim on any row with a hash.
- **Token minting** follows the same rule since the SEC-13 follow-up: a row with a hash is
  checked against that hash, never the directory.

What is left is data: rows that may still belong to the wrong person, and tokens minted while
they did.

1. **List the candidates.** This step is read-only and prints no hashes:
   ```bash
   docker compose -f docker-compose.yaml exec backend node audit_ldap_hashed_accounts.js
   ```
   Admin rows print first. If it reports none, record "no affected accounts" under SEC-13 and
   stop.
2. **Decide each row.** Who does this account really belong to?
   - **A real directory user**, created by an LDAP login, whose row somehow gained a hash.
     Clear the hash so only the directory decides:
     ```sql
     UPDATE users SET password = NULL
      WHERE id = <id> AND origin = 'ldap' AND username NOT IN ('root', 'me');
     ```
     Never clear root's hash: that locks root out. Root is always a local account.
   - **A local account that was taken over**, for example `root` or an admin created by hand.
     Give it back and rotate its password:
     ```sql
     UPDATE users SET origin = 'local' WHERE id = <id>;
     ```
     Then set a new password. For root, use `reset-root-password.js` with `NEW_ROOT_PASSWORD`;
     for anyone else, use User Management.

     Then **review what the takeover could have changed**:
     - The directory login wrote its own `email` into the row.
     - Whoever held the account could have set notification channels (`ntfy_url`,
       `ntfy_topic`, `gotify_url`, `gotify_token`, `telegram_chat_id`), or shared the library
       with themselves.
     ```sql
     SELECT email, ntfy_url, ntfy_topic, gotify_url, telegram_chat_id FROM users WHERE id = <id>;
     SELECT * FROM user_shares WHERE from_user = '<username>' OR to_user = '<username>';
     ```
     Reset anything the real owner does not recognise.

   Run the SQL with
   `docker compose -f docker-compose.yaml exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
3. **Either way, revoke the account's API tokens.** A token minted during a takeover survives
   every step above.
   ```bash
   docker compose -f docker-compose.yaml exec backend node create-api-token.js <username> --list
   docker compose -f docker-compose.yaml exec backend node create-api-token.js <username> --revoke <token-id>
   ```
   You can also revoke them all at once through the API, as an admin:
   `DELETE /api/v2/users/<id>/tokens`.
4. **Sessions.** If `JWT_SECRET` was not rotated at the P0-1 deploy, rotate it now. That ends
   every session from before the fix, and everyone signs in again. Update the GitHub Actions
   secret, then let the next deploy pick it up.
5. **Record** each account and the decision under SEC-13 in ROADMAP.md.

---

## UP-24: move settings.json into a directory mount

**Why.** Production bind-mounts `settings.json` as a single FILE, and `rename(2)` cannot replace
a mount point. So a settings save there is an in-place rewrite that can tear if the process
dies mid-write (UP-8). With a DIRECTORY mount every save is atomic.

**Safety net.** The backend now refuses to start when `SETTINGS_DIR` is set but the directory
has no `settings.json`, and it names the fix (`settings-store.js#checkSettingsLocation`).
Without that check, a half-done migration would start with LDAP and every API key unset, and
the first admin save would write a near-empty file.

**Do it on staging first** (GameTracker-stg), then on production.

**Precondition.** A release that understands `SETTINGS_DIR` (commit 9e38767 or later) must
ALREADY be deployed and running before the compose change below deploys. The deploy job keeps
the running image as `:previous` and rolls back to it automatically on a failed health check.
If that previous image predates `SETTINGS_DIR`, the rollback would start it on the new mounts
with no settings file at all.

1. **On the host, copy the file into a new directory.** Keep the original file too; it is the
   rollback:
   ```bash
   sudo mkdir -p /home/docker/gametracker/data/config
   sudo cp -p /home/docker/gametracker/data/settings.json /home/docker/gametracker/data/config/settings.json
   sudo chown -R 1000:1000 /home/docker/gametracker/data/config
   ```
2. **Change the backend service in `docker-compose.yaml`** in one commit. Make the same-shape
   change in `docker-compose.test.yml`, which must match production's shape.
   ```yaml
   volumes:
     # was: - /home/docker/gametracker/data/settings.json:/app/settings.json
     - /home/docker/gametracker/data/config:/app/config
   environment:
     - SETTINGS_DIR=/app/config
   ```
   The test stack's equivalent mount is
   `${SMOKE_DATA_DIR}/config:/app/config`. Its seed step in
   `.github/workflows/docker-build-deploy.yml` (the `echo '{}' > .../settings.json` line) must
   then write `${SMOKE_DATA_DIR}/config/settings.json` instead. Otherwise the startup check
   correctly refuses the smoke stack.

   In the same commit, remove `SETTINGS_DIR` from the `NOT_PASSED` table in
   `test/runtime.test.js`, since compose now passes it.
3. **Right before deploying, redo the step-1 copy.** A settings save made between step 1 and
   the deploy would otherwise be lost:
   ```bash
   sudo cp -p /home/docker/gametracker/data/settings.json /home/docker/gametracker/data/config/settings.json
   ```
   Then deploy, and check:
   - Settings → LDAP and API Keys still show as configured, and a directory user can sign in.
   - A save is atomic: change a harmless value, save, and confirm the file changed inside the
     directory:
     ```bash
     ls -l /home/docker/gametracker/data/config/
     ```
4. **Rollback.** Revert the compose commit. The old `data/settings.json` is still there, but it
   is **stale** if anything was saved after step 1. Copy the newer file back first:
   ```bash
   sudo cp -p /home/docker/gametracker/data/config/settings.json /home/docker/gametracker/data/settings.json
   ```
5. **After a week without trouble,** remove the old `data/settings.json`, and record UP-24 done.

---

## MOB-38: run the CI runner as a non-root user

The self-hosted runner is the production host, and it runs every job as root. Since the
MOB-38 change no workflow step needs root any more:
- gitleaks and trivy are cached in the runner user's own `~/.cache/gametracker-tools`,
  re-checksummed every run, and run by path;
- the smoke stack's data directory changes owner through a throwaway container, run from a
  digest-pinned image (never the PR's own build), and is emptied as uid 1000 with no
  capabilities;
- the APK signing containers run as the runner's own uid, so they can read its 0600 key and
  leave nothing root-owned behind;
- `test/runtime.test.js` fails if `sudo` comes back in any workflow.

What is left is on the host. Do it in a quiet window. A run that starts mid-way fails, and
re-running it is safe.

**Know what this buys.** Membership of the `docker` group is still root-equivalent on this
host: anyone who can run `docker run -v /:/host` owns it. So this stops ACCIDENTS (a step
writing where it should not, a tool installed over a system binary), not a determined
attacker. The durable fixes are in the root `CLAUDE.md`: GitHub-hosted runners for pull
requests, or a private repository.

1. **Check a green run on `main` first**, still as root, so a later failure is the switch and
   not the code.
2. **Create the user**, with Docker access and no sudo rights:
   ```bash
   sudo useradd --create-home --shell /bin/bash gha-runner
   sudo usermod -aG docker gha-runner
   ```
3. **Stop the service and hand the runner directory over.** The directory below is where
   this host's runner lives (`/srv/actions-runner`, per the job logs).
   ```bash
   cd /srv/actions-runner
   sudo ./svc.sh stop
   sudo ./svc.sh uninstall
   sudo chown -R gha-runner:gha-runner /srv/actions-runner
   ```
4. **The one host path a job writes to** outside its workspace: the published APK directory
   (MOB-40). Give it to the runner and keep it world-readable, because nginx reads it
   read-only:
   ```bash
   sudo chown gha-runner:gha-runner /home/docker/gametracker/apk
   sudo chmod 755 /home/docker/gametracker/apk
   sudo chown gha-runner:gha-runner /home/docker/gametracker/apk/gametracker.apk 2>/dev/null || true
   ```
   Nothing else needs to change. Deploy only runs `docker compose`: the daemon reads the
   bind mounts in `/home/docker/gametracker/data`, the runner does not. The data directory
   stays owned by `1000:1000` (see "Post-Deploy Requirement" in `CLAUDE.md`).
5. **Install the service as that user and start it:**
   ```bash
   sudo ./svc.sh install gha-runner
   sudo ./svc.sh start
   ps -o user= -p "$(pgrep -f Runner.Listener)"     # must print gha-runner
   ```
6. **Verify:** re-run the latest `main` workflow and the Android one, from GitHub ->
   Actions -> Re-run all jobs. Then check four things:
   - every job is green;
   - the Android job's "Sign and publish" step logs `[android] published`;
   - `/download/gametracker.apk` still downloads;
   - `ls -l /home/docker/gametracker/apk` shows `gha-runner`.
7. **Optional clean-up**, once a week of runs is green:
   - Delete the old root-installed `/usr/local/bin/gitleaks` and `/usr/local/bin/trivy`.
     Nothing uses them now: the jobs put their own verified copies first on PATH.
   - Delete root's caches: `/root/.cache/gametracker-semgrep`, `/root/.cache/trivy`.

**Rollback:** `sudo ./svc.sh stop && sudo ./svc.sh uninstall`, then
`sudo chown -R root:root /srv/actions-runner`, then `sudo ./svc.sh install root` and
`sudo ./svc.sh start`. Name `root` explicitly: with no argument `svc.sh` installs the service
as `$SUDO_USER`, which under `sudo` is YOUR account, not root.

Record the date under MOB-38 in `mobile/ROADMAP.md` when done.

---

## MOB-40: the Android release signing key

`android.yml` publishes the app at `/download/gametracker.apk` only when a signing key is
configured. Until then, every main build logs a warning and publishes nothing. This is a
one-time setup and cannot be done from code, because the key must never be in the repo.

1. **Create the key once**, on a trusted machine (not the production host), and **back it
   up** offline. A lost key means no future APK can update an installed one.
   ```bash
   keytool -genkeypair -v -keystore gametracker-release.p12 -storetype PKCS12 \
     -alias gametracker -keyalg RSA -keysize 4096 -validity 10000 \
     -dname "CN=GameTracker"
   base64 -w0 gametracker-release.p12 > gametracker-release.p12.b64
   ```
2. **GitHub → Settings → Environments → New environment `android-release`.**
   - Deployment branches and tags: **Selected branches → `main`** only. This rule is what
     keeps a pull request's copy of the workflow from reaching the key. Not "Protected
     branches only": `main` is not protected, so that would admit nothing (or, once it is,
     not what you expect).
   - Do **not** add required reviewers: every Android build on `main` runs in this
     environment and would then wait for an approval.
   - Environment secrets:
     - `ANDROID_KEYSTORE_BASE64`: the contents of the `.b64` file;
     - `ANDROID_KEYSTORE_PASSWORD`;
     - `ANDROID_KEY_ALIAS` (`gametracker` above);
     - `ANDROID_KEY_PASSWORD`, only if it differs from the keystore password (for PKCS12 it
       does not).
   - Do **not** add them as repository secrets: a repository secret is readable by any
     same-repo pull request's workflow.
   - Delete the local `.b64` file.
3. **Publish.** Re-run the latest "Android — GameTracker Mobile" run on `main`, or push any
   change under `mobile/`. Only a run whose commit is still `main`'s head publishes: an
   older run re-run publishes nothing, so it can never put an older app at the URL. The job log prints the signer's SHA-256 certificate digest and the
   published file's hash. Record the certificate digest here.
4. **Check** that `https://gametracker.etech.ink/download/gametracker.apk` downloads. The file
   lives at `/home/docker/gametracker/apk/gametracker.apk` on the host. That directory holds
   that one file and nothing else, and CI deletes anything else it finds there.

- **Installing:** phones need "Install unknown apps" allowed for the browser. Play Protect may
  warn about an unrecognised developer; choose "Install anyway". After the first install,
  each new download installs as an update.
- **Switching from the old app** (`com.example.gmaetrackermobile`, every APK before MOB-20):
  the new app id makes it a DIFFERENT app, so the new APK installs ALONGSIDE it. The old one
  keeps working and never updates again, and with fingerprint unlock on it still holds a live
  30-day library token. Tell users: **sign out in the old app first** (that revokes its token),
  then uninstall it. If it was uninstalled without signing out, revoke its "Android app"
  sign-in in My Account on the web. **Its ratings and notes stay with the old app** and are
  lost when it is uninstalled (MOB-11: they exist only on the device).
- **A debug or Android Studio build of the NEW id** is signed with a different key: Android
  refuses the download ("App not installed") until that copy is uninstalled.
- **Signer certificate SHA-256:** _record it here after step 3._

