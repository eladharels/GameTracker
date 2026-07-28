// Unit tests for ldap-helpers.js.  Run with: npm test
//
// SCOPE RULE -- READ BEFORE ADDING TO THIS FILE:
// This file tests PURE FUNCTIONS ONLY. No database, no directory, no network, no
// filesystem. That is what lets it be one stdlib-only file with no framework, no
// config and no CI service containers, and it is the only reason a test gate is
// affordable in a project that deliberately has none.
//
// Anything needing a real Postgres or a real LDAP server belongs in the smoke test
// (docker-compose.test.yml), NOT here. The moment this file needs a service, it has
// stopped being cheap and has become the test framework this project chose to avoid.
//
// ONE MODULE HERE HAS DEPENDENCIES: services/notifications.js requires db.js and
// settings-store.js. It is in scope anyway, and deleting these tests to honour the
// paragraph above would be the wrong reading. The rule is about what the tests TOUCH
// at run time, and these touch nothing: `pg`'s Pool is lazy, so requiring db.js
// opens no connection (verified with every PG* variable unset, which is also CI's
// situation), and the functions exercised — the guards, and dispatch() via the
// `transports` seam — take their inputs as arguments and perform no I/O.
//
// dispatch() is here rather than in the smoke test on purpose. Its contract, that
// one channel's failure never stops another, was broken in production precisely
// because nothing could reach it: the channel table used to close over the transport
// bindings directly. The seam exists so this file can assert it.
//
// Why these particular functions: both the escaping and the attribute lookup guard
// defects that are invisible to code review. Swapping two .replace() calls in
// escapeLdapFilterValue still looks correct but breaks the escaping; a directory
// answering `memberof` instead of `memberOf` used to refuse EVERY login while
// failing closed, so it presented as a directory outage rather than as our bug.
const assert = require('assert');
const {
  escapeLdapFilterValue, buildUserSearchFilter, entryAttributes, attrValue, attrValues,
  isCompatMirrorDn, compatTreeAdvice,
} = require("../ldap-helpers");
const { escapeIgdbSearch } = require('../igdb-helpers');
const { validateUsername, RESERVED_USERNAMES } = require('../user-rules');

let n = 0;
const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };

console.log('escapeLdapFilterValue:');
check('escapes * ( ) \\ and NUL', () => {
  assert.strictEqual(escapeLdapFilterValue('*'), '\\2a');
  assert.strictEqual(escapeLdapFilterValue('('), '\\28');
  assert.strictEqual(escapeLdapFilterValue(')'), '\\29');
  assert.strictEqual(escapeLdapFilterValue('\\'), '\\5c');
  assert.strictEqual(escapeLdapFilterValue('a\0b'), 'a\\00b');
});
check('backslash first — no double escaping', () => {
  // If * were escaped before \, the \ of \2a would itself be escaped to \5c2a.
  assert.strictEqual(escapeLdapFilterValue('\\*'), '\\5c\\2a');
});
check('null/undefined become empty', () => {
  assert.strictEqual(escapeLdapFilterValue(null), '');
  assert.strictEqual(escapeLdapFilterValue(undefined), '');
});

console.log('buildUserSearchFilter:');
check('wildcard cannot escape the assertion', () => {
  const f = buildUserSearchFilter('*');
  assert.strictEqual(f, '(|(sAMAccountName=\\2a)(uid=\\2a))');
  assert.ok(!/=\*/.test(f), 'a bare * survived into the filter');
});
check('injected assertion is neutralised', () => {
  const f = buildUserSearchFilter(')(uid=admin');
  assert.ok(!f.includes(')(uid=admin)'), 'filter injection succeeded');
  assert.strictEqual(f, '(|(sAMAccountName=\\29\\28uid=admin)(uid=\\29\\28uid=admin))');
});

console.log('entryAttributes:');
check('prefers .values over deprecated .vals', () => {
  const a = entryAttributes({ attributes: [{ type: 'cn', values: ['new'], vals: ['old'] }] });
  assert.strictEqual(a.cn, 'new');
});
check('falls back to .vals when .values is absent', () => {
  const a = entryAttributes({ attributes: [{ type: 'cn', vals: ['old'] }] });
  assert.strictEqual(a.cn, 'old');
});
check('single value scalar, multi value array', () => {
  const a = entryAttributes({ attributes: [
    { type: 'cn', values: ['one'] },
    { type: 'memberOf', values: ['g1', 'g2'] },
  ] });
  assert.strictEqual(a.cn, 'one');
  assert.deepStrictEqual(a.memberOf, ['g1', 'g2']);
});
check('null prototype — a __proto__ attribute cannot pollute', () => {
  const a = entryAttributes({ attributes: [{ type: '__proto__', values: ['{"polluted":true}'] }] });
  assert.strictEqual(Object.getPrototypeOf(a), null);
  assert.strictEqual({}.polluted, undefined);
});
check('handles a missing/empty entry', () => {
  assert.deepStrictEqual(Object.keys(entryAttributes(null)), []);
  assert.deepStrictEqual(Object.keys(entryAttributes({})), []);
});

console.log('attrValue / attrValues (RFC 4512 case-insensitivity):');
check('finds a lowercase attribute when asked for camelCase', () => {
  assert.strictEqual(attrValue({ displayname: 'Ada Lovelace' }, 'displayName', 'cn'), 'Ada Lovelace');
});
check('finds an UPPERCASE attribute too', () => {
  assert.strictEqual(attrValue({ MAIL: 'a@b.c' }, 'mail', 'email'), 'a@b.c');
});
check('honours the order of the requested names', () => {
  assert.strictEqual(attrValue({ displayname: 'Real Name', cn: 'uid123' }, 'displayName', 'cn'), 'Real Name');
  assert.strictEqual(attrValue({ cn: 'uid123' }, 'displayName', 'cn'), 'uid123');
});
check('skips empty values and falls through', () => {
  assert.strictEqual(attrValue({ displayName: '', cn: 'uid123' }, 'displayName', 'cn'), 'uid123');
});
check('returns null when nothing matches', () => {
  assert.strictEqual(attrValue({ cn: 'x' }, 'mail'), null);
  assert.strictEqual(attrValue(null, 'mail'), null);
});
check('attrValues always returns an array', () => {
  assert.deepStrictEqual(attrValues({ memberof: ['g1', 'g2'] }, 'memberOf'), ['g1', 'g2']);
  assert.deepStrictEqual(attrValues({ memberOf: 'g1' }, 'memberOf'), ['g1']);
  assert.deepStrictEqual(attrValues({}, 'memberOf'), []);
});
check('the requiredGroup regression: lowercase memberof is no longer invisible', () => {
  const foundUser = entryAttributes({ attributes: [{ type: 'memberof', values: ['CN=Gamers,DC=example,DC=com'] }] });
  // Old code: foundUser.memberOf || []  ->  [] -> every login refused.
  assert.deepStrictEqual(foundUser.memberOf, undefined);
  assert.deepStrictEqual(attrValues(foundUser, 'memberOf'), ['CN=Gamers,DC=example,DC=com']);
});

console.log('isCompatMirrorDn (the FreeIPA duplicate that broke LDAP login):');
check('identifies the cn=compat mirror', () => {
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=users,cn=compat,dc=etech,dc=com'), true);
  assert.strictEqual(isCompatMirrorDn('UID=JANE,CN=USERS,CN=COMPAT,DC=ETECH,DC=COM'), true);
});
check('leaves the canonical cn=accounts entry alone', () => {
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=users,cn=accounts,dc=etech,dc=com'), false);
  assert.strictEqual(isCompatMirrorDn('CN=Jane,OU=Staff,DC=corp,DC=example'), false);
});
check('does not match a substring of another RDN value', () => {
  // `cn=compatibility` is a different container and must NOT be dropped, or a real
  // account could be hidden — the one way this filter could do harm.
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=compatibility,dc=etech,dc=com'), false);
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=nocompat,dc=etech,dc=com'), false);
  assert.strictEqual(isCompatMirrorDn('cn=compat-team,dc=etech,dc=com'), false);
});
check('tolerates empty/missing input', () => {
  assert.strictEqual(isCompatMirrorDn(''), false);
  assert.strictEqual(isCompatMirrorDn(null), false);
  assert.strictEqual(isCompatMirrorDn(undefined), false);
});
console.log('compatTreeAdvice (diagnostic only — NOTHING is filtered):');
check('advises when a compat entry is among the matches', () => {
  const advice = compatTreeAdvice([
    'uid=jane,cn=users,cn=compat,dc=etech,dc=com',
    'uid=jane,cn=users,cn=accounts,dc=etech,dc=com',
  ], 'dc=etech,dc=com');
  assert.match(advice, /Narrow the LDAP base/);
  // Must NOT nominate one of the matched DNs as the real one — in the attack this
  // guard exists to stop, that would be pointing the operator at the attacker.
  assert.ok(!advice.includes('uid=jane'), 'advice named a specific matched entry');
});
check('stays silent when the compat tree is not involved', () => {
  assert.strictEqual(compatTreeAdvice([
    'uid=jane,ou=staff,dc=etech,dc=com',
    'uid=jane,ou=contractors,dc=etech,dc=com',
  ], 'dc=etech,dc=com'), null);
  assert.strictEqual(compatTreeAdvice([], 'dc=etech,dc=com'), null);
  assert.strictEqual(compatTreeAdvice(null, 'dc=etech,dc=com'), null);
});

console.log('THE INVARIANT: no DN-shape rule may ever shrink an auth result set');
check('ldap-helpers exports no filtering function', () => {
  // Both bypasses came from a helper that removed entries from the search result
  // before the ambiguity guard counted them. The guard is only fail-closed if the
  // set it counts is complete. If a future change reintroduces such a helper, this
  // fails and points at the two CVEs-in-miniature recorded in ldap-helpers.js.
  const exported = Object.keys(require('../ldap-helpers'));
  const filtering = exported.filter(name => /^(drop|filter|dedupe|prune|collapse|resolve)/i.test(name));
  assert.deepStrictEqual(filtering, [],
    `ldap-helpers exports filtering helper(s): ${filtering.join(', ')} — read the header comment before adding one`);
});
check('isCompatMirrorDn is diagnostic only and still identifies the tree', () => {
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=users,cn=compat,dc=etech,dc=com'), true);
  assert.strictEqual(isCompatMirrorDn('uid=jane,cn=compatibility,dc=etech,dc=com'), false);
});

