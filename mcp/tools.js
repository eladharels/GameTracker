// The tool set.
//
// DELIBERATELY NOT ONE TOOL PER ENDPOINT. /api/v2 has 34 operations; this exposes 14.
// A large tool list measurably degrades model performance — every tool is tokens in
// the context and one more thing to choose wrongly between — so these are shaped
// around what someone ASKS FOR ("what's in my backlog", "add this game"), not around
// the HTTP surface.
//
// WHAT IS EXCLUDED, AND WHY IT IS A BOUNDARY RATHER THAN AN OMISSION:
//
//   * user management        creating, editing and deleting accounts
//   * server settings        SMTP, LDAP, API keys
//   * token administration   minting and revoking credentials, including its own
//   * instance-wide jobs     sweeps that walk every user's library
//
// None of those are reachable through this server even when it is handed an
// admin-scoped token. An agent acting on someone's behalf has no business creating
// accounts or reading the SMTP password, and the cost of a mistake there is far higher
// than anything in the library surface. The API still enforces its own scopes — this
// is a second, narrower boundary on top, not a replacement for the first.
//
// Descriptions are written for a MODEL, not for a developer reading a reference. They
// say when to reach for the tool and what the result means, because that is what
// decides whether it gets chosen correctly.

const { z } = require('zod');
const api = require('./api');
const { GUIDE, CONVENTIONS } = require('./guide');

const STATUSES = ['wishlist', 'playing', 'done', 'backlog', 'unreleased'];

// The SAME shapes openapi/gametracker-v2.yaml constrains (GameRef, Username). Validated
// here rather than trusted, for two reasons. It stops a malformed value becoming a URL
// path segment — `..` survives encodeURIComponent and WHATWG URL normalises it away, so
// `remove_game{gameId:".."}` reached DELETE /library/ rather than /library/games/.. —
// and it tells the MODEL the id format at the point it is about to get it wrong, which
// a `z.string().min(1)` cannot.
const GAME_REF = z.string()
  .regex(/^(igdb|rawg|thegamesdb)_[A-Za-z0-9_-]+$/,
    'must be a source-prefixed game id from search_games, e.g. "igdb_1020" — not a title, not a bare number')
  .max(200);

// Must START alphanumeric. A plain `[a-z0-9._-]+` still matches `..`, which survives
// encodeURIComponent and is then normalised away by WHATWG URL — so
// `unshare_library{username:".."}` reached DELETE /shares/ rather than
// /shares/outgoing/.. . Anchoring the first character costs nothing and closes it.
const USERNAME = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/,
    'must be an exact lowercase username from list_shareable_users')
  .max(64);

// Wrap a handler so every tool answers the same way.
//
// A failed tool returns `isError: true` with a SENTENCE, not a thrown exception:
// the model sees the text and can act on it, where a thrown error is an opaque
// protocol failure it cannot reason about. api.toolError writes those sentences.
function tool(handler) {
  return async (args, extra) => {
    const token = extra?._gametrackerToken;
    if (!token) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'No GameTracker token was supplied. This server does not hold credentials of '
            + 'its own — the MCP client must send an Authorization: Bearer <gt_pat_...> header.',
        }],
      };
    }
    try {
      const result = await handler(args || {}, token);
      return {
        content: [{
          type: 'text',
          // COMPACT. `JSON.stringify(result, null, 2)` cost ~5,300 tokens of pure
          // indentation on a 200-game listing, measured. No model needs the whitespace.
          text: typeof result === 'string' ? result : JSON.stringify(result),
        }],
      };
    } catch (err) {
      // Logged server-side, in full. Without this a bug in a handler — a TypeError, say —
      // has no `.response`, falls through toolError's last branch, and reaches the agent
      // as "Could not reach GameTracker": it chases a phantom outage while the operator
      // has no trace at all. The SENTENCE the model sees is unchanged; only the log gains.
      console.error('[MCP] tool call failed:', err.stack || err.message);
      return { isError: true, content: [{ type: 'text', text: api.toolError(err) }] };
    }
  };
}

