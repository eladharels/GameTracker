// Script to refresh IGDB Bearer Token from Twitch OAuth
// Usage: node refresh_igdb_token.js [CLIENT_ID] [CLIENT_SECRET]

//
// Stores the token in settings.json through services/settings.js — the SAME call the
// Settings → API Keys → Refresh IGDB Token button makes (ROADMAP UP-9). It used to
// rewrite `.env`, which could not work: settings.json's apikeys WIN over the
// environment (settings-store#resolveApiKey), so once the UI had ever stored a bearer
// token this script reported success while the backend kept the old one; and inside
// the backend container, where CLAUDE.md says to run these scripts, there is no .env.
// Through settings.json the backend picks it up on its next read (mtime cache) — no
// restart.

require('dotenv').config();
const axios = require('axios');
const { resolveApiKey, SETTINGS_FILE } = require('./settings-store');
const settingsService = require('./services/settings');

// The last 6 characters only. This is a live credential and the console it prints to
// is a shell history, a CI log or a screen-share. It is stored for the backend to use;
// it does not also need to be readable over someone's shoulder.
const maskToken = (t) => (String(t).length <= 6 ? '••••••' : `••••••••${String(t).slice(-6)}`);

// Same precedence as the button: settings.json, then the environment. Arguments still
// override both for a one-off.
const CLIENT_ID = process.argv[2] || resolveApiKey('IGDB_CLIENT_ID');
const CLIENT_SECRET = process.argv[3] || resolveApiKey('IGDB_CLIENT_SECRET');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: Missing CLIENT_ID or CLIENT_SECRET');
  console.log('\nUsage:');
  console.log('  node refresh_igdb_token.js [CLIENT_ID] [CLIENT_SECRET]');
  console.log('\nOr set them in Settings → API Keys, or as IGDB_CLIENT_ID /');
  console.log('IGDB_CLIENT_SECRET in the environment.');
  process.exit(1);
}

async function refreshToken() {
  try {
    console.log('Requesting new token from Twitch...');
    // Credentials in the POST BODY. As `params` they went into the query string —
    // the request line, which every TLS-terminating proxy and access log on the path
    // records. RFC 6749 §2.3.1 says body. Matches the route in index.js.
    const response = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }), { timeout: 15000 });

    const { access_token, expires_in } = response.data;
    if (!access_token) {
      console.error('❌ Twitch returned no access_token.');
      process.exit(1);
    }

    console.log('\n✅ Token generated successfully!');
    console.log(`Token expires in: ${expires_in} seconds (${Math.round(expires_in / 86400)} days)`);
    console.log(`New Bearer Token: ${maskToken(access_token)}`);

    // A write failure (or a settings.json the store could not read, which it refuses
    // to overwrite) is reported separately from a Twitch failure, as the route does.
    try {
      const masked = settingsService.storeIgdbToken(access_token);
      // The PATH, because it is settings-store's __dirname: inside the backend container
      // that is the mounted file the server reads, but from a host checkout it is the
      // checkout's own settings.json, which no running server reads at all.
      console.log(`✅ Stored in ${SETTINGS_FILE} (${masked}).`);
      console.log('   A backend reading that file uses it on its next read — no restart needed.');
      console.log('   (Run this INSIDE the backend container, or the file above is not the live one.)');
    } catch (err) {
      console.error('❌ Twitch issued a token, but it could not be stored:', String(err.message).slice(0, 300));
      process.exit(1);
    }

  } catch (error) {
    // Status and message only. `error.response.data` is a third-party body echoed to
    // a log; with credentials in the query string it could carry them straight back.
    console.error('❌ Error generating token:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Reason:', String(error.response.data?.message
        || error.response.data?.error_description || '(no message)').slice(0, 200));
    } else {
      console.error(String(error.message).slice(0, 200));
    }
    process.exit(1);
  }
}

refreshToken();