console.log('escapeIgdbSearch:');
check('escapes the quote AND the backslash', () => {
  assert.strictEqual(escapeIgdbSearch('Half-Life "2"'), 'Half-Life \\"2\\"');
  assert.strictEqual(escapeIgdbSearch('Doom\\'), 'Doom\\\\');
});
check('a trailing backslash cannot consume the closing quote', () => {
  // The bug this replaced: stripping `"` but leaving `\` meant `Doom\` produced
  // search "Doom\" — the backslash escapes our own closing quote and the rest of
  // the APIcalypse query is swallowed into the string literal.
  const emitted = `search "${escapeIgdbSearch('Doom\\')}";`;
  assert.strictEqual(emitted, 'search "Doom\\\\";');
  // Count unescaped quotes: must be exactly the two we wrote ourselves.
  assert.strictEqual(emitted.replace(/\\./g, '').match(/"/g).length, 2);
});
check('an injection attempt stays inside the literal', () => {
  const emitted = `search "${escapeIgdbSearch('a\\"; fields *; limit 500;')}";`;
  assert.strictEqual(emitted.replace(/\\./g, '').match(/"/g).length, 2);
});
check('null/undefined become empty', () => {
  assert.strictEqual(escapeIgdbSearch(null), '');
  assert.strictEqual(escapeIgdbSearch(undefined), '');
});

console.log('validateUsername:');
check('rejects every reserved username', () => {
  for (const name of RESERVED_USERNAMES) assert.ok(validateUsername(name), `${name} was allowed`);
  // `me` is the load-bearing one: /api/user/me/* is registered first and would
  // permanently shadow such an account.
  assert.match(validateUsername('me'), /reserved/);
});
check('rejects an empty username', () => {
  assert.ok(validateUsername(''));
});
check('accepts an ordinary username', () => {
  assert.strictEqual(validateUsername('jane'), null);
});

// services/settings.js is in scope for THIS FILE only via its pure functions.
// mergeSection, maskSecrets, maskKey and normalizeApiKeyValue take and return plain
// objects. readForRole/write/listApiKeys/writeApiKeys touch settings.json and must
// stay out — requiring the module is fine, calling those is not.
const {
  mergeSection, maskSecrets, maskKey, normalizeApiKeyValue, SECRET_PLACEHOLDER,
} = require('../services/settings');

console.log('mergeSection (the partial write that killed LDAP login in production):');
check('a partial section MERGES — absent keys are not deleted', () => {
  // The outage: POST {"ldap":{"url":"ldaps://new"}} REPLACED the section, so
  // bindPass, bindDn, base and requiredGroup vanished. 200 OK, and every LDAP
  // login failed from that moment. The browser never tripped it because the form
  // always posts every field.
  const existing = { ldap: { url: 'ldaps://old', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'secret' } };
  const merged = mergeSection({ url: 'ldaps://new' }, 'ldap', existing);
  assert.deepStrictEqual(merged, {
    url: 'ldaps://new', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'secret',
  });
});
check('the placeholder means "leave the secret alone"', () => {
  const existing = { ldap: { url: 'ldaps://x', bindPass: 'secret' } };
  const merged = mergeSection({ url: 'ldaps://x', bindPass: SECRET_PLACEHOLDER }, 'ldap', existing);
  assert.strictEqual(merged.bindPass, 'secret');
});
check('an ABSENT secret also leaves it alone', () => {
  // The other way a caller says "don't touch this", and the default idiom of a
  // generated OpenAPI client doing a partial update.
  const existing = { smtp: { host: 'mail', pass: 'secret' } };
  assert.strictEqual(mergeSection({ host: 'mail2' }, 'smtp', existing).pass, 'secret');
});
check('an EMPTY STRING still clears a secret', () => {
  // The deliberate way to unset one — must keep working, or an admin can never
  // remove a stored password.
  const existing = { smtp: { host: 'mail', pass: 'secret' } };
  assert.strictEqual(mergeSection({ pass: '' }, 'smtp', existing).pass, '');
});
check('the placeholder with no stored secret does not become a literal password', () => {
  const merged = mergeSection({ bot_token: SECRET_PLACEHOLDER }, 'telegram', {});
  assert.strictEqual(merged.bot_token, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(merged, 'bot_token'));
});
check('"leave it alone" preserves a NON-STRING stored secret', () => {
  // `typeof prior[key] === 'string'` failed for a hand-edited numeric password, so
  // the else-branch DELETED it — the partial-write bug surviving inside its own fix.
  const merged = mergeSection({ bindPass: SECRET_PLACEHOLDER }, 'ldap', { ldap: { bindPass: 12345678 } });
  assert.strictEqual(merged.bindPass, 12345678);
});
check('a section that is not an object is rejected, not spread', () => {
  // `{...prior, ...'pwn'}` stored {"0":"p","1":"w","2":"n"}; a long string stored one
  // key per character.
  for (const bad of ['pwn', 42, ['a', 'b'], true]) {
    assert.throws(() => mergeSection(bad, 'ldap', {}), /must be an object/,
      `${JSON.stringify(bad)} was accepted as a section`);
  }
  // null keeps meaning "no change".
  assert.deepStrictEqual(mergeSection(null, 'ldap', { ldap: { url: 'x' } }), { url: 'x' });
});
check('the placeholder is not honoured for a NON-secret field', () => {
  // Only the declared secret fields get the sentinel treatment; anywhere else it is
  // just a string the admin typed, and storing it verbatim is correct.
  assert.strictEqual(mergeSection({ url: SECRET_PLACEHOLDER }, 'ldap', {}).url, SECRET_PLACEHOLDER);
});

console.log('maskSecrets:');
check('every declared secret is replaced, and nothing else is', () => {
  const masked = maskSecrets({
    smtp: { host: 'mail.example', user: 'bot', pass: 'hunter2' },
    ldap: { url: 'ldaps://x', bindDn: 'cn=svc', bindPass: 'bindpw' },
    telegram: { bot_token: '123:ABC' },
  });
  assert.strictEqual(masked.smtp.pass, SECRET_PLACEHOLDER);
  assert.strictEqual(masked.ldap.bindPass, SECRET_PLACEHOLDER);
  assert.strictEqual(masked.telegram.bot_token, SECRET_PLACEHOLDER);
  assert.strictEqual(masked.smtp.host, 'mail.example');
  assert.strictEqual(masked.ldap.bindDn, 'cn=svc');
  const dumped = JSON.stringify(masked);
  for (const secret of ['hunter2', 'bindpw', '123:ABC']) {
    assert.ok(!dumped.includes(secret), `${secret} leaked through maskSecrets`);
  }
});
check('an UNSET secret stays empty — the UI must tell the two apart', () => {
  assert.strictEqual(maskSecrets({ smtp: { pass: '' } }).smtp.pass, '');
});
check('a NON-STRING secret is masked too', () => {
  // `typeof val === 'string'` sent a hand-edited numeric SMTP password, and an
  // object-valued bind password, to the admin's browser in cleartext.
  const masked = maskSecrets({ smtp: { pass: 987654321 }, ldap: { bindPass: { v: 'NESTED' } } });
  assert.strictEqual(masked.smtp.pass, SECRET_PLACEHOLDER);
  assert.strictEqual(masked.ldap.bindPass, SECRET_PLACEHOLDER);
  assert.ok(!JSON.stringify(masked).includes('987654321'));
  assert.ok(!JSON.stringify(masked).includes('NESTED'));
});
check('a null secret is left as null, not masked into a fake one', () => {
  assert.strictEqual(maskSecrets({ smtp: { pass: null } }).smtp.pass, null);
});
check('does not mutate its argument', () => {
  // It returns the object a route is about to serialise; mutating the cached
  // settings object would replace the real password with the placeholder IN MEMORY,
  // and the next SMTP send would authenticate with '__unchanged__'.
  const original = { smtp: { pass: 'hunter2' } };
  maskSecrets(original);
  assert.strictEqual(original.smtp.pass, 'hunter2');
});
check('survives missing sections', () => {
  assert.deepStrictEqual(maskSecrets(null), {});
  assert.deepStrictEqual(maskSecrets({ ldap: {} }), { ldap: {} });
});

console.log('API key value handling:');
check('null/false/0 CLEAR a key instead of being stringified', () => {
  // Not `String(v)`: that stores the four characters "null", which reads as SET
  // everywhere and authenticates with the literal word.
  for (const cleared of [null, undefined, false, 0, '']) {
    assert.strictEqual(normalizeApiKeyValue(cleared), '');
  }
  assert.strictEqual(normalizeApiKeyValue('  abc  '), 'abc');
});
check('a non-string is rejected, not stringified', () => {
  for (const bad of [{}, [], 123, true]) {
    assert.throws(() => normalizeApiKeyValue(bad, 'rawg_api_key'), /must be a string/,
      `${JSON.stringify(bad)} was accepted as an API key`);
  }
});
check('maskKey reveals at most the last 6 characters', () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey('short'), '••••••');
  assert.ok(maskKey('abcdefghijklmnop').endsWith('klmnop'));
  assert.ok(!maskKey('abcdefghijklmnop').includes('abcdefghij'));
});

// services/notifications.js — the pure guards only. Requiring the module constructs
// no pool and opens no connection (verified), so this stays inside the scope rule;
// dispatch/resolveEmail need a database and are exercised outside CI.
const {
  isSafeImageUrl, isBlockedNotificationHost, escapeHtml, CHANNEL_KEYS,
} = require('../services/notifications');

console.log('isBlockedNotificationHost (SSRF to cloud metadata):');
check('blocks every instance-metadata endpoint', () => {
  assert.strictEqual(isBlockedNotificationHost('http://169.254.169.254/latest/meta-data/'), true);
  assert.strictEqual(isBlockedNotificationHost('http://169.254.1.2/'), true);   // whole /16
  assert.strictEqual(isBlockedNotificationHost('http://metadata.google.internal/'), true);
  assert.strictEqual(isBlockedNotificationHost('http://100.100.100.200/'), true);
  assert.strictEqual(isBlockedNotificationHost('http://[fd00:ec2::254]/'), true);
  assert.strictEqual(isBlockedNotificationHost('http://[fe80::1]/'), true);
});
check('IPv4-mapped IPv6 and a trailing dot cannot slip past', () => {
  // Both of these were allowed by a version of this function that an extraction
  // silently reverted to. The assertions that existed at the time passed against the
  // WEAKENED code, because they only covered the vectors it still handled — a
  // regression and a test arriving together and agreeing with each other.
  //
  // new URL() normalises ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, so the hex
  // groups must be decoded back to octets before any check can see the address.
  assert.strictEqual(isBlockedNotificationHost('http://[::ffff:169.254.169.254]/'), true);
  assert.strictEqual(isBlockedNotificationHost('http://[::ffff:a9fe:a9fe]/'), true);
  // A trailing dot is a fully-qualified name that resolves to exactly the same host.
  assert.strictEqual(isBlockedNotificationHost('http://metadata.google.internal./'), true);
  assert.strictEqual(isBlockedNotificationHost('http://169.254.169.254./'), true);
});
check('normalised IPv4 forms cannot slip past', () => {
  // new URL() rewrites decimal/octal/hex to dotted quads before we look.
  assert.strictEqual(isBlockedNotificationHost('http://2852039166/'), true);       // 169.254.169.254
  assert.strictEqual(isBlockedNotificationHost('http://0251.0376.0251.0376/'), true);
});
check('refuses anything it cannot parse', () => {
  assert.strictEqual(isBlockedNotificationHost('not a url'), true);
  assert.strictEqual(isBlockedNotificationHost(''), true);
  assert.strictEqual(isBlockedNotificationHost(null), true);
});
check('still ALLOWS a self-hosted LAN server — the documented feature', () => {
  // Blocking RFC1918 would break every user running ntfy or Gotify at home, which is
  // why the rule targets metadata endpoints specifically rather than private space.
  assert.strictEqual(isBlockedNotificationHost('http://192.168.1.10:8080/'), false);
  assert.strictEqual(isBlockedNotificationHost('http://10.0.0.5/'), false);
  assert.strictEqual(isBlockedNotificationHost('https://ntfy.sh'), false);
});

console.log('isSafeImageUrl (cover art is client-supplied):');
check('accepts only https on a known image host', () => {
  assert.strictEqual(isSafeImageUrl('https://images.igdb.com/x.png'), true);
  assert.strictEqual(isSafeImageUrl('https://cdn.thegamesdb.net/x.png'), true);
  assert.strictEqual(isSafeImageUrl('https://sub.media.rawg.io/x.png'), true);
});
check('rejects plaintext, credentials, unknown hosts and non-strings', () => {
  assert.strictEqual(isSafeImageUrl('http://images.igdb.com/x.png'), false);
  assert.strictEqual(isSafeImageUrl('https://user:pw@images.igdb.com/x.png'), false);
  assert.strictEqual(isSafeImageUrl('https://evil.test/x.png'), false);
  // Suffix matching must not accept a lookalike domain that merely ENDS with the host.
  assert.strictEqual(isSafeImageUrl('https://notimages.igdb.com.evil.test/x.png'), false);
  assert.strictEqual(isSafeImageUrl(null), false);
  assert.strictEqual(isSafeImageUrl(12345), false);
});

console.log('escapeHtml (game names reach an outbound email body):');
check('escapes every character that could open a tag or an attribute', () => {
  assert.strictEqual(escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.strictEqual(escapeHtml("it's & <that>"), 'it&#39;s &amp; &lt;that&gt;');
  // Ampersand first, or the escapes would themselves be escaped.
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
  assert.strictEqual(escapeHtml(null), '');
});

console.log('notification channels:');
check('all four channels are in the table', () => {
  assert.deepStrictEqual([...CHANNEL_KEYS], ['email', 'ntfy', 'gotify', 'telegram']);
});

// dispatch() touches no database — it is handed the user's channel row — so the
// contract this module exists to guarantee is testable right here. It was NOT tested
// before, which is how a broken try/catch silenced three channels in production.
const notifications = require('../services/notifications');
const ALL_CHANNELS = { email: 'a@b.c', ntfy_topic: 't', ntfy_url: '', gotify_token: 'g', gotify_url: '', telegram_chat_id: '1' };

// Substitute the transports for recorders. Restored after each case.
function withTransports(behaviour, fn) {
  const real = { ...notifications.transports };
  const calls = [];
  for (const name of Object.keys(real)) {
    notifications.transports[name] = async () => {
      calls.push(name);
      if (behaviour[name] === 'fail') throw new Error(`boom ${name}`);
      if (behaviour[name] === 'skip') return { code: 'test_skip', message: 'declined for a reason' };
      return true;   // a transport returns true ONLY when it actually delivered
    };
  }
  return Promise.resolve(fn(calls)).finally(() => Object.assign(notifications.transports, real));
}

const asyncChecks = [];
const checkAsync = (label, fn) => asyncChecks.push([label, fn]);

// --- catalog: the v2 resolution layer ---------------------------------------
//
// Every check below drives the REAL function with a stubbed provider layer, through
// the `deps` seam the service exposes for exactly this. Asserting the exported
// constants instead would prove nothing: the rules being tested — a total outage is
// not an empty result, an ambiguous name is a refusal — live in control flow.
{
  const catalogSvc = require('../services/catalog');
  const codeOf = async (fn) => {
    try { await fn(); } catch (err) { return err.code; }
    return null;
  };
  const detailsOf = async (fn) => {
    try { await fn(); } catch (err) { return err.details; }
    return null;
  };
  const providerResult = (providers, results = []) => ({
    results,
    providers,
    counts: { igdb: 0, rawg: 0, thegamesdb: 0 },
    degraded: Object.values(providers).includes('failed'),
  });

  console.log('catalog.igdbByIdQuery (the id lands in a WHERE clause, not a string literal):');
  check('a non-numeric IGDB id NEVER reaches the query text', () => {
    // The exact shape the GameRef pattern permits and APIcalypse would execute.
    for (const hostile of ['1;fields *', '1 | id', '*', '1-1', 'abc', '1;', '', ' 1']) {
      assert.strictEqual(catalogSvc.igdbByIdQuery(hostile), null,
        `igdbByIdQuery built a query for ${JSON.stringify(hostile)}`);
    }
  });
  check('a numeric id builds exactly one bounded where clause', () => {
    const q = catalogSvc.igdbByIdQuery('12345');
    assert.strictEqual(q, 'where id = 12345; fields id,name,first_release_date,'
      + 'cover.image_id,external_games.category,external_games.uid; limit 1;');
    // The field list is SHARED with the search path — a by-id row that asked for
    // fewer columns would normalise the missing ones to null and silently store a
    // game with no cover.
    assert.ok(q.includes('external_games.uid'), 'the by-id lookup asks for fewer fields than search');
  });

  console.log('catalog.parseGameRef:');
  check('parseGameRef accepts the three sources and refuses everything else', () => {
    assert.deepStrictEqual(catalogSvc.parseGameRef('igdb_12345'),
      { ref: 'igdb_12345', source: 'igdb', id: '12345' });
    assert.strictEqual(catalogSvc.parseGameRef('rawg_3498').source, 'rawg');
    assert.strictEqual(catalogSvc.parseGameRef('thegamesdb_1').source, 'thegamesdb');
    for (const bad of ['12345', 'steam_1', 'igdb_', 'igdb_a b', 'igdb_' + 'x'.repeat(300),
      null, undefined, {}, 'IGDB_1']) {
      assert.strictEqual(catalogSvc.parseGameRef(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  console.log('catalog.boundedLimit (a limit multiplies OUTBOUND provider traffic):');
  check('the limit is clamped, and junk is a 400 rather than a silent default', () => {
    assert.strictEqual(catalogSvc.boundedLimit(undefined), catalogSvc.LIMIT_SEARCH);
    assert.strictEqual(catalogSvc.boundedLimit(''), catalogSvc.LIMIT_SEARCH);
    assert.strictEqual(catalogSvc.boundedLimit(5), 5);
    assert.strictEqual(catalogSvc.boundedLimit('5'), 5);
    for (const bad of [0, -1, 21, 1000, 1.5, 'abc', NaN]) {
      assert.throws(() => catalogSvc.boundedLimit(bad), /between 1 and 20/,
        `boundedLimit accepted ${bad}`);
    }
  });

  console.log('catalog.search ("nobody answered" must not read as "no such game"):');
  checkAsync('every provider failing is a 502, not an empty result', async () => {
    const code = await codeOf(() => catalogSvc.search('halo', {}, {
      searchAll: async () => providerResult({ igdb: 'failed', rawg: 'failed', thegamesdb: 'failed' }),
    }));
    assert.strictEqual(code, 'provider_unavailable');
  });
  checkAsync('one provider answering is enough — the other two skipped is a configuration', async () => {
    // An instance running on IGDB alone is supported, and an empty result from it is a
    // real answer. If `skipped` counted as a failure this would be a 502.
    const out = await catalogSvc.search('halo', {}, {
      searchAll: async () => providerResult({ igdb: 'ok', rawg: 'skipped', thegamesdb: 'skipped' }),
    });
    assert.deepStrictEqual(out.results, []);
    assert.strictEqual(out.degraded, false);
  });
  checkAsync('NOBODY configured is a 502, not an empty result forever', async () => {
    // The deployment this catches: no API keys at all. Every provider reports
    // `skipped`, nothing failed — so an "every provider failed" test passes it through
    // and the instance answers 200 with [] to every search ever made, which reads as
    // "that game does not exist" to every client including the MCP.
    assert.strictEqual(await codeOf(() => catalogSvc.search('halo', {}, {
      searchAll: async () => providerResult({ igdb: 'skipped', rawg: 'skipped', thegamesdb: 'skipped' }),
    })), 'provider_unavailable');
    // ...and the mixed case, which is neither all-failed nor all-skipped.
    assert.strictEqual(await codeOf(() => catalogSvc.search('halo', {}, {
      searchAll: async () => providerResult({ igdb: 'failed', rawg: 'skipped', thegamesdb: 'skipped' }),
    })), 'provider_unavailable');
  });
  checkAsync('one provider failing degrades, it does not fail', async () => {
    const out = await catalogSvc.search('halo', {}, {
      searchAll: async () => providerResult(
        { igdb: 'ok', rawg: 'failed', thegamesdb: 'skipped' },
        [{ id: 'igdb_1', name: 'Halo', source: 'igdb' }]),
    });
    assert.strictEqual(out.degraded, true);
    assert.strictEqual(out.results.length, 1);
  });
  checkAsync('an empty or oversized query is refused before any provider is asked', async () => {
    let asked = 0;
    const deps = { searchAll: async () => { asked++; return providerResult({}); } };
    for (const bad of ['', '   ', null, undefined, 'x'.repeat(201)]) {
      assert.strictEqual(await codeOf(() => catalogSvc.search(bad, {}, deps)), 'validation',
        `search accepted ${JSON.stringify(String(bad).slice(0, 12))}`);
    }
    assert.strictEqual(asked, 0, 'a rejected query still reached the providers');
  });

  console.log('catalog.nobodyAnswered (THE rule every "not found" has to consult first):');
  check('an all-SKIPPED lookup asked nobody, and that is not `degraded`', () => {
    // The distinction the metadata refresh got wrong: `degraded` means at least one
    // provider FAILED, so an instance with no API keys is not degraded and still asked
    // nobody. Reporting that as "not found" told a user every game in their library
    // had ceased to exist in every database.
    assert.strictEqual(catalogSvc.nobodyAnswered({ igdb: 'skipped', rawg: 'skipped', thegamesdb: 'skipped' }), true);
    assert.strictEqual(catalogSvc.nobodyAnswered({ igdb: 'failed', rawg: 'skipped', thegamesdb: 'failed' }), true);
    assert.strictEqual(catalogSvc.nobodyAnswered({ igdb: 'failed', rawg: 'failed', thegamesdb: 'failed' }), true);
    assert.strictEqual(catalogSvc.nobodyAnswered({ igdb: 'ok', rawg: 'failed', thegamesdb: 'skipped' }), false);
    // Fail-closed on a shape it does not recognise: "we cannot tell who answered" must
    // not resolve to "everybody did".
    for (const junk of [undefined, null, {}, 'ok']) {
      assert.strictEqual(catalogSvc.nobodyAnswered(junk), true, `nobodyAnswered(${JSON.stringify(junk)}) said someone answered`);
    }
  });
  checkAsync('the metadata refresh says provider_unavailable, not not_found, when nobody was asked', async () => {
    // Driven through the real function with the provider layer and the database
    // stubbed, because this is the exact combination that shipped: two games, three
    // skipped providers, and two `not_found` failures on the wire.
    const jobsSvc = require('../services/jobs');
    const librarySvc = require('../services/library');
    const realList = librarySvc.listGamesWithAliases;
    const realSearch = catalogSvc.searchAll;
    librarySvc.listGamesWithAliases = async () => [{ game_id: 'igdb_1', game_name: 'Halo' }];
    catalogSvc.searchAll = async () => ({
      results: [], providers: { igdb: 'skipped', rawg: 'skipped', thegamesdb: 'skipped' },
      counts: {}, degraded: false,
    });
    try {
      const out = await jobsSvc.refreshMetadata({ userId: 1 });
      assert.deepStrictEqual(out.failures, [{ gameId: 'igdb_1', reason: 'provider_unavailable' }]);
      assert.strictEqual(out.failed, 1);
      assert.strictEqual(out.succeeded, 0);
      // ...and a provider that DID answer and had nothing is a real not_found.
      catalogSvc.searchAll = async () => ({
        results: [], providers: { igdb: 'ok', rawg: 'skipped', thegamesdb: 'skipped' },
        counts: {}, degraded: false,
      });
      const found = await jobsSvc.refreshMetadata({ userId: 1 });
      assert.deepStrictEqual(found.failures, [{ gameId: 'igdb_1', reason: 'not_found' }]);
    } finally {
      librarySvc.listGamesWithAliases = realList;
      catalogSvc.searchAll = realSearch;
    }
  });

  console.log('catalog.resolveGame (ambiguity is a REFUSAL, never a guess):');
  checkAsync('an exact case-insensitive match resolves', async () => {
    const game = await catalogSvc.resolveGame({ name: 'HALO' }, {
      search: async () => providerResult({ igdb: 'ok' },
        [{ id: 'igdb_1', name: 'Halo', source: 'igdb' }, { id: 'igdb_2', name: 'Halo 2', source: 'igdb' }]),
    });
    assert.strictEqual(game.id, 'igdb_1');
  });
  checkAsync('a name that matches nothing exactly is a 409 CARRYING the candidates', async () => {
    const results = [{ id: 'igdb_2', name: 'Halo 2', source: 'igdb' },
      { id: 'igdb_3', name: 'Halo 3', source: 'igdb' }];
    const run = () => catalogSvc.resolveGame({ name: 'halo' }, {
      search: async () => providerResult({ igdb: 'ok' }, results),
    });
    assert.strictEqual(await codeOf(run), 'conflict');
    // The candidates are what makes the refusal actionable — a 409 with nothing in it
    // leaves an agent with no next move but to guess, which is what this prevents.
    assert.deepStrictEqual((await detailsOf(run)).candidates.map((c) => c.id), ['igdb_2', 'igdb_3']);
  });
  checkAsync('nothing found at all is the SAME refusal, not a 404', async () => {
    assert.strictEqual(await codeOf(() => catalogSvc.resolveGame({ name: 'zzz' }, {
      search: async () => providerResult({ igdb: 'ok' }, []),
    })), 'conflict');
  });
  checkAsync('supplying both gameId and name is refused, not silently ranked', async () => {
    let asked = 0;
    const deps = { search: async () => { asked++; return providerResult({}); },
      fetchById: async () => { asked++; return { status: 'ok', game: null }; } };
    assert.strictEqual(await codeOf(() => catalogSvc.resolveGame({ gameId: 'igdb_1', name: 'Halo' }, deps)), 'validation');
    assert.strictEqual(await codeOf(() => catalogSvc.resolveGame({}, deps)), 'validation');
    assert.strictEqual(asked, 0, 'a rejected request still reached a provider');
  });
  checkAsync('a provider that could not be asked is a 502, never "no such game"', async () => {
    // The whole point: 'failed' and 'skipped' must not degrade into the 400 that says
    // the id is wrong. An agent retries a 502 and gives up on a 400.
    for (const status of ['failed', 'skipped']) {
      assert.strictEqual(await codeOf(() => catalogSvc.resolveGame({ gameId: 'igdb_1' }, {
        fetchById: async () => ({ status, game: null }),
      })), 'provider_unavailable', `status '${status}' did not map to provider_unavailable`);
    }
    // ...and an answered "there is no such game" IS a 400.
    assert.strictEqual(await codeOf(() => catalogSvc.resolveGame({ gameId: 'igdb_1' }, {
      fetchById: async () => ({ status: 'ok', game: null }),
    })), 'validation');
  });
}

// v2svc is declared further down this file; required locally so these checks can
// sit beside the catalog ones they belong with.
const v2map = require('../services/v2');

console.log('job-runner (ownership is the control; the id being unguessable is what makes 404 safe):');
{
  const runner = require('../services/job-runner');
  const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
  const done = () => Promise.resolve({ processed: 1, succeeded: 1, failed: 0 });

  checkAsync('a job is readable ONLY by the account that started it', async () => {
    runner._reset();
    const job = runner.start({ kind: 'updatePrices', scope: 'instance', ownerId: 1, work: done });
    assert.ok(runner.get(job.id, 1), 'the owner cannot read their own job');
    // 404, not 403 — and the same answer as an id that never existed, which is the
    // whole point. An instance-wide job's failures[] names game ids from every user's
    // library, so ownership rather than scope is what protects it.
    assert.strictEqual(runner.get(job.id, 2), null);
    assert.strictEqual(runner.get(job.id, '2'), null);
    assert.strictEqual(runner.get('no-such-id', 1), null);
    // ...and the id must be unguessable, or 404-vs-403 buys nothing. 24 random bytes.
    assert.ok(job.id.length >= 32, `job id is only ${job.id.length} chars`);
    assert.ok(!/^\d+$/.test(job.id), 'job ids are sequential — they can be enumerated');
    const second = runner.start({ kind: 'checkReleases', scope: 'instance', ownerId: 1, work: done });
    assert.notStrictEqual(second.id, job.id);
    await settle();
  });

  checkAsync('a second job of the same kind and scope is refused while one runs', async () => {
    runner._reset();
    // The gate is created EAGERLY, not inside `work`: start() invokes the work on a
    // microtask, so a resolver assigned in there does not exist yet when this test
    // reaches the line that releases it.
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = () => gate.then(() => ({ processed: 0, succeeded: 0, failed: 0 }));
    runner.start({ kind: 'updatePrices', scope: 'instance', ownerId: 1, work: held });
    let code = null;
    try {
      runner.start({ kind: 'updatePrices', scope: 'instance', ownerId: 1, work: done });
    } catch (err) { code = err.code; }
    assert.strictEqual(code, 'conflict', 'two instance-wide sweeps of one kind ran at once');
    // A DIFFERENT admin must be refused too: the lock is per instance, not per caller,
    // or two administrators double every outbound request to the providers.
    assert.throws(() => runner.start({ kind: 'updatePrices', scope: 'instance', ownerId: 99, work: done }));
    // A different KIND is unaffected, and so is the same kind at `self` scope for a
    // different account — a per-library refresh must not be blocked by someone else's.
    runner.start({ kind: 'checkReleases', scope: 'instance', ownerId: 1, work: done });
    runner.start({ kind: 'refreshMetadata', scope: 'self', ownerId: 7, work: done });
    runner.start({ kind: 'refreshMetadata', scope: 'self', ownerId: 8, work: done });
    // ...but the SAME account's own refresh is single-flighted.
    assert.throws(() => runner.start({ kind: 'refreshMetadata', scope: 'self', ownerId: 7, work: done }));
    release();
    await settle();
    // Once it has finished, the same kind may start again.
    runner.start({ kind: 'updatePrices', scope: 'instance', ownerId: 1, work: done });
    await settle();
  });

  checkAsync('a rejected job records a CLOSED reason, never the exception message', async () => {
    runner._reset();
    const { serviceError, CODES } = require('../services/errors');
    const cases = [
      [serviceError(CODES.PROVIDER_UNAVAILABLE, 'IGDB said: key sk-live-abc is over quota'), 'provider_unavailable'],
      [serviceError(CODES.NOT_FOUND, 'nope'), 'not_found'],
      [serviceError(CODES.VALIDATION, 'bad'), 'invalid_data'],
      [new Error('ECONNREFUSED 10.0.0.5:5432 — relation "users" does not exist'), 'internal'],
    ];
    for (const [err, expected] of cases) {
      const job = runner.start({
        kind: 'updatePrices', scope: 'instance', ownerId: 1,
        work: () => Promise.reject(err),
      });
      await settle();
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.error, expected);
      // The message must not survive anywhere on the record. These sweeps call five
      // third-party services whose error text carries endpoint paths, quota state and
      // occasionally the failing key.
      const wire = JSON.stringify(require('../services/v2').job(job));
      assert.ok(!wire.includes('sk-live-abc') && !wire.includes('10.0.0.5') && !wire.includes('users'),
        `an exception message reached the job record: ${wire}`);
    }
  });

  checkAsync('a synchronous throw inside the work is caught, not an unhandled rejection', async () => {
    runner._reset();
    const job = runner.start({
      kind: 'updatePrices', scope: 'instance', ownerId: 1,
      work: () => { throw new Error('boom'); },
    });
    await settle();
    assert.strictEqual(job.status, 'failed');
    assert.strictEqual(job.error, 'internal');
    assert.ok(job.finishedAt, 'finishedAt was never stamped');
  });

  check('normaliseResult truncates failures and keeps `failed` truthful', () => {
    const failures = Array.from({ length: 500 }, (_, i) => ({ gameId: `igdb_${i}`, reason: 'not_found' }));
    const out = runner.normaliseResult({ processed: 500, succeeded: 0, failed: 500, failures });
    assert.strictEqual(out.failures.length, runner.MAX_FAILURES);
    // The COUNT stays true. Truncating both would report a 500-failure sweep as a
    // 200-failure one, which is the "everything failed reads like success" defect
    // this shape exists to prevent, one step removed.
    assert.strictEqual(out.failed, 500);
  });
  check('a reason outside the closed set becomes internal, never travels as-is', () => {
    const out = runner.normaliseResult({
      processed: 1, succeeded: 0, failed: 1,
      failures: [{ gameId: 'igdb_1', reason: 'RAWG 401: key=sk-live-abc' }],
    });
    assert.strictEqual(out.failures[0].reason, 'internal');
    assert.ok(!JSON.stringify(out).includes('sk-live-abc'));
    // ...and every published reason must be one the spec's enum lists.
    for (const reason of runner.REASONS) {
      const kept = runner.normaliseResult({ failures: [{ gameId: 'g', reason }] });
      assert.strictEqual(kept.failures[0].reason, reason);
    }
  });
  check('junk counts become 0 rather than NaN on the wire', () => {
    const out = runner.normaliseResult({ processed: 'many', succeeded: undefined, failed: -3 });
    assert.deepStrictEqual(out, { processed: 0, succeeded: 0, failed: 0 });
    assert.strictEqual(runner.normaliseResult(null).processed, 0);
  });

  check('the runner\'s reason set is EXACTLY the spec\'s FailureReason enum', () => {
    // Two closed sets that must agree. They are compared against the spec in
    // test/openapi.test.js from the other side; this is the half that fails if the
    // runner grows a reason nobody documented.
    assert.deepStrictEqual([...runner.REASONS].sort(),
      ['internal', 'invalid_data', 'not_found', 'provider_unavailable', 'rate_limited']);
  });
}

console.log('v2 admin mappers (the rename is where a guard stops recognising a field):');
{
  const v2m = require('../services/v2');
  const usersSvc = require('../services/users');
  const throws = (fn) => { try { fn(); } catch (err) { return err; } return null; };

  check('userWrite refuses every user-owned notification target, in BOTH spellings', () => {
    // This is the one that has to hold. `userWrite` RENAMES fields, so a body carrying
    // `gotifyToken` would arrive at the service under a name its
    // USER_OWNED_NOTIFICATION_COLUMNS guard does not recognise — turning the refusal
    // that guard exists for into a silent pass-through, on the exact credential an
    // admin must not be able to plant. Both the column name and its camelCase form
    // have to be rejected here.
    const camel = (c) => c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
    for (const column of usersSvc.USER_OWNED_NOTIFICATION_COLUMNS) {
      for (const spelling of [column, camel(column)]) {
        for (const opts of [{ create: true }, { create: false }]) {
          const err = throws(() => v2m.userWrite({ username: 'x', password: 'y', [spelling]: 'v' }, opts));
          assert.ok(err, `userWrite accepted ${spelling} (create: ${opts.create})`);
          assert.strictEqual(err.code, 'validation');
        }
      }
    }
  });
  check('userWrite maps exactly the four writable fields and nothing else', () => {
    const out = v2m.userWrite({
      password: 'p', email: 'e@x.y', canManageUsers: true, sharesLibrary: true,
    }, { create: false });
    assert.deepStrictEqual(out,
      { password: 'p', email: 'e@x.y', can_manage_users: true, shares_library: true });
    // The mapped names must be exactly the columns the service will write. A typo here
    // is a field silently ignored, reported as a successful update.
    for (const key of Object.keys(out)) {
      assert.ok(usersSvc.ADMIN_WRITABLE_COLUMNS.includes(key),
        `userWrite emits '${key}', which services/users.js will not write`);
    }
  });
  check('userWrite carries username on create and REFUSES it on update', () => {
    assert.strictEqual(v2m.userWrite({ username: 'bob', password: 'p' }, { create: true }).username, 'bob');
    // Renaming an account is not an operation this API has. Passing it through would
    // reach update(), which does not write it — a silent no-op reported as success.
    assert.strictEqual(throws(() => v2m.userWrite({ username: 'bob' }, { create: false })).code, 'validation');
  });
  check('an empty update is refused before it becomes a SQL syntax error', () => {
    assert.ok(throws(() => v2m.userWrite({}, { create: false })));
    // ...but an empty CREATE is not this function's business to refuse — the service
    // rejects a missing username and password with a message about those fields.
    assert.deepStrictEqual(v2m.userWrite({}, { create: true }),
      { can_manage_users: false, shares_library: false });
  });

  check('user() emits the User shape and no notification target can reach it', () => {
    // Driven with a row carrying every user-owned column, which is what a `SELECT *`
    // regression in the projection would hand this mapper.
    const row = {
      id: 7, username: 'u', display_name: 'U', email: 'e@x.y', can_manage_users: 1,
      origin: 'ldap', shares_library: 0, created_at: '2020-01-01T00:00:00.000Z',
      // Distinctive values: a one-character topic would match a letter of 'username'
      // and make this assertion fire on nothing.
      password: '$2a$10$hashvalue', ntfy_url: 'http://ntfy.example',
      ntfy_topic: 'topic-secret', gotify_url: 'http://gotify.example',
      gotify_token: 'gotify-secret', telegram_chat_id: '99887766',
    };
    const out = v2m.user(row);
    assert.deepStrictEqual(Object.keys(out).sort(), ['canManageUsers', 'createdAt', 'displayName',
      'email', 'id', 'origin', 'sharesLibrary', 'username']);
    const body = JSON.stringify(out);
    for (const secret of ['$2a$10$hashvalue', 'http://ntfy.example', 'topic-secret',
      'http://gotify.example', 'gotify-secret', '99887766']) {
      assert.ok(!body.includes(secret), `user() leaked ${secret}`);
    }
    assert.strictEqual(out.canManageUsers, true);
    assert.strictEqual(out.sharesLibrary, false);
  });

  check('maskedSettings reports API keys as STATE — never a value, prefix or suffix', () => {
    // v1 emits the last six characters of every key. That is a disclosure, and worse it
    // round-trips: a client reading and writing back stores the mask AS the key.
    const out = v2m.maskedSettings(
      { smtp: { host: 'h', pass: '__unchanged__' }, telegram: { bot_token: '__unchanged__' } },
      { rawg_api_key: { set: true, source: 'settings', masked: '••••••••abcdef' },
        igdb_client_id: { set: false, source: null, masked: '' } },
      false);
    assert.deepStrictEqual(Object.keys(out.apikeys.rawgApiKey).sort(), ['configured', 'source']);
    assert.strictEqual(out.apikeys.rawgApiKey.configured, true);
    assert.strictEqual(out.apikeys.rawgApiKey.source, 'settings');
    assert.strictEqual(out.apikeys.igdbClientId.source, null);
    assert.ok(!JSON.stringify(out).includes('abcdef'), 'a fragment of an API key reached the response');
    assert.ok(!JSON.stringify(out).includes('masked'));
    // ...and the storage names are renamed, so a client never learns them either.
    assert.strictEqual(out.telegram.botToken, '__unchanged__');
    assert.ok(!('bot_token' in out.telegram));
  });
  check('maskedSettings reports every section and every key, always', () => {
    // A section absent from settings.json must still appear as {} — an absent key
    // cannot be told apart from an unreadable file, which is the exact defect the
    // `degraded` flag exists to fix one level up.
    const out = v2m.maskedSettings({}, {}, true);
    assert.strictEqual(out.degraded, true);
    assert.deepStrictEqual(Object.keys(out).sort(),
      ['apikeys', 'degraded', 'gotify', 'ldap', 'ntfy', 'smtp', 'telegram']);
    assert.deepStrictEqual(Object.keys(out.apikeys).sort(), Object.keys(v2m.API_KEY_FIELDS).sort());
    for (const state of Object.values(out.apikeys)) {
      assert.deepStrictEqual(state, { configured: false, source: null });
    }
  });

  check('settingsUpdate renames both ways and refuses what the spec closes', () => {
    const { sections, apikeys } = v2m.settingsUpdate({
      telegram: { botToken: 'b' }, smtp: { pass: 'p' }, apikeys: { igdbClientId: 'c' },
    });
    assert.deepStrictEqual(sections.telegram, { bot_token: 'b' });
    assert.deepStrictEqual(sections.smtp, { pass: 'p' });
    assert.deepStrictEqual(apikeys, { igdb_client_id: 'c' });
    // additionalProperties: false, enforced rather than described. Dropping quietly is
    // the failure this API documents as unacceptable for notification targets; it is
    // no better here, and it also fills settings.json with keys only a hand edit
    // removes.
    for (const bad of [{ oidc: {} }, { smtp: { hostname: 'x' } }, { apikeys: { openaiKey: 'x' } },
      { telegram: { bot_token: 'b' } }]) {
      assert.strictEqual(throws(() => v2m.settingsUpdate(bad))?.code, 'validation',
        `settingsUpdate accepted ${JSON.stringify(bad)}`);
    }
    // No apikeys key at all means "do not touch them" — distinct from an empty object.
    assert.strictEqual(v2m.settingsUpdate({ smtp: {} }).apikeys, null);
  });
  check('the two settings tables are inverses, field for field', () => {
    // The read and the write mappers are separate tables. If they disagree, a client
    // that reads a field cannot write it back under the name it was given — which is
    // exactly how `smtp.to` became unsettable in an earlier revision of the spec.
    const settingsSvc = require('../services/settings');
    for (const section of Object.keys(v2m.SETTINGS_FIELDS)) {
      assert.ok(settingsSvc.SECTIONS.includes(section),
        `v2 exposes a settings section the service will not write: ${section}`);
    }
    for (const section of settingsSvc.SECTIONS) {
      assert.ok(v2m.SETTINGS_FIELDS[section], `settings section '${section}' is unreachable from v2`);
    }
    // Every secret the service masks must be reachable under some wire name, or the
    // mask is published for a field nothing can ever clear.
    for (const [section, key] of settingsSvc.SECRET_FIELDS) {
      const wireNames = Object.entries(v2m.SETTINGS_FIELDS[section] || {})
        .filter(([, col]) => col === key).map(([wire]) => wire);
      assert.strictEqual(wireNames.length, 1,
        `secret ${section}.${key} maps to ${wireNames.length} wire names, expected exactly 1`);
    }
    assert.deepStrictEqual(Object.values(v2m.API_KEY_FIELDS).sort(),
      [...settingsSvc.API_KEY_NAMES].sort());
  });
}

console.log('shares: the v2 surface (the SQL is itself the control here):');
{
  const dbMod = require('../db');
  const sharesSvc = require('../services/shares');
  const librarySvc = require('../services/library');
  // The new share functions call db.promises.* THROUGH the module precisely so this
  // works. A destructured binding would leave the stub installed and never called —
  // the documented silent false pass, which has already happened once in this repo.
  const withDb = async (handlers, fn) => {
    const real = { get: dbMod.promises.get, all: dbMod.promises.all, run: dbMod.promises.run };
    const issued = [];
    for (const k of ['get', 'all', 'run']) {
      dbMod.promises[k] = async (sql, params) => {
        issued.push({ verb: k, sql: String(sql).replace(/\s+/g, ' ').trim(), params });
        return handlers[k] ? handlers[k](sql, params) : (k === 'all' ? [] : null);
      };
    }
    try { return { issued, result: await fn(issued) }; } finally { Object.assign(dbMod.promises, real); }
  };

  checkAsync('removeOutgoing NEVER looks at the users table', async () => {
    // This is the username oracle. The adapter turns removed:false into a 404, so if
    // this function distinguished "no such account" from "no such share" — even only
    // by which query it runs, and so by how long it takes — any authenticated caller
    // could enumerate accounts one DELETE at a time.
    const { issued, result } = await withDb({ run: async () => ({ changes: 0 }) },
      () => sharesSvc.removeOutgoing('root', 'ghost'));
    assert.strictEqual(issued.length, 1, `expected exactly one statement, got ${issued.length}`);
    assert.match(issued[0].sql, /^DELETE FROM user_shares WHERE from_user = \? AND to_user = \?$/);
    assert.ok(!/\busers\b/.test(issued[0].sql), 'the revoke consulted the users table');
    assert.deepStrictEqual(issued[0].params, ['root', 'ghost']);
    assert.deepStrictEqual(result, { removed: 0 });
  });
  checkAsync('removeOutgoing lowercases both sides, or the DELETE matches nothing', async () => {
    // Usernames are stored lowercase. A mixed-case path parameter that reached the
    // DELETE verbatim would delete no row and report 404 on a share that plainly
    // exists — v1 shipped exactly this bug in the admin release sweep.
    const { issued } = await withDb({ run: async () => ({ changes: 1 }) },
      () => sharesSvc.removeOutgoing('Root', 'ALICE'));
    assert.deepStrictEqual(issued[0].params, ['root', 'alice']);
  });

  checkAsync('readSharedPage checks the grant BEFORE reading a single row', async () => {
    let pageRead = 0;
    const realPage = librarySvc.listPage;
    librarySvc.listPage = async () => { pageRead++; return { data: [], meta: {} }; };
    try {
      const { issued } = await withDb({ get: async () => null },
        () => sharesSvc.readSharedPage('root', 'ghost').catch((err) => err));
      assert.strictEqual(pageRead, 0, 'a viewer with no grant reached the library');
      assert.strictEqual(issued.length, 1, 'more than the grant check ran');
      assert.match(issued[0].sql, /FROM user_shares s JOIN users u/);
    } finally { librarySvc.listPage = realPage; }
  });
  checkAsync('a missing grant is not_shared — the SAME answer as no such account', async () => {
    let code = null;
    await withDb({ get: async () => null },
      () => sharesSvc.readSharedPage('ghost', 'alice').catch((err) => { code = err.code; }));
    assert.strictEqual(code, 'not_shared');
  });

  checkAsync('addOutgoing refuses a self-share and an empty name without touching the db', async () => {
    for (const [from, to] of [['root', 'root'], ['root', 'ROOT'], ['root', '  '], ['root', null]]) {
      const { issued } = await withDb({}, () => sharesSvc.addOutgoing(from, to).catch((e) => e));
      assert.strictEqual(issued.length, 0, `addOutgoing(${from}, ${JSON.stringify(to)}) hit the database`);
    }
  });
  checkAsync('addOutgoing READS BACK, so the idempotent path reports the original date', async () => {
    // Returning the value just written would tell a caller re-adding an existing share
    // that it was granted today. ON CONFLICT DO NOTHING means the stored row is the
    // old one, so the response has to come from the table.
    const stored = { username: 'alice', displayName: 'Alice', sharedAt: '2020-01-01T00:00:00.000Z' };
    let call = 0;
    const { result } = await withDb({
      get: async () => { call++; return call === 1 ? { username: 'alice' } : stored; },
      run: async () => ({ changes: 0 }),
    }, () => sharesSvc.addOutgoing('root', 'Alice'));
    assert.deepStrictEqual(result, stored);
  });
  checkAsync('an unknown recipient carries the name in unknownUsers, the v2 extension key', async () => {
    let err = null;
    await withDb({ get: async () => null },
      () => sharesSvc.addOutgoing('root', 'ghost').catch((e) => { err = e; }));
    assert.strictEqual(err.code, 'unknown_users');
    assert.deepStrictEqual(err.details.unknownUsers, ['ghost']);
  });
}

console.log('library.addResolvedGame (an omitted status must not DEMOTE a stored game):');
{
  const lib = require('../services/library');
  const halo = { id: 'igdb_1', name: 'Halo', releaseDate: '2001-11-15', coverUrl: null, steamAppId: null };
  const withPrior = (prior) => {
    const written = [];
    return {
      written,
      deps: {
        findGame: async () => prior,
        upsertGame: async (userId, fields) => { written.push(fields); return { created: !prior, events: [] }; },
      },
    };
  };
  checkAsync('a game already in the library keeps its status when none is sent', async () => {
    // The failure this prevents: an agent told "add Halo" — with no idea it is already
    // there — silently moves a game the user is PLAYING back to wishlist, and the 200
    // gives nobody a reason to look.
    const { written, deps } = withPrior({ status: 'playing', game_id: 'igdb_1' });
    await lib.addResolvedGame(1, halo, undefined, deps);
    assert.strictEqual(written[0].status, 'playing');
  });
  checkAsync('a genuinely new game takes the default', async () => {
    const { written, deps } = withPrior(null);
    await lib.addResolvedGame(1, halo, undefined, deps);
    assert.strictEqual(written[0].status, lib.DEFAULT_NEW_STATUS);
    assert.strictEqual(lib.DEFAULT_NEW_STATUS, 'wishlist');
  });
  checkAsync('an EXPLICIT status still wins, including a demotion', async () => {
    const { written, deps } = withPrior({ status: 'playing', game_id: 'igdb_1' });
    await lib.addResolvedGame(1, halo, 'wishlist', deps);
    assert.strictEqual(written[0].status, 'wishlist');
  });
  checkAsync('an empty-string status is treated as absent, not as junk', async () => {
    // '' reaches here from a client that sends every field whether or not it has one.
    // Passing it through would be a 400 on a request that meant "leave it alone".
    const { written, deps } = withPrior({ status: 'done', game_id: 'igdb_1' });
    await lib.addResolvedGame(1, halo, '', deps);
    assert.strictEqual(written[0].status, 'done');
  });
}

console.log('v2 problem extensions (the ONLY two members allowed past the mapper):');
check('candidates are RE-SHAPED, never spread from err.details', () => {
  const { body } = v2map.toProblem({
    code: 'conflict',
    message: 'ambiguous',
    details: {
      candidates: [{ id: 'igdb_1', name: 'Halo', source: 'igdb', internalNote: 'secret', rating: 9 }],
      // Anything else a service attaches for its own use must NOT appear: this body
      // is already on its way to the caller, and a spread would publish it.
      debugSql: 'SELECT 1',
      apiKey: 'sk-live-xyz',
    },
  });
  assert.deepStrictEqual(Object.keys(body.candidates[0]).sort(),
    ['coverUrl', 'id', 'name', 'releaseDate', 'source', 'steamAppId']);
  assert.ok(!('debugSql' in body), 'an undocumented detail reached the problem body');
  assert.ok(!('apiKey' in body), 'an undocumented detail reached the problem body');
  assert.ok(!JSON.stringify(body).includes('sk-live-xyz'));
  assert.ok(!JSON.stringify(body).includes('internalNote'));
});
check('unknownUsers are echoed as strings, and nothing else rides along', () => {
  const { body } = v2map.toProblem({
    code: 'unknown_users',
    message: 'no',
    details: { unknownUsers: ['ghost', 42], hint: 'try harder' },
  });
  assert.deepStrictEqual(body.unknownUsers, ['ghost', '42']);
  assert.ok(!('hint' in body));
});
check('a problem WITHOUT those details grows neither key', () => {
  const { body } = v2map.toProblem({ code: 'not_found', message: 'x' });
  assert.ok(!('candidates' in body) && !('unknownUsers' in body));
});

console.log('v2.searchMeta (provider status as a LIST, so a new provider is not breaking):');
check('searchMeta reports every provider with its own status and count', () => {
  const meta = v2map.searchMeta({
    results: [1, 2, 3],
    providers: { igdb: 'ok', rawg: 'failed', thegamesdb: 'skipped' },
    counts: { igdb: 3, rawg: 0 },
    degraded: true,
  });
  assert.deepStrictEqual(Object.keys(meta).sort(), ['degraded', 'providers', 'total']);
  assert.strictEqual(meta.degraded, true);
  // total is AFTER de-duplication; the per-provider counts are before it.
  assert.strictEqual(meta.total, 3);
  assert.deepStrictEqual(meta.providers, [
    { name: 'igdb', status: 'ok', count: 3 },
    { name: 'rawg', status: 'failed', count: 0 },
    // A missing count is 0, not undefined — undefined disappears from the JSON and
    // the client sees the key removed rather than "none".
    { name: 'thegamesdb', status: 'skipped', count: 0 },
  ]);
});

console.log('dispatch (THE contract: one channel down must not silence the rest):');
checkAsync('a failing channel does not stop the other three', () => withTransports({ sendEmail: 'fail' }, async (calls) => {
  const r = await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' });
  assert.deepStrictEqual(calls.sort(), ['sendEmail', 'sendGotify', 'sendNtfy', 'sendTelegram'],
    'a channel was never attempted');
  assert.strictEqual(r.email.sent, false);
  for (const k of ['ntfy', 'gotify', 'telegram']) {
    assert.strictEqual(r[k].sent, true, `${k} did not send when email failed`);
  }
}));
checkAsync('every channel failing still reports every channel', () => withTransports(
  { sendEmail: 'fail', sendNtfy: 'fail', sendGotify: 'fail', sendTelegram: 'fail' }, async () => {
    const r = await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' });
    for (const k of CHANNEL_KEYS) {
      assert.strictEqual(r[k].sent, false);
      assert.ok(r[k].error, `${k} failed silently`);
    }
  }));
checkAsync('the raw transport error never reaches the caller', () => withTransports({ sendNtfy: 'fail' }, async () => {
  // sanitizeDeliveryError exists because raw axios errors distinguish
  // ECONNREFUSED / 404 / timeout, which makes the admin test button a port scanner.
  const r = await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' });
  assert.ok(!/boom/.test(r.ntfy.error), `raw error leaked: ${r.ntfy.error}`);
  assert.match(r.ntfy.error, /Delivery failed/);
}));
checkAsync('an unconfigured channel is not attempted and says why', () => withTransports({}, async (calls) => {
  const r = await notifications.dispatch({ email: '', ntfy_topic: '', gotify_token: '', telegram_chat_id: '' },
    { subject: 's', text: 't', title: 'T', message: 'm' });
  assert.deepStrictEqual(calls, []);
  for (const k of CHANNEL_KEYS) assert.ok(r[k].error, `${k} gave no explanation`);
}));
checkAsync('`only` restricts delivery; every channel still appears in the result', () => withTransports({}, async (calls) => {
  const r = await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' },
    { only: ['email', 'ntfy'] });
  assert.deepStrictEqual(calls.sort(), ['sendEmail', 'sendNtfy']);
  // v1's shape — the admin Diagnostics panel renders a row per channel
  // unconditionally, so a missing key would render as a red "✗ Failed".
  assert.deepStrictEqual(Object.keys(r).sort(), ['email', 'gotify', 'ntfy', 'telegram']);
  // `code` is null too: not-attempted is distinct from every failure reason.
  assert.deepStrictEqual(r.gotify, { sent: false, code: null, error: null });
  assert.deepStrictEqual(r.telegram, { sent: false, code: null, error: null });
}));
checkAsync('dispatch never throws, even on a malformed channels argument', () => withTransports({}, async () => {
  // services/errors.js tells adapters they may rely on this absolutely. It must not
  // depend on every caller normalising first — both current ones happen to, two
  // functions away, which is a convention rather than a guarantee.
  for (const bad of [null, undefined, 0, '', 'nonsense']) {
    const r = await notifications.dispatch(bad, { subject: 's', text: 't', title: 'T', message: 'm' });
    assert.deepStrictEqual(Object.keys(r).sort(), ['email', 'gotify', 'ntfy', 'telegram'],
      `dispatch(${JSON.stringify(bad)}) did not return a full result`);
    for (const k of CHANNEL_KEYS) assert.strictEqual(r[k].sent, false);
  }
}));
checkAsync('a transport that DECLINED is not reported as sent', () => withTransports({ sendEmail: 'skip' }, async () => {
  // "Resolved without throwing" is not delivery. Every transport short-circuits on
  // an unconfigured server — or, the one that matters, on a recipient the sink
  // refused as malformed. Reporting that as sent showed an admin with no SMTP four
  // green rows, and told an operator repairing a bad address that it had worked.
  const r = await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' });
  assert.strictEqual(r.email.sent, false, 'a declined delivery was reported as sent');
  assert.strictEqual(r.email.error, 'declined for a reason');
  assert.strictEqual(r.email.code, 'test_skip', 'the structured code was lost');
  assert.strictEqual(r.ntfy.sent, true);
}));
checkAsync('undefined `only` means every channel — what the SPA default sends', () => withTransports({}, async (calls) => {
  // `both` is the SPA's default, labelled "All Services". Narrowing it to a subset
  // silently stopped testing two channels AND rendered them as failures.
  await notifications.dispatch(ALL_CHANNELS, { subject: 's', text: 't', title: 'T', message: 'm' }, { only: undefined });
  assert.strictEqual(calls.length, 4);
}));

// services/problem.js — the table that decides which error messages a caller may
// see. Pure: it maps an error to {status, body} and touches nothing.
const problem = require('../services/problem');
const { serviceError, CODES: SVC } = require('../services/errors');

console.log('problem.toProblem (the disclosure rule, not just the status):');
check('our own validation messages ARE shown — they say what to fix', () => {
  const p = problem.toProblem(serviceError(SVC.VALIDATION, 'password must be at least 8 characters'));
  assert.deepStrictEqual(p, { status: 400, body: { error: 'password must be at least 8 characters' } });
});
check('a NOT_FOUND message is NOT shown', () => {
  // Otherwise a caller probes for records they cannot read, one 404 message at a time.
  const p = problem.toProblem(serviceError(SVC.NOT_FOUND, 'user 41 (alice@example.com) does not exist'));
  assert.strictEqual(p.status, 404);
  assert.strictEqual(p.body.error, 'Not found');
  assert.ok(!p.body.error.includes('alice'), 'the service message leaked');
});
check('NOT_SHARED and NOT_IN_BACKLOG are fixed text too', () => {
  assert.strictEqual(problem.toProblem(serviceError(SVC.NOT_SHARED, 'internal detail')).body.error,
    'Not shared with you.');
  assert.strictEqual(problem.toProblem(serviceError(SVC.NOT_IN_BACKLOG, 'internal detail')).body.error,
    'Game not in backlog');
});
check('every code in the taxonomy has a mapping', () => {
  // A code with no entry falls through to a 500, which is how a deliberate 4xx
  // silently becomes an opaque server error.
  for (const code of Object.values(SVC)) {
    assert.ok(problem.PROBLEMS[code], `no problem mapping for code '${code}'`);
  }
});
check('an unrecognised error is NOT pattern-matched into a 4xx', () => {
  assert.strictEqual(problem.toProblem(new Error('connection terminated unexpectedly')), null);
  assert.strictEqual(problem.toProblem(null), null);
  assert.strictEqual(problem.toProblem({ code: 'not_a_real_code' }), null);
});
check('a per-route override replaces the text but cannot expose a hidden one', () => {
  const p = problem.toProblem(serviceError(SVC.NOT_FOUND, 'secret detail'), { [SVC.NOT_FOUND]: 'User not found' });
  assert.deepStrictEqual(p, { status: 404, body: { error: 'User not found' } });
  // and it cannot change the status
  assert.strictEqual(problem.toProblem(serviceError(SVC.CONFLICT, 'x'), { [SVC.CONFLICT]: 'nope' }).status, 409);
});
check('send() does nothing when the response is already sent', () => {
  // The library upsert dispatches notifications AFTER res.json, so a rejection there
  // reaches this helper with the headers gone. A second write is a crash, not an
  // error response.
  let wrote = false;
  const res = { headersSent: true, status() { wrote = true; return this; }, json() { wrote = true; } };
  problem.send(res, serviceError(SVC.VALIDATION, 'too late'));
  assert.strictEqual(wrote, false, 'problem.send wrote a second response');
});
check('send() never echoes an unknown error message', () => {
  // The same rule as `expose`, applied to the case where we do not know what it is.
  let captured = null;
  const res = { status(s) { this._s = s; return this; }, json(b) { captured = { status: this._s, body: b }; } };
  problem.send(res, new Error('SELECT * FROM users -- connection string: postgres://u:p@h/db'),
    { fallback: 'DB error' });
  assert.deepStrictEqual(captured, { status: 500, body: { error: 'DB error' } });
  assert.ok(!JSON.stringify(captured).includes('postgres://'), 'a raw error leaked into the response');
});

// services/library.js — the pure parts. decideEvents decides how many push
// notifications real people receive, and until it was extracted it could not be
// exercised without a database.
const libraryService = require('../services/library');
const { EVENTS } = libraryService;

console.log('isReleaseInFuture (must agree with the cron AND with App.jsx):');
check('today counts as released, tomorrow does not', () => {
  const day = 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  assert.strictEqual(libraryService.isReleaseInFuture(iso(Date.now())), false, 'today read as future');
  assert.strictEqual(libraryService.isReleaseInFuture(iso(Date.now() + 2 * day)), true);
  assert.strictEqual(libraryService.isReleaseInFuture(iso(Date.now() - day)), false);
});
check('an absent date is not "in the future"', () => {
  for (const v of ['', null, undefined]) assert.strictEqual(libraryService.isReleaseInFuture(v), false);
});

console.log('validReleaseDate (an unparseable date used to defeat the coercion):');
check('only a real YYYY-MM-DD survives', () => {
  assert.strictEqual(libraryService.validReleaseDate('1998-11-19'), '1998-11-19');
  assert.strictEqual(libraryService.validReleaseDate(' 2099-01-01 '), '2099-01-01');
  // 'not-a-date' is TRUTHY, so `!releaseDate` was false, and isReleaseInFuture
  // compares NaN and returns false — the coercion to 'unreleased' never fired and
  // the game kept whatever status was asked for, with a garbage date stored.
  for (const bad of ['not-a-date', 'tomorrow', '2024-13-99', '{"x":1}', 42, null, '']) {
    assert.strictEqual(libraryService.validReleaseDate(bad), null, `${JSON.stringify(bad)} was accepted`);
  }
});

console.log('decideEvents:');
check('a new game is ADDED', () => {
  assert.deepStrictEqual(libraryService.decideEvents(null, 'playing'), [EVENTS.ADDED]);
});
check('a changed status is STATUS_CHANGED', () => {
  assert.deepStrictEqual(libraryService.decideEvents('done', 'playing'), [EVENTS.STATUS_CHANGED]);
});
check('leaving unreleased emits RELEASED first, then the status change', () => {
  // Order matters: the user must not read "changed status" before "has been released".
  assert.deepStrictEqual(libraryService.decideEvents('unreleased', 'playing'),
    [EVENTS.RELEASED, EVENTS.STATUS_CHANGED]);
});
check('staying unreleased emits neither RELEASED nor a change', () => {
  assert.deepStrictEqual(libraryService.decideEvents('unreleased', 'unreleased'), [EVENTS.ADDED]);
});
check('the preserved v1 wart: an unchanged re-save still says ADDED', () => {
  // Documented, not accidental — changing it changes how many notifications people
  // receive. Asserted so that if someone does change it, they do it deliberately.
  assert.deepStrictEqual(libraryService.decideEvents('done', 'done'), [EVENTS.ADDED]);
});
check('every event value is one notifyEvent understands', () => {
  assert.deepStrictEqual(Object.values(EVENTS).sort(), ['add', 'release', 'status']);
});

console.log('game field bounds:');
check('STATUSES is the documented five, frozen', () => {
  assert.deepStrictEqual([...libraryService.STATUSES], ['wishlist', 'playing', 'done', 'backlog', 'unreleased']);
  assert.ok(Object.isFrozen(libraryService.STATUSES));
});

// services/catalog.js — the pure parts. The provider calls need a network and live
// in the differential harness; the merge rules and normalisers do not, and they are
// where the subtle defects are.
const catalog = require('../services/catalog');

console.log('catalog.igdbDate (v1 threw RangeError and lost the whole provider):');
check('an out-of-range timestamp yields null instead of throwing', () => {
  // v1: new Date(ts * 1000).toISOString() — a RangeError here escaped the .map,
  // rejected the provider promise, and cost EVERY result rather than one date.
  assert.throws(() => new Date(1e18 * 1000).toISOString(), RangeError);
  assert.strictEqual(catalog.igdbDate(1e18), null);
  assert.strictEqual(catalog.igdbDate(1234567890), '2009-02-13');
});
check('falsy means "no date" — including 0, which is not a release date', () => {
  for (const v of [null, undefined, 0, '', false]) assert.strictEqual(catalog.igdbDate(v), null);
});

console.log('catalog.mergeResults:');
check('a missing cover and Steam App ID are borrowed from a same-named result', () => {
  const igdb = [{ name: 'Half-Life', releaseDate: '1998-11-19', coverUrl: 'i.png', steamAppId: '70' }];
  const rawg = [{ name: 'half-life', releaseDate: '1998-11-19', coverUrl: null, steamAppId: null }];
  const merged = catalog.mergeResults(igdb, rawg, []);
  assert.strictEqual(merged.length, 1, 'same-named results were not deduped');
  assert.strictEqual(merged[0].coverUrl, 'i.png');
  assert.strictEqual(merged[0].steamAppId, '70');
});
check('a release date is NEVER borrowed across a same-name pair', () => {
  // Two genuinely different games share the name "Judas". Borrowing the date would
  // give the unreleased one a 2017 release — and that date drives the
  // unreleased/released status coercion, so a wrong date rewrites a user's status.
  const igdb = [{ name: 'Judas', releaseDate: '2017-01-01', coverUrl: 'a.png', steamAppId: null }];
  const rawg = [{ name: 'Judas', releaseDate: null, coverUrl: null, steamAppId: null }];
  const merged = catalog.mergeResults(igdb, rawg, []);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].releaseDate, null, 'a date was borrowed by name');
  assert.strictEqual(merged[0].coverUrl, 'a.png', 'the cover should still be borrowed');
});
check('dedupe prefers the entry with no release date', () => {
  const a = { name: 'X', releaseDate: '2020-01-01', coverUrl: null, steamAppId: null };
  const b = { name: 'x', releaseDate: null, coverUrl: null, steamAppId: null };
  assert.strictEqual(catalog.mergeResults([a], [b], [])[0].releaseDate, null);
});

console.log('catalog.findExactMatch (a fuzzy match here rewrites the user\'s game):');
check('case-insensitive, but a near miss is not a match', () => {
  const rs = [{ name: 'Half-Life 2' }, { name: 'Portal' }];
  assert.strictEqual(catalog.findExactMatch(rs, 'half-life 2').name, 'Half-Life 2');
  assert.strictEqual(catalog.findExactMatch(rs, 'Half-Life'), null, 'a prefix matched');
  assert.strictEqual(catalog.findExactMatch(rs, 'Portal 2'), null);
  assert.strictEqual(catalog.findExactMatch([], 'x'), null);
});

console.log('catalog.theGamesDbCover:');
check('front boxart wins, then first, then a bare object', () => {
  const base = 'https://cdn/';
  assert.strictEqual(catalog.theGamesDbCover([{ side: 'back', filename: 'b.png' }, { side: 'front', filename: 'f.png' }], base), base + 'f.png');
  assert.strictEqual(catalog.theGamesDbCover([{ side: 'back', filename: 'b.png' }], base), base + 'b.png');
  assert.strictEqual(catalog.theGamesDbCover({ filename: 's.png' }, base), base + 's.png');
  assert.strictEqual(catalog.theGamesDbCover(undefined, base), null);
  assert.strictEqual(catalog.theGamesDbCover([], base), null);
});

console.log('library.statusForDate (one rule, shared by upsert and refresh):');
check('a future date locks unreleased; a past date promotes it', () => {
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(libraryService.statusForDate(iso(30), 'playing'), 'unreleased');
  assert.strictEqual(libraryService.statusForDate(iso(-30), 'unreleased'), 'wishlist');
  assert.strictEqual(libraryService.statusForDate(iso(0), 'unreleased'), 'wishlist');
});
check('a status the user chose is left alone once released', () => {
  const past = '1998-11-19';
  for (const s of ['playing', 'done', 'backlog', 'wishlist']) {
    assert.strictEqual(libraryService.statusForDate(past, s), s, `${s} was reassigned`);
  }
});

console.log('library.isReleased — the rule the two write paths actually share:');
check('absent, unparseable and future all mean "not released"', () => {
  // This is C1: statusForDate used to skip validReleaseDate, so it and upsertGame
  // disagreed on exactly these inputs — one said unreleased, the other wishlist.
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  for (const bad of [null, undefined, '', 'not-a-date', '2024-13-99', 42]) {
    assert.strictEqual(libraryService.isReleased(bad), false, `${JSON.stringify(bad)} read as released`);
    assert.strictEqual(libraryService.statusForDate(bad, 'unreleased'), 'unreleased',
      `${JSON.stringify(bad)} promoted a game with no usable date`);
  }
  assert.strictEqual(libraryService.isReleased(iso(-1)), true);
  assert.strictEqual(libraryService.isReleased(iso(0)), true, 'today must count as released');
  assert.strictEqual(libraryService.isReleased(iso(30)), false);
});

// --- services/users.js: push credentials are not an administrative field ------
//
// Both halves of the exposure, asserted from the two places it could come back:
// the SELECT projection and the update path. Neither needs a database — the
// projection is a string, and the refusal is thrown before any query is issued.

const usersService = require('../services/users');
const dbModule = require('../db');

// Tokenised, not a substring match: `includes('ntfy_topic')` would also accept a
// column named ntfy_topic_hash, and `includes('password')` would spuriously fail on
// a future last_password_change. Compare column names as a set.
const listedColumns = (sql) =>
  new Set(sql.replace(/^\s*SELECT\s+/i, '').split(/\s+FROM\s+/i)[0].split(',').map((c) => c.trim()));

checkAsync('the admin list query itself excludes every user-owned channel', async () => {
  // Asserted against the SQL listAll ACTUALLY issues, not against the exported
  // constant. Asserting the constant proved nothing: rewriting listAll to
  // `SELECT * FROM users` would ship every credential AND the bcrypt hash to every
  // admin while every assertion about ADMIN_LIST_COLUMNS still passed. That is the
  // same "test covers the artifact, not the behaviour" failure that let a weakened
  // SSRF guard through earlier in this project.
  const original = dbModule.promises.all;
  let issued = null;
  dbModule.promises.all = async (sql) => { issued = sql; return []; };
  try {
    await usersService.listAll();
  } finally {
    dbModule.promises.all = original;
  }

  assert.ok(issued, 'listAll issued no query at all');
  const projection = issued.replace(/^\s*SELECT\s+/i, '').split(/\s+FROM\s+/i)[0];

  // `*` needs the token set: `u.*` is not a bare star but still selects everything.
  const columns = listedColumns(issued);
  for (const token of columns) {
    assert.ok(!token.endsWith('*'), `admin list selects everything (${token}) — it would ship the password hash: ${issued}`);
  }
  // Everything else needs a WORD BOUNDARY, which strictly dominates both a substring
  // match and the token set. Tokenising alone accepted `users.ntfy_topic` and
  // `ntfy_topic AS topic`, because neither is equal to the bare column name; plain
  // substring matching wrongly rejected `last_password_change`. `_` is a word
  // character, so \b solves both: it matches the qualified and aliased forms and does
  // NOT match ntfy_topic_hash.
  const selects = (column) => new RegExp(`\\b${column}\\b`).test(projection);
  assert.ok(!selects('password'), `password is in the admin list query: ${issued}`);
  for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
    assert.ok(
      !selects(column),
      `${column} is in the query GET /api/users actually runs — every admin would `
      + `receive every user's notification target`
    );
  }
});

checkAsync('an admin cannot write another user\'s notification target', async () => {
  for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
    await assert.rejects(
      // actingUserId deliberately differs from id: this is an admin editing someone
      // else, the case that repointed another user's notifications.
      () => usersService.update(7, { [column]: 'attacker-controlled' }, 1),
      (err) => err.code === SVC.VALIDATION && String(err.message).includes(column),
      `update() accepted ${column} — an admin can repoint another user's notifications`
    );
  }
  // Refused, not merely ignored: a silent drop would return {success:true} and tell
  // the caller it had set something it had not.
  await assert.rejects(
    () => usersService.update(7, { email: 'a@b.c', gotify_token: 'x' }, 1),
    (err) => err.code === SVC.VALIDATION,
    'a field smuggled alongside a legitimate one must still be refused'
  );
  // null and "" are sent, not absent — JSON cannot carry undefined. Clearing another
  // user's channel is a silent denial of notification, the same unobservable write.
  for (const value of [null, '']) {
    await assert.rejects(
      () => usersService.update(7, { ntfy_topic: value }, 1),
      (err) => err.code === SVC.VALIDATION,
      `update() accepted ntfy_topic: ${JSON.stringify(value)} — clearing a channel is still writing it`
    );
  }
});

checkAsync('a hostile body can only ever emit allowlisted column literals', async () => {
  // The property the whole raw-body seam rests on. PUT /api/users/:id passes
  // req.body to update() wholesale — deliberately, so a route cannot forget to
  // forward a field the service must refuse — and that is safe ONLY because every
  // string appended to the UPDATE is hardcoded. Asserting it here is what stops a
  // future refactor turning that seam into an arbitrary-column write.
  const original = dbModule.promises.run;
  let issued = null;
  let bound = null;
  dbModule.promises.run = async (sql, params) => { issued = sql; bound = params; return { changes: 1 }; };
  try {
    const hostile = JSON.parse(JSON.stringify({
      email: 'a@b.c',
      "password = 'x', can_manage_users = 1 -- ": 'injected',
      origin: 'ldap',
      id: 999,
      username: 'root2',
      can_create_users: 1,
      created_at: '1970-01-01',
    }));
    await usersService.update(7, hostile, 1);
  } finally {
    dbModule.promises.run = original;
  }

  assert.strictEqual(issued, 'UPDATE users SET email = ? WHERE id = ?',
    `a non-allowlisted key reached the SQL: ${issued}`);
  assert.deepStrictEqual(bound, ['a@b.c', 7]);
});

checkAsync('prototype pollution cannot smuggle a notification target past the guard', async () => {
  // The other half of the raw-body argument: an inherited property is still visible
  // to the guard, so a polluted body fails CLOSED rather than slipping through.
  Object.prototype.gotify_token = 'pwned';
  try {
    await assert.rejects(
      () => usersService.update(7, { email: 'a@b.c' }, 1),
      (err) => err.code === SVC.VALIDATION && String(err.message).includes('gotify_token'),
      'an inherited gotify_token was not refused — the raw-body seam fails OPEN'
    );
  } finally {
    delete Object.prototype.gotify_token;
  }

  // The other direction, and the one passing req.body wholesale actually broke. The
  // old route built a fresh object literal, so every writable field was an OWN
  // property — undefined when unsent — which shadowed the prototype and immunised
  // these reads by accident. Removing that literal removed the accident: an inherited
  // can_manage_users would have been WRITTEN, granting admin on an arbitrary account
  // from a body that never named the field.
  Object.prototype.can_manage_users = 1;
  const original = dbModule.promises.run;
  let issued = null;
  dbModule.promises.run = async (sql) => { issued = sql; return { changes: 1 }; };
  try {
    await usersService.update(7, { email: 'a@b.c' }, 1);
  } finally {
    dbModule.promises.run = original;
    delete Object.prototype.can_manage_users;
  }
  assert.strictEqual(issued, 'UPDATE users SET email = ? WHERE id = ?',
    `an INHERITED can_manage_users was written: ${issued}`);
});

check('every channel column in the schema is classified as user-owned', () => {
  // Derived from the SCHEMA, not from a copy of the list. Without this, shrinking
  // USER_OWNED_NOTIFICATION_COLUMNS back to two names silently un-guarded ntfy_url,
  // gotify_url and telegram_chat_id and the whole suite still passed — the list is
  // the policy, so nothing asserting its contents means the policy can be edited
  // away. This is the same control as api-surface.test.js failing on an unrecorded
  // route: a NEW channel column added to `users` fails here until someone classifies
  // it, rather than defaulting to admin-writable by omission.
  // EVERY migration, not just 001. CLAUDE.md requires a new column to arrive as a
  // new numbered migration and forbids editing one that has already been applied —
  // so reading 001 alone missed the only sanctioned way to add a column. A migration
  // adding `pushover_user_key` to users passed this test while it read one file.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'migrations');
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

  const table = sql.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/);
  assert.ok(table, 'could not find the users table definition');

  const columns = table[1].split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0]);
  // ...unioned with every column any later migration bolts on.
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) {
    columns.push(m[1]);
  }
  assert.ok(columns.includes('gotify_token'), `column parse failed: ${columns.join(',')}`);

  // An EXHAUSTIVE PARTITION, not a name-guessing regex.
  //
  // The regex this replaced matched channel-sounding vocabulary, so it only ever
  // caught the vendors it was written knowing about: pushover_user, matrix_room and
  // signal_number all slipped through, and `apprise_urls` slipped through on the
  // plural. Partitioning inverts it — EVERY column must be classified, whatever it
  // is called, so a new one fails here until someone decides which bucket it is in.
  // That is the property the commit message claimed and the regex only approximated.
  const owned = new Set(usersService.USER_OWNED_NOTIFICATION_COLUMNS);
  const adminWritable = new Set(usersService.ADMIN_WRITABLE_COLUMNS);

  // Neither admin-writable nor a delivery target: server-managed identity, and the
  // user's own reminder schedule, which the admin API has never accepted.
  const NEITHER = new Set([
    'id', 'username', 'can_create_users', 'created_at', 'origin', 'display_name',
    'notification_days',
  ]);

  for (const column of columns) {
    const buckets = [owned.has(column), adminWritable.has(column), NEITHER.has(column)]
      .filter(Boolean).length;
    assert.strictEqual(buckets, 1,
      `users.${column} is in ${buckets} of the three classifications. Every column must be `
      + `in exactly one: USER_OWNED_NOTIFICATION_COLUMNS (refused with a 400), `
      + `ADMIN_WRITABLE_COLUMNS (an admin may set it), or the NEITHER list in this test. `
      + `A new column is unclassified until someone chooses — deciding by omission is how `
      + `an admin ends up able to write something nobody meant them to.`);
  }
  // And the reverse: a listed name that is not a real column protects nothing.
  for (const column of [...owned, ...adminWritable, ...NEITHER]) {
    assert.ok(columns.includes(column), `users.${column} is classified but does not exist in any migration`);
  }
});

