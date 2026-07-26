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
//
// THROWING, precisely — the split matters and is not obvious:
//   * dispatch() NEVER throws. Four independent outcomes, one advisory result. See
//     services/errors.js for why this is the taxonomy's one deliberate exception,
//     and for the rule that no adapter may turn a channel error into a 500.
//   * everything that touches the database — channelsForUsername, channelsForId,
//     resolveEmail, and therefore dispatchToUsername — CAN reject. A caller that
//     treats "notifications never throw" as covering the whole module leaves an
//     Express handler with an unsent response on a pool error.

const axios = require('axios');
const nodemailer = require('nodemailer');
const db = require('../db');
// Shared promise surface — see db.js. Four services had each written their own.
const { get, run } = db.promises;
const { loadSettings } = require('../settings-store');
const { isValidEmailAddress } = require('../user-rules');
const { getLdapEmail } = require('../directory');


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
    let host = u.hostname.toLowerCase()
      .replace(/^\[|\]$/g, '')   // strip IPv6 brackets
      .replace(/\.$/, '');       // "metadata.google.internal." resolves the same
    // Unwrap IPv4-mapped IPv6. Note that `new URL()` does NOT keep the readable
    // dotted form: it normalizes ::ffff:169.254.169.254 to ::ffff:a9fe:a9fe, so the
    // two 16-bit hex groups have to be decoded back to octets before the checks
    // below can see it. (Verified against Node's WHATWG URL parser.)
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    } else {
      const mappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (mappedDotted) host = mappedDotted[1];
    }
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
    return 'SMTP is not configured on this server.';
  }

  const finalRecipient = toOverride;
  if (!finalRecipient) {
    console.log('[Email] No recipient email found, skipping email send');
    return 'No recipient address for this account.';
  }
  // Last line of defence, at the sink. Even if a bad address reaches users.email
  // through a path that skipped validation, nodemailer never sees a recipient list.
  if (!isValidEmailAddress(finalRecipient)) {
    console.error('[Email] Refusing to send: recipient is not a single valid address.');
    return 'The stored address is not a single valid address.';
  }

  const options = {
    host: smtp.host,
    port: Number(smtp.port),
    secure: Number(smtp.port) === 465,
    // Parity with the other three transports, which all cap at 10s. This was the one
    // channel with no timeout at all: nodemailer's defaults are a 30s greeting, a
    // 2-minute connection and a TEN-MINUTE socket, and this call sits ahead of the
    // response on POST /api/user/:username/games. One unreachable SMTP host held the
    // request open far longer than any client would wait.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
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
    return true;
  } catch (err) {
    console.error('[Email] Failed to send:', { error: err.message, subject });
    throw err;  // Re-throw to let caller handle the error
  }
}

async function sendNtfy(title, message, topic, attachUrl, serverUrl) {
  // Prefer the user's own ntfy server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().ntfy?.url;
  if (!url) return 'No ntfy server URL — set one in My Account, or ask an admin for a default.';
  if (!topic) return 'No ntfy topic.';
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
  return true;
}

async function sendGotify(title, message, token, priority = 5, imageUrl, serverUrl) {
  // Prefer the user's own Gotify server; fall back to the optional global default.
  const url = (serverUrl && serverUrl.trim()) || loadSettings().gotify?.url;
  if (!url) return 'No Gotify server URL — set one in My Account, or ask an admin for a default.';
  if (!token) return 'No Gotify token.';
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
  return true;
}

