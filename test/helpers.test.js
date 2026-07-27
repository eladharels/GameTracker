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
  const columns = listedColumns(issued);
  assert.ok(!columns.has('*'), `admin list is SELECT * — it would ship the password hash: ${issued}`);
  assert.ok(!columns.has('password'), `password is in the admin list query: ${issued}`);
  for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
    assert.ok(
      !columns.has(column),
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

  // Vocabulary-based, and therefore only as good as the vocabulary: this catches a
  // column NAMED like the channels we already know. `matrix_room_id` would slip
  // through. It is a tripwire for the likely case, not a proof, and the comment says
  // so rather than letting the commit message overstate it.
  const channelish =
    /(ntfy|gotify|telegram|discord|slack|matrix|pushover|apprise|webhook)|_(url|token|topic|secret|key|chat_id|room_id)$/;
  const owned = new Set(usersService.USER_OWNED_NOTIFICATION_COLUMNS);
  for (const column of columns.filter((c) => channelish.test(c))) {
    assert.ok(
      owned.has(column),
      `users.${column} addresses a notification channel but is not in `
      + `USER_OWNED_NOTIFICATION_COLUMNS — an admin could write it on another user's `
      + `account and silently redirect their notifications`
    );
  }
  // Every name in the list must be a real column, or the guard protects nothing.
  for (const column of owned) {
    assert.ok(columns.includes(column), `USER_OWNED_NOTIFICATION_COLUMNS names users.${column}, which does not exist`);
  }
});

check('no INSERT into users writes a caller-supplied notification target', () => {
  // EVERY INSERT, not the first one. Matching a single statement silently tested the
  // root-seed INSERT at index.js:171, which never carried these columns — so the
  // assertion passed while the create route happily wrote a caller's gotify_token.
  // A vacuous assertion is worse than none: it reports the rule as covered.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const inserts = [...source.matchAll(/INSERT INTO users \([^)]*\)/g)].map((m) => m[0]);
  assert.ok(inserts.length >= 3, `expected every user INSERT to be found, saw ${inserts.length}`);
  for (const statement of inserts) {
    for (const column of usersService.USER_OWNED_NOTIFICATION_COLUMNS) {
      assert.ok(!statement.includes(column), `${column} is back in a user INSERT: ${statement}`);
    }
  }
  // The create route must still run the guard; there is no other path that refuses a
  // credential planted at provisioning time.
  assert.ok(
    /assertNotUserOwned/.test(source),
    'index.js no longer calls assertNotUserOwned — POST /api/users can plant a '
    + "notification target on a new account, which survives the user changing their password"
  );
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
