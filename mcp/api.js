// The HTTP client for /api/v2, and the ONLY place this server talks to GameTracker.
//
// Everything here is deliberately thin. The MCP server is a protocol translator, not a
// second implementation of the API: it does not cache, it does not merge, it does not
// decide who may do what. Authorization is the backend's, unchanged, on every call.

const axios = require('axios');

// How long a tool call may wait on the backend. Longer than a normal request because
// `searchCatalog` fans out to three providers, shorter than any sane agent's patience.
const REQUEST_TIMEOUT_MS = 30000;

// The base URL of the GameTracker API, INCLUDING /api/v2.
const API_BASE = (process.env.GAMETRACKER_API_URL || 'http://backend:3000/api/v2').replace(/\/+$/, '');

// A problem+json body from v2 carries `code`, `title` and sometimes `detail`. Those are
// the fields worth handing an agent: `code` is stable and machine-readable, and the
// title says what class of failure it was. `detail` is included when present because v2
// only populates it for codes the server marked safe to expose.
//
// The RAW body is never passed through. It is JSON from another service and an agent
// will read whatever is in it as instruction-shaped text; only these three fields cross.
function describeProblem(status, body) {
  if (body && typeof body === 'object' && typeof body.code === 'string') {
    const parts = [`${body.title || 'Request failed'} (${body.code})`];
    if (typeof body.detail === 'string' && body.detail) parts.push(body.detail);
    return parts.join(': ');
  }
  return `Request failed with HTTP ${status}`;
}

// Turn a backend failure into a sentence an agent can act on.
//
// The three that matter are separated because the right NEXT ACTION differs and an
// agent that cannot tell them apart either retries forever or gives up too early:
//   401 — the token is wrong or expired. Retrying is pointless; the human must act.
//   403 — the token is valid but lacks the scope. Also not retryable, but it is a
//         different fix, and conflating it with 401 sends the user to re-issue a token
//         that was fine.
//   5xx — the server had a problem. Retrying may well work.
function toolError(err) {
  if (err.response) {
    const { status, data } = err.response;
    if (status === 401) {
      return 'Not authenticated: the GameTracker token is missing, invalid, or expired. '
        + 'Mint a new one under My Account → API Tokens and update the MCP client configuration. '
        + 'Retrying will not help.';
    }
    if (status === 403) {
      // The BODY, not a lecture about scopes. A 403 here is at least as often
      // `not_shared` — the other user has not shared their library — as it is a scope
      // problem, and the first version of this discarded a body that said exactly
      // which and substituted the scope explanation. A review watched an agent tell a
      // user to re-issue a perfectly good token because someone had not shared with
      // them: wrong, unfixable by the user, and advice they would have followed.
      return `Not permitted: ${describeProblem(status, data)}. `
        + 'Retrying will not help. If this is a scope problem the token must be re-issued with '
        + 'the right scope; if it is a sharing problem, the other user has to grant access in '
        + 'GameTracker — you cannot do it from here.';
    }
    if (status === 404) {
      // Two words ("Not found (not_found)") reads as "this tool does not exist".
      return `${describeProblem(status, data)}. Nothing matched that identifier. `
        + 'Check the exact id with list_library (or list_shares for a username) — ids are '
        + 'source-prefixed strings like "igdb_1020", not titles and not bare numbers.';
    }
    if (status === 502) {
      // 502 from this API means every catalog provider failed or none is configured —
      // an operator problem, usually permanent. Lumping it with 5xx invited a retry
      // loop on an instance with no API keys, where EVERY search and every add fails.
      return `${describeProblem(status, data)}. No game database answered — this instance may be `
        + 'missing its IGDB/RAWG/TheGamesDB API keys. One retry is reasonable; if it repeats, '
        + 'tell the user their GameTracker instance cannot reach the game databases.';
    }
    if (status >= 500) {
      return `GameTracker returned a server error (${status}). This may be transient — retrying once is reasonable. `
        + describeProblem(status, data);
    }
    return describeProblem(status, data);
  }
  if (err.code === 'ECONNABORTED') {
    return 'GameTracker did not respond in time. The request may still have been applied — '
      + 'check the current state before retrying a write.';
  }
  // A connection failure names the address, which is internal topology. Say what
  // happened without it.
  return 'Could not reach GameTracker. The API may be down or the MCP server may be '
    + 'configured with the wrong address.';
}

// One request. `token` is the CALLER's, threaded through from the MCP request that
// triggered this tool — see server.js. This module never reads a token from the
// environment, and holds none of its own.
async function call(token, method, path, { params, data } = {}) {
  return axios({
    method,
    url: `${API_BASE}${path}`,
    params,
    data,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    // Redirects are not answers here, and following one would send a bearer token to
    // wherever the redirect pointed.
    maxRedirects: 0,
    // We handle every status ourselves so a 4xx becomes a described tool error rather
    // than a thrown stack.
    validateStatus: (s) => s >= 200 && s < 300,
  }).then((r) => r.data);
}

module.exports = { call, toolError, describeProblem, API_BASE, REQUEST_TIMEOUT_MS };
