// Notification delivery — email, ntfy, Gotify, Telegram.
//
// Owns BOTH the transports and the fan-out, because the fan-out was the duplicated
// part: three sites (the library add/status hook, the admin test-notification route
// and the daily release reminder) each looked up the same six user columns and then
// re-implemented "try each channel, don't let one failure stop the others" with
// three different error policies. They had already drifted:
//
//   * the reminder path awaited sendEmail OUTSIDE a try/catch, so SMTP being down
//     rejected the whole function and ntfy, Gotify and Telegram were never attempted
//     — the user got nothing on any channel because one channel was broken;
//   * only one of the two email-resolution paths validated the address it had just
//     read out of LDAP before writing it to the account and sending to it.
//
// Reads settings through settings-store DIRECTLY, never services/settings.js: it
// needs the real SMTP password and bot token, and the admin surface hands back
// '__unchanged__' in their place.

const axios = require('axios');
const nodemailer = require('nodemailer');
const db = require('../db');
const { loadSettings } = require('../settings-store');
const { isValidEmailAddress } = require('../user-rules');

const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Cover art comes from IGDB/RAWG/TheGamesDB, but the client supplies the value, so
// treat it as untrusted: https only, no credentials, and a known image host.
const ALLOWED_IMAGE_HOSTS = [
  'images.igdb.com', 'media.rawg.io', 'cdn.thegamesdb.net',
  'cdn.cloudflare.steamstatic.com', 'shared.akamai.steamstatic.com',
];
function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ALLOWED_IMAGE_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Per-user notification servers are deliberately allowed to be private/LAN
// addresses — users self-host ntfy and Gotify on their own networks, and blocking
// RFC1918 would break the documented feature. What is NOT acceptable is reaching a
// cloud instance-metadata endpoint, which is the one target that turns a blind
// SSRF into credential theft. Block those specifically.
const METADATA_HOSTS = ['169.254.169.254', 'metadata.google.internal', 'fd00:ec2::254', '100.100.100.200'];
function isBlockedNotificationHost(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    // new URL() keeps the brackets on an IPv6 literal.
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (METADATA_HOSTS.includes(host)) return true;
    // IPv4 link-local (169.254.0.0/16) covers the AWS/Azure/GCP metadata range.
    // new URL() already normalizes decimal/octal/hex IPv4 forms to dotted quads.
    if (/^169\.254\./.test(host)) return true;
    // IPv6 link-local
    if (/^fe80:/i.test(host)) return true;
    return false;
  } catch {
    return true; // unparseable -> refuse
  }
}

// Raw axios errors distinguish ECONNREFUSED / 404 / timeout, which turns the
// Diagnostics "send test notification" button into an open/closed/filtered port
// scanner for the server's internal network. Collapse every network-level outcome
// into one indistinguishable message; the detail still goes to the server log where
// the operator (and only the operator) can see it.
function sanitizeDeliveryError(err, channel) {
  console.error(`[Notify] ${channel} delivery failed:`, err?.message || err);
  if (err?.message === 'Notification server host is not permitted') return err.message;
  return 'Delivery failed. Check the server URL and credentials in My Account, then try again.';
}

// --- Transports -----------------------------------------------------------

async function sendEmail(subject, text, toOverride, coverUrl) {
  const { smtp } = loadSettings();
  if (!smtp.host || !smtp.port || !smtp.from) {
    console.log('[Email] SMTP settings incomplete:', { host: smtp.host, port: smtp.port, from: smtp.from });
    return;
  }

  const finalRecipient = toOverride;
  if (!finalRecipient) {
    console.log('[Email] No recipient email found, skipping email send');
    return;
  }
  // Last line of defence, at the sink. Even if a bad address reaches users.email
  // through a path that skipped validation, nodemailer never sees a recipient list.
  if (!isValidEmailAddress(finalRecipient)) {
    console.error('[Email] Refusing to send: recipient is not a single valid address.');
    return;
  }

  const options = {
    host: smtp.host,
    port: Number(smtp.port),
    secure: Number(smtp.port) === 465,
  };
  if (smtp.user && smtp.pass) {
    options.auth = { user: smtp.user, pass: smtp.pass };
  }

  const transporter = nodemailer.createTransport(options);
  // Both `text` and `coverUrl` derive from user-supplied game data (gameName /
  // coverUrl on POST /api/user/:username/games, and the test-notification body), so
  // interpolating them raw let an authenticated user author arbitrary HTML in a mail
  // sent from the deployment's own SPF/DKIM-aligned domain — a ready-made phishing
  // primitive. Escape the text, and only accept an https image URL.
  const safeText = escapeHtml(text);
  const safeCover = isSafeImageUrl(coverUrl) ? coverUrl : null;
  const html = safeCover
    ? `<div style="font-family:sans-serif;max-width:480px">` +
      `<img src="${escapeHtml(safeCover)}" alt="Game cover" style="max-width:200px;border-radius:6px;display:block;margin-bottom:12px">` +
      `<p style="margin:0;font-size:15px">${safeText}</p></div>`
    : `<div style="font-family:sans-serif;max-width:480px">` +
      `<p style="margin:0;font-size:15px">${safeText}</p></div>`;
  try {
    const result = await transporter.sendMail({
      from: smtp.from,
      to: finalRecipient,
      subject,
      text,
      ...(html && { html }),
    });
    console.log('[Email] Sent:', { messageId: result.messageId, subject });
  } catch (err) {
    console.error('[Email] Failed to send:', { error: err.message, subject });
    throw err;  // Re-throw to let caller handle the error
  }
}

