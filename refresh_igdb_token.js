// Script to refresh IGDB Bearer Token from Twitch OAuth
// Usage: node refresh_igdb_token.js [CLIENT_ID] [CLIENT_SECRET]

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

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
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials'
      }
    });

    const { access_token, expires_in } = response.data;
    
    console.log('\n✅ Token generated successfully!');
    console.log(`Token expires in: ${expires_in} seconds (${Math.round(expires_in / 86400)} days)`);
    console.log(`\nNew Bearer Token:\n${access_token}\n`);
    
    // Optionally update .env file
    if (fs.existsSync('.env')) {
      const envContent = fs.readFileSync('.env', 'utf8');
      const updatedContent = envContent.replace(
        /IGDB_BEARER_TOKEN=.*/,
        `IGDB_BEARER_TOKEN=${access_token}`
      );
      fs.writeFileSync('.env', updatedContent);
      console.log('✅ Updated .env file with new token');
    } else {
      console.log('⚠️  .env file not found. Please manually update IGDB_BEARER_TOKEN');
    }
    
  } catch (error) {
    console.error('❌ Error generating token:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

refreshToken();