check('no INSERT into users writes a caller-supplied notification target', () => {
  // EVERY INSERT, not the first one. Matching a single statement silently tested the
  // root-seed INSERT at index.js:171, which never carried these columns — so the
  // assertion passed while the create route happily wrote a caller's gotify_token.
  // A vacuous assertion is worse than none: it reports the rule as covered.
  // Every file that inserts a user, not just index.js. The test name says "no INSERT
  // into users", and it was scoped to one file while create-local-admin.js still
  // listed ntfy_topic in its column list — a hardcoded '' and host-shell-only, so no
  // live risk, but an assertion narrower than its own name is how the next one gets
  // missed.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  // services/ too. The create route's INSERT moved into services/users.js, and a scan
  // of the root alone would have gone from four statements to three WITHOUT noticing
  // that one of them had simply moved out of view — a coverage hole that reports
  // itself as a smaller, tidier codebase.
  const files = [
    ...fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => f),
    ...fs.readdirSync(path.join(root, 'services')).filter((f) => f.endsWith('.js'))
      .map((f) => path.join('services', f)),
  ];
  const inserts = files.flatMap((f) =>
    [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/INSERT INTO users \([^)]*\)/g)]
      .map((m) => ({ file: f, sql: m[0] })));
  assert.ok(inserts.length >= 4, `expected every user INSERT to be found, saw ${inserts.length}`);
  for (const { file, sql: statement } of inserts) {
    for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
      assert.ok(!statement.includes(column), `${column} is back in a user INSERT in ${file}: ${statement}`);
    }
  }
  // The guard must still run on the create path. It now lives in the service, where
  // BOTH surfaces reach it — checking index.js alone would pass while v2's create
  // bypassed it entirely, which is the same "narrower than its own name" failure this
  // test's comment above is about.
  const createSource = fs.readFileSync(path.join(root, 'services', 'users.js'), 'utf8');
  const createBody = createSource.slice(createSource.indexOf('async function create('),
    createSource.indexOf('// Delete an account'));
  assert.ok(
    /assertNotUserOwned/.test(createBody),
    'services/users.js#create no longer calls assertNotUserOwned — an admin can plant a '
    + 'notification target on a new account, which survives the user changing their password'
  );
});

