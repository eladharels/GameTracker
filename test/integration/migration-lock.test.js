// Migration lock integration test — needs a REAL Postgres, run by the smoke-test job
// inside the backend container. NOT part of `npm test`.
//
// ROADMAP CC-7: runMigrations took a SESSION-level advisory lock and then only called
// client.release(), which returns the connection to the pool with the session -- and
// the lock -- still alive. Whether a lock is held is a fact only the server knows, so
// this asks pg_locks after a run.
const assert = require('assert');
const db = require('../../db');
const { runMigrations } = require('../../schema-migrate');

let n = 0, failed = 0;
const ok = (label) => { n++; console.log('  ok  ' + label); };
const fail = (label, e) => { n++; failed++; console.log('  FAIL ' + label + ' -> ' + e.message); };
async function check(label, fn) { try { await fn(); ok(label); } catch (e) { fail(label, e); } }

// 4127710501 fits in 32 bits, so pg_locks shows it as classid 0 / objid <key>.
const HELD = `SELECT count(*)::int AS n FROM pg_locks
               WHERE locktype = 'advisory' AND classid = 0 AND objid = 4127710501 AND granted`;

(async () => {
  console.log('\nthe migration lock (CC-7):');
  await check('no session still holds the migration lock after a run', async () => {
    await runMigrations();
    const { n: held } = await db.promises.get(HELD, []);
    assert.strictEqual(held, 0, 'the advisory lock survived on a pooled connection');
  });
  await check('a second PROCESS migrating straight after is not blocked by the first', async () => {
    // A separate process, because the lock is re-entrant within one session: this
    // process's pool would reuse the connection that holds it and sail through. The
    // case that hung was a SECOND backend -- an overlapping deploy or a rollback.
    const { execFile } = require('child_process');
    const path = require('path');
    const code = "require('./schema-migrate').runMigrations()"
      + ".then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); })";
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['-e', code],
        { cwd: path.join(__dirname, '..', '..'), timeout: 8000, env: process.env },
        (err, stdout, stderr) => (err
          ? reject(new Error(err.killed ? 'the second process blocked on the migration lock' : String(stderr).trim()))
          : resolve()));
    });
  });

  console.log(`\n${n - failed}/${n} passed`);
  await db.close?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