async function sendNtfy(title, message, topic, attachUrl, serverUrl) {
  // Prefer the user's own ntfy server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().ntfy?.url;
  if (!url || !topic) return;
  if (isBlockedNotificationHost(url)) {
    throw new Error('Notification server host is not permitted');
  }
  const headers = { Title: title };
  if (isSafeImageUrl(attachUrl)) headers.Attach = attachUrl;
  // encodeURIComponent: `topic` is unvalidated user input, so interpolating it raw
  // let the caller append their own path, query string and fragment to the request
  // — turning "pick your own server" into "craft an arbitrary request from the
  // server's network position".
  await axios.post(`${url.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, message, {
    headers,
    timeout: 10000,
    maxRedirects: 0,
  });
}

async function sendGotify(title, message, token, priority = 5, imageUrl, serverUrl) {
  // Prefer the user's own Gotify server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().gotify?.url;
  if (!url || !token) return;
  if (isBlockedNotificationHost(url)) {
    throw new Error('Notification server host is not permitted');
  }
  const body = { title, message, priority };
  if (isSafeImageUrl(imageUrl)) {
    body.extras = { 'client::notification': { bigImageUrl: imageUrl } };
  }
  // Token goes in the header, not the query string: query strings land in reverse
  // proxy and Gotify access logs. Header also removes the path-injection sink.
  await axios.post(`${url.replace(/\/$/, '')}/message`, body, {
    headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': token },
    timeout: 10000,
    maxRedirects: 0,
  });
}

async function sendTelegram(title, message, chatId, photoUrl) {
  const { telegram } = loadSettings();
  const botToken = telegram?.bot_token;
  if (!botToken || !chatId) return;
  const text = `*${title}*\n${message}`;
  // Parity with sendNtfy/sendGotify: a hung api.telegram.org must not hold the
  // request open indefinitely.
  const opts = { timeout: 10000, maxRedirects: 0 };
  if (photoUrl) {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption: text,
      parse_mode: 'Markdown',
    }, opts);
  } else {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }, opts);
  }
}

// --- Recipients -----------------------------------------------------------

// The six per-user columns every dispatch needs. One SELECT, one column list: it was
// written out three times, once keyed by id and twice by username, and one of the
// three had already fallen behind on which columns it read.
const CHANNEL_COLUMNS = 'email, ntfy_topic, ntfy_url, gotify_token, gotify_url, telegram_chat_id';

async function channelsForUsername(username) {
  const name = username ? String(username).toLowerCase() : '';
  return (await get(`SELECT ${CHANNEL_COLUMNS} FROM users WHERE username = ?`, [name])) || {};
}

async function channelsForId(id) {
  return (await get(`SELECT ${CHANNEL_COLUMNS} FROM users WHERE id = ?`, [id])) || {};
}

// The account's email, falling back to the directory and caching what it finds.
//
// `ldapLookup` is passed in rather than imported: LDAP belongs to the auth path, not
// to notifications, and requiring index.js from here would be a cycle.
//
// TWO things this fixes, both of which were live on the daily release cron:
//
//   * the address read from LDAP was written to the account and used as a recipient
//     WITHOUT validation. One path checked, the other did not. A directory `mail`
//     value carrying a comma turns the cron into an authenticated relay from this
//     deployment's SPF/DKIM-aligned domain — the same reason the check exists at the
//     write site in services/users.js and again at the sink in sendEmail.
//   * the backfill UPDATE was fire-and-forget. Per db.js, pool.end() abandons queries
//     still waiting for a connection WITHOUT invoking their callbacks, so in a script
//     or a shutting-down process the write vanishes silently. Awaited now.
async function resolveEmail(username, ldapLookup) {
  const name = username ? String(username).toLowerCase() : '';
  const row = await get('SELECT email FROM users WHERE username = ?', [name]);
  if (row?.email) return row.email;
  if (typeof ldapLookup !== 'function') return null;

  let fromLdap = null;
  try {
    fromLdap = await ldapLookup(name);
  } catch (err) {
    console.error('[Notify] LDAP email lookup failed for', name, '-', err.message);
    return null;
  }
  if (!fromLdap) return null;
  if (!isValidEmailAddress(fromLdap)) {
    console.warn('[Notify] Ignoring malformed mail attribute from the directory for', name);
    return null;
  }
  try {
    await run('UPDATE users SET email = ? WHERE username = ?', [fromLdap, name]);
  } catch (err) {
    // Cache miss, not a delivery failure — still send to the address we resolved.
    console.error('[Notify] Could not cache the directory email for', name, '-', err.message);
  }
  return fromLdap;
}

// --- Fan-out --------------------------------------------------------------

// One channel table. Adding a channel means adding a row here, not a fourth
// copy of the same try/catch in a third call site.
const CHANNELS = [
  {
    key: 'email',
    configured: (c) => !!c.email,
    missing: 'No email configured for current user',
    send: (c, p) => sendEmail(p.subject, p.text, c.email, p.coverUrl),
  },
  {
    key: 'ntfy',
    configured: (c) => !!c.ntfy_topic,
    missing: 'No personal NTFY topic set — configure it in My Account',
    send: (c, p) => sendNtfy(p.title, p.message, c.ntfy_topic, p.coverUrl, c.ntfy_url),
  },
  {
    key: 'gotify',
    configured: (c) => !!c.gotify_token,
    missing: 'No personal Gotify token set — configure it in My Account',
    send: (c, p) => sendGotify(p.title, p.message, c.gotify_token, 5, p.coverUrl, c.gotify_url),
  },
  {
    key: 'telegram',
    configured: (c) => !!c.telegram_chat_id,
    missing: 'No personal Telegram chat ID set — configure it in My Account',
    send: (c, p) => sendTelegram(p.title, p.message, c.telegram_chat_id, p.coverUrl),
  },
];

const CHANNEL_KEYS = CHANNELS.map((c) => c.key);

// Deliver `payload` on every configured channel.
//
// NO CHANNEL'S FAILURE STOPS ANOTHER. That is the whole contract, and it is why this
// is one function: the release-reminder path awaited email outside a try/catch, so a
// broken SMTP server silenced ntfy, Gotify and Telegram for every user, every day,
// until someone noticed.
//
// `only` restricts delivery to a subset (the admin test route sends one channel at a
// time). Returns { channel: {sent, error} } for every channel considered — the
// caller decides whether anyone wants to hear about it.
async function dispatch(channels, payload, { only } = {}) {
  // EVERY channel appears in the result, including ones `only` excluded — they come
  // back {sent:false, error:null}, meaning "not attempted". v1's shape, and the
  // admin Diagnostics panel renders a row per channel unconditionally.
  const results = {};
  for (const key of CHANNEL_KEYS) results[key] = { sent: false, error: null };

  const wanted = only ? CHANNELS.filter((c) => only.includes(c.key)) : CHANNELS;
  for (const channel of wanted) {
    if (!channel.configured(channels)) {
      results[channel.key].error = channel.missing;
      continue;
    }
    try {
      await channel.send(channels, payload);
      results[channel.key].sent = true;
    } catch (err) {
      results[channel.key].error = sanitizeDeliveryError(err, channel.key);
    }
  }
  return results;
}

// Dispatch to a username, resolving the address through the directory if needed.
async function dispatchToUsername(username, payload, opts = {}) {
  const channels = await channelsForUsername(username);
  if (!channels.email) {
    channels.email = await resolveEmail(username, opts.ldapLookup);
  }
  return dispatch(channels, payload, opts);
}

module.exports = {
  // transports
  sendEmail, sendNtfy, sendGotify, sendTelegram,
  // helpers other code still needs
  escapeHtml, isSafeImageUrl, isBlockedNotificationHost, sanitizeDeliveryError,
  ALLOWED_IMAGE_HOSTS, METADATA_HOSTS,
  // recipients + fan-out
  CHANNEL_COLUMNS, CHANNELS, CHANNEL_KEYS,
  channelsForUsername, channelsForId, resolveEmail, dispatch, dispatchToUsername,
};
