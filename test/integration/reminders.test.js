// Release-reminder dedupe integration test — needs a REAL Postgres, and is run by the
// smoke-test job inside the backend container. NOT part of `npm test`.
//
// The dedupe used to be a JSON file with one in-memory copy per process, checked
// before sending and marked after (ROADMAP CC-3, CC-4). Two sweeps overlapping — the
// 08:00 cron, POST /api/admin/check-releases, run_notifications.js — both read "not
// sent" and both delivered to every channel. It is a primary-key claim in
// `sent_reminders` now (migration 006), and the property worth proving is one no stub
// can show: that under real concurrency Postgres lets exactly ONE sweep win.
//
// The notification transport is stubbed through the module object (jobs.js calls
// `notifications.notifyReleaseReminder`), so nothing is actually sent.
//
// NEVER POINT THIS AT A REAL DATABASE. It runs full sweeps over EVERY account: other
// users' due releases are really promoted, and their reminders are answered "not
// delivered" -- harmless only in the throwaway smoke database.
const assert = require('assert');
const db = require('../../db');
const lib = require('../../services/library');
const jobs = require('../../services/jobs');
const notifications = require('../../services/notifications');

let n = 0, failed = 0;
const ok = (label) => { n++; console.log('  ok  ' + label); };
const fail = (label, e) => { n++; failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
async function check(label, fn) { try { await fn(); ok(label); } catch (e) { fail(label, e); } }

const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const USER = 'remtest';

(async () => {
  await db.promises.run('DELETE FROM users WHERE username = ?', [USER]);
  await db.promises.run(
    "INSERT INTO users (username, password, can_manage_users, created_at, origin, notification_days) VALUES (?, 'x', 0, 'now', 'local', '[7]')",
    [USER]);
  const uid = (await db.promises.get('SELECT id FROM users WHERE username = ?', [USER])).id;
  await lib.upsertGame(uid, { gameId: 'igdb_rem1', gameName: 'Rem', releaseDate: iso(7), status: 'unreleased' });

  // Count what WOULD have been sent to this user. Other accounts in the database are
  // swept too; they are answered "not delivered" and never counted.
  const real = { remind: notifications.notifyReleaseReminder, event: notifications.notifyLibraryEvent };
  let sent = 0;
  let deliver = true;
  notifications.notifyReleaseReminder = async (username) => {
    if (username !== USER) return {};
    // A real send takes time; this widens the window two sweeps can overlap in.
    await new Promise((r) => setTimeout(r, 50));
    if (!deliver) return { email: { sent: false } };
    sent++;
    return { email: { sent: true } };
  };
  notifications.notifyLibraryEvent = async () => ({});
  const claims = () => db.promises.all(
    'SELECT type FROM sent_reminders WHERE user_id = ? AND game_id = ?', [uid, 'igdb_rem1']);

  try {
    console.log('\nreminder dedupe (CC-3, CC-4):');
    await check('the old {wasSent, markSent} shape is refused, not silently accepted', async () => {
      let msg = '';
      await jobs.checkReleases({ dedupe: { wasSent: () => false, markSent: () => {} } })
        .catch((e) => { msg = e.message; });
      assert.match(msg, /claim, release/);
    });

    await check('a reminder that no channel delivered is NOT recorded as sent', async () => {
      deliver = false;
      await jobs.checkReleases({ dedupe: jobs.REMINDER_LOG });
      assert.strictEqual(sent, 0);
      assert.deepStrictEqual(await claims(), [], 'an undelivered reminder kept its claim');
      deliver = true;
    });

    await check('THREE overlapping sweeps send the reminder exactly once', async () => {
      // The cron, the admin route and the script, all at once.
      await Promise.all([1, 2, 3].map(() => jobs.checkReleases({ dedupe: jobs.REMINDER_LOG })));
      assert.strictEqual(sent, 1, `sent ${sent} times`);
      assert.deepStrictEqual((await claims()).map((r) => r.type), ['7days']);
    });

    await check('a later sweep, from any process, does not send it again', async () => {
      await jobs.checkReleases({ dedupe: jobs.REMINDER_LOG });
      assert.strictEqual(sent, 1, `sent ${sent} times`);
    });

    await check('deleting the account removes its reminder log', async () => {
      await db.promises.run('DELETE FROM users WHERE id = ?', [uid]);
      const left = await db.promises.all('SELECT 1 FROM sent_reminders WHERE user_id = ?', [uid]);
      assert.strictEqual(left.length, 0);
    });
  } finally {
    notifications.notifyReleaseReminder = real.remind;
    notifications.notifyLibraryEvent = real.event;
  }

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