console.log('auth.createToken expiry (minting something inert and reporting success):');
checkAsync('a non-string expiresAt is REFUSED, not coerced into a dead token', async () => {
  const authSvc = require('../services/auth');
  // Date.parse coerces via toString, so ["2099-01-01"] parses as a valid future
  // instant — and the array is then stored as the Postgres literal {"2099-01-01"},
  // which reads back as NaN. The token minted, reported 201, and 401'd on first use.
  // Not exploitable (verifyToken fails closed) but exactly what this function's own
  // comment forbids two lines further down.
  for (const bad of [['2099-01-01'], 2099, { toString: () => '2099-01-01' }, true]) {
    let code = null;
    await authSvc.createToken({ userId: 1, name: 'x', scopes: ['library'], expiresAt: bad })
      .catch((err) => { code = err.code; });
    assert.strictEqual(code, 'validation', `createToken accepted expiresAt ${JSON.stringify(bad)}`);
  }
  // null still means "never expires", and a real ISO string still passes validation.
  // Neither reaches the database here — both throw later, on the insert — so the
  // assertion is only that they got PAST the type check.
  for (const good of [null, '2099-01-01T00:00:00.000Z']) {
    let code = null;
    await authSvc.createToken({ userId: 1, name: 'x', scopes: ['library'], expiresAt: good })
      .catch((err) => { code = err.code; });
    assert.notStrictEqual(code, 'validation', `createToken rejected a legitimate expiresAt ${good}`);
  }
});

