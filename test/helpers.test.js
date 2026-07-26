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
// Why these particular functions: both the escaping and the attribute lookup guard
// defects that are invisible to code review. Swapping two .replace() calls in
// escapeLdapFilterValue still looks correct but breaks the escaping; a directory
// answering `memberof` instead of `memberOf` used to refuse EVERY login while
// failing closed, so it presented as a directory outage rather than as our bug.
const assert = require('assert');
const {
  escapeLdapFilterValue, buildUserSearchFilter, entryAttributes, attrValue, attrValues,
  isCompatMirrorDn,
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
check('the real pair from production resolves to exactly one entry', () => {
  const matched = [
    'uid=eladharels,cn=users,cn=compat,dc=etech,dc=com',
    'uid=eladharels,cn=users,cn=accounts,dc=etech,dc=com',
  ].filter(dn => !isCompatMirrorDn(dn));
  assert.deepStrictEqual(matched, ['uid=eladharels,cn=users,cn=accounts,dc=etech,dc=com']);
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

console.log(`\n${n} assertions passed.`);