async function sendTelegram(title, message, chatId, photoUrl) {
  const { telegram } = loadSettings();
  const botToken = telegram?.bot_token;
  if (!botToken) return 'No Telegram bot token configured on this server.';
  if (!chatId) return 'No Telegram chat ID.';
  const text = `*${title}*\n${message}`;
  // Parity with sendNtfy/sendGotify: a hung api.telegram.org must not hold the
  // request open indefinitely.
  const opts = { timeout: 10000, maxRedirects: 0 };
  // Telegram was the ONE channel that did not filter the cover URL — email, ntfy and
  // Gotify all gate on isSafeImageUrl, this took whatever the client supplied and
  // handed it to Telegram's servers to fetch. Body-identical to the pre-extraction
  // code, so not a regression; putting the four channels side by side in one table
  // is what made the odd one out visible. An unsafe URL degrades to a text message
  // rather than dropping the notification.
  const safePhoto = isSafeImageUrl(photoUrl) ? photoUrl : null;
  if (safePhoto) {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      chat_id: chatId,
      photo: safePhoto,
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
  return true;
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
async function resolveEmail(username, knownEmail) {
  const name = username ? String(username).toLowerCase() : '';
  // `knownEmail` lets a caller that has already SELECTed the row skip a second
  // round-trip; undefined means "look it up".
  const cached = knownEmail !== undefined
    ? knownEmail
    : (await get('SELECT email FROM users WHERE username = ?', [name]))?.email;
  if (cached) return cached;

  let fromLdap = null;
  try {
    fromLdap = await getLdapEmail(name);
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

// The transports, reachable through one object so a test can substitute them.
//
// Not decoration: the property this module exists to guarantee — one channel's
// failure never stops another — is exactly the one that cannot be asserted if the
// table closes over the four bindings directly. That property was already broken
// once, in a way review caught and tests did not, because there were no tests that
// could reach it. `dispatch` touches no database, so with these substitutable the
// whole contract is testable in the database-free CI suite.
const transports = { sendEmail, sendNtfy, sendGotify, sendTelegram };

// One channel table. Its value is NOT that a fifth channel is cheap to add — there
// have been four for years. It is that independence is now a loop invariant instead
// of four hand-placed try/catches, which is the drift that caused the bug.
const CHANNELS = Object.freeze([
  {
    key: 'email',
    configured: (c) => !!c.email,
    missing: 'No email configured for current user',
    send: (c, p) => transports.sendEmail(p.subject, p.text, c.email, p.coverUrl),
  },
  {
    key: 'ntfy',
    configured: (c) => !!c.ntfy_topic,
    missing: 'No personal NTFY topic set — configure it in My Account',
    send: (c, p) => transports.sendNtfy(p.title, p.message, c.ntfy_topic, p.coverUrl, c.ntfy_url),
  },
  {
    key: 'gotify',
    configured: (c) => !!c.gotify_token,
    missing: 'No personal Gotify token set — configure it in My Account',
    send: (c, p) => transports.sendGotify(p.title, p.message, c.gotify_token, 5, p.coverUrl, c.gotify_url),
  },
  {
    key: 'telegram',
    configured: (c) => !!c.telegram_chat_id,
    missing: 'No personal Telegram chat ID set — configure it in My Account',
    send: (c, p) => transports.sendTelegram(p.title, p.message, c.telegram_chat_id, p.coverUrl),
  },
].map(Object.freeze));

// Frozen: this drives a response shape the admin Diagnostics panel iterates.
const CHANNEL_KEYS = Object.freeze(CHANNELS.map((c) => c.key));

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
  // An absolute "never throws" is only absolute if it does not depend on every
  // caller normalising first. Both current callers happen to `|| {}` two functions
  // away; that is a convention, and services/errors.js now tells adapters to rely on
  // this guarantee.
  channels = channels || {};
  // EVERY channel appears in the result, including ones `only` excluded — they come
  // back {sent:false, error:null}, meaning "not attempted". v1's shape, and the
  // admin Diagnostics panel renders a row per channel unconditionally.
  const results = {};
  for (const key of CHANNEL_KEYS) results[key] = { sent: false, error: null };

  const wanted = only ? CHANNELS.filter((c) => only.includes(c.key)) : CHANNELS;

  // CONCURRENT, deliberately. Sequentially the worst case was the SUM of four
  // timeouts — up to 40s of third-party latency inside POST /api/user/:username/games
  // before the response, and per user in the daily cron. It is now the MAX of them.
  // It also makes independence structural: there is no ordering in which one
  // channel's failure could precede and prevent another's attempt.
  await Promise.all(wanted.map(async (channel) => {
    try {
      // configured() is INSIDE the try. Outside it, a channel row with an unexpected
      // shape threw out of the map callback — and Promise.all would then reject out
      // of a function documented as never throwing. Total callback, so Promise.all
      // is correct by construction rather than by coincidence. (allSettled would be
      // the wrong fix: it would swallow such a throw into {sent:false, error:null},
      // which is the reserved "not attempted" sentinel and renders as a bare
      // "✗ Failed" in the admin panel.)
      if (!channel.configured(channels)) {
        results[channel.key].error = channel.missing;
        return;
      }
      // A transport returns `true` when it actually delivered, or a STRING saying
      // why it declined. "Resolved without throwing" is not delivery: every
      // transport short-circuits on a missing server URL, an unconfigured SMTP host,
      // or — the one that matters — a recipient the sink refused as malformed. That
      // used to be reported as sent:true, so an admin with no SMTP configured saw
      // four green rows in Diagnostics, and the operator repairing a bad directory
      // address got "sent" as confirmation while nothing had left the building.
      const outcome = await channel.send(channels, payload);
      if (outcome === true) results[channel.key].sent = true;
      else results[channel.key].error = typeof outcome === 'string' ? outcome : 'Not delivered.';
    } catch (err) {
      results[channel.key].error = sanitizeDeliveryError(err, channel.key);
    }
  }));
  return results;
}

// Dispatch to a username, resolving the address through the directory if needed.
async function dispatchToUsername(username, payload, opts = {}) {
  const channels = await channelsForUsername(username);
  // channelsForUsername already read `email`; pass it so resolveEmail does not
  // re-SELECT the same column before falling through to the directory.
  channels.email = await resolveEmail(username, channels.email || '');
  return dispatch(channels, payload, opts);
}

module.exports = {
  // transports
  sendEmail, sendNtfy, sendGotify, sendTelegram,
  // THE TEST SEAM. The CHANNELS rows are frozen and call through this object, so
  // substituting a transport here is the only way to exercise dispatch() without a
  // network — and dispatch()'s contract (one channel's failure never stops another)
  // is the thing this module exists to guarantee. Production code must not reassign
  // these; a test must restore what it replaced.
  transports,
  // helpers other code still needs
  escapeHtml, isSafeImageUrl, isBlockedNotificationHost, sanitizeDeliveryError,
  ALLOWED_IMAGE_HOSTS, METADATA_HOSTS,
  // recipients + fan-out
  CHANNEL_COLUMNS, CHANNELS, CHANNEL_KEYS,
  channelsForUsername, channelsForId, resolveEmail, dispatch, dispatchToUsername,
};