// Every tool: name, config, handler. Registered by server.js.
const TOOLS = [
  {
    name: 'read_gametracker_guide',
    config: {
      title: 'Read the GameTracker guide',
      description:
        'The full explanation of how GameTracker works: the five game statuses and the lifecycle '
        + 'between them, why the backlog is ordered and what that order means, how games are '
        + 'identified, what every library field holds and which are stale, how sharing works, and '
        + 'which failures are worth retrying.\n\n'
        + 'Read this ONCE at the start of any session that will do more than a single lookup. It '
        + 'is the same content as the gametracker://guide resource, offered as a tool because many '
        + 'clients do not surface resources.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // No token needed — it describes the application, not the account. It still goes
    // through `tool()` so the no-token path stays uniform across every entry here.
    handler: async () => ({
      content: [{ type: 'text', text: `${GUIDE}\n\n---\n\n${CONVENTIONS}` }],
    }),
  },

  {
    name: 'whoami',
    config: {
      title: 'Who am I',
      description:
        'Identify the GameTracker account this session is acting as, and what it is allowed to do. '
        + 'Returns the username, display name, and the token\'s scopes. '
        + 'Call this first when you are unsure whether the connection is configured, or before '
        + 'telling the user what you can and cannot do for them — it is the cheapest way to find out.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool((_args, token) => api.call(token, 'get', '/me')),
  },

  {
    name: 'search_games',
    config: {
      title: 'Search for games',
      description:
        'Search IGDB, RAWG and TheGamesDB for games by title. Use this to find a game BEFORE adding '
        + 'it — the `id` in each result is what `add_game` takes, and it cannot be guessed or '
        + 'constructed from a title.\n\n'
        + 'Results are merged and de-duplicated across the three providers. If a provider is down, '
        + 'its results are simply absent and the search still SUCCEEDS.\n\n'
        + '`meta.degraded: true` means at least one provider could not be asked. With few or no '
        + 'results that means "could not ask", NOT "no such game" — say so rather than telling the '
        + 'user the game is not in the databases.',
      inputSchema: {
        query: z.string().min(1).describe('Game title to search for. Partial titles work.'),
        limit: z.number().int().min(1).max(20).optional()
          .describe('Maximum results (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: tool(({ query, limit }, token) =>
      api.call(token, 'get', '/catalog/search', { params: { q: query, limit } })),
  },

  {
    name: 'get_game_price',
    config: {
      title: 'Get current Steam price',
      description:
        'Look up a game\'s CURRENT price on Steam, by Steam app id. Library games carry their '
        + '`steamAppId`, and `lastPrice` on a library game is whatever was recorded by the weekly '
        + 'sweep — possibly days old. Use this tool when the price needs to be current.\n\n'
        + 'A null price is a normal answer, not a failure: the game may be free, unreleased, or not '
        + 'sold in the requested region. The `reason` field says which.',
      inputSchema: {
        steamAppId: z.string().regex(/^[0-9]{1,10}$/)
          .describe('Steam application id, e.g. "440". Found on a library game as steamAppId.'),
        region: z.string().regex(/^[a-z]{2}$/).optional()
          .describe('Two-letter country code selecting the Steam store. Defaults to the instance\'s region.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler: tool(({ steamAppId, region }, token) =>
      api.call(token, 'get', `/catalog/prices/${encodeURIComponent(steamAppId)}`, { params: { region } })),
  },

  {
    name: 'list_library',
    config: {
      title: 'List my games',
      description:
        'List the games in this account\'s library, ALPHABETICALLY BY NAME unless you pass `sort`. '
        + 'Filter by `status` to answer "what am I playing" (playing) or "what do I want" (wishlist).\n\n'
        + 'For "what did I add recently" pass sort="addedAt", order="desc". For "what is coming out" '
        + 'pass sort="releaseDate". Read `meta.total` for the real size of the library — do not count '
        + 'the rows you received, which are one page.\n\n'
        + 'Statuses: wishlist (want it), playing (in progress), done (finished), backlog (queued to '
        + 'play, and ordered — see get_backlog), unreleased (release date is in the future; the '
        + 'server assigns this automatically and moves the game to wishlist on release).',
      inputSchema: {
        status: z.enum(STATUSES).optional().describe('Only games with this status.'),
        sort: z.enum(['name', 'releaseDate', 'addedAt', 'backlogOrder']).optional()
          .describe('Default "name". Use "addedAt" for recently added, "releaseDate" for upcoming. '
            + '"backlogOrder" is only meaningful together with status="backlog".'),
        order: z.enum(['asc', 'desc']).optional()
          .describe('Default "asc". Pair with sort="addedAt" and order="desc" for newest first.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum games to return.'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response\'s meta.nextCursor.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool(({ status, sort, order, limit, cursor }, token) =>
      api.call(token, 'get', '/library/games', { params: { status, sort, order, limit, cursor } })),
  },

  {
    name: 'add_game',
    config: {
      title: 'Add a game to my library',
      description:
        'Add a game to the library. Two ways, and the second is usually better:\n\n'
        + '1. `name` — an exact title. The SERVER resolves it against the game databases and '
        + 'refuses to guess: an ambiguous title returns a conflict listing the candidates, which '
        + 'you should put to the user rather than choosing for them. One call, and the match rule '
        + 'is the same one the web app uses.\n'
        + '2. `gameId` — a source-prefixed id from search_games, when you already searched or the '
        + 'user picked a specific result.\n\n'
        + 'Pass exactly one. The stored name, cover and release date are always resolved '
        + 'server-side, never from what you type.\n\n'
        + 'IMPORTANT: if the game is ALREADY in the library, omitting `status` leaves its current '
        + 'status untouched. Only pass `status` when the user actually asked to set one, or you will '
        + 'demote a game they are playing back to wishlist. A game whose release date is in the '
        + 'future is stored as `unreleased` whatever you ask for.\n\n'
        + 'Safe to repeat as far as the data goes, but each call notifies the user — do not retry '
        + 'a call that may already have succeeded just to be sure.',
      inputSchema: {
        gameId: GAME_REF.optional()
          .describe('Source-prefixed id from search_games, e.g. "igdb_1020". Exactly one of gameId or name.'),
        name: z.string().min(1).max(400).optional()
          .describe('Exact game title, resolved server-side. Exactly one of gameId or name.'),
        status: z.enum(STATUSES).optional()
          .describe('Only set this if the user asked for a specific status. Omit otherwise — see the description.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(({ gameId, name, status }, token) => {
      if (!gameId && !name) throw new Error('Pass either gameId or name.');
      if (gameId && name) throw new Error('Pass gameId OR name, not both.');
      const data = gameId ? { gameId } : { name };
      // `status` only when asked for. Sending it unconditionally is what demotes a game
      // the user is already playing back to wishlist.
      if (status) data.status = status;
      return api.call(token, 'post', '/library/games', { data });
    }),
  },

  {
    name: 'update_game_status',
    config: {
      title: 'Change a game\'s status',
      description:
        'Move a game between wishlist, playing, done and backlog. Use this when the user says they '
        + 'started, finished, or queued something.\n\n'
        + 'Moving a game INTO backlog places it at the end of the backlog queue; moving it out '
        + 'removes its position. `unreleased` is assigned by the server from the release date and '
        + 'should not normally be set by hand.',
      inputSchema: {
        gameId: GAME_REF.describe('The game\'s id as it appears in list_library.'),
        status: z.enum(STATUSES).describe('The new status.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(({ gameId, status }, token) =>
      api.call(token, 'patch', `/library/games/${encodeURIComponent(gameId)}`, { data: { status } })),
  },

  {
    name: 'remove_game',
    config: {
      title: 'Remove a game from my library',
      description:
        'Delete a game from the library entirely. This is NOT the same as marking it done — it '
        + 'discards the entry along with its status, backlog position and stored price. '
        + 'Prefer update_game_status unless the user clearly wants the game gone.',
      inputSchema: {
        gameId: GAME_REF.describe('The game\'s id as it appears in list_library.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(async ({ gameId }, token) => {
      await api.call(token, 'delete', `/library/games/${encodeURIComponent(gameId)}`);
      return `Removed ${gameId} from the library.`;
    }),
  },

  {
    name: 'get_game',
    config: {
      title: 'Get one game from my library',
      description:
        'Fetch a single library game by id — its status, backlog position, Steam id, stored price '
        + 'and DRM status. Use this to answer "is X in my library" or "what status is X" without '
        + 'listing the whole library, which can be hundreds of games.\n\n'
        + 'A not-found answer means the game is not in the library at all, under ANY status.',
      inputSchema: {
        gameId: GAME_REF.describe('The game\'s id, e.g. "igdb_1020".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool(({ gameId }, token) =>
      api.call(token, 'get', `/library/games/${encodeURIComponent(gameId)}`)),
  },

  {
    name: 'get_backlog',
    config: {
      title: 'Get my backlog in order',
      description:
        'The games queued to play, IN THE USER\'S CHOSEN ORDER — first is what they intend to play '
        + 'next. Use this rather than list_library(status="backlog") when the order matters, which '
        + 'is most of the time: "what should I play next" is answered by the first entry here.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool((_args, token) => api.call(token, 'get', '/library/backlog')),
  },

  {
    name: 'reorder_backlog',
    config: {
      title: 'Reorder my backlog',
      description:
        'Set the full backlog order.\n\n'
        + 'You MUST include EVERY backlogged game id, not just the ones you are moving. A partial '
        + 'list assigns positions 1..N to the ids you send and leaves every other game\'s stored '
        + 'position UNCHANGED, producing duplicate positions that silently break the up/down '
        + 'controls in the GameTracker web app. The damage does not show up in get_backlog, which '
        + 'renders position by row number — so you will see a clean list and report success.\n\n'
        + 'Always: call get_backlog, take its full list, apply your change, send all of it back.',
      inputSchema: {
        order: z.array(GAME_REF).min(1).max(1000)
          .describe('EVERY backlogged game id, first to last. Not just the ones you are moving.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(({ order }, token) =>
      api.call(token, 'put', '/library/backlog', { data: { order } })),
  },

  {
    name: 'list_shares',
    config: {
      title: 'List library shares',
      description:
        'Who this account shares its library WITH (outgoing), and whose libraries are shared with '
        + 'it (incoming). Sharing is read-only for the recipient: they can see the games, not change '
        + 'them. Use read_shared_library to actually read one.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool((_args, token) => api.call(token, 'get', '/shares')),
  },

  {
    name: 'list_shareable_users',
    config: {
      title: 'List accounts that can be shared with',
      description:
        'Every account on this instance, as username and display name. Use this to resolve a person '
        + 'the user names in conversation ("share with Dana") into the exact username share_library '
        + 'requires. Do not guess a username — an unknown one is rejected.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool((_args, token) => api.call(token, 'get', '/users/directory')),
  },

  {
    name: 'share_library',
    config: {
      title: 'Share my library with someone',
      description:
        'Grant one other account read-only access to this library. Additive — it does not affect '
        + 'anyone already shared with. Resolve the username with list_shareable_users first.',
      inputSchema: {
        username: USERNAME.describe('Exact username from list_shareable_users.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(({ username }, token) =>
      api.call(token, 'post', '/shares/outgoing', { data: { username } })),
  },

  {
    name: 'unshare_library',
    config: {
      title: 'Stop sharing my library with someone',
      description:
        'Revoke one account\'s read access to this library. Takes effect immediately — on their '
        + 'next request they can no longer see the games.\n\n'
        + 'This only affects the named account; everyone else keeps their access. It does not '
        + 'delete anything of theirs, and it can be undone by calling share_library again.',
      inputSchema: {
        username: USERNAME.describe('Exact username currently listed as an outgoing share.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handler: tool(async ({ username }, token) => {
      await api.call(token, 'delete', `/shares/outgoing/${encodeURIComponent(username)}`);
      return `No longer sharing with ${username}.`;
    }),
  },

  {
    name: 'read_shared_library',
    config: {
      title: 'Read a library shared with me',
      description:
        'Read the games in someone else\'s library, when they have shared it with this account. '
        + 'Read-only: nothing here can be changed. list_shares shows whose libraries are available. '
        + 'Useful for "what does Dana have that I do not".',
      inputSchema: {
        username: USERNAME.describe('The owner\'s username, from list_shares incoming.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum games to return.'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler: tool(({ username, limit, cursor }, token) =>
      api.call(token, 'get', `/shares/incoming/${encodeURIComponent(username)}/games`, { params: { limit, cursor } })),
  },
];

module.exports = { TOOLS, STATUSES, tool };
