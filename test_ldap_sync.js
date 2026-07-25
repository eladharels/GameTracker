// ===========================================================================
// NOT YET PORTED TO POSTGRESQL.
//
// This script still opens the legacy SQLite file, which is no longer the source
// of truth. node-sqlite3 opens with OPEN_CREATE by default, so without this
// guard it would silently CREATE an empty gametracker.db and then cheerfully
// report "no rows found" -- looking like a successful no-op while the real
// database was untouched. Fail loudly instead.
//
// To port: replace the sqlite3 handle with `require('./db')`, which exposes the
// same run/get/all callback surface. See reset-root-password.js for a worked
// example. Remove this guard when done.
// ===========================================================================
if (!process.env.ALLOW_LEGACY_SQLITE_SCRIPT) {
  console.error('[UNPORTED] ' + __filename.split('/').pop() + ' still targets SQLite, which GameTracker no longer uses.');
  console.error('           Porting it to ./db is required before it will do anything useful.');
  console.error('           Set ALLOW_LEGACY_SQLITE_SCRIPT=1 only to run it against an old .db file on purpose.');
  process.exit(1);
}

const sqlite3 = require('sqlite3').verbose();
const ldap = require('ldapjs');
const fs = require('fs');

// Load settings
const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const ldapSettings = settings.ldap;

const db = new sqlite3.Database('gametracker.db');

console.log('Testing LDAP Sync Functionality...');
console.log('LDAP Settings:', {
  url: ldapSettings.url,
  base: ldapSettings.base,
  bindDn: ldapSettings.bindDn,
  bindPass: ldapSettings.bindPass ? '[HIDDEN]' : 'NOT SET'
});

// Test LDAP connection
async function testLdapConnection() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: ldapSettings.url });
    
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.error('❌ LDAP bind failed:', err.message);
        client.unbind();
        reject(err);
        return;
      }
      
      console.log('✅ LDAP connection successful');
      client.unbind();
      resolve();
    });
  });
}

// Test getting LDAP users from database
function testGetLdapUsers() {
  return new Promise((resolve, reject) => {
    db.all("SELECT id, username, email, display_name FROM users WHERE origin = 'ldap'", [], (err, rows) => {
      if (err) {
        console.error('❌ Database error:', err.message);
        reject(err);
        return;
      }
      
      console.log(`✅ Found ${rows.length} LDAP users in database:`);
      rows.forEach(user => {
        console.log(`  - ${user.username} (${user.display_name || 'No display name'})`);
      });
      
      resolve(rows);
    });
  });
}

// Main test function
async function runTests() {
  try {
    await testLdapConnection();
    await testGetLdapUsers();
    console.log('\n✅ All tests passed! LDAP sync should work correctly.');
  } catch (error) {
    console.error('\n❌ Tests failed:', error.message);
  } finally {
    db.close();
  }
}

runTests();
