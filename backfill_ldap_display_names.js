const sqlite3 = require('sqlite3').verbose();
const ldap = require('ldapjs');
const fs = require('fs');

// Load LDAP settings from settings.json
const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
const ldapSettings = settings.ldap;

const db = new sqlite3.Database('gametracker.db');

function getLdapDisplayName(username, callback) {
  const client = ldap.createClient({ url: ldapSettings.url });
  client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
    if (err) {
      console.error(`LDAP bind failed for ${username}:`, err);
      client.unbind();
      return callback(null);
    }
    const searchOptions = {
      filter: `(sAMAccountName=${username})`,
      scope: 'sub',
      attributes: ['displayName', 'cn']
    };
    client.search(ldapSettings.base, searchOptions, (err, res) => {
      if (err) {
        console.error(`LDAP search failed for ${username}:`, err);
        client.unbind();
        return callback(null);
      }
      let found = false;
      res.on('searchEntry', (entry) => {
        const attrs = entry.attributes.reduce((acc, attr) => {
          acc[attr.type] = attr.vals[0];
          return acc;
        }, {});
        const displayName = attrs.displayName || attrs.cn || username;
        found = true;
        callback(displayName);
        client.unbind();
      });
      res.on('end', () => {
        if (!found) {
          callback(null);
          client.unbind();
        }
      });
      res.on('error', (err) => {
        console.error(`LDAP search error for ${username}:`, err);
        callback(null);
        client.unbind();
      });
    });
  });
}

db.all("SELECT username FROM users WHERE origin = 'ldap'", [], (err, rows) => {
  if (err) {
    console.error('DB error:', err);
    db.close();
    return;
  }
  let processed = 0;
  rows.forEach(row => {
    getLdapDisplayName(row.username, (displayName) => {
      if (displayName) {
        db.run("UPDATE users SET display_name = ? WHERE username = ?", [displayName, row.username], (err) => {
          if (err) {
            console.error(`Failed to update ${row.username}:`, err);
          } else {
            console.log(`Updated ${row.username} to "${displayName}"`);
          }
          if (++processed === rows.length) db.close();
        });
      } else {
        console.warn(`Could not find displayName for ${row.username}`);
        if (++processed === rows.length) db.close();
      }
    });
  });
  if (rows.length === 0) db.close();
});