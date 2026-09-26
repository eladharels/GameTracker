/**
 * SEC-13: list the accounts an LDAP login may have taken over before P0-1. READ-ONLY.
 *
 *   docker compose -f docker-compose.yaml exec backend node audit_ldap_hashed_accounts.js
 *
 * Before P0-1, a directory login for a username that already existed LOCALLY relabelled
 * the row origin='ldap' and KEPT its password hash. Those rows are the ones below:
 * origin='ldap' AND a local hash. For each, the operator decides (see
 * OPERATOR_RUNBOOK.md, SEC-13):
 *   - a real directory account  -> clear the hash;
 *   - a local account taken over -> set origin='local' and rotate its password;
 *   - EITHER WAY                 -> revoke its API tokens (a token minted during a
 *                                   takeover survives everything else).
 *
 * It changes NOTHING, on purpose. Every row is a judgement about who the account really
 * belongs to, and a script that "fixed" them would have to guess. It prints the facts the
 * judgement needs: the admin flag, when the row was created, and the tokens that exist.
 * The password hash is never printed.
 */
const db = require('./db');

async function main() {
  const rows = await db.promises.all(
    `SELECT u.id, u.username, u.can_manage_users, u.created_at, u.display_name,
            COUNT(t.id) AS tokens,
            MAX(t.created_at) AS newest_token,
            MAX(t.last_used_at) AS token_last_used
       FROM users u
       LEFT JOIN api_tokens t ON t.user_id = u.id
      WHERE u.origin = 'ldap' AND u.password IS NOT NULL AND u.password <> ''
      GROUP BY u.id
      ORDER BY u.can_manage_users DESC, u.username`,
    []);

  if (!rows.length) {
    console.log('[SEC-13] No origin=ldap account holds a local password hash. Nothing to audit.');
    console.log('[SEC-13] Record this outcome under SEC-13 in ROADMAP.md.');
    return;
  }
  console.log(`[SEC-13] ${rows.length} account(s) are origin=ldap AND hold a local password hash:\n`);
  for (const r of rows) {
    console.log(`  id=${r.id}  ${r.username}${r.can_manage_users ? '  [ADMIN]' : ''}`
      + `  created=${r.created_at || 'unknown'}  display_name=${JSON.stringify(r.display_name || '')}`);
    console.log(`      tokens=${r.tokens}  newest_token=${r.newest_token || '-'}  token_last_used=${r.token_last_used || '-'}`);
  }
  console.log('\n[SEC-13] Decide each account by hand: see OPERATOR_RUNBOOK.md, section SEC-13.');
  console.log('[SEC-13] Admin rows first: a taken-over ADMIN is the case that matters most.');
}

main()
  .catch((err) => { console.error('[SEC-13] Audit failed:', err.message); process.exitCode = 1; })
  .finally(() => db.close());
