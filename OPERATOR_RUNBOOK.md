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

1. **The database.** Look for write failures during the window:
   ```bash
   docker compose -f docker-compose.yaml logs --since 2026-09-26T09:00:00 --until 2026-09-26T11:10:00 db \
     | grep -iE "no space|could not (write|extend)|PANIC|FATAL" | head -50
   docker compose -f docker-compose.yaml logs --since 2026-09-26T09:00:00 --until 2026-09-26T11:10:00 backend \
     | grep -iE "ENOSPC|no space|DB error|Database error" | head -50
   ```
   - If both are empty, nothing was lost.
   - If Postgres logged `PANIC` or `could not write`, run the integrity check below and compare
     row counts against the last backup:
     ```bash
     docker compose -f docker-compose.yaml exec db psql -U gametracker -c \
       "SELECT count(*) AS users FROM users; SELECT count(*) AS games FROM user_games;"
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
   holds the production database. Look before deleting anything:
   ```bash
   docker volume ls -f dangling=true
   docker volume inspect <name>        # check what created it and when
   ```
   Never remove `gametracker-pgdata`, or any volume a staging stack still uses. Remove the
   others one at a time with `docker volume rm <name>`. `docker volume prune` is not safe here.
4. **Disk alerting.** Nothing warned before the disk filled. A minimal version reuses the ntfy
   server you already run. Add it to root's crontab:
   ```
   */30 * * * * [ "$(df -P / | awk 'NR==2 {print $5+0}')" -ge 85 ] && curl -s -d "gametracker host disk at $(df -P / | awk 'NR==2 {print $5}')" https://<your-ntfy>/<topic>
   ```

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
     UPDATE users SET password = NULL WHERE id = <id> AND origin = 'ldap';
     ```
   - **A local account that was taken over**, for example `root` or an admin created by hand.
     Give it back and rotate its password:
     ```sql
     UPDATE users SET origin = 'local' WHERE id = <id>;
     ```
     Then set a new password. For root, use `reset-root-password.js` with `NEW_ROOT_PASSWORD`;
     for anyone else, use User Management.

   Run the SQL with `docker compose -f docker-compose.yaml exec db psql -U gametracker`.
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
3. **Deploy.** Then check:
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