console.log('ldap-helpers.satisfiesRequiredGroup:');
{
  const { satisfiesRequiredGroup } = require('../ldap-helpers');
  check('an empty requiredGroup means the control is not in use', () => {
    for (const none of ['', '   ', null, undefined]) {
      assert.strictEqual(satisfiesRequiredGroup({ memberOf: [] }, none), true);
    }
  });
  check('a PADDED requiredGroup still matches', () => {
    // Untrimmed, ' gamers ' matched nothing and locked every user out permanently,
    // while '   ' read as unconfigured and silently turned the control off. A stray
    // space in a settings field should not be able to do either.
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: ['cn=gamers,dc=x'] }, ' gamers '), true);
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: ['cn=other,dc=x'] }, ' gamers '), false);
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: ['cn=gamers,dc=x'] }, '\tGAMERS\n'), true);
  });
  check('a single-valued memberOf (a bare string) is handled like a list', () => {
    // entryAttributes collapses a one-element attribute to a scalar, so this is what a
    // user in exactly one group actually looks like.
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: 'cn=gamers,dc=x' }, 'gamers'), true);
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: 'cn=other,dc=x' }, 'gamers'), false);
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: '' }, 'gamers'), false);
  });
  check('membership is case-insensitive on BOTH the attribute name and the value', () => {
    // A directory answering `memberof` (lowercase) used to read as "member of
    // nothing", which refused every login and presented as a directory outage.
    assert.strictEqual(satisfiesRequiredGroup({ memberof: ['CN=Gamers,dc=x'] }, 'gamers'), true);
    assert.strictEqual(satisfiesRequiredGroup({ MemberOf: ['cn=gamers,dc=x'] }, 'GAMERS'), true);
  });
  check('a non-member is refused, and so is an entry with no groups at all', () => {
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: ['cn=other,dc=x'] }, 'gamers'), false);
    assert.strictEqual(satisfiesRequiredGroup({ memberOf: [] }, 'gamers'), false);
    assert.strictEqual(satisfiesRequiredGroup({}, 'gamers'), false);
    // Fails CLOSED on a malformed entry rather than treating absence as membership.
    assert.strictEqual(satisfiesRequiredGroup(null, 'gamers'), false);
  });
}

