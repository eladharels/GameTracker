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
