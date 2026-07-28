# GameTracker MCP server

Exposes a narrow, task-shaped subset of `/api/v2` over the [Model Context
Protocol](https://modelcontextprotocol.io) so an AI assistant can work with your game
library — search for games, add them, move things through the backlog, manage sharing.

## The one thing to understand first

**This server holds no credentials.** There is no token in its environment, no token in
a config file, and nothing for it to leak if it is compromised. Every request must
carry its own:

```
Authorization: Bearer gt_pat_...
```

which it forwards to the API unchanged. Authorization stays the backend's, and reaching
this port grants nothing on its own.

The alternative — one ambient token in the container's environment — would make the
port itself a credential: anything that could reach it would act as that account.

## Setup

**1. Mint a token.** In GameTracker: **My Account → API Tokens → New Token**. The
`library` scope is enough; this server exposes nothing that needs `admin`.

**2. Point your MCP client at it.** For a client that supports remote MCP servers over
HTTP:

```json
{
  "mcpServers": {
    "gametracker": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer gt_pat_your_token_here"
      }
    }
  }
}
```

The token lives in your MCP client's config, which is where a per-user credential
belongs.

## Tools

Fifteen, shaped around what people ask for rather than around HTTP endpoints. A large
tool list measurably degrades model performance, so this is not one tool per endpoint.

| Tool | |
|---|---|
| `read_gametracker_guide` | the full application explanation — call this first |
| `whoami` | which account, and what the token may do |
| `search_games` | find a game across IGDB, RAWG and TheGamesDB |
| `list_library` | your games, filterable and sortable |
| `get_game` | one game, without listing the whole library |
| `add_game` | add one found via `search_games` |
| `update_game_status` | wishlist / playing / done / backlog |
| `remove_game` | delete an entry |
| `get_backlog` | the backlog **in order** |
| `reorder_backlog` | replace the ordering |
| `list_shares` | who you share with, and who shares with you |
| `list_shareable_users` | resolve a name to a username |
| `share_library` | grant someone read access |
| `unshare_library` | revoke it |
| `read_shared_library` | read a library shared with you |

### What is deliberately absent

Price lookup — a library row's `lastPrice` is a weekly snapshot and that is all this
server reports; nobody uses an assistant to check a store price.

User management, server settings, token administration, and instance-wide job
triggering. **None of them are reachable through this server even if you hand it an
admin-scoped token.** An agent acting on your behalf has no business creating accounts
or reading your SMTP password, and the cost of a mistake there is far higher than
anything in the library surface.

The API still enforces its own scopes. This is a second, narrower boundary on top.

## The application guide

An agent connecting fresh knows nothing about GameTracker. Tool descriptions cannot
carry that — they describe one call each. So the server also serves a full explanation
of the application: the five statuses and the lifecycle between them, why the backlog is
ordered, how games are identified, which fields are stale, how sharing works, and which
failures are worth retrying.

It is available **both** ways, deliberately:

* as the `read_gametracker_guide` **tool** — because many MCP clients surface tools only
* as the `gametracker://guide` and `gametracker://conventions` **resources**

The instructions sent on connect stay short and carry only the four defaults an agent
gets wrong unaided. Everything else is one call away.

## Configuration

| Variable | Default | |
|---|---|---|
| `GAMETRACKER_API_URL` | `http://backend:3000/api/v2` | must include `/api/v2` |
| `MCP_PORT` | `3001` | |
| `MCP_BIND` | `127.0.0.1` | `0.0.0.0` in the container; compose publishes to loopback |
| `MCP_ALLOWED_HOSTS` | localhost/mcp variants | Host header allowlist. Set this when publishing under a name. |

## Deployment

It ships as its own container in `docker-compose.yaml`, published on `127.0.0.1:3001`
by default. It talks to `backend:3000` over the internal network and has no volumes, no
database access and no secrets.

To reach it from another machine, set `MCP_BIND=0.0.0.0` — **and put TLS in front of
it**, or personal access tokens will cross the network in a cleartext header.

Running it separately from the backend is deliberate: it is the least-trusted consumer
in this design, and inside the backend container it would have `settings.json`, the
database and the LDAP bind password within reach.

## Development

```bash
npm install
npm test    # tool inventory, credentials, error mapping, application documentation
```

To try it against a running backend:

```bash
GAMETRACKER_API_URL=http://127.0.0.1:3000/api/v2 MCP_PORT=3399 node server.js
```

then point any MCP client at `http://127.0.0.1:3399/mcp` with a token.

`npm test` deliberately touches no network. It pins the exposed tool inventory —
every tool is reachable by an AI agent acting on a real library, so adding one should
be a deliberate edit — and asserts that the server holds no credential of its own.
