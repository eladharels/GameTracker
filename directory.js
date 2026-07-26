// Directory reads that are not part of authentication.
//
// getLdapEmail lived in index.js, which meant services/notifications.js could not
// require it without a cycle — so it was passed IN as a parameter. That made the
// validation of the returned address conditional on every caller remembering to
// supply the function, which is authorization by omission: the exact shape that has
// already cost this project two LDAP auth bypasses. A caller that forgot got a
// silent `null` and no directory lookup at all.
//
// It lives here so resolveEmail() can just require it. ldap-helpers.js stays free of
// settings-store, and this module owns the combination.

const { loadSettings } = require('./settings-store');
const {
  buildUserSearchFilter, createLdapClient, warnIfCleartextLdap, entryAttributes, attrValue,
} = require('./ldap-helpers');

async function getLdapEmail(username) {
  return new Promise((resolve) => {
    // Normalize username to lowercase to prevent case sensitivity issues
    const normalizedUsername = username ? username.toLowerCase() : '';
    const settings = loadSettings();
    const ldapSettings = settings.ldap || {};
    
    if (!ldapSettings.url || !ldapSettings.bindDn || !ldapSettings.bindPass) {
      resolve(null);
      return;
    }

    warnIfCleartextLdap(ldapSettings.url);
    // A socket error here resolves null (no email found) instead of crashing.
    const client = createLdapClient(ldapSettings.url, () => resolve(null));
    client.bind(ldapSettings.bindDn, ldapSettings.bindPass, (err) => {
      if (err) {
        console.log('[LDAP] Service account bind failed for email lookup:', err.message);
        client.markHandled();
        client.unbind();
        resolve(null);
        return;
      }
      
      // Try multiple username attributes: first sAMAccountName (AD), then uid (FreeIPA).
      // Using an OR filter means if either matches, we get a result. The username is
      // RFC 4515-escaped so it cannot alter the filter's structure.
      const searchOptions = {
        filter: buildUserSearchFilter(normalizedUsername),
        scope: 'sub',
        attributes: ['mail', 'email']
      };
      
      client.search(ldapSettings.base, searchOptions, (err, searchRes) => {
        if (err) {
          console.log('[LDAP] Search failed for email lookup:', err);
          client.markHandled();
          client.unbind();
          resolve(null);
          return;
        }
        
        // Buffered, and the SAME pairing rule as the login path — a bare
        // "skip anything under cn=compat" would discard a compat-only account's
        // entry outright and read the email off whatever else matched the username.
        const rawEntries = [];
        searchRes.on('searchEntry', (entry) => rawEntries.push(entry));

        searchRes.on('end', () => {
          client.markHandled();
          client.unbind();
          // No compat filtering — see ldap-helpers.js. An ambiguous match means we
          // cannot say whose address this is, and it gets written to the account and
          // used as a notification recipient, so decline rather than guess.
          const entries = rawEntries;
          if (entries.length > 1) {
            console.warn(`[LDAP] ${entries.length} entries matched during email lookup — ambiguous, skipping.`);
            return resolve(null);
          }
          let foundEmail = null;
          for (const entry of entries) {
            foundEmail = attrValue(entryAttributes(entry), 'mail', 'email') || foundEmail;
          }
          resolve(foundEmail);
        });
        
        searchRes.on('error', (err) => {
          console.error('[LDAP] Search error during email lookup:', err);
          client.markHandled();
          client.unbind();
          resolve(null);
        });
      });
    });
  });
}

module.exports = { getLdapEmail };