console.log('users.update — a directory account may not be given a local password:');
checkAsync('setting a password on an origin=ldap row is REFUSED', async () => {
  // The hybrid this prevents authenticates two ways and only one consults the
  // directory, so ldap.requiredGroup is skipped on the local path — a review showed an
  // account removed from the required group being refused with its directory password
  // and admitted with its local one.
  const dbMod = require('../db');
  const realGet = dbMod.promises.get;
  const realRun = dbMod.promises.run;
  let wrote = 0;
  dbMod.promises.get = async () => ({ origin: 'ldap' });
  dbMod.promises.run = async () => { wrote++; };
  try {
    let code = null;
    await usersService.update(5, { password: 'a-perfectly-valid-password' }, 1)
      .catch((err) => { code = err.code; });
    assert.strictEqual(code, 'validation', 'a directory account accepted a local password');
    assert.strictEqual(wrote, 0, 'the password was written despite the refusal');
  } finally {
    dbMod.promises.get = realGet;
    dbMod.promises.run = realRun;
  }
});

checkAsync('a LOCAL account is unaffected', async () => {
  const dbMod = require('../db');
  const realGet = dbMod.promises.get;
  const realRun = dbMod.promises.run;
  dbMod.promises.get = async () => ({ origin: 'local' });
  dbMod.promises.run = async () => {};
  try {
    let code = null;
    await usersService.update(5, { password: 'a-perfectly-valid-password' }, 1)
      .catch((err) => { code = err.code; });
    assert.notStrictEqual(code, 'validation', 'a local account was refused its own password change');
  } finally {
    dbMod.promises.get = realGet;
    dbMod.promises.run = realRun;
  }
});

console.log('jobs.fetchSteamPrice — three outcomes, never collapsed:');
{
  const axiosMod = require('axios');
  const jobsSvc = require('../services/jobs');
  const withSteam = async (impl, fn) => {
    const real = axiosMod.get;
    axiosMod.get = impl;
    try { return await fn(); } finally { axiosMod.get = real; }
  };

  checkAsync('a priced game returns the formatted string for that region', async () => {
    let seen = null;
    await withSteam(async (url, cfg) => {
      seen = { url, params: cfg.params, redirects: cfg.maxRedirects, timeout: cfg.timeout };
      return { data: { 440: { success: true, data: { price_overview: { final_formatted: '₪59.99' } } } } };
    }, async () => {
      const r = await jobsSvc.fetchSteamPrice('440', { region: 'il' });
      assert.deepStrictEqual(r, { ok: true, price: '₪59.99', reason: null });
    });
    assert.strictEqual(seen.params.cc, 'il', 'the region was not passed to Steam');
    assert.strictEqual(seen.redirects, 0,
      'redirects are followed — a 302 off Steam is not an answer about a price');
    assert.ok(seen.timeout > 0, 'no timeout, so a hung Steam holds the request open');
  });

  checkAsync('an app absent from the region is 200-with-null, not an error', async () => {
    // Steam answers success:false for an id its regional store does not carry. That is
    // an ANSWER. Collapsing it into the error branch makes the route 502 and a caller
    // report an outage for a game that is simply not sold there.
    await withSteam(async () => ({ data: { 999: { success: false } } }), async () => {
      const r = await jobsSvc.fetchSteamPrice('999');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.price, null);
      assert.strictEqual(r.reason, 'not_in_region');
    });
  });

  checkAsync('a free or unreleased game is also 200-with-null, distinctly', async () => {
    await withSteam(async () => ({ data: { 7: { success: true, data: {} } } }), async () => {
      const r = await jobsSvc.fetchSteamPrice('7');
      assert.deepStrictEqual(r, { ok: true, price: null, reason: 'free_or_unpriced' });
    });
  });

  checkAsync('an unreachable Steam is NOT ok, and carries no upstream body', async () => {
    await withSteam(async () => { const e = new Error('connect ETIMEDOUT'); e.response = { data: 'secret upstream body' }; throw e; },
      async () => {
        const r = await jobsSvc.fetchSteamPrice('440');
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'connect ETIMEDOUT');
        assert.ok(!JSON.stringify(r).includes('secret upstream body'),
          'the upstream response body reached the caller');
      });
  });

  checkAsync('a hostile price string is sanitised and bounded', async () => {
    // This value lands in a user-visible column. A non-string once became the literal
    // "[object Object]" while the run reported success.
    await withSteam(async () => ({ data: { 1: { success: true, data: { price_overview: { final_formatted: { evil: 1 } } } } } }),
      async () => {
        assert.strictEqual((await jobsSvc.fetchSteamPrice('1')).price, null);
      });
    await withSteam(async () => ({ data: { 1: { success: true, data: { price_overview: { final_formatted: 'x'.repeat(500) } } } } }),
      async () => {
        const r = await jobsSvc.fetchSteamPrice('1');
        assert.ok(r.price.length <= 64, `price not bounded: ${r.price.length} chars`);
      });
  });
}

console.log('jobs.updatePrices — the sweep counts three outcomes separately:');
checkAsync('updated / withoutPrice / errors are not collapsed, and only priced rows are written', async () => {
  // The counting was rewritten when the Steam call was extracted for the v2 price
  // route, and it had no test — a run that checked 40 games and priced none must not
  // report 40 successes, and an unreachable Steam must not read as "no price".
  const axiosMod = require('axios');
  const dbMod = require('../db');
  const jobsSvc = require('../services/jobs');
  const realGet = axiosMod.get, realAll = dbMod.promises.all, realRun = dbMod.promises.run;
  const written = [];
  dbMod.promises.all = async () => ([
    { id: 1, steam_app_id: '440' },   // priced
    { id: 2, steam_app_id: '999' },   // not in region
    { id: 3, steam_app_id: '7' },     // Steam unreachable
  ]);
  dbMod.promises.run = async (sql, params) => { written.push(params[0]); return { changes: 1 }; };
  axiosMod.get = async (url, cfg) => {
    const id = cfg.params.appids;
    if (id === '440') return { data: { 440: { success: true, data: { price_overview: { final_formatted: '₪59.99' } } } } };
    if (id === '999') return { data: { 999: { success: false } } };
    throw new Error('connect ETIMEDOUT');
  };
  try {
    const report = await jobsSvc.updatePrices({ region: 'il' });
    assert.deepStrictEqual(report, { checked: 3, updated: 1, withoutPrice: 1, errors: 1 },
      `the sweep miscounted: ${JSON.stringify(report)}`);
    // ONLY the priced row is written. An unreachable Steam must not blank a price that
    // was correct yesterday.
    assert.deepStrictEqual(written, ['₪59.99'],
      'the sweep wrote a row it had no price for');
  } finally {
    axiosMod.get = realGet; dbMod.promises.all = realAll; dbMod.promises.run = realRun;
  }
});

console.log('auth admin revocation — the SQL is the safety property:');
{
  const dbMod = require('../db');
  const authSvc = require('../services/auth');
  // `get` is stubbed too: the admin operations now resolve the target account FIRST and
  // 404 when it is absent, so without this they reach the real database. Returns a row
  // by default — the "no such user" case is asserted separately below.
  const capture = async (fn, { userExists = true } = {}) => {
    const realGet = dbMod.promises.get;
    const realRun = dbMod.promises.run;
    const realAll = dbMod.promises.all;
    const seen = [];
    dbMod.promises.get = async (sql, params) => {
      seen.push({ sql, params, lookup: true });
      return userExists ? { id: params[0] } : undefined;
    };
    dbMod.promises.run = async (sql, params) => { seen.push({ sql, params }); return { changes: 1 }; };
    dbMod.promises.all = async (sql, params) => { seen.push({ sql, params }); return []; };
    try { await fn(); } finally {
      dbMod.promises.get = realGet;
      dbMod.promises.run = realRun;
      dbMod.promises.all = realAll;
    }
    return seen.filter((q) => !q.lookup);
  };

  checkAsync('revoking ONE token matches BOTH the token and the owner', async () => {
    // Matching on tokenId alone and checking the owner separately leaves a window
    // between the check and the delete — and, more practically, a mistyped userId
    // would silently destroy a token belonging to an account nobody meant to touch.
    // Asserted against the statement actually issued, not against a constant.
    const [{ sql, params }] = await capture(() => authSvc.revokeTokenForUser(7, 42));
    const where = sql.slice(sql.toUpperCase().indexOf('WHERE'));
    assert.match(where, /\bid\s*=\s*\?/, 'the token id is not in the WHERE clause');
    assert.match(where, /\buser_id\s*=\s*\?/, 'the OWNER is not in the WHERE clause');
    assert.deepStrictEqual(params, [7, 42]);
  });

  checkAsync('a token id that matches nothing is NOT_FOUND, never a silent success', async () => {
    const realRun = dbMod.promises.run;
    dbMod.promises.run = async () => ({ changes: 0 });
    try {
      let code = null;
      await authSvc.revokeTokenForUser(7, 42).catch((err) => { code = err.code; });
      assert.strictEqual(code, 'not_found');
    } finally { dbMod.promises.run = realRun; }
  });

  checkAsync('bulk revoke is scoped to the one account, and zero is a SUCCESS', async () => {
    const [{ sql, params }] = await capture(() => authSvc.revokeAllTokensForUser(42));
    assert.match(sql, /DELETE FROM api_tokens WHERE user_id = \?/i);
    assert.deepStrictEqual(params, [42], 'bulk revoke is not scoped to a single account');
    // The zero-revoked case has its own assertion above, where the account-existence
    // lookup is stubbed too. Doing it inline here reached the real database.
  });

  checkAsync('a user id that is not a user is NOT_FOUND, not a quiet success', async () => {
    // The defect a review found in production: DELETE /users/99999/tokens answered
    // 200 {"revoked": 0}, which an operator deprovisioning a departing employee reads
    // as "they held no credentials" — while a live admin-scoped token with no expiry
    // keeps working. The count tells "revoked seven" from "revoked none"; it cannot
    // tell "revoked none" from "you did not address a real account".
    for (const call of [
      () => authSvc.revokeAllTokensForUser(99999),
      () => authSvc.listTokensForUser(99999),
    ]) {
      let code = null;
      await capture(async () => { await call().catch((err) => { code = err.code; }); }, { userExists: false });
      assert.strictEqual(code, 'not_found', 'a nonexistent account was reported as a success');
    }
  });

  checkAsync('zero tokens for a REAL account is still a success', async () => {
    // The other half, and the reason this is not just "throw on zero": an account that
    // genuinely holds nothing is the outcome the administrator wanted.
    const realGet = dbMod.promises.get;
    const realRun = dbMod.promises.run;
    dbMod.promises.get = async () => ({ id: 42 });
    dbMod.promises.run = async () => ({ changes: 0 });
    try {
      assert.deepStrictEqual(await authSvc.revokeAllTokensForUser(42), { revoked: 0 });
    } finally { dbMod.promises.get = realGet; dbMod.promises.run = realRun; }
  });

  checkAsync('the admin listing never selects the hash', async () => {
    // This projection now crosses an account boundary, where token_hash matters more
    // than it did on the self-service listing. Read from the statement, because
    // rewriting it to SELECT * would ship the lookup key with every assertion green.
    const [{ sql, params }] = await capture(() => authSvc.listTokensForUser(42));
    const projection = sql.slice(0, sql.toUpperCase().indexOf('FROM'));
    assert.ok(!/token_hash/i.test(projection), 'the admin token listing selects token_hash');
    assert.ok(!/\*/.test(projection), 'the admin token listing uses SELECT *');
    assert.match(sql, /WHERE user_id = \?/i);
    assert.deepStrictEqual(params, [42]);
  });
}

