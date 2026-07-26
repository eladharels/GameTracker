// Script to refresh IGDB Bearer Token from Twitch OAuth
// Usage: node refresh_igdb_token.js [CLIENT_ID] [CLIENT_SECRET]

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// __dirname, not the process cwd. `.env` used to be resolved against wherever the
// operator was standing, so running this from another directory reported "Updated
// .env file" having written a stray file — or, if none existed there, told the
// operator to update a token by hand that it could have updated.
const ENV_FILE = path.join(__dirname, '.env');

// The last 6 characters only. This is a live credential and the console it prints to
// is a shell history, a CI log or a screen-share. The token is written to `.env` for
// the operator to use; it does not also need to be readable over someone's shoulder.
const maskToken = (t) => (String(t).length <= 6 ? '••••••' : `••••••••${String(t).slice(-6)}`);

const CLIENT_ID = process.argv[2] || process.env.IGDB_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.IGDB_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: Missing CLIENT_ID or CLIENT_SECRET');
  console.log('\nUsage:');
  console.log('  node refresh_igdb_token.js [CLIENT_ID] [CLIENT_SECRET]');
  console.log('\nOr set in .env file:');
  console.log('  IGDB_CLIENT_ID=your_client_id');
  console.log('  IGDB_CLIENT_SECRET=your_client_secret');
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

    if (!fs.existsSync(ENV_FILE)) {
      console.log(`⚠️  ${ENV_FILE} not found. Set IGDB_BEARER_TOKEN yourself, or use`);
      console.log('   Settings → API Keys → Refresh IGDB Token, which stores it for you.');
      return;
    }
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    if (!/^IGDB_BEARER_TOKEN=.*$/m.test(envContent)) {
      // The old code ran .replace() regardless: with no such line it changed nothing,
      // rewrote the file identically and reported success. The operator then restarted
      // against the SAME expired token and had no reason to suspect this step.
      console.log(`⚠️  No IGDB_BEARER_TOKEN line in ${ENV_FILE} — nothing was changed.`);
      console.log('   Add the line yourself, then re-run.');
      return;
    }
    fs.writeFileSync(ENV_FILE, envContent.replace(/^IGDB_BEARER_TOKEN=.*$/m, `IGDB_BEARER_TOKEN=${access_token}`));
    console.log(`✅ Updated ${ENV_FILE} with the new token. Restart the backend to pick it up.`);

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
