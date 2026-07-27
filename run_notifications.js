// Manually trigger the release check — the same sweep the 08:00 cron runs.
//
// It used to REIMPLEMENT that sweep, and its own header admitted the copy had already
// drifted twice: it hardcoded 30/7/0-day reminders and ignored users.notification_days,
// and it marked the release-day reminder with a different dedup key than the cron, so
// running it re-sent a day-0 reminder the cron had already delivered.
//
// "This must mirror the cron exactly" is not a thing a comment can enforce. It calls
// services/jobs.js#checkReleases now, which is the only implementation there is — the
// cron and POST /api/admin/check-releases call the same function.
//
// Run inside the backend container so the PG* variables and settings.json are the
// ones production uses:
//   docker compose -f docker-compose.yaml exec backend node run_notifications.js
const { db, dedupe } = require('./index.js');
const jobs = require('./services/jobs');

jobs.checkReleases({ dedupe })
  .then((report) => {
    console.log('[MANUAL] Release check complete.');
    console.log(`  users checked : ${report.usersChecked}`);
    console.log(`  promoted      : ${report.promoted.length}`);
    for (const p of report.promoted) console.log(`      ${p.username} — ${p.gameName}`);
    console.log(`  reminders sent: ${report.remindersSent.length}`);
    for (const r of report.remindersSent) console.log(`      ${r.username} — ${r.gameName} (${r.days}d)`);
    if (report.errors.length) {
      console.log(`  errors        : ${report.errors.length}`);
      for (const e of report.errors) console.log(`      ${e.username} — ${e.gameName || ''} ${e.error}`);
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('[MANUAL] Release check failed:', err.message);
    process.exitCode = 1;
  })
  // The pool must be closed or the script hangs on idle sockets. Note db.js
  // divergence: pool.end() abandons queries still waiting for a connection WITHOUT
  // invoking their callbacks, so everything above is awaited before we get here.
  .finally(() => db.close());