console.log('users.verifyPassword (sudo mode for minting a token from the browser):');
  check('readSettings() really does return { settings, degraded }', () => {
    // The stubs below imitate this shape. When they imitated it WRONGLY — returning
    // the settings object bare — verifyPassword read `.ldap` off the wrapper, got
    // undefined, and refused every directory user with a 503 while these tests stayed
    // green. A stub is only as good as the contract it copies, so the contract is
    // asserted against the real module here.
    const real = require('../settings-store').readSettings();
    assert.ok(Object.hasOwn(real, 'settings'), 'readSettings() no longer returns a .settings wrapper');
    assert.ok(Object.hasOwn(real, 'degraded'), 'readSettings() no longer reports .degraded');
    assert.strictEqual(typeof real.settings, 'object');
  });

{
  const dbMod = require('../db');
  const bcryptLib = require('bcryptjs');
  const withRow = async (row, fn) => {
    const real = dbMod.promises.get;
    dbMod.promises.get = async () => row;
    try { return await fn(); } finally { dbMod.promises.get = real; }
  };

  checkAsync('the right password passes and the wrong one does not', async () => {
    const hash = await bcryptLib.hash('correct horse', 10);
    await withRow({ password: hash, origin: 'local' }, async () => {
      assert.deepStrictEqual(await usersService.verifyPassword(1, 'correct horse'), { ok: true });
      assert.strictEqual((await usersService.verifyPassword(1, 'wrong')).ok, false);
      // Case matters, and so does whitespace — no trimming on a password, ever.
      assert.strictEqual((await usersService.verifyPassword(1, 'Correct Horse')).ok, false);
      assert.strictEqual((await usersService.verifyPassword(1, ' correct horse ')).ok, false);
    });
  });

  checkAsync('a NULL password never reaches bcrypt', async () => {
    // Directory accounts have no local hash. bcrypt.compare REJECTS on a null hash
    // rather than returning false — and an unhandled rejection in the route's promise
    // chain takes the process down under Node's default --unhandled-rejections=throw.
    const ldapHelpers = require('../ldap-helpers');
    const settingsStore = require('../settings-store');
    const realRead = settingsStore.readSettings;
    const realVerify = ldapHelpers.verifyLdapCredentials;
    settingsStore.readSettings = () => ({ settings: { ldap: {} }, degraded: false });
    ldapHelpers.verifyLdapCredentials = async () => { throw new Error('must not be called'); };
    try {
      for (const stored of [null, undefined, '', 0, {}]) {
        await withRow({ username: 'u', password: stored, origin: 'ldap' }, async () => {
          const out = await usersService.verifyPassword(1, 'anything at all');
          assert.strictEqual(out.ok, false, `a stored password of ${JSON.stringify(stored)} was accepted`);
          // No local hash AND no directory to ask: fails closed, and says which.
          assert.strictEqual(out.reason, 'no_directory');
        });
      }
    } finally {
      settingsStore.readSettings = realRead;
      ldapHelpers.verifyLdapCredentials = realVerify;
    }
  });

  checkAsync('a verified directory user OUTSIDE requiredGroup is still refused', async () => {
    // The blocker. requiredGroup lives only in the directory — it is never mirrored
    // into `users` — so the per-request privilege re-read cannot revoke it. Without
    // this re-check a deprovisioned account, refused at login, could still turn its
    // residual session into a token with no expiry that no admin can see or revoke.
    //
    // Asserted HERE and not only at the route, because the route test stubs
    // verifyPassword whole: deleting this check left every route assertion green.
    const ldapHelpers = require('../ldap-helpers');
    const settingsStore = require('../settings-store');
    const realRead = settingsStore.readSettings;
    const realVerify = ldapHelpers.verifyLdapCredentials;
    settingsStore.readSettings = () => ({
      settings: { ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw', requiredGroup: 'gamers' } },
      degraded: false,
    });
    try {
      // Correct password, but the entry is not in the group.
      ldapHelpers.verifyLdapCredentials = async () => ({
        ok: true, entry: { dn: 'uid=jane', memberOf: ['cn=other,dc=x'] },
      });
      await withRow({ username: 'jane', password: null, origin: 'ldap' }, async () => {
        const out = await usersService.verifyPassword(1, 'their-real-password');
        assert.strictEqual(out.ok, false, 'a user outside the required group was allowed to mint');
        assert.strictEqual(out.reason, 'directory_not_authorized');
      });
      // ...and a member of the group still passes, so the check is not just refusing.
      ldapHelpers.verifyLdapCredentials = async () => ({
        ok: true, entry: { dn: 'uid=jane', memberOf: ['cn=gamers,dc=x'] },
      });
      await withRow({ username: 'jane', password: null, origin: 'ldap' }, async () => {
        assert.strictEqual((await usersService.verifyPassword(1, 'pw')).ok, true);
      });
    } finally {
      settingsStore.readSettings = realRead;
      ldapHelpers.verifyLdapCredentials = realVerify;
    }
  });

  checkAsync('a directory account is verified against the DIRECTORY, and the outcomes are not collapsed', async () => {
    // The mapping is the safety property. 'unreachable' is an outage the user cannot
    // fix by retyping and 'ambiguous' is a directory misconfiguration the login route
    // refuses outright — reporting either as "wrong password" would send the user to
    // debug their own typing while the real fault sits elsewhere. Only a rejected bind
    // is a wrong password.
    const ldapHelpers = require('../ldap-helpers');
    const settingsStore = require('../settings-store');
    const realRead = settingsStore.readSettings;
    const realVerify = ldapHelpers.verifyLdapCredentials;
    settingsStore.readSettings = () => ({
      settings: { ldap: { url: 'ldaps://dc', base: 'dc=x', bindDn: 'cn=svc', bindPass: 'pw' } },
      degraded: false,
    });
    const cases = [
      [{ ok: true, entry: { dn: 'uid=jane' } }, { ok: true }],
      [{ ok: false, reason: 'bad_password' }, { ok: false, reason: 'wrong_password' }],
      [{ ok: false, reason: 'unreachable' }, { ok: false, reason: 'directory_unreachable' }],
      [{ ok: false, reason: 'ambiguous', dns: ['a', 'b'] }, { ok: false, reason: 'directory_ambiguous' }],
      [{ ok: false, reason: 'not_found' }, { ok: false, reason: 'directory_not_found' }],
    ];
    try {
      for (const [ldapResult, expected] of cases) {
        let sawUsername = null;
        ldapHelpers.verifyLdapCredentials = async (_settings, username) => {
          sawUsername = username; return ldapResult;
        };
        await withRow({ username: 'jane', password: null, origin: 'ldap' }, async () => {
          const out = await usersService.verifyPassword(1, 'typed-password');
          assert.strictEqual(out.ok, expected.ok, `${ldapResult.reason}: ok mismatch`);
          if (expected.reason) assert.strictEqual(out.reason, expected.reason);
          // The DIRECTORY username comes from the row, never from the caller.
          assert.strictEqual(sawUsername, 'jane');
        });
      }
    } finally {
      settingsStore.readSettings = realRead;
      ldapHelpers.verifyLdapCredentials = realVerify;
    }
  });

  checkAsync('a non-string or empty supplied password is refused before any lookup', async () => {
    let looked = 0;
    const real = dbMod.promises.get;
    dbMod.promises.get = async () => { looked++; return null; };
    try {
      for (const bad of [undefined, null, '', 0, 1, {}, [], true]) {
        const out = await usersService.verifyPassword(1, bad);
        assert.strictEqual(out.ok, false, `verifyPassword accepted ${JSON.stringify(bad)}`);
        assert.strictEqual(out.reason, 'missing');
      }
      assert.strictEqual(looked, 0, 'a malformed password still hit the database');
    } finally { dbMod.promises.get = real; }
  });

  checkAsync('an unknown user id fails closed', async () => {
    await withRow(undefined, async () => {
      assert.strictEqual((await usersService.verifyPassword(999, 'x')).ok, false);
    });
  });

  checkAsync('the reasons are distinct enough to route, without being an oracle', async () => {
    // The ADAPTER collapses wrong_password and missing into one 403 so a caller cannot
    // learn which it was. The service still reports them separately, because
    // `not_local` has to reach a different message — that is the whole point of
    // returning a reason rather than a boolean. Both halves are asserted: here, and in
    // the route, which answers the same 403 for both.
    const hash = await bcryptLib.hash('pw', 10);
    await withRow({ password: hash, origin: 'local' }, async () => {
      assert.strictEqual((await usersService.verifyPassword(1, 'nope')).reason, 'wrong_password');
    });
    const settingsStore = require('../settings-store');
    const realRead = settingsStore.readSettings;
    settingsStore.readSettings = () => ({ settings: { ldap: {} }, degraded: false });
    try {
      await withRow({ username: 'u', password: null, origin: 'ldap' }, async () => {
        assert.strictEqual((await usersService.verifyPassword(1, 'nope')).reason, 'no_directory');
      });
    } finally { settingsStore.readSettings = realRead; }
  });
}

checkAsync('a duplicate username is CONFLICT, matched on SQLSTATE and not on message text', async () => {
  // The other half of the v1 shim asserted in api-contract.test.js: that shim only
  // fires if create() actually throws CONFLICT here. db.js divergence #11 — match the
  // SQLSTATE, never the message, which is localisable and version-dependent. 23505 is
  // unique_violation, and username is the only unique constraint on this table.
  const dbMod = require('../db');
  const real = dbMod.promises.run;
  const throwing = (code) => async () => { const e = new Error('whatever the driver says'); e.code = code; throw e; };
  try {
    dbMod.promises.run = throwing('23505');
    let err = null;
    await usersService.create({ username: 'taken', password: 'longenoughpassword' }).catch((e) => { err = e; });
    assert.strictEqual(err?.code, 'conflict');
    assert.strictEqual(err.message, 'User already exists');

    // Any OTHER database error must NOT be laundered into a 4xx. 23503 is a foreign
    // key violation — a real defect, and reporting it as "user already exists" sends
    // whoever is debugging it in precisely the wrong direction.
    dbMod.promises.run = throwing('23503');
    let other = null;
    await usersService.create({ username: 'fine', password: 'longenoughpassword' }).catch((e) => { other = e; });
    // Rethrown UNTOUCHED — still the driver's error, still carrying its SQLSTATE, and
    // not a ServiceError, so problem.js sends it to the 500 branch that never echoes a
    // message rather than pattern-matching it into a 4xx.
    assert.notStrictEqual(other?.name, 'ServiceError',
      'a non-unique-violation was laundered into a service error');
    assert.strictEqual(other.code, '23503');
    assert.strictEqual(require('../services/problem').toProblem(other), null,
      'a raw driver error is recognised by the problem table — it must fall through to the 500');
  } finally { dbMod.promises.run = real; }
});

checkAsync('the create path REFUSES a planted notification target, on both surfaces', async () => {
  // The assertion above reads the source; this drives the function. Both matter: the
  // grep proves the call has not been deleted, and this proves it still refuses —
  // a call whose result was ignored would satisfy the grep alone.
  for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
    let code = null;
    await usersService.create({ username: 'victim', password: 'longenoughpassword', [column]: 'x' })
      .catch((err) => { code = err.code; });
    assert.strictEqual(code, 'validation', `create() accepted a caller-supplied ${column}`);
  }
});

// --- services/auth.js: personal access tokens ---------------------------------
//
// The scope rule gets the most attention here because it is the only thing standing
// between a library-scoped MCP token and the admin routes, and because it is a rule
// that fails SILENTLY in the dangerous direction: a scope that accidentally grants
// looks exactly like a scope that correctly permits.

const authService = require('../services/auth');

check('a scope can only NARROW privilege, never grant it', () => {
  const admin = { id: 1, username: 'root', can_manage_users: true, origin: 'local', display_name: 'root' };
  const plain = { id: 2, username: 'jane', can_manage_users: false, origin: 'local', display_name: 'jane' };

  // An admin account holding a library-only token is NOT an admin for that request.
  // This is the whole point: it is what makes handing an MCP server a token safe.
  assert.strictEqual(
    authService.authorize({ user: admin, scopes: ['library'] }).can_manage_users, false,
    'a library-scoped token kept its holder\'s admin rights'
  );
  // ...and an admin-scoped token held by a NON-admin does not become one. A scope is
  // a filter over privilege the account already has, not a grant of privilege.
  assert.strictEqual(
    authService.authorize({ user: plain, scopes: ['admin'] }).can_manage_users, false,
    'an admin scope GRANTED admin to an account that does not have it'
  );
  // The only combination that authorises.
  assert.strictEqual(authService.authorize({ user: admin, scopes: ['admin', 'library'] }).can_manage_users, true);
});

check('authorize() emits the same shape the JWT path does', () => {
  // Every route reads req.user. If the two credential types produced different
  // shapes, a route would work under one and break under the other — and the one
  // that breaks would be the one nobody clicks through by hand.
  const user = { id: 3, username: 'jane', can_manage_users: false, origin: 'ldap', display_name: 'Jane' };
  const out = authService.authorize({ user, scopes: ['library'] });
  assert.deepStrictEqual(Object.keys(out).sort(),
    ['can_manage_users', 'display_name', 'id', 'origin', 'username']);
});

check('a malformed scopes column falls back to LEAST privilege', () => {
  // Read on every authenticated request. A parse failure that defaulted to admin
  // would turn one corrupt row into privilege escalation.
  for (const bad of ['', 'not json', '{}', 'null', '[]', '["nonsense"]', '["ADMIN"]']) {
    assert.deepStrictEqual(authService.parseScopes(bad), ['library'],
      `parseScopes(${JSON.stringify(bad)}) did not fall back to library-only`);
  }
  assert.deepStrictEqual(authService.parseScopes('["admin"]'), ['admin']);
  // An unknown scope alongside a real one is dropped, not honoured.
  assert.deepStrictEqual(authService.parseScopes('["admin","root","library"]'), ['admin', 'library']);
});

check('normaliseScopes refuses an empty result rather than minting a useless token', () => {
  assert.deepStrictEqual(authService.normaliseScopes(['Admin', ' library ']), ['admin', 'library']);
  assert.deepStrictEqual(authService.normaliseScopes(undefined), ['library']);
  for (const empty of [[], ['nonsense'], ['', null]]) {
    assert.throws(() => authService.normaliseScopes(empty), (err) => err.code === SVC.VALIDATION,
      `normaliseScopes(${JSON.stringify(empty)}) produced a token that can do nothing`);
  }
});

check('strict mode REFUSES an unknown scope; lenient mode drops it', () => {
  // Both answers are right in their own place. Re-reading a stored row: drop, so a
  // name that is no longer a scope stops granting. Accepting one a human just typed:
  // refuse, because silently minting a weaker token than they asked for is found out
  // at the worst possible moment. The rule lives in the service so the CLI and the
  // coming Settings route cannot each carry their own copy.
  assert.deepStrictEqual(authService.normaliseScopes(['admin', 'nonsense']), ['admin']);
  assert.throws(() => authService.normaliseScopes(['admin', 'nonsense'], { strict: true }),
    (err) => err.code === SVC.VALIDATION && /nonsense/.test(err.message),
    'strict mode accepted an unknown scope');
});

check('stored scopes are CANONICAL, so the schema CHECK can enumerate them', () => {
  // migrations/003 constrains the column to exactly three values. Unsorted output
  // would produce '["library","admin"]' and the INSERT would fail the constraint —
  // a fatal migration-era error surfacing at mint time.
  assert.deepStrictEqual(authService.normaliseScopes(['library', 'admin']), ['admin', 'library']);
  assert.deepStrictEqual(authService.normaliseScopes(['admin', 'library']), ['admin', 'library']);
  const legal = new Set(['["library"]', '["admin"]', '["admin","library"]']);
  for (const input of [['library'], ['admin'], ['admin', 'library'], ['library', 'admin']]) {
    const stored = JSON.stringify(authService.normaliseScopes(input));
    assert.ok(legal.has(stored), `${stored} is not one of the three values the CHECK allows`);
  }
});

check('an expiry in the past is refused rather than minted dead', () => {
  // Unreachable from the CLI, whose flag is a positive number of days. A UI date
  // picker reaches it, and a token that can never authenticate reporting success is
  // worse than a refusal.
  assert.rejects(
    () => authService.createToken({ userId: 1, name: 'x', scopes: ['library'], expiresAt: '2000-01-01T00:00:00Z' }),
    (err) => err.code === SVC.VALIDATION);
});

checkAsync('the token listing returns PARSED scopes, not the raw column', async () => {
  // It returned '["library"]' where every caller expects ['library']. Invisible while
  // nothing called it — which is exactly why unused code needs its shape pinned.
  const original = dbModule.promises.all;
  dbModule.promises.all = async () => [{ id: 1, name: 'cli', hint: 'abcd', scopes: '["admin","library"]', created_at: 'x', last_used_at: null, expires_at: null }];
  try {
    const [row] = await authService.listTokens(1);
    assert.deepStrictEqual(row.scopes, ['admin', 'library'], 'scopes came back as a raw JSON string');
  } finally {
    dbModule.promises.all = original;
  }
});

check('looksLikePat ROUTES a credential without authorizing it', () => {
  assert.strictEqual(authService.looksLikePat('gt_pat_abc'), true);
  // A JWT has three dot-separated segments and never this prefix.
  assert.strictEqual(authService.looksLikePat('eyJhbGciOiJIUzI1NiJ9.e30.sig'), false);
  for (const bad of [null, undefined, 42, {}, '', 'Gt_Pat_abc', ' gt_pat_abc']) {
    assert.strictEqual(authService.looksLikePat(bad), false, `${JSON.stringify(bad)} was routed to the token verifier`);
  }
});

check('the token hash is stable, and is not the token', () => {
  const token = 'gt_pat_example';
  const hash = authService.hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/, 'not a SHA-256 hex digest');
  assert.strictEqual(hash, authService.hashToken(token), 'hashing is not deterministic — no token would ever verify');
  assert.ok(!hash.includes('example'), 'the plaintext survived into the stored value');
  assert.notStrictEqual(authService.hashToken('gt_pat_examplf'), hash);
});

checkAsync('verifyToken answers null identically for unknown, expired and orphaned', async () => {
  // Distinguishing these confirms to a prober that a guess was once real.
  const original = dbModule.promises.get;
  const rows = {
    unknown: undefined,
    expired: {
      id: 1, user_id: 1, scopes: '["library"]', expires_at: '2000-01-01T00:00:00.000Z',
      last_used_at: null, username: 'jane', can_manage_users: 0, origin: 'local', display_name: 'Jane',
    },
  };
  try {
    for (const [label, row] of Object.entries(rows)) {
      dbModule.promises.get = async () => row;
      assert.strictEqual(await authService.verifyToken('gt_pat_whatever'), null,
        `an ${label} token did not answer null`);
    }
    // A credential that is not PAT-shaped must not even reach the database.
    let queried = false;
    dbModule.promises.get = async () => { queried = true; return undefined; };
    assert.strictEqual(await authService.verifyToken('eyJhbGciOiJIUzI1NiJ9.e30.sig'), null);
    assert.strictEqual(queried, false, 'a JWT was looked up in the token table');
  } finally {
    dbModule.promises.get = original;
  }
});

checkAsync('a credential cannot mint a token holding a scope it lacks', async () => {
  // The escape hatch out of the whole scope system if it is missing: the
  // library-scoped token handed to the MCP mints itself an admin token and is an
  // administrator one call later. authorize() narrows the PRESENTED credential; it
  // says nothing about the scopes of one being created.
  const originalGet = dbModule.promises.get;
  const originalRun = dbModule.promises.run;
  dbModule.promises.get = async () => ({ id: 1, can_manage_users: 1 });
  dbModule.promises.run = async () => ({ changes: 1, lastID: 1 });
  try {
    await assert.rejects(
      () => authService.createToken({
        userId: 1, name: 'escalate', scopes: ['admin'], grantedScopes: ['library'],
      }),
      (err) => err.code === SVC.FORBIDDEN,
      'a library-scoped credential minted an admin-scoped token');
    // The same request from a credential that DOES hold admin is fine.
    const ok = await authService.createToken({
      userId: 1, name: 'fine', scopes: ['admin'], grantedScopes: ['admin', 'library'],
    });
    assert.deepStrictEqual(ok.scopes, ['admin']);
    // null means "operator at a shell", which is above the API by construction.
    const cli = await authService.createToken({ userId: 1, name: 'cli', scopes: ['admin'] });
    assert.deepStrictEqual(cli.scopes, ['admin']);
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.run = originalRun;
  }
});

checkAsync('an admin-scoped token is refused for a non-admin account', async () => {
  // Not an escalation — authorize() narrows it away on every request — but a
  // credential that silently does less than its minter believes. Same reasoning as
  // refusing an already-expired expiry: minting something inert and reporting success
  // is worse than saying no.
  const originalGet = dbModule.promises.get;
  const originalRun = dbModule.promises.run;
  dbModule.promises.get = async () => ({ id: 2, can_manage_users: 0 });
  dbModule.promises.run = async () => ({ changes: 1, lastID: 2 });
  try {
    await assert.rejects(
      () => authService.createToken({ userId: 2, name: 'inert', scopes: ['admin'] }),
      (err) => err.code === SVC.VALIDATION);
    // library-scoped on the same account is of course fine.
    const ok = await authService.createToken({ userId: 2, name: 'ok', scopes: ['library'] });
    assert.deepStrictEqual(ok.scopes, ['library']);
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.run = originalRun;
  }
});

checkAsync('an UNPARSEABLE expiry is treated as expired, not as absent', async () => {
  // The dangerous half of this is that the naive check passes: Date.parse of junk is
  // NaN and `NaN <= Date.now()` is false, so a corrupt expires_at reads as "never
  // expires". parseScopes fails closed on the same class of input on the same row.
  const originalGet = dbModule.promises.get;
  const originalRun = dbModule.promises.run;
  dbModule.promises.run = async () => ({ changes: 1 });
  try {
    for (const junk of ['not-a-date', '', '0000-00-00', 'null', 'Infinity']) {
      dbModule.promises.get = async () => ({
        id: 1, user_id: 1, scopes: '["admin"]', expires_at: junk, last_used_at: null,
        username: 'jane', can_manage_users: 1, origin: 'local', display_name: 'Jane',
      });
      const result = await authService.verifyToken('gt_pat_whatever');
      // '' is falsy and therefore genuinely "no expiry set" — that one may verify.
      if (junk === '') { assert.ok(result, 'an empty expiry should mean no expiry'); continue; }
      assert.strictEqual(result, null, `expires_at ${JSON.stringify(junk)} was honoured as never-expiring`);
    }
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.run = originalRun;
  }
});

checkAsync('a valid token yields fresh privilege from users, not from the token', async () => {
  const originalGet = dbModule.promises.get;
  const originalRun = dbModule.promises.run;
  dbModule.promises.get = async () => ({
    id: 9, user_id: 4, scopes: '["admin","library"]', expires_at: null, last_used_at: null,
    // can_manage_users comes from the JOINed users row — this is the value that was
    // frozen into the JWT payload before authRequired started re-reading it.
    username: 'jane', can_manage_users: 1, origin: 'local', display_name: 'Jane',
  });
  dbModule.promises.run = async () => ({ changes: 1 });
  try {
    const identity = await authService.verifyToken('gt_pat_whatever');
    assert.ok(identity);
    assert.deepStrictEqual(identity.scopes, ['admin', 'library']);
    assert.strictEqual(identity.user.can_manage_users, true);
    assert.strictEqual(authService.authorize(identity).can_manage_users, true);
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.run = originalRun;
  }
});

checkAsync('revocation is scoped to the owner in the WHERE clause', async () => {
  // Not checked beforehand: an ownership test followed by a delete has a window
  // between them. Asserting the SQL is the only way to see the difference.
  const original = dbModule.promises.run;
  let issued = null;
  let bound = null;
  dbModule.promises.run = async (sql, params) => { issued = sql; bound = params; return { changes: 1 }; };
  try {
    await authService.revokeToken(5, 7);
  } finally {
    dbModule.promises.run = original;
  }
  assert.match(issued, /WHERE id = \? AND user_id = \?/, `revoke is not owner-scoped: ${issued}`);
  assert.deepStrictEqual(bound, [5, 7]);
});

checkAsync('revoking someone else\'s token is NOT FOUND, never success', async () => {
  const original = dbModule.promises.run;
  dbModule.promises.run = async () => ({ changes: 0 });
  try {
    await assert.rejects(() => authService.revokeToken(5, 7), (err) => err.code === SVC.NOT_FOUND,
      'a revoke that deleted nothing reported success — the holder believes a live token is dead');
  } finally {
    dbModule.promises.run = original;
  }
});

checkAsync('the token listing never returns the hash', async () => {
  const original = dbModule.promises.all;
  let issued = null;
  dbModule.promises.all = async (sql) => { issued = sql; return []; };
  try {
    await authService.listTokens(1);
  } finally {
    dbModule.promises.all = original;
  }
  assert.ok(!/\btoken_hash\b/.test(issued), `token_hash is in the listing query: ${issued}`);
  assert.ok(!/\*/.test(issued), `the listing is SELECT *, so a new column ships automatically: ${issued}`);
});

// --- services/library.js: the v2 page ------------------------------------------

checkAsync('meta.total counts the FILTER, never the cursor-narrowed set', async () => {
  // The count and the page shared one WHERE, so `total` reported rows REMAINING from
  // page 2 onward while the spec promises "rows matching the filter, ignoring paging"
  // and a client renders "12 of 340" from it. Correct on page 1, wrong after — the
  // shape of defect that survives a demo.
  const libraryService = require('../services/library');
  const originalGet = dbModule.promises.get;
  const originalAll = dbModule.promises.all;
  let countSql = null;
  let pageSql = null;
  dbModule.promises.get = async (sql) => { countSql = sql; return { total: 42 }; };
  dbModule.promises.all = async (sql) => { pageSql = sql; return []; };
  try {
    const cursor = libraryService.encodeCursor(
      { sort: 'name', order: 'asc', status: null, lastKey: 'M', lastId: 7 });
    await libraryService.listPage(1, { sort: 'name', cursor });
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.all = originalAll;
  }
  assert.ok(!/game_name >/.test(countSql),
    `the COUNT carries the cursor predicate, so total shrinks per page: ${countSql}`);
  assert.ok(/game_name >/.test(pageSql), `the page query lost its cursor predicate: ${pageSql}`);
  // ...and the ordering stays total, with NULLS LAST stated rather than defaulted.
  assert.ok(/NULLS LAST/.test(pageSql), `ordering no longer says NULLS LAST: ${pageSql}`);
  assert.ok(/id ASC/.test(pageSql), `the id tiebreaker is gone — keyset paging needs a TOTAL order: ${pageSql}`);
});

checkAsync('a forged cursor is a 400, never a database type error', async () => {
  // lastId is compared against an INTEGER column: a string produces SQLSTATE 22P02 and
  // a 500 where the spec promises 400. db.js divergence #5 — the class parseRouteId
  // exists to prevent for route params, and the cursor was the one integer comparison
  // without such a guard. Each of these must throw BEFORE any query is issued.
  const libraryService = require('../services/library');
  const originalGet = dbModule.promises.get;
  const originalAll = dbModule.promises.all;
  let queried = false;
  dbModule.promises.get = async () => { queried = true; return { total: 0 }; };
  dbModule.promises.all = async () => { queried = true; return []; };
  try {
    const forge = (state) => Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
    const base = { sort: 'name', order: 'asc', status: null };
    for (const bad of [
      { ...base, lastKey: 'M', lastId: 'abc' },
      { ...base, lastKey: 'M', lastId: 1.5 },
      { ...base, lastKey: {}, lastId: 1 },
      { ...base, lastKey: ['a'], lastId: 1 },
    ]) {
      await assert.rejects(
        () => libraryService.listPage(1, { sort: 'name', cursor: forge(bad) }),
        (err) => err.code === SVC.VALIDATION,
        `a cursor with lastId=${JSON.stringify(bad.lastId)} lastKey=${JSON.stringify(bad.lastKey)} was accepted`);
    }
    await assert.rejects(() => libraryService.listPage(1, { limit: 'abc' }),
      (err) => err.code === SVC.VALIDATION, 'limit=abc was silently coerced instead of refused');
    assert.strictEqual(queried, false, 'a malformed request reached the database');
  } finally {
    dbModule.promises.get = originalGet;
    dbModule.promises.all = originalAll;
  }
});

check('the taxonomy has a 401 code, distinct from 403', () => {
  // There was NO code mapping to 401, so v2's auth middleware was forced to answer 403
  // — the same code an insufficient SCOPE returns. A client then cannot tell
  // "re-authenticate" from "stop retrying" except by reading English out of `detail`,
  // which Problem explicitly tells it never to branch on. For an agent holding a
  // long-lived token, expiry is the one failure it is guaranteed to hit.
  const { PROBLEMS } = require('../services/problem');
  assert.strictEqual(PROBLEMS[SVC.UNAUTHENTICATED].status, 401);
  assert.strictEqual(PROBLEMS[SVC.FORBIDDEN].status, 403);
  assert.notStrictEqual(SVC.UNAUTHENTICATED, SVC.FORBIDDEN);
});

// --- services/v2.js: the wire format ------------------------------------------

const v2svc = require('../services/v2');

check('v2 errors are problem+json and never leak a withheld message', () => {
  const exposed = v2svc.toProblem(serviceError(SVC.VALIDATION, 'sort must be one of: name', { field: 'sort' }));
  assert.strictEqual(exposed.status, 400);
  assert.strictEqual(exposed.body.code, 'validation');
  assert.strictEqual(exposed.body.type, '/problems/validation');
  assert.ok(exposed.body.detail.includes('sort must be'));

  // expose:false in services/problem.js means the service's own message must not
  // appear — the same rule v1 applies, carried onto a format whose `detail` field
  // invites putting an exception message in it.
  const hidden = v2svc.toProblem(serviceError(SVC.NOT_FOUND, 'user 42 has no row in user_games'));
  assert.strictEqual(hidden.status, 404);
  assert.strictEqual(hidden.body.detail, undefined, 'a withheld message reached `detail`');
  assert.ok(!/user_games|42/.test(JSON.stringify(hidden.body)));

  // An unrecognised error is never pattern-matched into a 4xx and never echoed.
  const unknown = v2svc.toProblem(new Error('connection terminated unexpectedly'));
  assert.strictEqual(unknown.status, 500);
  assert.strictEqual(unknown.body.code, 'internal');
  assert.ok(!/connection terminated/.test(JSON.stringify(unknown.body)));
});

check('the v2 mapper emits camelCase ONCE, with no v1 aliases', () => {
  const row = {
    id: 1, user_id: 2, game_id: 'igdb_5', game_name: 'A', cover_url: null,
    release_date: '2024-01-01', status: 'backlog', steam_app_id: '440',
    last_price: null, last_price_updated: null, crack_status: 'cracked',
    backlog_order: 3, added_at: '2026-01-01T00:00:00.000Z',
  };
  const out = v2svc.libraryGame(row);
  assert.deepStrictEqual(Object.keys(out).sort(), [
    'addedAt', 'backlogOrder', 'coverUrl', 'crackStatus', 'gameId', 'lastPrice',
    'lastPriceUpdatedAt', 'name', 'releaseDate', 'status', 'steamAppId',
  ]);
  // No snake_case survives, and no internal ids leak.
  for (const key of Object.keys(out)) assert.ok(!key.includes('_'), `${key} is snake_case`);
  assert.strictEqual(out.id, undefined, 'the internal row id reached the response');
  assert.strictEqual(out.userId, undefined, 'the owning user id reached the response');
});

check('the mapper uses ?? so a real 0 is not turned into null', () => {
  // `|| null` would map backlogOrder 0 to null. Position 0 does not occur today; the
  // habit is what matters, and the same operator protects every other optional.
  const out = v2svc.libraryGame({ game_id: 'igdb_1', game_name: 'A', status: 'backlog', backlog_order: 0 });
  assert.strictEqual(out.backlogOrder, 0);
  // ...and an absent value is null, never undefined: JSON.stringify drops undefined
  // keys entirely, so a client sees "field removed" rather than "no value".
  assert.strictEqual(out.coverUrl, null);
  assert.ok('coverUrl' in out);
});

check('me() reports EFFECTIVE privilege, after scope narrowing', () => {
  const admin = { id: 1, username: 'root', display_name: 'root', origin: 'local', can_manage_users: true };
  // authorize() has already narrowed can_manage_users by the time this runs, so a
  // library-scoped admin arrives here as false — which is the correct answer for what
  // that credential can do, and what /api/v2/me must report.
  const narrowed = v2svc.me({ ...admin, can_manage_users: false }, { scopes: ['library'], expiresAt: null });
  assert.strictEqual(narrowed.canManageUsers, false);
  assert.deepStrictEqual(narrowed.scopes, ['library']);
  assert.deepStrictEqual(Object.keys(narrowed).sort(),
    ['canManageUsers', 'displayName', 'id', 'origin', 'scopes', 'tokenExpiresAt', 'username']);
});

check('the cursor pins the query it was issued for', () => {
  const libraryService = require('../services/library');
  const cursor = libraryService.encodeCursor({ sort: 'name', order: 'asc', status: null, lastKey: 'A', lastId: 1 });
  // Opaque to a client, but decodable here: it must not be a bare offset, and it must
  // carry the query it belongs to so a sort change mid-page is caught rather than
  // silently resuming in a different ordering.
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  assert.deepStrictEqual(Object.keys(decoded).sort(), ['lastId', 'lastKey', 'order', 'sort', 'status']);
  assert.ok(!/^\d+$/.test(cursor), 'the cursor is a bare number — that is an offset, not a keyset position');
});

// The async cases run last. A rejection here must fail the process — an async
// assertion that only prints would be a test that always passes.
(async () => {
  for (const [label, fn] of asyncChecks) {
    await fn();
    n++;
    console.log('  ok  ' + label);
  }
  console.log(`\n${n} assertions passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
